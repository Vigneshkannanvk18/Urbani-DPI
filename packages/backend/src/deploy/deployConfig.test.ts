import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DPI 2 deployment readiness guard (item 14). The deploy example, the rendered task definition and the IAM
 * documents are cross-checked against the backend config so they cannot drift apart. Offline: no AWS, no Docker.
 * The checker is an ES module run in a child process (the repository path may contain spaces).
 */
const ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-deploy-config.mjs');

type Result = { errors: string[]; schema: { name: string; hasDefault: boolean }[] };
const check = (root: string): Result =>
  JSON.parse(execFileSync(process.execPath, [SCRIPT, root, '--json'], { encoding: 'utf8' })) as Result;

describe('deploy config cross-check', () => {
  it('has no findings (npm run check:deploy)', () => {
    expect(check(ROOT).errors).toEqual([]);
  });

  it('actually reads the backend schema (guards against a vacuous check)', () => {
    const { schema } = check(ROOT);
    expect(schema.length).toBeGreaterThan(60);
    expect(schema.find((v) => v.name === 'JWT_SECRET')?.hasDefault).toBe(false);
    expect(schema.find((v) => v.name === 'DB_DRIVER')?.hasDefault).toBe(true);
  });

  it('flags a literal secret and an unknown variable in a broken example', () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-deploycheck-'));
    try {
      for (const rel of ['packages/frontend/nginx.conf.template', 'deploy/lib.sh', 'deploy/dpi2.env.example',
        'deploy-ecs-dpi2.sh', 'redeploy-dpi2.sh']) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
      }
      fs.cpSync(path.join(ROOT, 'packages/backend/src/config'), path.join(tmp, 'packages/backend/src/config'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'scripts'), path.join(tmp, 'scripts'), { recursive: true });
      const ex = path.join(tmp, 'deploy/dpi2.env.example');
      fs.writeFileSync(ex, `${fs.readFileSync(ex, 'utf8')}\n#@section app\nJWT_SECRET=literal-value\nNOT_A_REAL_SETTING=1\n`);
      const { errors } = check(tmp);
      expect(errors.some((e) => e.includes('(c) secret JWT_SECRET'))).toBe(true);
      expect(errors.some((e) => e.includes('NOT_A_REAL_SETTING'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
