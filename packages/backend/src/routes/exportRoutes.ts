import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { requirePermission } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { config } from '../config';
import { getRepositories } from '../repositories';
import { telemetryService } from '../services/telemetryService';
import { alertService } from '../services/alertService';
import { parseLogSearch, appliedFilters } from '../lib/logQuery';
import { alertFilterSchema } from '../lib/alertQuery';
import { ExportAbortedError, exportFileName, writeCsv, writeJson } from '../lib/export/formats';
import { writeIncidentPdf, writeLogsPdf, type PdfListMeta } from '../lib/export/pdf';
import { logger } from '../lib/logger';

/**
 * Exports (DPI 2 item 11; docs/EXPORT.md). One permission, `logs:export`, covers every export in this file
 * (logs, alerts and the incident report). Order of checks: auth (401) -> permission (403) -> per-user rate limit
 * (429) -> parameter validation (400) -> data -> stream. Audited as SENSITIVE_QUERY with filters and counts only.
 */
export const exportRoutes = Router();

const exportLimiter = rateLimit({
  windowMs: 60_000,
  max: () => config.export.rateLimitPerMin,
  key: (req) => `export:${req.auth?.sub ?? req.ip ?? 'unknown'}`,
});

const bomParam = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : typeof v === 'string' ? !['false', '0', 'no', 'off'].includes(v.toLowerCase()) : v),
  z.boolean().default(true),
);
const logFormat = z.object({ format: z.enum(['csv', 'json', 'pdf']), bom: bomParam });
const alertFormat = z.object({ format: z.enum(['csv', 'json']), bom: bomParam });
const reportFormat = z.object({ format: z.enum(['pdf']).default('pdf') });

const MIME = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', pdf: 'application/pdf' } as const;

/** Common response headers; set BEFORE the first byte so the client can read provenance without parsing. */
function startResponse(
  res: Response,
  o: { format: keyof typeof MIME; kind: string; source: string; rows: number; truncated: boolean },
): void {
  res.status(200);
  res.setHeader('Content-Type', MIME[o.format]);
  res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(o.kind, o.format)}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Export-Source', o.source);
  res.setHeader('X-Export-Rows', String(o.rows));
  res.setHeader('X-Export-Truncated', String(o.truncated));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Source, X-Export-Rows, X-Export-Truncated');
}

/** Run the streaming body with a deadline; stop quietly when the client disconnects. */
async function stream(req: Request, res: Response, body: () => Promise<void>): Promise<void> {
  const timer = setTimeout(() => {
    logger.warn('Export timed out; closing the connection', { path: req.path });
    res.destroy();
  }, config.export.timeoutMs);
  try {
    await body();
  } catch (err) {
    if (err instanceof ExportAbortedError || res.destroyed) return; // client went away or deadline hit
    if (!res.headersSent) throw err;
    logger.error('Export failed mid-stream', { message: err instanceof Error ? err.message : 'unknown' });
    res.destroy(); // cannot send a JSON error once streaming started: cut the connection so the file is not mistaken for complete
  } finally {
    clearTimeout(timer);
  }
}

const COLS = { logs: ['timestamp', 'level', 'service', 'environment', 'message', 'id'] } as const;

// -------------------- LOGS --------------------
exportRoutes.get(
  '/logs/export',
  requirePermission('logs:export'),
  exportLimiter,
  asyncHandler(async (req, res) => {
    const { format, bom } = logFormat.parse(req.query);
    const search = parseLogSearch(req.query, config.logs.regexMaxLength); // page/pageSize are ignored on purpose
    const cap = format === 'pdf' ? Math.min(config.export.pdfMaxRows, config.export.maxRows) : config.export.maxRows;
    const out = await telemetryService.exportLogs(search, config.export.maxRows);
    const rows = out.rows.slice(0, cap);
    const pdfCut = out.rows.length > rows.length;
    const truncated = out.truncated || pdfCut;
    const filters = { ...appliedFilters(search), ...(search.environment ? { environment: search.environment } : {}), sort: search.sort };
    const generatedAt = new Date().toISOString();
    const generatedBy = req.auth!.email;

    await getRepositories().audit.record(generatedBy, 'logs.export', 'logs', {
      format, filters, rowCount: rows.length, truncated,
    });
    startResponse(res, { format, kind: 'logs', source: out.source, rows: rows.length, truncated });

    const notice = pdfCut
      ? `NOTICE: PDF exports are limited to ${cap} rows; this file shows the first ${rows.length} of ${out.rows.length} matching rows. Use CSV or JSON for the full set.`
      : out.truncated
        ? `NOTICE: the data source returned a capped window (${out.windowCap} lines); more matching lines may exist outside it.`
        : undefined;
    await stream(req, res, async () => {
      if (format === 'csv') {
        await writeCsv(res, COLS.logs, rows, (r) => [r.timestamp, r.level, r.service, r.environment, r.message, r.id], { bom });
      } else if (format === 'json') {
        const meta = {
          source: out.source, sourceNote: out.sourceNote, scope: out.scope, filters, rowCount: rows.length,
          truncated, generatedAt, generatedBy, exportMaxRows: config.export.maxRows,
        };
        await writeJson(res, meta, rows);
      } else {
        const meta: PdfListMeta = {
          title: 'Log export', source: out.source, sourceNote: out.sourceNote, scope: out.scope, filters,
          rowCount: rows.length, truncated, truncationNotice: notice, generatedAt, generatedBy,
        };
        await writeLogsPdf(res, meta, rows);
      }
    });
  }),
);

