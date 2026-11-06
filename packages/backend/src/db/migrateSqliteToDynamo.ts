import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type {
  AlertStatus,
  AuditAction,
  AuditResult,
  ChatMessageRole,
  ChatRating,
  DataSource,
  LogLevel,
  ServiceStatus,
  Severity,
  Theme,
  UserRole,
} from '@urbani/shared';
import type { AppConfig } from '../config';
import { PersistenceError } from '../lib/errors';
import { logger } from '../lib/logger';
import { createDynamoRepositories } from '../repositories/dynamodb';
import { createDynamoContext, type DynamoContext } from '../repositories/dynamodb/client';
import {
  alertItem,
  analysisItem,
  auditItem,
  chatMessageItem,
  chatSessionItem,
  emailLockItem,
  environmentItem,
  feedbackItem,
  integrationItem,
  logItem,
  metricItem,
  preferencesItem,
  roleItem,
  serviceItem,
  usageItem,
  userItem,
  type DynamoItem,
} from '../repositories/dynamodb/items';
import {
  batchGetAll,
  cancellationCodes,
  CONDITIONAL_CHECK_FAILED,
  errorName,
  isConditionalCheckFailed,
  mapLimit,
  send,
  TRANSACTION_CANCELED,
  translateAwsError,
} from '../repositories/dynamodb/ops';
import { CliPreconditionError } from './cliErrors';

/**
 * `npm run dynamo:migrate -- --source <path> [--dry-run] [--allow-aws]` (design §10): copies a DPI 1/2
 * SQLite database into the DynamoDB app table. The source is opened read-only. Every write is create-only,
 * so a re-run skips what was copied and never overwrites newer DynamoDB state. Items are built by the
 * driver's items.ts builders, so every item carries entityType. Errors are logged with entity and id only.
 */

export interface MigrateArgs {
  source: string;
  dryRun: boolean;
  allowAws: boolean;
}

const USAGE = 'Usage: npm run dynamo:migrate -- --source <path> [--dry-run] [--allow-aws]';
const AWS_REFUSAL =
  'Refusing: dynamo:migrate would target AWS DynamoDB. Pass --allow-aws, or set DYNAMODB_ENDPOINT for DynamoDB Local.';
/** Writes in flight per entity. */
const CONCURRENCY = 8;

/**
 * No file-system access. `source` comes back absolute: path.resolve(baseDir ?? INIT_CWD ?? cwd, raw), because
 * npm runs the script in packages/backend. A missing --source, a missing value, an unknown flag or any stray
 * token throws CliPreconditionError (exit 2).
 */
export function parseMigrateArgs(argv: string[], baseDir?: string): MigrateArgs {
  let raw: string | undefined;
  let dryRun = false;
  let allowAws = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new CliPreconditionError(`--source needs a value. ${USAGE}`);
      }
      if (raw !== undefined) throw new CliPreconditionError(`--source given more than once. ${USAGE}`);
      raw = value;
      i++;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--allow-aws') {
      allowAws = true;
    } else if (arg.startsWith('-')) {
      throw new CliPreconditionError(`Unknown flag: ${arg}. ${USAGE}`);
    } else {
      throw new CliPreconditionError(`Unexpected argument: ${arg}. ${USAGE}`);
    }
  }
  if (raw === undefined) throw new CliPreconditionError(`--source is required. ${USAGE}`);
  return { source: path.resolve(baseDir ?? process.env.INIT_CWD ?? process.cwd(), raw), dryRun, allowAws };
}

/** Dependency order: every entity is written after the entities it refers to. */
export const MIGRATION_ENTITIES = [
  'roles',
  'users',
  'preferences',
  'environments',
  'services',
  'alerts',
  'logs',
  'metrics',
  'aiAnalyses',
  'usage',
  'audit',
  'integrations',
  'chatSessions',
  'chatMessages',
  'chatFeedback',
] as const;
export type MigrationEntity = (typeof MIGRATION_ENTITIES)[number];

/** In a dry run, created/skipped mean would-create/would-skip. */
export interface EntityCounts {
  source: number;
  created: number;
  skipped: number;
  failed: number;
  trimmedEvidence: number;
}

