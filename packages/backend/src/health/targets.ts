import { z } from 'zod';
import { parseTargetUrl } from './ssrf';

/**
 * Health targets (DPI 2 item 9). Config-driven: the HEALTH_TARGETS env var is the ONLY source of probe URLs.
 *
 * Built-in targets that need no client input:
 *   radar-api               this service: database ping through the repository readiness check
 *   urbani-qa-telemetry-api reachability of the configured Urbani observability API (NOT the customer's QA application)
 * Placeholder targets (QA, Main, Payment): WAITING_FOR_INTEGRATION until HEALTH_TARGETS has an entry with that id.
 */
export const RADAR_API_ID = 'radar-api';
export const URBANI_API_ID = 'urbani-qa-telemetry-api';
export const PLACEHOLDER_IDS = ['qa', 'main', 'payment'] as const;
export const WAITING_NOTE = 'No health endpoint configured -- needs Urbani input';

export interface HttpTarget {
  kind: 'http';
  id: string;
  name: string;
  description: string;
  url: string;
  method: 'GET' | 'HEAD';
  expectedStatus: number[] | null;
  timeoutMs: number;
  degradedAboveMs: number;
  /** Urbani service id used to show open alerts for this target; null = no mapping. */
  service: string | null;
}
export interface RadarTarget { kind: 'radar'; id: typeof RADAR_API_ID; name: string; description: string; degradedAboveMs: number }
export interface UrbaniApiTarget { kind: 'urbani-api'; id: typeof URBANI_API_ID; name: string; description: string }
export interface PlaceholderTarget { kind: 'placeholder'; id: string; name: string; description: string; configHint: string }
export type HealthTarget = HttpTarget | RadarTarget | UrbaniApiTarget | PlaceholderTarget;

const PLACEHOLDER_INFO: Record<(typeof PLACEHOLDER_IDS)[number], { name: string; description: string }> = {
  qa: { name: 'QA', description: 'Urbani QA application health endpoint' },
  main: { name: 'Main', description: 'Urbani Main application health endpoint' },
  payment: { name: 'Payment', description: 'Urbani Payment application health endpoint' },
};

const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'id: lowercase letters, digits, _ and - (1-64)'),
  name: z.string().trim().min(1).max(80).optional(),
  type: z.literal('http'),
  url: z.string().min(1).max(2048),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  expectedStatus: z.array(z.number().int().min(100).max(599)).min(1).max(20).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(5000),
  degradedAboveMs: z.number().int().min(1).max(60_000).default(2000),
  service: z.string().min(1).max(64).optional(),
});

export interface TargetsLoad {
  targets: HealthTarget[];
  /** Human-readable problems with HEALTH_TARGETS. Invalid entries are skipped, never fatal. */
  errors: string[];
}

export interface BuiltinInput {
  urbaniApiConfigured: boolean;
  urbaniServices: string[];
}

/** Parses HEALTH_TARGETS and merges it with the built-in and placeholder targets. */
export function loadTargets(raw: string | null, builtin: BuiltinInput): TargetsLoad {
  const errors: string[] = [];
  const configured = new Map<string, HttpTarget>();

  if (raw) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        errors.push('HEALTH_TARGETS must be a JSON array; ignoring it');
        parsed = [];
      }
    } catch {
      errors.push('HEALTH_TARGETS is not valid JSON; ignoring it');
    }
    (parsed as unknown[]).forEach((item, index) => {
      const res = entrySchema.safeParse(item);
      if (!res.success) {
        const issue = res.error.issues[0];
        errors.push(`HEALTH_TARGETS[${index}]: ${issue.path.join('.') || 'entry'}: ${issue.message}`);
        return;
      }
      const e = res.data;
      if (e.id === RADAR_API_ID || e.id === URBANI_API_ID) {
        errors.push(`HEALTH_TARGETS[${index}]: id "${e.id}" is reserved for a built-in target`);
        return;
      }
      if (configured.has(e.id)) {
        errors.push(`HEALTH_TARGETS[${index}]: duplicate id "${e.id}"`);
        return;
      }
      const url = parseTargetUrl(e.url);
      if (!url.ok) {
        // The URL itself is never echoed (it could carry credentials).
        errors.push(`HEALTH_TARGETS[${index}] (${e.id}): url: ${url.reason}`);
        return;
      }
      const placeholder = (PLACEHOLDER_IDS as readonly string[]).includes(e.id) ? PLACEHOLDER_INFO[e.id as (typeof PLACEHOLDER_IDS)[number]] : null;
      configured.set(e.id, {
        kind: 'http',
        id: e.id,
        name: e.name ?? placeholder?.name ?? e.id,
        description: placeholder?.description ?? 'HTTP health endpoint configured in HEALTH_TARGETS',
        url: url.url.toString(),
        method: e.method,
        expectedStatus: e.expectedStatus ?? null,
        timeoutMs: e.timeoutMs,
        degradedAboveMs: e.degradedAboveMs,
        service: e.service ?? (builtin.urbaniServices.includes(e.id) ? e.id : null),
      });
    });
  }

  const targets: HealthTarget[] = [
    {
      kind: 'radar',
      id: RADAR_API_ID,
      name: 'Radar API',
      description: 'This service: database ping through the repository readiness check',
      degradedAboveMs: 2000,
    },
    {
      kind: 'urbani-api',
      id: URBANI_API_ID,
      name: 'Urbani QA telemetry API',
      description: "Reachability of the Urbani observability API used for logs and alerts. This is NOT the health of the customer's QA application.",
    },
  ];
  for (const id of PLACEHOLDER_IDS) {
    const http = configured.get(id);
    if (http) {
      targets.push(http);
    } else {
      targets.push({
        kind: 'placeholder',
        id,
        name: PLACEHOLDER_INFO[id].name,
        description: PLACEHOLDER_INFO[id].description,
        configHint: `Add an entry with "id":"${id}" to HEALTH_TARGETS, e.g. [{"id":"${id}","type":"http","url":"https://<health-endpoint>"}]`,
      });
    }
  }
  for (const [id, t] of configured) {
    if (!(PLACEHOLDER_IDS as readonly string[]).includes(id)) targets.push(t);
  }
  return { targets, errors };
}

/** Env var names that enable the Urbani API probe (shown by the UI when it is not configured). */
export const URBANI_API_CONFIG_HINT = 'Set URBANI_API_BASE_URL and URBANI_API_KEY';
