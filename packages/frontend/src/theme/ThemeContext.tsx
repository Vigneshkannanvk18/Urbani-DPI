import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ThemePreference } from '@urbani/shared';
import { preferencesApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';

/**
 * Theme state (DPI 2 item 10).
 *
 * mode     = what the user chose: 'system' | 'light' | 'dark' (default 'system').
 * resolved = what is actually applied: 'light' | 'dark' (system follows prefers-color-scheme live).
 *
 * The first paint is handled by the inline script in index.html (same storage key, same logic), so there is no
 * flash. After that this provider keeps <html data-theme> in sync, stores the choice in localStorage and, for a
 * signed-in user, saves it with PUT /api/preferences. On login the server value wins when the user has saved
 * preferences before; otherwise the local choice is pushed to the server.
 */
export const THEME_STORAGE_KEY = 'urbani.theme';
export const THEME_MODES: ThemePreference[] = ['system', 'light', 'dark'];

type Resolved = 'light' | 'dark';

function readStoredMode(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}
const systemPrefersDark = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
const resolveMode = (mode: ThemePreference): Resolved => (mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode);

function applyToDocument(mode: ThemePreference, resolved: Resolved): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', mode);
}

interface ThemeState {
  mode: ThemePreference;
  resolved: Resolved;
  setMode: (mode: ThemePreference) => void;
}
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [mode, setModeState] = useState<ThemePreference>(readStoredMode);
  const [resolved, setResolved] = useState<Resolved>(() => resolveMode(readStoredMode()));
  const syncedFor = useRef<string | null>(null);

  const applyLocal = useCallback((next: ThemePreference) => {
    const r = resolveMode(next);
    setModeState(next);
    setResolved(r);
    applyToDocument(next, r);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode: the choice just is not remembered locally */
    }
  }, []);

  // Follow the OS setting while mode is 'system'.
  useEffect(() => {
    applyToDocument(mode, resolved);
    if (mode !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const r = resolveMode('system');
      setResolved(r);
      applyToDocument('system', r);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode, resolved]);

  // Sync with the per-user preference once per signed-in user.
  useEffect(() => {
    if (!user) {
      syncedFor.current = null;
      return;
    }
    if (syncedFor.current === user.id) return;
    syncedFor.current = user.id;
    let cancelled = false;
    preferencesApi
      .get()
      .then((prefs) => {
        if (cancelled) return;
        if (prefs.updatedAt) applyLocal(prefs.theme);
        else if (readStoredMode() !== 'system') void preferencesApi.update({ theme: readStoredMode() }).catch(() => undefined);
      })
      .catch(() => undefined); // offline / API error: keep the local choice
    return () => {
      cancelled = true;
    };
  }, [user, applyLocal]);

  const setMode = useCallback(
    (next: ThemePreference) => {
      applyLocal(next);
      if (user) void preferencesApi.update({ theme: next }).catch(() => undefined);
    },
    [applyLocal, user],
  );

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
