import { useState, type FormEvent } from 'react';
import type { UserRole } from '@urbani/shared';
import { ROLES as USER_ROLES, ROLE_DISPLAY_NAMES } from '@urbani/shared/rbac';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import { usersApi, type ManagedUser } from '../api/endpoints';
import { PageHeader, Card, Button, Input, Select, AsyncView, fmtTime } from '../components/ui';

const MIN_PASSWORD_LENGTH = 10;

/** User management (DPI 2 item 2). Super Admin only; the API enforces users:manage. */
export function Users() {
  const { user: me } = useAuth();
  const users = useApi(() => usersApi.list(), []);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', displayName: '', role: 'READER_AUDITOR' as UserRole, password: '' });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      users.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    }
  };

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await usersApi.create({ ...form, password: form.password || undefined });
      setForm({ email: '', displayName: '', role: 'READER_AUDITOR', password: '' });
    });
  };

  const onReset = (u: ManagedUser) => {
    const password = window.prompt(`New password for ${u.email} (min ${MIN_PASSWORD_LENGTH} characters)`);
    if (password) void run(() => usersApi.resetPassword(u.id, password));
  };

  return (
    <div className="stack">
      <PageHeader
        title="User Management"
        subtitle="Create users, change roles, deactivate accounts. The role-permission matrix is a DRAFT pending Urbani sign-off."
        source="LIVE"
      />
      {error && <div className="form-error" role="alert">{error}</div>}
      <Card title="Add user">
        <form className="user-form" onSubmit={onCreate}>
          <label className="field">
            <span className="field-label">Email</span>
            <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Name</span>
            <Input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Role</span>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}>
              {USER_ROLES.map((r) => <option key={r} value={r}>{ROLE_DISPLAY_NAMES[r]}</option>)}
            </Select>
          </label>
          <label className="field">
            <span className="field-label">Initial password (optional, min {MIN_PASSWORD_LENGTH}; leave empty for Google sign-in only)</span>
            <Input
              type="password"
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <Button type="submit">Create user</Button>
        </form>
      </Card>
      <Card title="Users">
        <AsyncView state={users}>
          {(list) => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>MFA</th><th>Last login</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {list.map((u) => {
                    const self = u.id === me?.id;
                    return (
                      <tr key={u.id}>
                        <td>{u.displayName}</td>
                        <td className="cell-mono">{u.email}</td>
                        <td>
                          <Select
                            aria-label={`Role for ${u.email}`}
                            value={u.role}
                            disabled={self}
                            title={self ? 'You cannot change your own role' : undefined}
                            onChange={(e) => void run(() => usersApi.changeRole(u.id, e.target.value as UserRole))}
                          >
                            {USER_ROLES.map((r) => <option key={r} value={r}>{ROLE_DISPLAY_NAMES[r]}</option>)}
                          </Select>
                        </td>
                        <td>{u.isActive ? 'Active' : 'Deactivated'}</td>
                        <td>{u.authSource === 'sso' ? 'SSO' : u.mfaEnabled ? 'Enabled' : 'Off'}</td>
                        <td>{fmtTime(u.lastLoginAt)}</td>
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => onReset(u)}>Reset password</Button>{' '}
                          {u.mfaEnabled && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  if (window.confirm(`Reset MFA for ${u.email}? They will need to enrol again.`)) void run(() => usersApi.resetMfa(u.id));
                                }}
                              >
                                Reset MFA
                              </Button>{' '}
                            </>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={self && u.isActive}
                            title={self && u.isActive ? 'You cannot deactivate yourself' : undefined}
                            onClick={() => void run(() => usersApi.setActive(u.id, !u.isActive))}
                          >
                            {u.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
