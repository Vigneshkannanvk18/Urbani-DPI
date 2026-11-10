#!/usr/bin/env node
// Offline cross-check of the DPI 2 deployment config (no AWS, no network, no dependencies).
//   npm run check:deploy        (also runs inside the backend test suite: src/deploy/deployConfig.test.ts)
//
// (a) every variable in deploy/dpi2.env.example is a real backend setting or a documented deploy-only variable
// (b) every backend setting WITHOUT a default is present in the example (as a variable or as SECRET_NAME_<VAR>)
// (c) secrets never get literal values in the example
// (d) the task definition rendered from the example is sane (no host volume, both containers, health checks,
//     secrets by valueFrom only, no :latest) and the IAM documents have no stray wildcards
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, toMap, SECRET_APP_VARS, ALWAYS_SECRETS, OPTIONAL_SECRETS } from './lib/dpi2-env.mjs';
import { renderTaskDef } from './render-taskdef.mjs';
import { execPolicy, taskPolicy, trustPolicy } from './render-policies.mjs';
import { retag } from './retag-taskdef.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
/** Settings read from the environment by the platform (set by the renderer or irrelevant in ECS). */
const PLATFORM_SET = new Set(['NODE_ENV', 'PORT', 'AWS_REGION', 'AWS_ACCOUNT_ID', 'DYNAMODB_ENDPOINT', 'DATABASE_URL']);
const MAIN_FILES = ['deploy-ecs-dpi2.sh', 'redeploy-dpi2.sh', 'deploy/lib.sh', 'scripts/render-taskdef.mjs',
  'scripts/render-policies.mjs', 'scripts/retag-taskdef.mjs'];

/** Keys of the zod schema in config/index.ts, with whether they have a default or are optional. */
export function schemaVars(configText) {
  const start = configText.indexOf('z.object({');
  const end = configText.indexOf('\n});', start);
  const body = configText.slice(start, end);
  const lines = body.split('\n');
  const vars = [];
  let cur = null;
  for (const line of lines) {
    const m = /^ {2}([A-Z][A-Z0-9_]+): /.exec(line);
    if (m) { cur = { name: m[1], text: line }; vars.push(cur); } else if (cur) cur.text += `\n${line}`;
  }
  return vars.map((v) => ({
    name: v.name,
    hasDefault: /\.default\(/.test(v.text) || /\.optional\(\)/.test(v.text),
  }));
}

/** Every `env.NAME` / `process.env.NAME` read outside tests (covers config/authConfig.ts and friends). */
export function directEnvReads(srcDir) {
  const names = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1]);
      }
    }
  };
  walk(srcDir);
  return names;
}

const isAllowedWildcard = (stmt) => stmt.Resource.every((r) => r !== '*') ||
  stmt.Action.every((a) => /^(logs:(GetQueryResults|StopQuery)|ssmmessages:)/.test(a));

