import http from 'node:http';
import https from 'node:https';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getRepositories, resetRepositories, setRepositoriesForTesting, type AuditRepository } from './index';

describe('repository registry', () => {
  afterEach(() => resetRepositories());

  it('defaults to the sqlite driver', () => {
    expect(getRepositories().driver).toBe('sqlite');
  });

  it('setRepositoriesForTesting overrides single repositories', () => {
    const before = getRepositories();
    const fake: AuditRepository = {
      record: async () => undefined,
      query: async () => ({ items: [], total: 0 }),
      listByTimeRange: async () => ({ items: [], nextCursor: null }),
    };
    setRepositoriesForTesting({ audit: fake });
    const repos = getRepositories();
    expect(repos.audit).toBe(fake);
    expect(repos.alerts).toBe(before.alerts);
    expect(repos.driver).toBe('sqlite');
  });

  it('resetRepositories builds a fresh instance', () => {
    const fake: AuditRepository = {
      record: async () => undefined,
      query: async () => ({ items: [], total: 0 }),
      listByTimeRange: async () => ({ items: [], nextCursor: null }),
    };
    setRepositoriesForTesting({ audit: fake });
    const overridden = getRepositories();
    resetRepositories();
    const fresh = getRepositories();
    expect(fresh).not.toBe(overridden);
    expect(fresh.audit).not.toBe(fake);
    expect(fresh.driver).toBe('sqlite');
  });

  it('selects the dynamodb driver without a network call (fresh-config dynamic import)', async () => {
    const snapshot = { ...process.env };
    const httpRequest = vi.spyOn(http, 'request');
    const httpsRequest = vi.spyOn(https, 'request');
    try {
      // config is built once at import, so set the env and re-import a fresh module graph.
      process.env.DB_DRIVER = 'dynamodb';
      process.env.DYNAMODB_ENDPOINT = 'http://127.0.0.1:9';
      vi.resetModules();
      const mod = await import('./index');
      const repos = mod.getRepositories();
      expect(repos.driver).toBe('dynamodb');
      expect(httpRequest).not.toHaveBeenCalled();
      expect(httpsRequest).not.toHaveBeenCalled();
      await repos.close();
    } finally {
      httpRequest.mockRestore();
      httpsRequest.mockRestore();
      process.env = snapshot;
      vi.resetModules();
    }
  });
});
