export * from './alerts';
export * from './common';
export * from './domain';
// Explicit named re-exports (not `export *`) so bundlers can statically detect
// these runtime value exports through the CommonJS build.
export {
  ALLOWED_LINK_SCHEMES,
  sanitizeUrl,
  parseMarkdown,
  parseInline,
} from './markdown';
export type { InlineToken, BlockToken } from './markdown';
export type { Permission } from './rbac';
export {
  PERMISSIONS,
  ROLES,
  ROLE_DISPLAY_NAMES,
  ROLE_PERMISSIONS,
  isUserRole,
  permissionsForRole,
  roleHasPermission,
} from './rbac';
export * from './notifications';
export * from './health';
// Explicit named re-exports so bundlers can detect these runtime values through the CommonJS build.
export {
  DASHBOARD_LAYOUT_VERSION,
  MAX_LAYOUT_ENTRIES,
  DASHBOARD_WIDGETS,
  DASHBOARD_WIDGET_IDS,
  defaultLayout,
  normalizeLayout,
} from './dashboardLayout';
export type { WidgetDefinition, WidgetLayoutEntry, DashboardLayout } from './dashboardLayout';
