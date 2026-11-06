import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { USER_ROLES, type UserRole } from '@urbani/shared';
import { config } from '../config';
import { ssoEnabled, ssoSettings, type SsoSettings } from '../config/authConfig';
import { setAuditActor } from '../lib/auditMetadata';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { getRepositories, type UserRow } from '../repositories';
import { authService, type LoginResult } from './authService';
import { ensureLegacyRole, legacyRoleId } from './userService';

/**
 * OIDC single sign-on (DPI 2 item 5): Authorization Code + PKCE, built on Node crypto + fetch (no OIDC
 * library). The ID token is validated here: signature via the provider's JWKS (RS256), issuer, audience,
 * nonce and expiry. Built and unit-tested against a local FAKE provider only; NOT exercised against real
 * Cognito or Google. The IdP is responsible for enforcing MFA for SSO users.
 */

export const SSO_COOKIE = 'urbani_sso';
const COOKIE_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
export const SSO_PASSWORD_MARKER = '!sso-no-local-password';

/** Error that the callback route renders as a 4xx/5xx page or JSON (and audits as sso.denied). */
export class SsoError extends AppError {
  constructor(code: string, message: string, status = 403) {
    super(code, message, status);
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
interface Jwk { kid?: string; kty: string; n?: string; e?: string; [k: string]: unknown }

const b64url = (b: Buffer): string => b.toString('base64url');
const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();
const CACHE_MS = 3_600_000;

/** Test hook: forget cached discovery documents and keys. */
export function resetSsoCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

function requireConfigured(s: SsoSettings): Required<Pick<SsoSettings, 'issuer' | 'clientId' | 'redirectUri'>> & SsoSettings {
  if (!ssoEnabled(s)) throw new SsoError('SSO_NOT_CONFIGURED', 'Single sign-on is not configured', 404);
  if (process.env.NODE_ENV === 'production' && !s.issuer!.startsWith('https://')) {
    throw new SsoError('SSO_NOT_CONFIGURED', 'OIDC_ISSUER must be https in production', 500);
  }
  return s as Required<Pick<SsoSettings, 'issuer' | 'clientId' | 'redirectUri'>> & SsoSettings;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new SsoError('SSO_PROVIDER_ERROR', 'Identity provider request failed', 502);
  return (await res.json()) as T;
}

async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const doc = await getJson<Discovery>(`${issuer}/.well-known/openid-configuration`);
  if (doc.issuer?.replace(/\/+$/, '') !== issuer) throw new SsoError('SSO_PROVIDER_ERROR', 'Issuer mismatch in discovery document', 502);
  discoveryCache.set(issuer, { at: Date.now(), value: doc });
  return doc;
}

async function jwkFor(jwksUri: string, kid: string | undefined): Promise<Jwk> {
  const find = (keys: Jwk[]) => keys.find((k) => k.kty === 'RSA' && (kid === undefined || k.kid === kid));
  const hit = jwksCache.get(jwksUri);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    const k = find(hit.keys);
    if (k) return k;
  }
  const { keys } = await getJson<{ keys: Jwk[] }>(jwksUri); // refetch once on unknown kid (key rotation)
  jwksCache.set(jwksUri, { at: Date.now(), keys });
  const k = find(keys);
  if (!k) throw new SsoError('SSO_INVALID_TOKEN', 'ID token signing key not found', 401);
  return k;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface IdTokenClaims {
  iss: string; aud: string | string[]; exp: number; nonce?: string; email?: string;
  email_verified?: boolean | string; name?: string; azp?: string; [k: string]: unknown;
}

/** Validates signature (RS256 via JWKS), issuer, audience, expiry and nonce. Throws SsoError otherwise. */
export async function validateIdToken(idToken: string, s: ReturnType<typeof requireConfigured>, expectedNonce: string, disc: Discovery): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new SsoError('SSO_INVALID_TOKEN', 'Malformed ID token', 401);
  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new SsoError('SSO_INVALID_TOKEN', 'Malformed ID token', 401);
  }
  if (header.alg !== 'RS256') throw new SsoError('SSO_INVALID_TOKEN', 'Unsupported ID token algorithm', 401);
  const jwk = await jwkFor(disc.jwks_uri, header.kid);
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  const okSig = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!okSig) throw new SsoError('SSO_INVALID_TOKEN', 'ID token signature is invalid', 401);
  if (claims.iss?.replace(/\/+$/, '') !== s.issuer) throw new SsoError('SSO_INVALID_TOKEN', 'ID token issuer mismatch', 401);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(s.clientId)) throw new SsoError('SSO_INVALID_TOKEN', 'ID token audience mismatch', 401);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < Math.floor(Date.now() / 1000)) {
    throw new SsoError('SSO_INVALID_TOKEN', 'ID token has expired', 401);
  }
  if (!claims.nonce || claims.nonce !== expectedNonce) throw new SsoError('SSO_INVALID_TOKEN', 'ID token nonce mismatch', 401);
  return claims;
}

/** Highest-privilege role among the user's mapped groups (USER_ROLES is ordered most to least privileged). */
export function mapGroupsToRole(groups: string[], map: Record<string, UserRole>): UserRole | null {
  const roles = groups.map((g) => map[g]).filter((r): r is UserRole => Boolean(r));
  return USER_ROLES.find((r) => roles.includes(r)) ?? null;
}

function groupsFrom(claims: IdTokenClaims, claim: string): string[] {
  const v = claims[claim];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean);
  return [];
}

