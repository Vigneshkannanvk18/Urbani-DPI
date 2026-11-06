import type { LogEntry } from '@urbani/shared';
import type { CloudWatchLogQuery } from './types';
import { assertSafeRegex, regexMatchAll } from '../lib/safeRegex';

/** Union of the legacy single `level` and the multi-select `levels`. */
export function effectiveLevels(q: CloudWatchLogQuery): string[] {
  return [...new Set([...(q.levels ?? []), ...(q.level ? [q.level] : [])])];
}

/** Union of the legacy single `service` and the multi-select `services`. */
export function effectiveServices(q: CloudWatchLogQuery): string[] {
  return [...new Set([...(q.services ?? []), ...(q.service ? [q.service] : [])])];
}

/**
 * Shared in-process filter used by the Mock and Http adapters (the Insights adapter
 * pushes level/range/text into the query and only re-checks regex here).
 * Filters: service(s), environment, level(s), from/to range, text or regex.
 * Does not sort or cap; callers own ordering and the window cap.
 */
export function filterLogEntries(items: LogEntry[], q: CloudWatchLogQuery): LogEntry[] {
  let out = items;
  const services = effectiveServices(q);
  if (services.length) out = out.filter((l) => services.includes(l.service));
  if (q.environment) out = out.filter((l) => l.environment === q.environment);
  const levels = effectiveLevels(q);
  if (levels.length) out = out.filter((l) => levels.includes(l.level));

  const fromMs = q.startTime ? Date.parse(q.startTime) : NaN;
  const toMs = q.endTime ? Date.parse(q.endTime) : NaN;
  if (!Number.isNaN(fromMs) || !Number.isNaN(toMs)) {
    out = out.filter((l) => {
      const t = Date.parse(l.timestamp);
      if (Number.isNaN(t)) return false;
      if (!Number.isNaN(fromMs) && t < fromMs) return false;
      if (!Number.isNaN(toMs) && t > toMs) return false;
      return true;
    });
  }

  if (q.search) {
    if (q.regex) {
      assertSafeRegex(q.search, q.regexMaxLength);
      const hits = regexMatchAll(q.search, out.map((l) => l.message));
      out = out.filter((_, i) => hits[i]);
    } else {
      const needle = q.search.toLowerCase();
      out = out.filter((l) => l.message.toLowerCase().includes(needle));
    }
  }
  return out;
}

/** Sort by timestamp (stable). Unparseable timestamps always go last. */
export function sortLogEntries(items: LogEntry[], sort: 'newest' | 'oldest' = 'newest'): LogEntry[] {
  const dir = sort === 'oldest' ? 1 : -1;
  return items
    .map((e, i) => ({ e, i, t: Date.parse(e.timestamp) }))
    .sort((a, b) => {
      const an = Number.isNaN(a.t);
      const bn = Number.isNaN(b.t);
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      return a.t === b.t ? a.i - b.i : (a.t - b.t) * dir;
    })
    .map((x) => x.e);
}
