import { describe, it, expect, afterEach } from 'vitest';
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
});
