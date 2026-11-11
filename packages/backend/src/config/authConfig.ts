import { createHash } from 'node:crypto';
import { USER_ROLES, type UserRole } from '@urbani/shared';

/**
 * MFA / SSO settings (DPI 2 item 5). Read from process.env on every call (cheap), so tests and
 * operators can change them without re-importing the config module. No secret is logged or returned
 * by anything that serialises these objects to a client: use publicAuthConfig() for that.
 */

const bool = (v: string | undefined, def: boolean): boolean =>
  v === undefined || v.trim() === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
const str = (v: string | undefined): string | undefined => (v && v.trim() !== '' ? v.trim() : undefined);

export interface MfaSettings {
  /** RBAC roles that MUST have MFA. Empty = MFA optional for everyone (placeholder default, pending client decision). */
  requiredRoles: UserRole[];
  issuer: string;
}

export function mfaSettings(env: NodeJS.ProcessEnv = process.env): MfaSettings {
  const requiredRoles = (env.MFA_REQUIRED_ROLES ?? '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  const bad = requiredRoles.filter((r) => !(USER_ROLES as readonly string[]).includes(r));
  if (bad.length) throw new Error(`MFA_REQUIRED_ROLES contains unknown roles: ${bad.join(', ')}`);
  return { requiredRoles: requiredRoles as UserRole[], issuer: 'Urbani Radar' };
}

/** 32-byte AES key. Production requires MFA_ENCRYPTION_KEY; dev/test use a clearly-labelled derived key. */
export function mfaEncryptionKey(env: NodeJS.ProcessEnv = process.env): { key: Buffer; isDevKey: boolean } {
  const raw = str(env.MFA_ENCRYPTION_KEY);
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    return { key, isDevKey: false };
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('MFA_ENCRYPTION_KEY is required in production to enrol MFA (32 bytes, base64).');
  }
  // DEV/TEST ONLY key: derived from a fixed label. Never use outside development.
  return { key: createHash('sha256').update('urbani-DEV-ONLY-mfa-encryption-key-not-for-production').digest(), isDevKey: true };
}

export interface SsoSettings {
  provider: 'local' | 'oidc';
  localEnabled: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes: string;
  groupsClaim: string;
  groupRoleMap: Record<string, UserRole>;
  /** E-mail (lower case) -> role, for providers without a groups claim (Google). Checked before the group map. */
  emailRoleMap: Record<string, UserRole>;
  /** Allowed e-mail domains (lower case, no @). Empty = any verified e-mail passes the domain check. */
  allowedEmailDomains: string[];
  autoProvision: boolean;
  /** Where the browser lands after SSO; defaults to the SPA root (same origin). */
  postLoginUrl: string;
}

export function ssoSettings(env: NodeJS.ProcessEnv = process.env): SsoSettings {
  const provider = (str(env.AUTH_PROVIDER) ?? 'local').toLowerCase();
  if (provider !== 'local' && provider !== 'oidc') throw new Error('AUTH_PROVIDER must be local or oidc');
  let groupRoleMap: Record<string, UserRole> = {};
  const rawMap = str(env.OIDC_GROUP_ROLE_MAP);
  if (rawMap) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMap);
    } catch {
      throw new Error('OIDC_GROUP_ROLE_MAP must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OIDC_GROUP_ROLE_MAP must be a JSON object');
    for (const [g, r] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof r !== 'string' || !(USER_ROLES as readonly string[]).includes(r)) {
        throw new Error(`OIDC_GROUP_ROLE_MAP: "${g}" maps to an unknown role`);
      }
      groupRoleMap[g] = r as UserRole;
    }
  }
  const emailRoleMap: Record<string, UserRole> = {};
  const rawEmailMap = str(env.OIDC_EMAIL_ROLE_MAP);
  if (rawEmailMap) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawEmailMap);
    } catch {
      throw new Error('OIDC_EMAIL_ROLE_MAP must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OIDC_EMAIL_ROLE_MAP must be a JSON object');
    for (const [e, r] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof r !== 'string' || !(USER_ROLES as readonly string[]).includes(r)) {
        throw new Error(`OIDC_EMAIL_ROLE_MAP: "${e}" maps to an unknown role`);
      }
      emailRoleMap[e.trim().toLowerCase()] = r as UserRole;
    }
  }
  return {
    provider,
    localEnabled: bool(env.AUTH_LOCAL_ENABLED, true),
    issuer: str(env.OIDC_ISSUER)?.replace(/\/+$/, ''),
    clientId: str(env.OIDC_CLIENT_ID),
    clientSecret: str(env.OIDC_CLIENT_SECRET),
    redirectUri: str(env.OIDC_REDIRECT_URI),
    scopes: str(env.OIDC_SCOPES) ?? 'openid email profile',
    groupsClaim: str(env.OIDC_GROUPS_CLAIM) ?? 'cognito:groups',
    groupRoleMap,
    emailRoleMap,
    allowedEmailDomains: (str(env.OIDC_ALLOWED_EMAIL_DOMAIN) ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    autoProvision: bool(env.OIDC_AUTO_PROVISION, true),
    postLoginUrl: str(env.OIDC_POST_LOGIN_URL) ?? '/',
  };
}

/** SSO is usable only when the provider is oidc AND the mandatory settings are present. */
export function ssoEnabled(s: SsoSettings = ssoSettings()): boolean {
  return s.provider === 'oidc' && Boolean(s.issuer && s.clientId && s.redirectUri);
}