// -------------------- ALERTS --------------------
const ALERT_COLS = [
  'alertId', 'timestamp', 'service', 'environment', 'severity', 'anomalyType', 'status', 'summary',
  'probableCause', 'confidence', 'confidenceDerived', 'recommendedActions', 'evidenceCount',
] as const;
const ALERT_SCOPE = 'Alerts held by the dashboard store (live-ingested incidents in LIVE mode, seeded demonstration alerts in MOCK mode).';

exportRoutes.get(
  '/alerts/export',
  requirePermission('logs:export'),
  exportLimiter,
  asyncHandler(async (req, res) => {
    const { format, bom } = alertFormat.parse(req.query);
    const filter = alertFilterSchema.parse(req.query);
    const out = await alertService.listForExport(filter, config.export.maxRows);
    const derived = out.source === 'LIVE'; // live confidence is derived from severity (see the alert detail page)
    const filters = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined && v !== ''));
    const generatedAt = new Date().toISOString();
    const generatedBy = req.auth!.email;

    await getRepositories().audit.record(generatedBy, 'alerts.export', 'alerts', {
      format, filters, rowCount: out.items.length, truncated: out.truncated,
    });
    startResponse(res, { format, kind: 'alerts', source: out.source, rows: out.items.length, truncated: out.truncated });
    await stream(req, res, async () => {
      if (format === 'csv') {
        await writeCsv(res, ALERT_COLS, out.items, (a) => [
          a.alertId, a.timestamp, a.service, a.environment, a.severity, a.anomalyType, a.status, a.summary, a.probableCause,
          a.confidence ?? '', a.confidence != null && derived, a.recommendedActions.join(' | '), a.evidence.length,
        ], { bom });
      } else {
        const meta = {
          source: out.source, sourceNote: out.sourceNote, scope: ALERT_SCOPE, filters, rowCount: out.items.length,
          truncated: out.truncated, generatedAt, generatedBy, exportMaxRows: config.export.maxRows,
        };
        await writeJson(res, meta, out.items.map((a) => ({
          alertId: a.alertId, timestamp: a.timestamp, service: a.service, environment: a.environment, severity: a.severity,
          anomalyType: a.anomalyType, status: a.status, summary: a.summary, probableCause: a.probableCause,
          confidence: a.confidence, confidenceDerived: a.confidence != null && derived,
          recommendedActions: a.recommendedActions, evidenceCount: a.evidence.length,
        })));
      }
    });
  }),
);

// -------------------- INCIDENT REPORT --------------------
exportRoutes.get(
  '/alerts/:id/report',
  requirePermission('logs:export'),
  exportLimiter,
  asyncHandler(async (req, res) => {
    reportFormat.parse(req.query);
    const out = await alertService.getForReport(req.params.id);
    const generatedAt = new Date().toISOString();
    const generatedBy = req.auth!.email;
    await getRepositories().audit.record(generatedBy, 'incident.report', req.params.id, {
      format: 'pdf', filters: { alertId: req.params.id }, rowCount: out.relatedLogs.length + out.alert.evidence.length, truncated: false,
    });
    startResponse(res, { format: 'pdf', kind: `incident-${req.params.id}`, source: out.source, rows: 1, truncated: false });
    await stream(req, res, async () => {
      await writeIncidentPdf(res, {
        alert: out.alert, relatedLogs: out.relatedLogs, source: out.source, sourceNote: out.sourceNote,
        generatedAt, generatedBy, confidenceDerived: out.alert.confidence != null && out.source === 'LIVE',
      });
    });
  }),
);
