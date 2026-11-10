#!/usr/bin/env node
// Renders the DPI 2 ECS task definition JSON from deploy/dpi2.env. Pure function of its inputs:
// no AWS calls, no secret values (secrets are valueFrom references only).
//
//   node scripts/render-taskdef.mjs --env deploy/dpi2.env --tag <image-tag> [--mode service|bootstrap]
//        [--backend-image URI] [--frontend-image URI] [--exec-role ARN] [--task-role ARN]
//        [--secret-arn VAR=ARN]... [--out file]
import fs from 'node:fs';
import { parseEnvFile, toMap, ALWAYS_SECRETS, OPTIONAL_SECRETS } from './lib/dpi2-env.mjs';

export function parseArgs(argv) {
  const a = { secretArns: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--secret-arn') { const [n, ...r] = v.split('='); a.secretArns[n] = r.join('='); i++; }
    else if (k.startsWith('--')) { a[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; i++; }
  }
  return a;
}

export function renderTaskDef(entries, opts) {
  const m = toMap(entries);
  const need = (k) => { if (!m[k]) throw new Error(`${k} is required in the env file`); return m[k]; };
  const mode = opts.mode ?? 'service';
  const region = need('AWS_REGION');
  const account = need('ACCOUNT_ID');
  const tag = opts.tag ?? need_tag();
  function need_tag() { throw new Error('--tag is required (the image tag is never implicit)'); }
  if (tag === 'latest') throw new Error('refusing to deploy the :latest tag; pass the git short SHA');
  const ecr = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const backendImage = opts.backendImage ?? `${ecr}/${need('BACKEND_REPO')}:${tag}`;
  const frontendImage = opts.frontendImage ?? `${ecr}/${need('FRONTEND_REPO')}:${tag}`;
  const execRole = opts.execRole ?? `arn:aws:iam::${account}:role/${need('EXEC_ROLE_NAME')}`;
  const taskRole = opts.taskRole ?? `arn:aws:iam::${account}:role/${need('TASK_ROLE_NAME')}`;

  // ---- environment: every non-empty variable of the "app" section, then fixed platform values ----
  const env = {};
  for (const e of entries) if (e.section === 'app' && e.value !== '') env[e.key] = e.value;
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: '4000',
    DB_DRIVER: 'dynamodb',
    AWS_REGION: region,
    AWS_ACCOUNT_ID: account,
  });
  delete env.DYNAMODB_ENDPOINT; // DynamoDB Local only
  delete env.DATABASE_URL; // no SQLite file in ECS
  if (m.ENABLE_SNS === '1' && !env.ALERT_SNS_TOPIC_ARN) {
    env.ALERT_SNS_TOPIC_ARN = `arn:aws:sns:${region}:${account}:${need('SNS_TOPIC_NAME')}`;
  }
  const environment = Object.keys(env).sort().map((name) => ({ name, value: env[name] }));

  // ---- secrets: valueFrom only ----
  const optionalOn = (m.ENABLED_OPTIONAL_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of optionalOn) if (!OPTIONAL_SECRETS.includes(s)) throw new Error(`ENABLED_OPTIONAL_SECRETS: unknown secret ${s}`);
  const names = mode === 'bootstrap'
    ? ['JWT_SECRET', 'MFA_ENCRYPTION_KEY', 'SEED_ADMIN_PASSWORD']
    : [...ALWAYS_SECRETS, ...optionalOn];
  const secrets = names.map((n) => {
    const secretName = need(`SECRET_NAME_${n}`);
    return {
      name: n,
      // Real ARN (with the random suffix) when the deploy script resolved it, else the partial ARN.
      valueFrom: (opts.secretArns ?? {})[n] ?? `arn:aws:secretsmanager:${region}:${account}:secret:${secretName}`,
    };
  });

  const logging = (prefix) => ({
    logDriver: 'awslogs',
    options: {
      'awslogs-group': need('LOG_GROUP'),
      'awslogs-region': region,
      'awslogs-stream-prefix': prefix,
    },
  });
  const backendHealth = {
    command: ['CMD', 'node', '-e', "require('http').get('http://127.0.0.1:4000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"],
    interval: 30, timeout: 5, startPeriod: 30, retries: 3,
  };

  const backend = {
    name: 'backend',
    image: backendImage,
    essential: true,
    // SIGTERM -> the app drains (10 s failsafe in server.ts); give it room before SIGKILL.
    stopTimeout: Number(m.STOP_TIMEOUT_SECONDS || 30),
    environment,
    secrets,
    logConfiguration: logging(mode === 'bootstrap' ? 'bootstrap' : 'backend'),
  };
  if (mode === 'service') {
    backend.portMappings = [{ containerPort: 4000, protocol: 'tcp' }];
    backend.healthCheck = backendHealth;
  }

  const containerDefinitions = [backend];
  if (mode === 'service') {
    containerDefinitions.push({
      name: 'frontend',
      image: frontendImage,
      essential: true,
      stopTimeout: Number(m.STOP_TIMEOUT_SECONDS || 30),
      portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
      // awsvpc: both containers share one network namespace, so nginx reaches the API on loopback.
      environment: [{ name: 'BACKEND_UPSTREAM', value: '127.0.0.1:4000' }],
      dependsOn: [{ containerName: 'backend', condition: 'HEALTHY' }],
      healthCheck: {
        command: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8080/healthz'],
        interval: 30, timeout: 3, startPeriod: 10, retries: 3,
      },
      logConfiguration: logging('frontend'),
    });
  }

  return {
    family: mode === 'bootstrap' ? `${need('TASK_FAMILY')}-bootstrap` : need('TASK_FAMILY'),
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: String(m.TASK_CPU || '512'),
    memory: String(m.TASK_MEMORY || '1024'),
    executionRoleArn: execRole,
    taskRoleArn: taskRole,
    containerDefinitions,
    // Deliberately NO "volumes": DPI 2 keeps no state on the task (DynamoDB only).
  };
}

if (process.argv[1]?.endsWith('render-taskdef.mjs')) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.env) { console.error('--env <file> is required'); process.exit(2); }
  try {
    const td = renderTaskDef(parseEnvFile(a.env), a);
    const json = `${JSON.stringify(td, null, 2)}\n`;
    if (a.out) fs.writeFileSync(a.out, json);
    else process.stdout.write(json);
  } catch (err) {
    console.error(`render-taskdef: ${err.message}`);
    process.exit(2);
  }
}
