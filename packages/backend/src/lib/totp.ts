import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mfaEncryptionKey } from '../config/authConfig';

/**
 * TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s step), HOTP (RFC 4226), base32 (RFC 4648), AES-256-GCM
 * envelope for the stored secret, and one-time recovery codes. Node crypto only; no dependency.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP over a raw key. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/** RFC 6238 TOTP at a given time (ms) for a raw key. */
export function totpAt(key: Buffer, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(key, timeStep(nowMs), digits);
}

/** Code for a base32 secret at `nowMs` (used by tests and the smoke script). */
export function totpNow(secretB32: string, nowMs = Date.now()): string {
  return totpAt(base32Decode(secretB32), nowMs);
}

const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Returns the matching time-step within +-window steps, or null. Constant-time compare per candidate. */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const cur = timeStep(nowMs);
  let match: number | null = null;
  for (let s = cur - window; s <= cur + window; s++) {
    if (s >= 0 && safeEq(hotp(key, s), code) && match === null) match = s;
  }
  return match;
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ---- secret encryption at rest: "v1:<iv>:<tag>:<ciphertext>" (base64), AES-256-GCM ----
export function encryptSecret(plain: string, key = mfaEncryptionKey().key): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(envelope: string, key = mfaEncryptionKey().key): string {
  const [v, iv, tag, ct] = envelope.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret envelope');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---- recovery codes: 10 random codes "XXXXX-XXXXX" (50 bits each); only SHA-256 hashes are stored ----
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () => {
    const raw = randomBytes(10);
    let s = '';
    for (const b of raw) s += B32[b & 31];
    return `${s.slice(0, 5)}-${s.slice(5, 10)}`;
  });
}

export const normalizeRecoveryCode = (c: string): string => c.toUpperCase().replace(/[^A-Z2-7]/g, '');
export const hashRecoveryCode = (c: string): string => createHash('sha256').update(normalizeRecoveryCode(c)).digest('hex');
