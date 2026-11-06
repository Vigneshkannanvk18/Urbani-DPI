import { USER_ROLES, type UserRole } from './domain';

/**
 * RBAC vocabulary shared by backend and frontend (DPI 2 item 2).
 *
 * *** DRAFT *** The role -> permission matrix below is a proposal pending Urbani sign-off
 * (client input #11). Change ROLE_PERMISSIONS here and nowhere else; the API and UI both read it.
 */

export const PERMISSIONS = [
  'dashboard:view',
  'alerts:view',
  'alerts:acknowledge',
  'alerts:rules', // placeholder: alert rules (item 6)
  'logs:view',
  'logs:export', // placeholder: export (item 11)
  'metrics:view',
  'services:view',
  'ai:view',
  'ai:analyze',
  'chat:use',
  'usage:view',
  'audit:view',
  'settings:view',
  'settings:update',
  'users:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Role list for UI pickers (same values as USER_ROLES; exported here so bundlers resolve it). */
export const ROLES: readonly UserRole[] = USER_ROLES;

export const ROLE_DISPLAY_NAMES: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  INFRA_ADMIN: 'Infrastructure Administrator',
  QA_OPERATOR: 'QA Operator',
  READER_AUDITOR: 'Reader / Auditor',
};

const VIEW_ALL: Permission[] = [
  'dashboard:view',
  'alerts:view',
  'logs:view',
  'metrics:view',
  'services:view',
  'ai:view',
  'usage:view',
  'settings:view',
];

/** DRAFT matrix, pending Urbani sign-off (client input #11). */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  SUPER_ADMIN: [...PERMISSIONS],
  INFRA_ADMIN: PERMISSIONS.filter((p) => p !== 'users:manage'),
  QA_OPERATOR: [...VIEW_ALL, 'alerts:acknowledge', 'ai:analyze', 'chat:use', 'logs:export'],
  // Read-only. chat:use is allowed as read-only advisory (judgment call, DRAFT).
  READER_AUDITOR: [...VIEW_ALL, 'audit:view', 'chat:use', 'logs:export'],
};

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export function permissionsForRole(role: string | null | undefined): Permission[] {
  return isUserRole(role) ? [...ROLE_PERMISSIONS[role]] : [];
}

export function roleHasPermission(role: string | null | undefined, permission: Permission): boolean {
  return isUserRole(role) && ROLE_PERMISSIONS[role].includes(permission);
}
