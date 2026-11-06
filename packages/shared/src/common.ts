/**
 * Data provenance labelling.
 *
 * Epics 4/6/7/10 require the UI to make it explicit whether a value is real
 * telemetry, controlled mock/seed data, or a placeholder awaiting Phase 2
 * integration. Never present MOCK data as if it were real AWS data.
 */
export const DATA_SOURCES = ['LIVE', 'MOCK', 'WAITING_FOR_INTEGRATION'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/** Wrapper attached to any payload that may not yet be backed by real integrations. */
export interface Sourced<T> {
  source: DataSource;
  /** Human-readable note, e.g. "Seeded demo data — Bedrock not yet connected". */
  sourceNote?: string;
  data: T;
}

/** Standard paginated list envelope used across list endpoints. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Filters that were actually applied to a log search (echoed back by GET /api/logs). */
export interface LogSearchApplied {
  levels?: string[];
  services?: string[];
  from?: string;
  to?: string;
  search?: string;
  regex?: boolean;
}

/** Search metadata returned next to the Sourced log page so coverage is never misrepresented. */
export interface LogSearchMeta {
  applied: LogSearchApplied;
  sort: 'newest' | 'oldest';
  /** Matches found inside the scanned window (not a claim about the whole log stream). */
  total: number;
  /** True when the window cap was hit, so more matching lines may exist beyond it. */
  truncated: boolean;
  /** Maximum lines the active source scans per request. */
  windowCap: number;
  /** Plain-language description of WHAT is searched. */
  scope: string;
}

/** Standard API error body (see backend error handler). */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId?: string;
  };
}