async function audit(actor: string, action: 'sso.denied' | 'auth.sso_login' | 'user.provisioned', target: string | undefined, meta: Record<string, unknown>, result: 'SUCCESS' | 'DENIED' | 'FAILURE' = 'SUCCESS'): Promise<void> {
  try {
    await getRepositories().audit.record(actor, action, target, meta, result);
  } catch (err) {
    logger.warn('SSO audit failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export const ssoService = {
  publicConfig() {
    const s = ssoSettings();
    const enabled = ssoEnabled(s);
    return {
      provider: s.provider,
      ssoEnabled: enabled,
      localEnabled: s.localEnabled || !enabled, // never lock everyone out when SSO is not usable
      ssoLoginUrl: enabled ? '/api/auth/sso/login' : null,
    };
  },

  /** Builds the provider redirect and the signed, short-lived state cookie value. */
  async begin(): Promise<{ redirectUrl: string; cookie: string; maxAge: number }> {
    const s = requireConfigured(ssoSettings());
    const disc = await discover(s.issuer);
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const url = new URL(disc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: s.clientId, redirect_uri: s.redirectUri, scope: s.scopes,
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    const cookie = jwt.sign({ state, nonce, cv: verifier, p: 'sso' }, config.auth.jwtSecret, { expiresIn: COOKIE_TTL_SECONDS });
    return { redirectUrl: url.toString(), cookie, maxAge: COOKIE_TTL_SECONDS };
  },

  /** Completes the login. Throws SsoError for every denial; the route audits and renders it. */
  async complete(query: { code?: string; state?: string; error?: string }, cookieHeader: string | undefined): Promise<LoginResult> {
    const s = requireConfigured(ssoSettings());
    if (query.error) throw new SsoError('SSO_PROVIDER_DENIED', 'The identity provider refused the sign-in', 403);
    let saved: { state: string; nonce: string; cv: string; p: string };
    try {
      saved = jwt.verify(parseCookies(cookieHeader)[SSO_COOKIE] ?? '', config.auth.jwtSecret) as typeof saved;
    } catch {
      throw new SsoError('SSO_STATE_INVALID', 'Sign-in session expired or missing. Please try again.', 400);
    }
    if (saved.p !== 'sso' || !query.state || query.state !== saved.state) {
      throw new SsoError('SSO_STATE_INVALID', 'Sign-in state does not match. Please try again.', 400);
    }
    if (!query.code) throw new SsoError('SSO_STATE_INVALID', 'Missing authorization code', 400);

    const disc = await discover(s.issuer);
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: query.code, redirect_uri: s.redirectUri, client_id: s.clientId, code_verifier: saved.cv,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (s.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.clientSecret)}`).toString('base64')}`;
    const res = await fetch(disc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new SsoError('SSO_TOKEN_EXCHANGE_FAILED', 'Could not exchange the authorization code', 502);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new SsoError('SSO_TOKEN_EXCHANGE_FAILED', 'Identity provider returned no ID token', 502);

    const claims = await validateIdToken(tokens.id_token, s, saved.nonce, disc);
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email) throw new SsoError('SSO_EMAIL_REQUIRED', 'The identity provider did not return an email address', 403);
    if (!(claims.email_verified === true || claims.email_verified === 'true')) {
      throw new SsoError('SSO_EMAIL_UNVERIFIED', 'Your email address is not verified with the identity provider', 403);
    }
    if (s.allowedEmailDomain && email.split('@')[1] !== s.allowedEmailDomain) {
      throw new SsoError('SSO_DOMAIN_NOT_ALLOWED', 'Your email domain is not allowed to sign in', 403);
    }
    const role = mapGroupsToRole(groupsFrom(claims, s.groupsClaim), s.groupRoleMap);
    if (!role) throw new SsoError('SSO_NO_ROLE', 'Your account is not in any group mapped to a role. Ask an administrator for access.', 403);

    const repos = getRepositories();
    const existing = (await repos.users.list()).find((u) => u.email.toLowerCase() === email);
    let user: UserRow;
    if (existing) {
      // A deactivated local record blocks SSO.
      if (existing.is_active !== 1) throw new SsoError('SSO_USER_INACTIVE', 'This account has been deactivated', 403);
      const roleId = legacyRoleId(role);
      await ensureLegacyRole(roleId);
      user = { ...existing, role, role_id: roleId };
      if (existing.role !== role) {
        await repos.users.upsertUser(user);
        await repos.audit.record(email, 'user.role_change', existing.id, { email, from: existing.role, to: role, source: 'sso' });
      }
      await repos.users.updateSecurity(existing.id, { authSource: 'sso' });
    } else {
      if (!s.autoProvision) throw new SsoError('SSO_NOT_PROVISIONED', 'No account exists for you and automatic provisioning is off', 403);
      const roleId = legacyRoleId(role);
      await ensureLegacyRole(roleId);
      user = {
        id: randomUUID(), email, display_name: (typeof claims.name === 'string' && claims.name.trim()) || email,
        password_hash: SSO_PASSWORD_MARKER, role_id: roleId, is_active: 1, last_login_at: null,
        created_at: new Date().toISOString(), role,
      };
      await repos.users.upsertUser(user);
      await repos.users.updateSecurity(user.id, { authSource: 'sso' });
      await audit(email, 'user.provisioned', user.id, { email, role, source: 'sso' });
    }
    setAuditActor({ userId: user.id, email, role: user.role });
    const session = await authService.issueSession(user, { sso: true });
    await audit(email, 'auth.sso_login', user.id, { role });
    return session;
  },

  /** Audit for a denial (called by the route; actor is unknown at that point). */
  async auditDenied(err: SsoError): Promise<void> {
    await audit('anonymous', 'sso.denied', undefined, { code: err.code, reason: err.message }, 'DENIED');
  },
};
