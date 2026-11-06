import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Permission } from '@urbani/shared';
import { authApi, type AuthUser, type LoginOutcome, type MfaCredential } from '../api/endpoints';
import { getToken, setToken } from '../api/client';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** Password step. Resolves with what the UI must do next (session / second factor / forced enrolment). */
  login: (email: string, password: string) => Promise<LoginOutcome>;
  /** Second step of an MFA login. */
  verifyMfa: (mfaToken: string, cred: MfaCredential) => Promise<void>;
  /** Establish a session from a token obtained elsewhere (SSO callback, forced enrolment). */
  acceptSession: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  /** True if the signed-in user's role holds the permission (UI gating only; the API enforces it). */
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session from an existing token on first load.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    authApi
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const outcome = await authApi.login(email, password);
    if (outcome.kind === 'session') setUser(outcome.user);
    return outcome;
  };

  const verifyMfa = async (mfaToken: string, cred: MfaCredential) => {
    setUser(await authApi.verifyMfa(mfaToken, cred));
  };

  const acceptSession = async (token: string) => {
    setToken(token);
    setUser(await authApi.me());
  };

  const logout = async () => {
    await authApi.logout();
    setUser(null);
  };

  const can = (permission: Permission) => !!user && user.permissions.includes(permission);
  return (
    <AuthContext.Provider value={{ user, loading, login, verifyMfa, acceptSession, logout, can }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
