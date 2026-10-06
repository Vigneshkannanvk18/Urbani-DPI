import type { ComponentType } from 'react';
import {
  IconDashboard,
  IconAlert,
  IconLogs,
  IconMetrics,
  IconAI,
  IconAssistant,
  IconServices,
  IconCost,
  IconAudit,
  IconSettings,
} from './components/icons';

/**
 * Modular navigation config (Part 12). Sections are data-driven so they can be
 * enabled/disabled without touching the layout. `title` is used by the header.
 */
export interface NavSection {
  key: string;
  label: string;
  title: string;
  path: string;
  icon: ComponentType<{ size?: number }>;
  enabled: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  { key: 'dashboard', label: 'Dashboard', title: 'Dashboard', path: '/', icon: IconDashboard, enabled: true },
  { key: 'alerts', label: 'Alerts / Incidents', title: 'Alerts / Incidents', path: '/alerts', icon: IconAlert, enabled: true },
  { key: 'logs', label: 'Logs', title: 'Logs', path: '/logs', icon: IconLogs, enabled: true },
  { key: 'metrics', label: 'Metrics', title: 'Metrics', path: '/metrics', icon: IconMetrics, enabled: true },
  { key: 'ai', label: 'AI Insights', title: 'AI Insights', path: '/ai', icon: IconAI, enabled: true },
  { key: 'assistant', label: 'Urbani Copilot', title: 'Urbani Copilot', path: '/assistant', icon: IconAssistant, enabled: true },
  { key: 'services', label: 'Services', title: 'Services / Applications', path: '/services', icon: IconServices, enabled: true },
  { key: 'usage', label: 'Usage & Cost', title: 'Usage & Cost', path: '/usage', icon: IconCost, enabled: true },
  { key: 'audit', label: 'Audit / Activity', title: 'Audit / Activity', path: '/audit', icon: IconAudit, enabled: true },
  { key: 'settings', label: 'Settings', title: 'Settings', path: '/settings', icon: IconSettings, enabled: true },
];
