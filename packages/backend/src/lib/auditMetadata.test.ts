import { describe, it, expect } from 'vitest';
import { REDACTED, buildAuditMetadata, preview, redact } from './auditMetadata';

describe('audit redaction', () => {
  it('redacts secret-looking keys at any depth, case-insensitively', () => {
    const out = redact({
      password: 'hunter2',
      Token: 't',
      Authorization: 'Bearer x',
      apiKey: 'k',
      'x-api-key': 'k2',
      client_secret: 's',
      nested: { newPassword: 'p', list: [{ refreshToken: 'r', ok: 1 }] },
      keep: 'visible',
    });
    expect(out).toEqual({
      password: REDACTED,
      Token: REDACTED,
      Authorization: REDACTED,
      apiKey: REDACTED,
      'x-api-key': REDACTED,
      client_secret: REDACTED,
      nested: { newPassword: REDACTED, list: [{ refreshToken: REDACTED, ok: 1 }] },
      keep: 'visible',
    });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|Bearer x/);
  });

  it('does not mutate the input and returns null metadata when nothing is given', () => {
    const input = { password: 'a' };
    redact(input);
    expect(input.password).toBe('a');
    expect(buildAuditMetadata()).toBeNull();
    expect(buildAuditMetadata({ a: 1 })).toEqual({ a: 1 });
  });

  it('truncates question previews', () => {
    expect(preview('  hello   world ')).toBe('hello world');
    expect(preview('x'.repeat(200))).toHaveLength(81);
  });
});