export interface MigrationReport {
  dryRun: boolean;
  sourcePath: string;
  table: string;
  endpoint: string | null;
  entities: Record<MigrationEntity, EntityCounts>;
  totals: EntityCounts;
  startedAt: string;
  finishedAt: string;
}

/**
 * Raw snake_case rows per entity. Alerts carry evidence[] and recommendedActions[] (read ORDER BY ordinal);
 * logs, metrics and analyses keep alert_id. role/result are already defaulted for 001-only sources.
 */
export type SqliteSnapshot = Record<MigrationEntity, Array<Record<string, unknown>>>;

type Row = Record<string, unknown>;

/** Migration 002's backfill rule for audit_events.result, with its guard against malformed JSON. */
const LEGACY_AUDIT_RESULT_SQL =
  "CASE WHEN (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.outcome') END) = 'unavailable' " +
  "THEN 'FAILURE' ELSE 'SUCCESS' END";

/** Reads the whole source. Schema detection uses PRAGMA table_info, so a 001-only database works too. */
export function readSqliteSnapshot(db: Database.Database): SqliteSnapshot {
  const all = (sql: string): Row[] => db.prepare(sql).all() as Row[];
  const hasTable = (name: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  const hasColumn = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  /** Tables added by migration 002 count as 0 rows on a 001-only source. */
  const optional = (table: string, sql: string): Row[] => (hasTable(table) ? all(sql) : []);

  const evidence = db.prepare('SELECT line FROM alert_evidence WHERE alert_id = ? ORDER BY ordinal');
  const actions = db.prepare('SELECT action FROM alert_recommended_actions WHERE alert_id = ? ORDER BY ordinal');

  return {
    roles: all('SELECT * FROM roles ORDER BY id'),
    users: hasColumn('users', 'role')
      ? all('SELECT * FROM users ORDER BY id')
      : all("SELECT *, 'SUPER_ADMIN' AS role FROM users ORDER BY id"),
    preferences: optional('user_preferences', 'SELECT * FROM user_preferences ORDER BY user_id'),
    environments: all('SELECT * FROM environments ORDER BY id'),
    services: all('SELECT * FROM services ORDER BY id'),
    alerts: all('SELECT * FROM alerts ORDER BY alert_id').map((a) => ({
      ...a,
      evidence: (evidence.all(a.alert_id) as Array<{ line: string }>).map((r) => r.line),
      recommendedActions: (actions.all(a.alert_id) as Array<{ action: string }>).map((r) => r.action),
    })),
    logs: all('SELECT * FROM log_references ORDER BY id'),
    metrics: all('SELECT * FROM metric_snapshots ORDER BY id'),
    aiAnalyses: all('SELECT * FROM ai_analyses ORDER BY id'),
    usage: all('SELECT * FROM usage_records ORDER BY id'),
    audit: hasColumn('audit_events', 'result')
      ? all('SELECT * FROM audit_events ORDER BY id')
      : all(`SELECT *, ${LEGACY_AUDIT_RESULT_SQL} AS result FROM audit_events ORDER BY id`),
    integrations: all('SELECT * FROM integrations ORDER BY id'),
    chatSessions: optional('chat_sessions', 'SELECT * FROM chat_sessions ORDER BY id'),
    chatMessages: optional('chat_messages', 'SELECT * FROM chat_messages ORDER BY id'),
    chatFeedback: optional('chat_feedback', 'SELECT * FROM chat_feedback ORDER BY message_id'),
  };
}

// ---------------------------------------------------------------- Mapping (items.ts builders only)

/** One source row, mapped. Users also carry their email lock. */
interface Planned {
  id: string;
  item: DynamoItem;
  lock?: DynamoItem;
  /** The evidence budget dropped lines of this alert. */
  trimmed: boolean;
}

const s = (row: Row, col: string): string => row[col] as string;
const sn = (row: Row, col: string): string | null => (row[col] ?? null) as string | null;
const n = (row: Row, col: string): number => row[col] as number;
const nn = (row: Row, col: string): number | null => (row[col] ?? null) as number | null;
const planned = (id: string, item: DynamoItem): Planned => ({ id, item, trimmed: false });

/** The natural id of a source row, for logs. */
function rowId(entity: MigrationEntity, row: Row): string {
  const col =
    entity === 'preferences' ? 'user_id' : entity === 'alerts' ? 'alert_id' : entity === 'chatFeedback' ? 'message_id' : 'id';
  return String(row[col]);
}

const MAPPERS: Record<MigrationEntity, (row: Row) => Planned> = {
  roles: (r) =>
    planned(
      s(r, 'id'),
      roleItem({
        id: s(r, 'id'),
        name: s(r, 'name'),
        description: sn(r, 'description'),
        permissions: s(r, 'permissions'),
        created_at: s(r, 'created_at'),
      }),
    ),
  users: (r) => ({
    ...planned(
      s(r, 'id'),
      userItem({
        id: s(r, 'id'),
        email: s(r, 'email'),
        display_name: s(r, 'display_name'),
        password_hash: s(r, 'password_hash'),
        role_id: s(r, 'role_id'),
        is_active: n(r, 'is_active'),
        last_login_at: sn(r, 'last_login_at'),
        created_at: s(r, 'created_at'),
        role: s(r, 'role') as UserRole,
      }),
    ),
    lock: emailLockItem(s(r, 'email'), s(r, 'id')),
  }),
  preferences: (r) =>
    planned(
      s(r, 'user_id'),
      preferencesItem({
        userId: s(r, 'user_id'),
        theme: sn(r, 'theme') as Theme | null,
        widgetLayoutJson: sn(r, 'widget_layout_json'),
        updatedAt: s(r, 'updated_at'),
      }),
    ),
  environments: (r) => planned(s(r, 'id'), environmentItem({ id: s(r, 'id'), name: s(r, 'name') }, s(r, 'created_at'))),
  services: (r) =>
    planned(
      s(r, 'id'),
      serviceItem(
        {
          id: s(r, 'id'),
          name: s(r, 'name'),
          environment: s(r, 'environment'),
          status: s(r, 'status') as ServiceStatus,
          errorRate: n(r, 'error_rate'),
          lastTelemetryAt: sn(r, 'last_telemetry_at'),
          lastIncidentAt: sn(r, 'last_incident_at'),
        },
        s(r, 'data_source') as DataSource,
        s(r, 'created_at'),
      ),
    ),
  alerts: (r) => {
    const evidence = r.evidence as string[];
    const item = alertItem(
      {
        alertId: s(r, 'alert_id'),
        timestamp: s(r, 'timestamp'),
        service: s(r, 'service'),
        environment: s(r, 'environment'),
        severity: s(r, 'severity') as Severity,
        anomalyType: s(r, 'anomaly_type'),
        summary: s(r, 'summary'),
        evidence,
        probableCause: s(r, 'probable_cause'),
        recommendedActions: r.recommendedActions as string[],
        confidence: nn(r, 'confidence'),
        modelId: s(r, 'model_id'),
      },
      s(r, 'data_source') as DataSource,
      s(r, 'status') as AlertStatus,
      s(r, 'created_at'),
      { acknowledgedBy: sn(r, 'acknowledged_by'), acknowledgedAt: sn(r, 'acknowledged_at') },
    );
    return { ...planned(s(r, 'alert_id'), item), trimmed: (item.evidence as string[]).length < evidence.length };
  },
  logs: (r) =>
    planned(
      s(r, 'id'),
      logItem(
        {
          id: s(r, 'id'),
          timestamp: s(r, 'timestamp'),
          level: s(r, 'level') as LogLevel,
          service: s(r, 'service'),
          environment: s(r, 'environment'),
          message: s(r, 'message'),
        },
        s(r, 'data_source') as DataSource,
        sn(r, 'alert_id'),
      ),
    ),
  metrics: (r) =>
    planned(
      s(r, 'id'),
      metricItem(
        {
          id: s(r, 'id'),
          service: s(r, 'service'),
          environment: s(r, 'environment'),
          timestamp: s(r, 'timestamp'),
          cpuPercent: n(r, 'cpu_percent'),
          memoryPercent: n(r, 'memory_percent'),
          errorRate: n(r, 'error_rate'),
          requestCount: n(r, 'request_count'),
          latencyMsP95: n(r, 'latency_ms_p95'),
          http5xxCount: n(r, 'http_5xx_count'),
          instanceRestarts: n(r, 'instance_restarts'),
        },
        s(r, 'data_source') as DataSource,
        sn(r, 'alert_id'),
      ),
    ),
  aiAnalyses: (r) =>
    planned(
      s(r, 'id'),
      analysisItem(
        {
          id: s(r, 'id'),
          alertId: sn(r, 'alert_id'),
          timestamp: s(r, 'timestamp'),
          service: s(r, 'service'),
          environment: s(r, 'environment'),
          modelId: s(r, 'model_id'),
          provider: s(r, 'provider'),
          anomalyType: sn(r, 'anomaly_type'),
          confidence: nn(r, 'confidence'),
          finding: JSON.parse(s(r, 'finding_json')),
          inputTokens: n(r, 'input_tokens'),
          outputTokens: n(r, 'output_tokens'),
          dataSource: s(r, 'data_source') as DataSource,
        },
        s(r, 'created_at'),
      ),
    ),
  usage: (r) =>
    planned(
      s(r, 'id'),
      usageItem(
        {
          id: s(r, 'id'),
          date: s(r, 'date'),
          modelId: s(r, 'model_id'),
          aiRequestCount: n(r, 'ai_request_count'),
          inputTokens: n(r, 'input_tokens'),
          outputTokens: n(r, 'output_tokens'),
          estimatedCostUsd: n(r, 'estimated_cost_usd'),
        },
        s(r, 'data_source') as DataSource,
      ),
    ),
  audit: (r) =>
    planned(
      s(r, 'id'),
      auditItem({
        id: s(r, 'id'),
        timestamp: s(r, 'timestamp'),
        actor: s(r, 'actor'),
        action: s(r, 'action') as AuditAction,
        target: sn(r, 'target'),
        metadataJson: sn(r, 'metadata'),
        result: s(r, 'result') as AuditResult,
        createdAt: s(r, 'created_at'),
      }),
    ),
  integrations: (r) =>
    planned(
      s(r, 'id'),
      integrationItem({
        id: s(r, 'id'),
        kind: s(r, 'kind'),
        display_name: s(r, 'display_name'),
        mode: s(r, 'mode'),
        status: s(r, 'status'),
        config_json: s(r, 'config_json'),
        updated_at: s(r, 'updated_at'),
      }),
    ),
  // Sessions keep their source messageCount and messages their source ids: nothing is incremented.
  chatSessions: (r) =>
    planned(
      s(r, 'id'),
      chatSessionItem({
        id: s(r, 'id'),
        userId: s(r, 'user_id'),
        title: sn(r, 'title'),
        service: sn(r, 'service'),
        environment: sn(r, 'environment'),
        messageCount: n(r, 'message_count'),
        createdAt: s(r, 'created_at'),
        updatedAt: s(r, 'updated_at'),
      }),
    ),
  chatMessages: (r) =>
    planned(
      s(r, 'id'),
      chatMessageItem({
        id: s(r, 'id'),
        sessionId: s(r, 'session_id'),
        role: s(r, 'role') as ChatMessageRole,
        content: s(r, 'content'),
        citations: JSON.parse(s(r, 'citations_json')) as string[],
        provider: sn(r, 'provider'),
        modelId: sn(r, 'model_id'),
        source: sn(r, 'data_source') as DataSource | null,
        latencyMs: nn(r, 'latency_ms'),
        inputTokens: nn(r, 'input_tokens'),
        outputTokens: nn(r, 'output_tokens'),
        createdAt: s(r, 'created_at'),
      }),
    ),
  chatFeedback: (r) =>
    planned(
      s(r, 'message_id'),
      feedbackItem({
        messageId: s(r, 'message_id'),
        sessionId: s(r, 'session_id'),
        userId: s(r, 'user_id'),
        rating: s(r, 'rating') as ChatRating,
        comment: sn(r, 'comment'),
        createdAt: s(r, 'created_at'),
        updatedAt: s(r, 'updated_at'),
      }),
    ),
};

// ---------------------------------------------------------------- Writing

type Outcome = 'created' | 'skipped' | 'failed';

const keyOf = (item: DynamoItem): { PK: string; SK: string } => ({ PK: item.PK as string, SK: item.SK as string });
const keyId = (key: { PK: string; SK: string }): string => `${key.PK}\u0000${key.SK}`;

function logFailure(entity: MigrationEntity, id: string, err: unknown): void {
  logger.error('dynamo:migrate: item failed', {
    entity,
    id,
    error: err instanceof PersistenceError ? err.reason : errorName(err),
  });
}

/** Create-only PutItem; a condition failure means the item was copied before. */
async function createItem(ctx: DynamoContext, item: DynamoItem, op: string): Promise<Outcome> {
  try {
    await send(
      ctx,
      new PutCommand({
        TableName: ctx.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': 'PK' },
      }),
      op,
      { handled: [CONDITIONAL_CHECK_FAILED] },
    );
    return 'created';
  } catch (err) {
    if (isConditionalCheckFailed(err)) return 'skipped';
    throw err;
  }
}

/**
 * A create-only user plus its create-only email lock in one transaction. [0] failed: the user was copied
 * before (skipped). Only [1] failed: the email belongs to another user (failed, logged as a conflict).
 */
async function createUser(ctx: DynamoContext, p: Planned, op: string): Promise<Outcome> {
  const createOnly = { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'PK' } };
  try {
    await send(
      ctx,
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: ctx.tableName, Item: p.item, ...createOnly } },
          { Put: { TableName: ctx.tableName, Item: p.lock as DynamoItem, ...createOnly } },
        ],
      }),
      op,
      { handled: [TRANSACTION_CANCELED] },
    );
    return 'created';
  } catch (err) {
    const codes = cancellationCodes(err);
    if (codes === null) throw err;
    if (codes[0] === 'ConditionalCheckFailed') return 'skipped';
    if (codes[1] === 'ConditionalCheckFailed') {
      logger.error('dynamo:migrate: email lock owned by another user', { entity: 'users', id: p.id });
      return 'failed';
    }
    throw translateAwsError(err, op);
  }
}

