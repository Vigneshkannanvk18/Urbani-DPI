import { describe, it, expect } from 'vitest';
import { DASHBOARD_WIDGETS, defaultLayout, normalizeLayout, ROLE_PERMISSIONS, type WidgetDefinition } from '@urbani/shared';

const ALL_PERMS = [...ROLE_PERMISSIONS.SUPER_ADMIN];
const ids = (l: { widgets: { id: string }[] }) => l.widgets.map((w) => w.id);
const REG: WidgetDefinition[] = [
  { id: 'a', title: 'A', permission: 'dashboard:view', size: 'full' },
  { id: 'b', title: 'B', permission: 'dashboard:view', size: 'half' },
  { id: 'c', title: 'C', permission: 'ai:view', size: 'half' },
  { id: 'd', title: 'D', permission: 'dashboard:view', size: 'half' },
];
const P = ['dashboard:view', 'ai:view'];

describe('normalizeLayout', () => {
  it('falls back to the default for anything malformed', () => {
    const def = defaultLayout(P, REG);
    for (const bad of [null, undefined, 'x', 5, [], {}, { version: 2, widgets: [] }, { version: 1 }, { version: 1, widgets: 'no' }]) {
      expect(normalizeLayout(bad, REG, P), JSON.stringify(bad)).toEqual(def);
    }
  });
  it('keeps the saved order and visibility', () => {
    const l = normalizeLayout({ version: 1, widgets: [{ id: 'c', visible: true }, { id: 'a', visible: false }, { id: 'b', visible: true }, { id: 'd', visible: true }] }, REG, P);
    expect(l.widgets).toEqual([{ id: 'c', visible: true }, { id: 'a', visible: false }, { id: 'b', visible: true }, { id: 'd', visible: true }]);
  });
  it('drops unknown ids, de-duplicates (first wins) and ignores junk entries', () => {
    const l = normalizeLayout({ version: 1, widgets: [{ id: 'zzz', visible: true }, { id: 'b', visible: false }, { id: 'b', visible: true }, null, 7, { visible: true }, { id: 'a' }] }, REG, P);
    expect(ids(l)).toEqual(['b', 'c', 'd', 'a']);
    expect(new Set(ids(l)).size).toBe(ids(l).length);
    expect(l.widgets.find((w) => w.id === 'b')!.visible).toBe(false);
    expect(l.widgets.find((w) => w.id === 'a')!.visible).toBe(true);
    expect(ids(l)).not.toContain('zzz');
  });
  it('appends widgets missing from the saved layout at their default position', () => {
    // 'c' and 'd' are new releases: c belongs after b, d after c
    const l = normalizeLayout({ version: 1, widgets: [{ id: 'b', visible: true }, { id: 'a', visible: true }] }, REG, P);
    expect(ids(l)).toEqual(['b', 'c', 'd', 'a']);
    // a brand-new first widget goes first
    const l2 = normalizeLayout({ version: 1, widgets: [{ id: 'b', visible: true }] }, REG, P);
    expect(ids(l2)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('drops widgets the user lacks permission for, even if saved', () => {
    const l = normalizeLayout({ version: 1, widgets: REG.map((w) => ({ id: w.id, visible: true })) }, REG, ['dashboard:view']);
    expect(ids(l)).toEqual(['a', 'b', 'd']);
  });
  it('only an explicit false hides a widget', () => {
    const l = normalizeLayout({ version: 1, widgets: [{ id: 'a', visible: 0 }, { id: 'b', visible: 'no' }, { id: 'c', visible: false }] }, REG, P);
    expect(l.widgets.slice(0, 3).map((w) => w.visible)).toEqual([true, true, false]);
  });
  it('works on the real registry: every widget has a unique id and is shown for a super admin', () => {
    expect(new Set(DASHBOARD_WIDGETS.map((w) => w.id)).size).toBe(DASHBOARD_WIDGETS.length);
    expect(ids(normalizeLayout(null, DASHBOARD_WIDGETS, ALL_PERMS))).toEqual(DASHBOARD_WIDGETS.map((w) => w.id));
  });
});
