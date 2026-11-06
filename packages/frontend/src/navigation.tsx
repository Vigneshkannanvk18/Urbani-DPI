import type { ComponentType } from 'react';
import type { Permission } from '@urbani/shared';
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
  IconBell,
  IconSettings,
  IconUsers,
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
  /** Permission required to see this page (DPI 2 RBAC). */
  permission: Permission;
}

export const NAV_SECTIONS: NavSection[] = [
  { key: 'dashboard', label: 'Dashboard', title: 'Dashboard', path: '/', icon: IconDashboard, enabled: true, permission: 'dashboard:view' },
  { key: 'alerts', label: 'Alerts / Incidents', title: 'Alerts / Incidents', path: '/alerts', icon: IconAlert, enabled: true, permission: 'alerts:view' },
  { key: 'logs', label: 'Logs', title: 'Logs', path: '/logs', icon: IconLogs, enabled: true, permission: 'logs:view' },
  { key: 'metrics', label: 'Metrics', title: 'Metrics', path: '/metrics', icon: IconMetrics, enabled: true, permission: 'metrics:view' },
  { key: 'ai', label: 'AI Insights', title: 'AI Insights', path: '/ai', icon: IconAI, enabled: true, permission: 'ai:view' },
  { key: 'assistant', label: 'Urbani Copilot', title: 'Urbani Copilot', path: '/assistant', icon: IconAssistant, enabled: true, permission: 'chat:use' },
  { key: 'services', label: 'Services', title: 'Services / Applications', path: '/services', icon: IconServices, enabled: true, permission: 'services:view' },
  { key: 'notifications', label: 'Notifications', title: 'Notifications', path: '/notifications', icon: IconBell, enabled: true, permission: 'alerts:view' },
  { key: 'usage', label: 'Usage & Cost', title: 'Usage & Cost', path: '/usage', icon: IconCost, enabled: true, permission: 'usage:view' },
  { key: 'audit', label: 'Audit / Activity', title: 'Audit / Activity', path: '/audit', icon: IconAudit, enabled: true, permission: 'audit:view' },
  { key: 'settings', label: 'Settings', title: 'Settings', path: '/settings', icon: IconSettings, enabled: true, permission: 'settings:view' },
  { key: 'users', label: 'Users', title: 'User Management', path: '/users', icon: IconUsers, enabled: true, permission: 'users:manage' },
];
