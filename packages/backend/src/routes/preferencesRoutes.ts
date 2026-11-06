import { Router } from 'express';
import { z } from 'zod';
import { THEME_PREFERENCES, type ThemePreference } from '@urbani/shared';
import { asyncHandler } from '../lib/asyncHandler';
import { getRepositories } from '../repositories';
import type { UserPreferences } from '../repositories/types';

/**
 * Per-user preferences (DPI 2 item 10). Any authenticated user, OWN preferences only: there is no user id in the
 * path or body. Known keys only (unknown keys are rejected with 400): `theme` now, `widgetLayout` reserved for
 * the dashboard personalisation (item 12; its shape is validated there, here only a size-bounded JSON object).
 * 'system' is stored as theme = null (follow prefers-color-scheme).
 */
export const preferencesRoutes = Router();

const widgetLayout = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 8192, 'widgetLayout is too large (max 8 KB)');

const putBody = z
  .object({
    theme: z.enum(THEME_PREFERENCES).optional(),
    widgetLayout: widgetLayout.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'At least one preference is required');

function view(prefs: UserPreferences | null) {
  return {
    theme: (prefs?.theme ?? 'system') as ThemePreference,
    widgetLayout: prefs?.widgetLayout ?? null,
    updatedAt: prefs?.updatedAt ?? null,
  };
}

preferencesRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ data: view(await getRepositories().preferences.get(req.auth!.sub)) });
  }),
);

preferencesRoutes.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = putBody.parse(req.body ?? {});
    const patch: { theme?: 'light' | 'dark' | null; widgetLayout?: unknown } = {};
    if (body.theme !== undefined) patch.theme = body.theme === 'system' ? null : body.theme;
    if (body.widgetLayout !== undefined) patch.widgetLayout = body.widgetLayout;
    res.json({ data: view(await getRepositories().preferences.update(req.auth!.sub, patch)) });
  }),
);
