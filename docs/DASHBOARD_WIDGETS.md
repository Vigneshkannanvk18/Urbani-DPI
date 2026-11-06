# Dashboard widgets (DPI 2 item 12)

Each user can reorder and hide Dashboard sections. Any signed-in user can customize their own dashboard. The layout is stored in the per-user preferences (`widgetLayout`), cached in localStorage per user for instant paint, and the server value wins on login.

## Registry
`packages/shared/src/dashboardLayout.ts` (`DASHBOARD_WIDGETS`). Default order is array order.

| id | Title | Permission | Size |
|---|---|---|---|
| kpi | Key metrics | dashboard:view | full |
| service-health | Service health | services:view | full |
| system-health | System health | dashboard:view | half |
| ai-cost | AI cost & budget | usage:view | half |
| observability | Observability chart | dashboard:view | full |
| recent-alerts | Recent alerts | alerts:view | half |
| recent-analyses | Recent AI analyses | ai:view | half |

## Layout schema
`{ "version": 1, "widgets": [ { "id": "kpi", "visible": true }, ... ] }` in display order. `PUT /api/preferences` with `widgetLayout` validates it (version 1, at most 30 entries, known ids, strict keys). `widgetLayout: null` resets to default. Own preferences only.

`normalizeLayout(saved, registry, permissions)` makes any saved value safe: drops unknown ids and duplicates, drops widgets the user lacks permission for, inserts widgets missing from the saved layout at their default position, and falls back to the default for malformed input.

## UI
Customize toggle: per widget drag handle (native HTML5 drag and drop), move up/down buttons (keyboard and narrow-screen alternative), Hide; hidden widgets sit in a tray with Show. Save / Cancel / Reset to default, an unsaved-changes indicator, optimistic save with rollback on error, and a live-region announcement on every move.

## Adding a widget
1. Add an entry to `DASHBOARD_WIDGETS` (id, title, permission, size). Existing users get it at its default position automatically.
2. Add a render function with the same id in the `widgets` map in `packages/frontend/src/pages/Dashboard.tsx`.
3. Add the id to the expectations in `dashboardLayout.test.ts` if needed.
