import { useCallback, useEffect, useRef, useState } from 'react';
import { DASHBOARD_WIDGETS, defaultLayout, normalizeLayout, type DashboardLayout } from '@urbani/shared/dashboardLayout';
import { preferencesApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';

/**
 * Per-user dashboard layout (DPI 2 item 12). localStorage (keyed per user) paints instantly; the server value wins
 * as soon as it arrives. Saving is optimistic: the new layout shows at once and is rolled back if the PUT fails.
 */
const cacheKey = (userId: string) => `urbani.dashboardLayout.${userId}`;

function readCache(userId: string, permissions: string[]): DashboardLayout | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    return raw ? normalizeLayout(JSON.parse(raw), DASHBOARD_WIDGETS, permissions) : null;
  } catch {
    return null;
  }
}

export function useDashboardLayout() {
  const { user } = useAuth();
  const perms = user?.permissions ?? [];
  const userId = user?.id ?? '';
  const permKey = perms.join(',');
  const [layout, setLayout] = useState<DashboardLayout>(() => (userId && readCache(userId, perms)) || defaultLayout(perms));
  const [isCustom, setIsCustom] = useState<boolean>(() => !!(userId && readCache(userId, perms)));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const apply = useCallback(
    (next: DashboardLayout, custom: boolean) => {
      setLayout(next);
      setIsCustom(custom);
      try {
        if (!userId) return;
        if (custom) localStorage.setItem(cacheKey(userId), JSON.stringify(next));
        else localStorage.removeItem(cacheKey(userId));
      } catch {
        /* private mode: no local cache */
      }
    },
    [userId],
  );

  // Server value wins on load / user change.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    preferencesApi
      .get()
      .then((p) => {
        if (cancelled) return;
        if (p.widgetLayout) apply(normalizeLayout(p.widgetLayout, DASHBOARD_WIDGETS, perms), true);
        else apply(defaultLayout(perms), false);
      })
      .catch(() => undefined); // keep the cached / default layout when offline
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, permKey]);

  /** Optimistic save. Resolves true on success; on failure the previous layout is restored. */
  const save = useCallback(
    async (next: DashboardLayout): Promise<boolean> => {
      const prev = layoutRef.current;
      const prevCustom = isCustom;
      apply(next, true);
      try {
        await preferencesApi.update({ widgetLayout: next as unknown as Record<string, unknown> });
        return true;
      } catch {
        apply(prev, prevCustom);
        return false;
      }
    },
    [apply, isCustom],
  );

  const reset = useCallback(async (): Promise<boolean> => {
    const prev = layoutRef.current;
    const prevCustom = isCustom;
    apply(defaultLayout(perms), false);
    try {
      await preferencesApi.update({ widgetLayout: null });
      return true;
    } catch {
      apply(prev, prevCustom);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, isCustom, permKey]);

  return { layout, isCustom, save, reset, defaults: defaultLayout(perms) };
}