/** Dry run: strongly consistent, keys-only existence check. */
async function checkEntity(ctx: DynamoContext, entity: MigrationEntity, plans: Planned[], counts: EntityCounts): Promise<void> {
  const keys = new Map(plans.map((p) => [keyId(keyOf(p.item)), keyOf(p.item)]));
  const found = await batchGetAll<{ PK: string; SK: string }>(ctx, [...keys.values()], { projection: ['PK', 'SK'] }, `migrate.${entity}`);
  const existing = new Set(found.map(keyId));
  for (const p of plans) {
    if (existing.has(keyId(keyOf(p.item)))) {
      counts.skipped++;
    } else {
      counts.created++;
      if (p.trimmed) counts.trimmedEvidence++;
    }
  }
}

/**
 * Writes one entity with at most 8 calls in flight. A per-item failure is counted and logged; an
 * UNAVAILABLE store (fatal or not) aborts the run, which can be repeated safely.
 */
async function writeEntity(ctx: DynamoContext, entity: MigrationEntity, plans: Planned[], counts: EntityCounts): Promise<void> {
  const op = `migrate.${entity}`;
  await mapLimit(plans, CONCURRENCY, async (p) => {
    let outcome: Outcome;
    try {
      outcome = entity === 'users' ? await createUser(ctx, p, op) : await createItem(ctx, p.item, op);
    } catch (err) {
      if (err instanceof PersistenceError && err.reason === 'UNAVAILABLE') throw err;
      logFailure(entity, p.id, err);
      outcome = 'failed';
    }
    counts[outcome]++;
    if (outcome === 'created' && p.trimmed) counts.trimmedEvidence++;
  });
}

