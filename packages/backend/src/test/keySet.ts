/**
 * Recursive key set of a JSON body (design §14 step 1). The throwaway capture script that
 * recorded routes.baseline.json carries an identical copy:
 *  - an object adds the path of each key (`parent.key`, or `key` at the top) and recurses;
 *  - an array recurses into each element under `parent[]`; a primitive element adds `parent[]`;
 *  - a primitive or null adds nothing at its own level;
 *  - the result is the sorted list of distinct paths.
 */
export function keySet(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      const ap = `${p}[]`;
      for (const el of v) {
        if (el !== null && typeof el !== 'object') out.add(ap);
        else walk(el, ap);
      }
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const kp = p ? `${p}.${k}` : k;
        out.add(kp);
        walk((v as Record<string, unknown>)[k], kp);
      }
    }
    // primitive or null: adds nothing at its own level
  };
  walk(value, '');
  return [...out].sort();
}