export function runChecks(root = DEFAULT_ROOT) {
  const errors = [];
  const fail = (m) => errors.push(m);
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const examplePath = path.join(root, 'deploy', 'dpi2.env.example');
  if (!fs.existsSync(examplePath)) return ['deploy/dpi2.env.example is missing'];
  const entries = parseEnvFile(examplePath);
  const map = toMap(entries);
  const seen = new Set();
  for (const e of entries) { if (seen.has(e.key)) fail(`duplicate variable ${e.key}`); seen.add(e.key); }

  const schema = schemaVars(read('packages/backend/src/config/index.ts'));
  const known = new Set([...schema.map((s) => s.name), ...directEnvReads(path.join(root, 'packages/backend/src'))]);
  const deployText = MAIN_FILES.map((f) => (fs.existsSync(path.join(root, f)) ? read(f) : '')).join('\n');

  // (a)
  for (const e of entries) {
    if (e.section === 'app') {
      if (!known.has(e.key)) fail(`(a) app variable ${e.key} is not read by the backend (config/index.ts or env.X)`);
    } else if (e.section === 'secrets') {
      const m = /^SECRET_NAME_(.+)$/.exec(e.key);
      if (e.key === 'ENABLED_OPTIONAL_SECRETS') continue;
      if (!m || !SECRET_APP_VARS.includes(m[1])) fail(`(a) ${e.key}: secrets section only allows SECRET_NAME_<secret variable>`);
      else if (!known.has(m[1])) fail(`(a) ${e.key}: ${m[1]} is not a backend setting`);
    } else if (e.section === 'deploy') {
      if (!new RegExp(`\\b${e.key}\\b`).test(deployText)) fail(`(a) deploy-only variable ${e.key} is not used by any deploy script (dead setting)`);
    } else fail(`(a) ${e.key}: unknown section ${e.section}`);
  }
  // REQUIRED / OPTIONAL marker on the variables that the scripts insist on
  for (const v of ['AWS_REGION', 'ACCOUNT_ID', 'SERVICE_NAME', 'DOMAIN', 'SECRET_NAME_JWT_SECRET', 'SECRET_NAME_URBANI_API_KEY']) {
    const e = entries.find((x) => x.key === v);
    if (!e) fail(`(a) ${v} missing from the example`); else if (e.requirement !== 'REQUIRED') fail(`(a) ${v} must be marked # REQUIRED`);
  }

  // (b)
  for (const s of schema) {
    if (s.hasDefault) continue;
    const present = entries.some((e) => e.key === s.name && e.section === 'app') || `SECRET_NAME_${s.name}` in map;
    if (!present) fail(`(b) ${s.name} has no default in the backend config but is not in deploy/dpi2.env.example`);
  }

  // (c)
  for (const e of entries) {
    if (e.section === 'app' && SECRET_APP_VARS.includes(e.key)) fail(`(c) secret ${e.key} must not be assigned in the example; use SECRET_NAME_${e.key}`);
    if (e.section === 'secrets' && e.key !== 'ENABLED_OPTIONAL_SECRETS' && !/^[A-Za-z0-9/_+=.@-]{3,512}$/.test(e.value)) fail(`(c) ${e.key} does not look like a secret NAME`);
    if (/AKIA|ASIA[A-Z0-9]{12}|-----BEGIN|hooks\.slack\.com\/services|webhook\.office\.com\/webhookb2|[0-9a-f]{40,}/.test(e.value)) fail(`(c) ${e.key} looks like a literal secret value`);
  }
  const optionalEnabled = (map.ENABLED_OPTIONAL_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (optionalEnabled.length) fail('(c) ENABLED_OPTIONAL_SECRETS must be empty in the example (secret shells have no value yet)');

  // (d)
  let td;
  try {
    td = renderTaskDef(entries, { tag: 'check123' });
    const out = path.join(root, 'deploy', 'dpi2.taskdef.generated.json');
    fs.writeFileSync(out, `${JSON.stringify(td, null, 2)}\n`);
    td = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (err) { fail(`(d) task definition does not render/parse: ${err.message}`); }
  if (td) {
    if ('volumes' in td || JSON.stringify(td).includes('"host"')) fail('(d) task definition must not define volumes / host volumes');
    if (td.networkMode !== 'awsvpc') fail('(d) networkMode must be awsvpc');
    const names = td.containerDefinitions.map((c) => c.name).sort().join(',');
    if (names !== 'backend,frontend') fail(`(d) containers must be backend,frontend (got ${names})`);
    for (const c of td.containerDefinitions) {
      if (!c.healthCheck?.command?.length) fail(`(d) container ${c.name} has no health check`);
      if (!c.stopTimeout || c.stopTimeout < 15) fail(`(d) container ${c.name} stopTimeout too low for graceful shutdown`);
      if (c.image.endsWith(':latest')) fail(`(d) container ${c.name} uses :latest`);
      if (c.logConfiguration?.logDriver !== 'awslogs') fail(`(d) container ${c.name} is not logging to awslogs`);
    }
    const be = td.containerDefinitions.find((c) => c.name === 'backend');
    const fe = td.containerDefinitions.find((c) => c.name === 'frontend');
    const envMap = Object.fromEntries((be?.environment ?? []).map((x) => [x.name, x.value]));
    if (envMap.DB_DRIVER !== 'dynamodb') fail('(d) backend DB_DRIVER must be dynamodb');
    if (envMap.DYNAMODB_ENDPOINT || envMap.DATABASE_URL) fail('(d) DYNAMODB_ENDPOINT / DATABASE_URL must not be set in ECS');
    for (const s of SECRET_APP_VARS) if (s in envMap) fail(`(d) secret ${s} is in plain environment`);
    const secretNames = (be?.secrets ?? []).map((s) => s.name).sort().join(',');
    if (secretNames !== [...ALWAYS_SECRETS].sort().join(',')) fail(`(d) backend secrets should be ${ALWAYS_SECRETS.join(',')} (got ${secretNames})`);
    for (const s of be?.secrets ?? []) if (!/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+/.test(s.valueFrom)) fail(`(d) secret ${s.name} valueFrom is not a Secrets Manager ARN`);
    if (fe?.environment?.find((x) => x.name === 'BACKEND_UPSTREAM')?.value !== '127.0.0.1:4000') fail('(d) frontend BACKEND_UPSTREAM must be 127.0.0.1:4000 in ECS');
    if (!fe?.dependsOn?.some((d) => d.containerName === 'backend')) fail('(d) frontend should wait for a healthy backend');
    // the bootstrap definition
    const bs = renderTaskDef(entries, { tag: 'check123', mode: 'bootstrap' });
    if ('volumes' in bs || bs.containerDefinitions.length !== 1) fail('(d) bootstrap task definition should be one container, no volumes');
    // optional secrets flow through only when enabled
    const withSlack = renderTaskDef(entries.map((e) => (e.key === 'ENABLED_OPTIONAL_SECRETS' ? { ...e, value: 'SLACK_WEBHOOK_URL' } : e)), { tag: 'check123' });
    if (!withSlack.containerDefinitions[0].secrets.some((s) => s.name === 'SLACK_WEBHOOK_URL')) fail('(d) enabled optional secret is not injected');
    if (OPTIONAL_SECRETS.some((s) => envMap[s])) fail('(d) optional secret leaked into environment');
    // redeploy transformation keeps everything but the image
    const re = retag({ ...td, taskDefinitionArn: 'x', revision: 3, status: 'ACTIVE' }, { backend: 'img:new' });
    if (re.taskDefinitionArn || re.revision || re.containerDefinitions[0].image !== 'img:new' || re.containerDefinitions[1].image !== fe.image) fail('(d) retag-taskdef does not behave');
  }
  // IAM documents
  const kms = 'arn:aws:kms:us-east-1:111111111111:key/test';
  const OVR = { ENABLE_SNS: '1', ENABLE_EXEC: '1', LOGS_SOURCE: 'insights', LOGS_INSIGHTS_LOG_GROUPS: 'main=/aws/ecs/a/app,payments=/aws/ecs/b/app' };
  const variants = [entries, entries.map((e) => ({ ...e, value: OVR[e.key] ?? e.value }))];
  for (const v of variants) {
    for (const st of [...taskPolicy(v, kms).Statement, ...execPolicy(v).Statement]) {
      if (!isAllowedWildcard(st)) fail(`(d) IAM statement ${st.Sid} uses a wildcard resource`);
      if (st.Resource.some((r) => /^arn:[^:]*:[^:]*:[^:]*:[^:]*:?\*$/.test(r))) fail(`(d) IAM statement ${st.Sid} has a service-wide wildcard`);
    }
  }
  const tp = taskPolicy(entries, kms).Statement.map((s) => s.Sid).join(',');
  if (tp !== 'UrbaniAppTableData,UrbaniAppTableKmsViaDynamoDb') fail(`(d) default task policy should only contain table + KMS statements (got ${tp})`);
  if (trustPolicy().Statement[0].Principal.Service !== 'ecs-tasks.amazonaws.com') fail('(d) trust policy');

  // Frontend nginx: upstream configurable, timeouts sane
  const ng = read('packages/frontend/nginx.conf.template');
  if (!ng.includes('${BACKEND_UPSTREAM}')) fail('nginx template must use ${BACKEND_UPSTREAM}');
  const rt = /proxy_read_timeout\s+(\d+)s/.exec(ng);
  if (!rt || Number(rt[1]) < 30) fail('nginx proxy_read_timeout must be >= 30s (chat timeout)');
  if (!/location = \/healthz/.test(ng)) fail('nginx must keep /healthz');
  // scripts keep their safety switches
  for (const f of ['deploy-ecs-dpi2.sh', 'redeploy-dpi2.sh']) {
    const t = read(f);
    if (!/^set -euo pipefail/m.test(t)) fail(`${f}: missing set -euo pipefail`);
  }
  const lib = read('deploy/lib.sh');
  if (!/CONFIRM_ACCOUNT/.test(lib) || !/APPLY_MODE="dry-run"/.test(lib)) fail('deploy/lib.sh: dry-run default / CONFIRM_ACCOUNT guard missing');
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => !a.startsWith('--'));
  const root = rootArg ? path.resolve(rootArg) : DEFAULT_ROOT;
  const errors = runChecks(root);
  if (args.includes('--json')) {
    // Machine-readable form used by the backend test suite.
    const schema = schemaVars(fs.readFileSync(path.join(root, 'packages/backend/src/config/index.ts'), 'utf8'));
    console.log(JSON.stringify({ errors, schema }));
    process.exit(0);
  }
  if (errors.length) {
    console.error(`check:deploy FAILED (${errors.length})`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('check:deploy OK: example config, rendered task definition and IAM documents are consistent');
}
