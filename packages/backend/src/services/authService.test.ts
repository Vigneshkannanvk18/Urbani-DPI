import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { freshTestDb } from '../test/testDb';
import { userRepository } from '../repositories/userRepository';
import { authService } from './authService';
import { UnauthorizedError } from '../lib/errors';

describe('authService', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = freshTestDb();
    const now = new Date().toISOString();
    userRepository.upsertRole({
      id: 'role-admin',
      name: 'ADMIN',
      description: null,
      permissions: JSON.stringify(['*']),
      created_at: now,
    });
    userRepository.upsertUser({
      id: randomUUID(),
      email: 'admin@urbani.local',
      display_name: 'Admin',
      password_hash: await bcrypt.hash('Secret123!', 10),
      role_id: 'role-admin',
      is_active: 1,
      last_login_at: null,
      created_at: now,
    });
  });

  afterEach(() => db.close());

  it('logs in with valid credentials and issues a verifiable token', async () => {
    const result = await authService.login('admin@urbani.local', 'Secret123!');
    expect(result.user.role).toBe('ADMIN');
    expect(result.token).toBeTruthy();
    const payload = authService.verify(result.token);
    expect(payload.email).toBe('admin@urbani.local');
  });

  it('rejects an invalid password', async () => {
    await expect(authService.login('admin@urbani.local', 'wrong')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rejects an unknown user', async () => {
    await expect(authService.login('nobody@urbani.local', 'x')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rejects a tampered token', () => {
    expect(() => authService.verify('not.a.valid.token')).toThrow(UnauthorizedError);
  });
});