const emptyCounts = (source: number): EntityCounts => ({ source, created: 0, skipped: 0, failed: 0, trimmedEvidence: 0 });

/** Maps every row, then writes (or, in a dry run, checks) the entities in dependency order. */
export async function migrateSqliteToDynamo(opts: {
  snapshot: SqliteSnapshot;
  ctx: DynamoContext;
  dryRun: boolean;
  sourcePath: string;
  endpoint: string | null;
}): Promise<MigrationReport> {
  const { snapshot, ctx, dryRun } = opts;
  const startedAt = new Date().toISOString();
  const entities = Object.fromEntries(
    MIGRATION_ENTITIES.map((e) => [e, emptyCounts(snapshot[e].length)]),
  ) as Record<MigrationEntity, EntityCounts>;

  for (const entity of MIGRATION_ENTITIES) {
    const counts = entities[entity];
    const plans: Planned[] = [];
    for (const row of snapshot[entity]) {
      try {
        plans.push(MAPPERS[entity](row));
      } catch (err) {
        logFailure(entity, rowId(entity, row), err);
        counts.failed++;
      }
    }
    if (dryRun) await checkEntity(ctx, entity, plans, counts);
    else await writeEntity(ctx, entity, plans, counts);
  }

  const totals = emptyCounts(0);
  for (const entity of MIGRATION_ENTITIES) {
    for (const k of Object.keys(totals) as Array<keyof EntityCounts>) totals[k] += entities[entity][k];
  }
  return {
    dryRun,
    sourcePath: opts.sourcePath,
    table: ctx.tableName,
    endpoint: opts.endpoint,
    entities,
    totals,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function printReport(report: MigrationReport): void {
  const [created, skipped] = report.dryRun ? ['wouldCreate', 'wouldSkip'] : ['created', 'skipped'];
  const row = (entity: string, c: EntityCounts) => ({
    entity,
    source: c.source,
    [created]: c.created,
    [skipped]: c.skipped,
    failed: c.failed,
    trimmedEvidence: c.trimmedEvidence,
  });
  console.table([...MIGRATION_ENTITIES.map((e) => row(e, report.entities[e])), row('TOTAL', report.totals)]);
}

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Used by db/cli.ts. Preconditions in the §10 order, each exiting 2: arguments; the source line;
 * a regular file; the AWS guard (before the file is opened or any client exists); a read-only open;
 * health.ping of the target ([F32]: fatal → exit 2 via the CLI, unreachable → exit 1). Returns 1 when
 * any item failed, else 0. The client is destroyed in finally.
 */
export async function runMigrate(cfg: AppConfig, argv: string[]): Promise<number> {
  const args = parseMigrateArgs(argv);
  console.log(`Source (read-only): ${args.source}`);
  if (!isRegularFile(args.source)) throw new CliPreconditionError(`--source is not a regular file: ${args.source}`);
  const { endpoint, tableName } = cfg.db.dynamodb;
  if (!endpoint && !args.allowAws) throw new CliPreconditionError(AWS_REFUSAL);

  let db: Database.Database;
  try {
    db = new Database(args.source, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new CliPreconditionError(
      `Cannot open --source read-only: ${args.source} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let ctx: DynamoContext | null = null;
  try {
    ctx = createDynamoContext({ region: cfg.aws.region, endpoint, tableName });
    try {
      await createDynamoRepositories(ctx).health.ping();
    } catch (err) {
      if (err instanceof PersistenceError && err.reason === 'UNAVAILABLE' && !err.fatal) {
        logger.error(`DynamoDB not reachable at ${endpoint ?? 'the AWS endpoint'}`, { table: tableName, awsError: err.awsErrorName });
        return 1;
      }
      throw err;
    }
    const report = await migrateSqliteToDynamo({
      snapshot: readSqliteSnapshot(db),
      ctx,
      dryRun: args.dryRun,
      sourcePath: args.source,
      endpoint,
    });
    printReport(report);
    logger.info('Migration summary', { ...report });
    return report.totals.failed > 0 ? 1 : 0;
  } finally {
    ctx?.destroy();
    db.close();
  }
}
