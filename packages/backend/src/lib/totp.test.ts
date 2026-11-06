import { describe, it, expect } from 'vitest';
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, generateRecoveryCodes, hashRecoveryCode, hotp,
  normalizeRecoveryCode, otpauthUri, totpAt, verifyTotp,
} from './totp';
import { mfaEncryptionKey } from '../config/authConfig';
import { redact } from './auditMetadata';

// RFC 6238 Appendix B (SHA-1, 8 digits, secret "12345678901234567890")
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 vector at T=%i', (t, expected) => {
    expect(totpAt(RFC_KEY, t * 1000, 8)).toBe(expected);
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((e, i) => expect(hotp(RFC_KEY, i)).toBe(e));
  });

  it('accepts +-1 step and rejects +-2 steps; returns the matched step', () => {
    const secret = base32Encode(RFC_KEY);
    const t = 1_700_000_000_000;
    const step = Math.floor(t / 30000);
    expect(verifyTotp(secret, totpAt(RFC_KEY, t), t)).toBe(step);
    expect(verifyTotp(secret, totpAt(RFC_KEY, t - 30000), t)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(RFC_KEY, t + 30000), t)).toBe(step + 1);
    const far = totpAt(RFC_KEY, t + 90000);
    const near = [-1, 0, 1].map((d) => totpAt(RFC_KEY, t + d * 30000));
    if (!near.includes(far)) expect(verifyTotp(secret, far, t)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', t)).toBeNull();
  });

  it('base32 round-trips', () => {
    expect(base32Encode(RFC_KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(RFC_KEY)).toBe(true);
  });

  it('builds an otpauth URI with issuer Urbani Radar and the email as account', () => {
    const uri = otpauthUri('ABC234', 'a.b@urbani.test', 'Urbani Radar');
    expect(uri.startsWith('otpauth://totp/Urbani%20Radar:a.b%40urbani.test?')).toBe(true);
    expect(uri).toContain('secret=ABC234');
    expect(uri).toContain('issuer=Urbani+Radar');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('secret encryption and recovery codes', () => {
  it('AES-256-GCM round trip; envelope never contains the plaintext; tampering fails', () => {
    const env = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(env.startsWith('v1:')).toBe(true);
    expect(env).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(env)).toBe('JBSWY3DPEHPK3PXP');
    expect(encryptSecret('JBSWY3DPEHPK3PXP')).not.toBe(env); // random IV
    const parts = env.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('uses MFA_ENCRYPTION_KEY when set, validates length, and refuses to run without it in production', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(mfaEncryptionKey({ MFA_ENCRYPTION_KEY: key } as never).isDevKey).toBe(false);
    expect(() => mfaEncryptionKey({ MFA_ENCRYPTION_KEY: 'c2hvcnQ=' } as never)).toThrow(/32 bytes/);
    expect(() => mfaEncryptionKey({ NODE_ENV: 'production' } as never)).toThrow(/required in production/);
    expect(mfaEncryptionKey({ NODE_ENV: 'development' } as never).isDevKey).toBe(true);
  });

  it('generates 10 distinct recovery codes; only normalised hashes are comparable', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(hashRecoveryCode(codes[0].toLowerCase())).toBe(hashRecoveryCode(codes[0]));
    expect(hashRecoveryCode(codes[0])).not.toContain(normalizeRecoveryCode(codes[0]));
  });

  it('redaction masks MFA secret-like keys', () => {
    const out = redact({ totpSecret: 'x', recoveryCodes: ['a'], mfaToken: 't', code_verifier: 'v', ok: 1 });
    expect(out).toEqual({ totpSecret: '[REDACTED]', recoveryCodes: '[REDACTED]', mfaToken: '[REDACTED]', code_verifier: '[REDACTED]', ok: 1 });
  });
});
