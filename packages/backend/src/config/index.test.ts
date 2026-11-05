import { describe, it, expect, vi } from 'vitest';

/**
 * DYNAMODB_* configuration (design §6). config is built once at import from process.env, so each
 * case flips the environment and re-imports a fresh module graph (the pattern of
 * integrations/index.test.ts), then restores both.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  const snapshot = { ...process.env };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    const mod = await import('./index');
    return mod.config;
  } finally {
    process.env = snapshot;
    vi.resetModules();
  }
}

describe('config: DynamoDB settings', () => {
  it('treats an empty DYNAMODB_ENDPOINT as unset', async () => {
    const config = await loadConfig({ DYNAMODB_ENDPOINT: '' });
    expect(config.db.dynamodb.endpoint).toBeNull();
  });

  it('rejects a non-http DYNAMODB_ENDPOINT', async () => {
    await expect(loadConfig({ DYNAMODB_ENDPOINT: 'ftp://x' })).rejects.toThrow(/DYNAMODB_ENDPOINT/);
  });

  it('rejects a DYNAMODB_ENDPOINT that is not a URL', async () => {
    await expect(loadConfig({ DYNAMODB_ENDPOINT: 'not a url' })).rejects.toThrow(/DYNAMODB_ENDPOINT/);
  });

  it('defaults the table name to UrbaniApp', async () => {
    const config = await loadConfig({ DYNAMODB_TABLE_PREFIX: undefined, DYNAMODB_ENDPOINT: undefined });
    expect(config.db.dynamodb.tableName).toBe('UrbaniApp');
    expect(config.db.dynamodb.endpoint).toBeNull();
  });

  it('rejects a bad DYNAMODB_TABLE_PREFIX', async () => {
    await expect(loadConfig({ DYNAMODB_TABLE_PREFIX: 'bad prefix!' })).rejects.toThrow(/DYNAMODB_TABLE_PREFIX/);
  });
});
