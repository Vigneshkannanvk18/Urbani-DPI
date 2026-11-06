import type { Permission } from './rbac';

/**
 * Dashboard widget registry + layout model (DPI 2 item 12; docs/DASHBOARD_WIDGETS.md).
 * The registry is the single list of personalisable Dashboard sections. To add a widget: add an entry here
 * (it is appended for existing users automatically) and render it in the frontend widget map.
 */
export const DASHBOARD_LAYOUT_VERSION = 1 as const;
export const MAX_LAYOUT_ENTRIES = 30;

export interface WidgetDefinition {
  id: string;
  title: string;
  /** Permission the user needs to see the widget at all (it is dropped completely without it). */
  permission: Permission;
  /** Layout hint for the grid: full row or half row. */
  size: 'full' | 'half';
}

/** Default order = array order. */
export const DASHBOARD_WIDGETS: readonly WidgetDefinition[] = [
  { id: 'kpi', title: 'Key metrics', permission: 'dashboard:view', size: 'full' },
  { id: 'service-health', title: 'Service health', permission: 'services:view', size: 'full' },
  { id: 'system-health', title: 'System health', permission: 'dashboard:view', size: 'half' },
  { id: 'ai-cost', title: 'AI cost & budget', permission: 'usage:view', size: 'half' },
  { id: 'observability', title: 'Observability chart', permission: 'dashboard:view', size: 'full' },
  { id: 'recent-alerts', title: 'Recent alerts', permission: 'alerts:view', size: 'half' },
  { id: 'recent-analyses', title: 'Recent AI analyses', permission: 'ai:view', size: 'half' },
];

export interface WidgetLayoutEntry {
  id: string;
  visible: boolean;
}
export interface DashboardLayout {
  version: typeof DASHBOARD_LAYOUT_VERSION;
  widgets: WidgetLayoutEntry[];
}

export const DASHBOARD_WIDGET_IDS: readonly string[] = DASHBOARD_WIDGETS.map((w) => w.id);

/** The default layout for a user (permission-filtered). */
export function defaultLayout(
  userPermissions: readonly string[],
  registry: readonly WidgetDefinition[] = DASHBOARD_WIDGETS,
): DashboardLayout {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    widgets: registry.filter((w) => userPermissions.includes(w.permission)).map((w) => ({ id: w.id, visible: true })),
  };
}

/**
 * Turn whatever was saved into a safe layout for this user.
 *  - malformed input (not an object, wrong version, widgets not an array) -> default layout
 *  - unknown ids are dropped, duplicates keep the first occurrence
 *  - widgets the user lacks permission for are dropped
 *  - registry widgets missing from the saved layout (new releases) are inserted at their default position:
 *    after the closest preceding default widget that is already placed, else first
 *  - `visible` must be exactly `false` to hide; anything else is shown
 */
export function normalizeLayout(
  saved: unknown,
  registry: readonly WidgetDefinition[] = DASHBOARD_WIDGETS,
  userPermissions: readonly string[] = [],
): DashboardLayout {
  const allowed = registry.filter((w) => userPermissions.includes(w.permission));
  const allowedIds = new Set(allowed.map((w) => w.id));
  const fallback = defaultLayout(userPermissions, registry);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return fallback;
  const s = saved as { version?: unknown; widgets?: unknown };
  if (s.version !== DASHBOARD_LAYOUT_VERSION || !Array.isArray(s.widgets)) return fallback;

  const out: WidgetLayoutEntry[] = [];
  const seen = new Set<string>();
  for (const raw of s.widgets) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, visible } = raw as { id?: unknown; visible?: unknown };
    if (typeof id !== 'string' || seen.has(id) || !allowedIds.has(id)) continue;
    seen.add(id);
    out.push({ id, visible: visible !== false });
  }
  // Insert missing widgets at their default position.
  allowed.forEach((w, idx) => {
    if (seen.has(w.id)) return;
    let insertAt = 0;
    for (let i = idx - 1; i >= 0; i--) {
      const pos = out.findIndex((e) => e.id === allowed[i].id);
      if (pos >= 0) {
        insertAt = pos + 1;
        break;
      }
    }
    out.splice(insertAt, 0, { id: w.id, visible: true });
    seen.add(w.id);
  });
  return { version: DASHBOARD_LAYOUT_VERSION, widgets: out };
}
