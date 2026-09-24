/**
 * Modular navigation config (Epic 3). Sections are data-driven so they can be
 * enabled/disabled later without touching the layout. `enabled: false` hides a
 * section entirely.
 */
export interface NavSection {
  key: string;
  label: string;
  path: string;
  icon: string;
  enabled: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', icon: '▤', enabled: true },
  { key: 'alerts', label: 'Alerts / Incidents', path: '/alerts', icon: '⚠', enabled: true },
  { key: 'logs', label: 'Logs', path: '/logs', icon: '≣', enabled: true },
  { key: 'metrics', label: 'Metrics', path: '/metrics', icon: '📈', enabled: true },
  { key: 'ai', label: 'AI Insights', path: '/ai', icon: '✦', enabled: true },
  { key: 'services', label: 'Services', path: '/services', icon: '◈', enabled: true },
  { key: 'usage', label: 'Usage & Cost', path: '/usage', icon: '$', enabled: true },
  { key: 'audit', label: 'Audit / Activity', path: '/audit', icon: '⧉', enabled: true },
  { key: 'settings', label: 'Settings', path: '/settings', icon: '⚙', enabled: true },
];
