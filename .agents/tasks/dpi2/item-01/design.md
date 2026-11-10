# DPI 2 item 1: Technical design. Async repository layer and DynamoDB driver

Revision 3. It resolves findings 22–29 from the second review in `design-review.md`; §18 answers each one. §17 keeps the answers to findings 1–21 from revision 2. Requirements: `requirements.md` in this folder (also Revision 3).
Unless a path is absolute, paths are relative to the worktree `C:\Antigravity\Urbani DPI\.worktrees\dpi2`. Line numbers are 1-based and were taken from the worktree at dpi2 HEAD `5c81908`.

## 1. Overview

Today the backend talks to SQLite through six synchronous repository modules. Services, routes, the seed and the mock DynamoDB adapter import these modules as singletons. This design keeps that boundary and makes it formal:

- one async interface per entity;
- two implementations: SQLite, which wraps today's SQL unchanged, and a new DynamoDB driver;
- a registry, `getRepositories()`, that picks one implementation at startup from `config.db.driver`.

Every caller switches to the registry and awaits every call. The DynamoDB driver uses a single table, `<DYNAMODB_TABLE_PREFIX>App`, with generic `PK`/`SK` keys and one overloaded GSI. Two facts about the current code drove that choice. First, every list endpoint reads a whole entity collection and then filters, sorts, counts and pages it. Second, the alert relationship to logs, metrics and AI analyses needs one reverse index spanning three entity types.

SQLite stays the default. With `DB_DRIVER=sqlite`, observable behavior does not change, with one documented exception: duplicate-email upserts (§4.3). A forward-only migration adds `users.role` (existing users become `SUPER_ADMIN`), `audit_events.result`, and the preferences and chat tables. One contract test suite defines the behavior both drivers must share. It runs on SQLite in every `npm test`, and on DynamoDB Local when `DYNAMODB_ENDPOINT` is set.

**Technology stack.** This is locked once the design is approved.
- Existing and unchanged: Node 20 in the container (v24 locally), TypeScript 5.x compiled to CommonJS, Express 4, zod 3, better-sqlite3 11.10 (SQLite 3.49.2), vitest 2.1 and supertest 7.3.
- New runtime dependencies in `packages/backend`: `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb`, both `^3` at the same version. No other new dependency, runtime or dev. The only exception is the conditional fallback in §15.2.
- Local DynamoDB: the Docker Hub image `amazon/dynamodb-local:2.5.2`. When no Docker engine runs, the fallback is the official DynamoDB Local 2.x jar on a Java 11+ runtime (§9.2).
- IaC: AWS CDK v2 (the existing `aws-cdk-lib ^2.150.0`, 2.271.0 in the lockfile). The offline IaC check uses `aws-cdk-lib/assertions`, which ships inside `aws-cdk-lib`, and `node:assert`. The CDK CLI is not run (§11).

## 2. Current state (verified in the worktree)

### 2.1 Repository files and exported functions

There is no separate usage repository file. `usageRepository` lives in `telemetryRepository.ts`.

| File | Exports and methods (line) | Notes |
|---|---|---|
| `src/repositories/alertRepository.ts` | `AlertFilter` (14); `alertRepository` (92): `insert` (93), `upsertLivePreservingStatus` (141), `findById` (198), `query` (205), `replaceDerivedEvidence` (244), `deleteByDataSource` (261), `acknowledge` (266), `countActive` (277), `countBySeverity` (285) | Private `loadChildren` and `rowToAlert`. `rowToAlert` also reads `log_references` and `metric_snapshots` for `relatedLogIds`/`relatedMetricIds`. `acknowledge` calls `this.findById` (273–274). |
| `src/repositories/telemetryRepository.ts` | `serviceRepository` (22): `all` (23), `findById` (27), `count` (31); `LogFilter` (53); `logRepository` (62): `query` (63), `byAlert` (97), `clearAlertLinks` (115), `linkLogsToAlert` (125); `metricRepository` (135): `query` (136); `usageRepository` (167): `all` (168) | `mapService` runs `COUNT(*) FROM alerts WHERE service = name` per row. |
| `src/repositories/userRepository.ts` | `RoleRow` (10), `UserRow` (18), `AuthUser` (29); `userRepository` (41): `findByEmail` (42), `findById` (50), `getRole` (58), `toAuthUser` (64), `recordLogin` (81), `upsertRole` (85), `upsertUser` (94) | `toAuthUser` calls `this.getRole` (65). |
| `src/repositories/aiRepository.ts` | `AIAnalysisRecord` (12); `aiRepository` (32): `insert` (33), `query` (63), `findById` (73), `count` (78) | `finding_json` holds the full `UrbaniIncidentAlert`. |
| `src/repositories/auditRepository.ts` | `auditRepository` (32): `record` (33), `query` (44) | |
| `src/repositories/integrationRepository.ts` | `IntegrationRow` (9); `integrationRepository` (23): `all` (24) | |

### 2.2 Caller sites

| Caller | Calls (line) |
|---|---|
| `services/alertService.ts` | `syncLiveAlerts`: `alertRepository.deleteByDataSource` (115), `upsertLivePreservingStatus` (118, in a loop). `correlateLiveAlerts`: `replaceDerivedEvidence` (166), `logRepository.clearAlertLinks` (170), `linkLogsToAlert` (171), inside a per-alert try/catch. `list`: `alertRepository.query` (194). `get`: `findById` (213), `auditRepository.record` (215), `logRepository.byAlert` (220); its return type uses `ReturnType<typeof logRepository.byAlert>` (211). `acknowledge`: `acknowledge` (227), `record` (229). |
| `services/telemetryService.ts` | `metrics`: `metricRepository.query` (54). `services`: `serviceRepository.all` (62). `service`: `findById` (67). (`logs` uses the CloudWatch adapter, not a repository.) |
| `services/aiService.ts` | `listAnalyses`: `aiRepository.query` (17). `getAnalysis`: `findById` (31). `analyze`: `logRepository.query` (41), `metricRepository.query` (42), `dynamodb.putAlert` (48, which goes through the mock adapter), `aiRepository.insert` (51), `findById` (66). |
| `services/chatService.ts` | `ask`: `auditRepository.record` on the failure path (80), `aiRepository.insert` (92), `record` (106). |
| `services/dashboardService.ts` | `summary`: `serviceRepository.count` (13), `alertRepository.countActive` (14), `countBySeverity('CRITICAL')` (15), `serviceRepository.all` (16), `alertRepository.query({pageSize:200}).total` (30), `aiRepository.count` (31). `health`: `serviceRepository.all` (43), `metricRepository.query({limit:60})` (44); its return type uses `ReturnType<typeof serviceRepository.all>` (38). |
| `services/usageService.ts` | `usage`: `usageRepository.all` (15). `cost`: `all` (29). |
| `services/settingsService.ts` | `get`: `integrationRepository.all` (141). `update`: `auditRepository.record` (159). |
| `services/authService.ts` | `login`: `findByEmail` (29), `recordLogin` (37), `toAuthUser` (38), `auditRepository.record` (39). `me`: `findById` (58), `toAuthUser` (60). `logout`: `record` (64). |
| `routes/apiRoutes.ts` | `auditRepository.query` (170). Synchronous service results serialized at 32, 36, 93, 100, 104, 111, 116, 158, 159, 180 and 184. |
| `routes/authRoutes.ts` | `authService.logout` (36), `authService.me` (45). |
| `routes/healthRoutes.ts` | `getDb().prepare('SELECT 1')` (30). This is a DB call in a route. |
| `integrations/mock/MockDynamoDBAdapter.ts` | `alertRepository.insert` (15), `findById` (20), `query` (27). |
| `db/seed.ts` | `userRepository.upsertRole` (40, 47), `findByEmail` (56), `upsertUser` (59), `alertRepository.insert` (101). Raw SQL (§2.3). |
| Tests | `repositories/alertCorrelation.test.ts` (5 tests): repository calls at 59–122 plus raw-SQL helpers `seedLog` (34) and `evidenceLines` (43). `services/alertService.test.ts`: `insert` (30), plus `upsertLivePreservingStatus`/`findById`/`acknowledge` at 74–81. `services/authService.test.ts`: `upsertRole` (16), `upsertUser` (23). `services/chatService.test.ts` reaches repositories indirectly through `chatService.ask`. `services/alertService.test.ts:2`, `services/authService.test.ts:4` and `services/chatService.test.ts:2` import `type Database from 'better-sqlite3'` only to type their `let db` handle (§2.3, §8.4). |

### 2.3 Direct database access outside the repositories
- `db/seed.ts`: `runMigrations()` (35) and `getDb()` (36). Raw statements:
  - environments `INSERT OR IGNORE` (76);
  - services `INSERT OR REPLACE` (81);
  - `log_references` (105), `metric_snapshots` (113) and `usage_records` (137), all `INSERT OR REPLACE`;
  - `DELETE FROM integrations WHERE kind='URBANI_APP' AND id != 'int-urbani-ecs'` (159);
  - integrations `INSERT OR REPLACE` (166).
  `closeDb()` (182).
- `routes/healthRoutes.ts:30` (see above).
- SQLite tooling, which is part of the persistence layer and stays: `db/connection.ts`, `db/migrate.ts`, `db/reset.ts`. Also `server.ts:15` (`runMigrations()`).
- Tests: `test/testDb.ts:13` (`setDbForTesting`) and the raw-SQL helpers in `alertCorrelation.test.ts:34,43`.
- Type-only imports in tests outside `repositories/`, `db/` and `test/`: `import type Database from 'better-sqlite3'` in `services/alertService.test.ts:2`, `services/authService.test.ts:4` and `services/chatService.test.ts:2`. Each file uses it only for `let db: Database.Database`. §8.4 replaces it with `ReturnType<typeof freshTestDb>`, so the AC5 import gate holds.

### 2.4 better-sqlite3 transactions
These use `db.transaction`:
- `alertRepository.insert` (94);
- `upsertLivePreservingStatus` (154, after a pre-read at 142–149 outside the transaction);
- `replaceDerivedEvidence` (245);
- `logRepository.linkLogsToAlert` (128);
- `db/migrate.ts:45`;
- `db/reset.ts:25`.

A better-sqlite3 transaction function must be synchronous. A callback that returns a promise throws. **Decision:** transactions stay synchronous inside the SQLite implementation. Each async repository method runs its whole SQL body, including any transaction, without an internal `await`. Each method therefore stays one atomic unit in the process, exactly as today. No current flow needs a transaction spanning two repository calls, so the interfaces expose no transaction or unit-of-work API. On DynamoDB the equivalents are single-item conditional writes or `TransactWriteItems` (§5.5).

### 2.5 SQLite semantics the drivers share, and accepted divergences
Items 1, 3, 4 and 8 were checked with in-memory better-sqlite3 experiments on this machine. Those cover REPLACE cascades and UNIQUE resolution, `LIKE` case folding and wildcards (this build has no ICU), and the foreign-key edge cases. The existing `alertCorrelation.test.ts` covers item 2. The rest come from reading the code.
1. `INSERT OR REPLACE INTO alerts`, used by `insert` and `upsertLivePreservingStatus`, deletes the old row first. With `foreign_keys = ON` this cascades `alert_evidence` and `alert_recommended_actions`, and sets `log_references.alert_id`, `metric_snapshots.alert_id` and `ai_analyses.alert_id` to NULL for that alert. This is observable. `MockAIProvider.ts:54` derives the alert id as `ALT-${service}-${Date.parse(logs[0].timestamp)}`, and `aiService.analyze` feeds it the same seeded logs, so repeated `POST /api/ai/analyze` regenerates the same id and only the newest analysis keeps its `alertId`.
2. `DELETE FROM alerts WHERE data_source = ?` cascades in the same way (`alertCorrelation.test.ts`).
3. `LIKE '%term%'` is case-insensitive for ASCII letters only. `%` and `_` inside the user's term act as wildcards because the term is not escaped.
4. `INSERT OR REPLACE` also resolves UNIQUE conflicts. `upsertUser` with another user's email silently deletes that other user. `upsertRole` with another role's name fails with a FOREIGN KEY error while users still reference that role.
5. Equality filters use BINARY collation, so they are case-sensitive. A filter applies only when its value is truthy, so an empty string means no filter.
6. `ORDER BY <ts> DESC` compares strings with BINARY collation. The order of ties is unspecified.
7. Clamps:
   - alerts: page/pageSize default 25, range 1..200;
   - logs: default 50, range 1..200;
   - AI analyses: default 25, range 1..200;
   - audit: default 50, range 1..200;
   - metrics: `Math.min(limit ?? 200, 500)` with no lower bound, so 0 returns nothing and a negative value means no limit in SQLite.
8. Foreign keys:
   - `linkLogsToAlert` to a missing alert fails only if one of the log rows exists;
   - `replaceDerivedEvidence(missing, lines)` fails when `lines` is non-empty and is a no-op when `lines` is `[]`;
   - an `ai_analyses` insert that references a missing alert fails;
   - an `ai_analyses` insert with a duplicate id fails (plain `INSERT`).
9. Email lookup is exact (case-sensitive). `findByEmail` and `findById` return only users with `is_active = 1`. An `UPDATE` of a missing row is a silent no-op (`recordLogin`, `acknowledge`).

The DynamoDB driver reproduces items 1–3 and 5–9, and the email part of item 4. **Accepted divergences** (DynamoDB enforces uniqueness only on the primary key, and limits key length; the review confirmed the first four on in-memory SQLite 3.49.2):
- `roles.name UNIQUE`. On SQLite, `upsertRole` with a new id and an existing name fails with a FOREIGN KEY error while users reference the old role; otherwise REPLACE deletes the old role row. DynamoDB stores a second role with that name.
- `services UNIQUE(name, environment)`. `services.upsert` with a new id and an existing pair leaves 1 row on SQLite and 2 items on DynamoDB.
- `environments.name UNIQUE`. `environments.ensure` with a new id and an existing name is ignored on SQLite and creates a second item on DynamoDB.
- `usage_records`. The DynamoDB key is `(date, modelId)` (§5.2), so the `UNIQUE(date, model_id)` half of REPLACE is reproduced. The `id` half is not: a same-id upsert with a new date leaves 1 row on SQLite and 2 items on DynamoDB.
- Key length. DynamoDB limits a partition key to 2,048 bytes and a sort key to 1,024 bytes (UTF-8). Lookups with a longer id or email return their not-found result without a call (§5.4, key-size guard). That equals SQLite's answer, because no such item can exist on DynamoDB. Writes with a longer key reject with `INVALID_ARGUMENT`, where SQLite stores them.

The only writers of roles, services, environments and usage are the seed, which uses static ids, and the migration, whose SQLite source already satisfies these constraints. The mock usage dates derive from the fixed instant in `mockData.ts:21`, so each usage id keeps its date. No contract case depends on these divergences. The ADR lists them (§12.1).

### 2.6 Observations that constrain the build
- Stale SQLite sidecar files are tracked in git, and therefore present in the worktree: `packages/backend/data/urbani.sqlite-wal`/`-shm` and `verify.sqlite-wal`/`-shm`. The default `DB_SQLITE_PATH` (`./data/urbani.sqlite` with cwd `packages/backend`) would open a new database next to that WAL. That risks replaying DPI 1 data and modifying tracked files. Every runtime check therefore sets `DATABASE_URL` under `<worktree>/.tmp/` (§14).
- On 2026-10-28 the Docker CLI was present but the Docker Desktop engine was not running, and no Java runtime was installed. `infra/node_modules` is absent, so `npm ci` in `infra/` must run before the infra type check.

## 3. Target architecture

### 3.1 Files

Legend: A = add, M = modify, R = `git mv` and then modify.

| Area | Files |
|---|---|
| shared | M `packages/shared/src/domain.ts`: add `USER_ROLES`, `AUDIT_RESULTS`, `THEMES`, `CHAT_MESSAGE_ROLES`, `CHAT_RATINGS` and their types. `AuditEvent` is unchanged. |
| backend config, errors | M `src/config/index.ts` (§6). M `src/lib/errors.ts`: add `PersistenceError` (§7.1). |
| repository core | A `src/repositories/types.ts` (§3.2), `index.ts` (registry, §3.3), `common.ts` (shared helpers, §4.5), `validation.ts` (zod schemas for new inputs, §7.3). |
| SQLite driver | R the six files in §2.1 → `src/repositories/sqlite/{alert,telemetry,user,ai,audit,integration}Repository.ts`. A `sqlite/{preferences,chat,health}Repository.ts` and `sqlite/index.ts`. |
| DynamoDB driver | A `src/repositories/dynamodb/{index,client,keys,items,ops,links,tableDefinition}.ts` and `dynamodb/{alert,telemetry,user,preferences,ai,audit,integration,chat,health}Repository.ts`. |
| DB tooling | A `src/db/migrations/002_dpi2_persistence_foundation.sql`, `src/db/dynamoTables.ts`, `src/db/migrateSqliteToDynamo.ts`, `src/db/cli.ts` (thin entry point for both DynamoDB CLIs, §9.5), `src/db/cliErrors.ts` (`CliPreconditionError`, no imports). M `src/db/seed.ts`, `reset.ts`, `migrate.ts`. |
| callers | M all 8 `src/services/*.ts`, `src/routes/{api,auth,health}Routes.ts`, `src/integrations/mock/MockDynamoDBAdapter.ts`, `src/server.ts`, `src/test/testDb.ts` (adds `resetRepositories()`), `src/test/setup.ts` (adds `process.env.DB_DRIVER = 'sqlite'`, so a shell-level `DB_DRIVER` cannot change the default suite). |
| tests | A the files in §8, including `src/test/repositoryHarness.ts`, `src/test/repositoryContract.ts`, `src/test/keySet.ts` and the fixture `src/routes/routes.baseline.json`, which §14 step 1 captures. M `repositories/alertCorrelation.test.ts`, `services/alertService.test.ts`, `services/authService.test.ts`, `services/chatService.test.ts` (the last three get the type-only edit of §8.4). |
| backend package | M `packages/backend/package.json`: dependencies, plus scripts `dynamo:tables` (`ts-node src/db/cli.ts tables`) and `dynamo:migrate` (`ts-node src/db/cli.ts migrate`). |
| root | M `package.json`: aliases `"dynamo:tables": "npm run dynamo:tables --workspace @urbani/backend --"` and the same pattern for `dynamo:migrate`. The trailing `--` forwards flags so npm does not swallow `--dry-run`. M `package-lock.json`, `docker-compose.yml`, `.env.example`, `.gitignore` (add `.tmp/`). A `docs/adr/0001-dynamodb-persistence.md`. |
| infra | M `config/index.ts`, `lib/persistence-construct.ts`, `lib/security-construct.ts`, `lib/dashboard-construct.ts`, `lib/urbani-dpi-stack.ts`, `README.md`, `package.json` (script `check`), `tsconfig.json` (`include` gains `test/**/*.ts`). A `test/app-table.check.ts` (§11). |

Untouched: `packages/frontend/**`, `deploy-ecs.sh`, `redeploy.sh`, `OUTPUT/`, every integration adapter except `MockDynamoDBAdapter.ts`, and the backend `tsconfig.json`/`vitest.config.ts`.

### 3.2 Repository interfaces (`src/repositories/types.ts`)

The legacy shapes `AlertFilter`, `LogFilter`, `AIAnalysisRecord`, `UserRow`, `RoleRow`, `AuthUser` and `IntegrationRow` move here unchanged, except that `UserRow` gains `role`. That way services and the API keep the exact types they use today.

```ts
import type {
  AlertStatus, AuditAction, AuditEvent, AuditResult, ChatMessageRole, ChatRating, DataSource,
  LogEntry, MetricSnapshot, PersistedAlert, ServiceSummary, Theme, UrbaniIncidentAlert,
  UsageRecord, UserRole,
} from '@urbani/shared';

export type DbDriver = 'sqlite' | 'dynamodb';
/** Legacy offset-paged result; total counts every match. */
export interface PageResult<T> { items: T[]; total: number }
/** DPI 2 cursor page; nextCursor is null exactly when there are no further items. */
export interface CursorPage<T> { items: T[]; nextCursor: string | null }
export interface CursorOptions { limit?: number; cursor?: string }
/** now() supplies every repository-generated timestamp (ISO-8601 UTC, ms). Default: new Date().toISOString(). */
export interface RepositoryOptions { now?: () => string }

// ---- Alerts ----
export interface AlertFilter {
  service?: string; environment?: string; severity?: string; anomalyType?: string; status?: string;
  search?: string; from?: string; to?: string; page?: number; pageSize?: number;
}
export interface AlertRepository {
  /** Full replace (REPLACE semantics, §2.5-1). Defaults: source 'MOCK', status 'OPEN'. */
  insert(alert: UrbaniIncidentAlert, source?: DataSource, status?: AlertStatus): Promise<void>;
  /** Body refreshed and dataSource set to LIVE; status/acknowledgedBy/acknowledgedAt preserved; new rows are OPEN. */
  upsertLivePreservingStatus(alert: UrbaniIncidentAlert): Promise<void>;
  findById(alertId: string): Promise<PersistedAlert | null>;
  query(filter: AlertFilter): Promise<PageResult<PersistedAlert>>;
  replaceDerivedEvidence(alertId: string, lines: string[]): Promise<void>;
  deleteByDataSource(source: DataSource): Promise<number>;
  acknowledge(alertId: string, actor: string): Promise<PersistedAlert | null>;
  /** New: same value as query({}).total, without loading children (dashboard). */
  countAll(): Promise<number>;
  countActive(): Promise<number>;
  countBySeverity(severity: string): Promise<number>;
}

// ---- Services, environments ----
export type ServiceInput = Pick<ServiceSummary,
  'id' | 'name' | 'environment' | 'status' | 'errorRate' | 'lastTelemetryAt' | 'lastIncidentAt'>;
export interface ServiceRepository {
  all(): Promise<ServiceSummary[]>;                      // ORDER BY name; alertCount computed
  findById(id: string): Promise<ServiceSummary | null>;
  count(): Promise<number>;
  upsert(service: ServiceInput, source: DataSource): Promise<void>;   // new (seed): INSERT OR REPLACE
}
export interface EnvironmentRecord { id: string; name: string; createdAt: string }
export interface EnvironmentRepository {
  ensure(env: { id: string; name: string }): Promise<void>;           // new (seed): INSERT OR IGNORE
  all(): Promise<EnvironmentRecord[]>;                                // ORDER BY name
}

// ---- Logs, metrics, usage ----
export interface LogFilter {
  service?: string; environment?: string; level?: string; search?: string; page?: number; pageSize?: number;
}
export interface LogRepository {
  query(filter: LogFilter): Promise<PageResult<LogEntry>>;
  byAlert(alertId: string): Promise<LogEntry[]>;
  clearAlertLinks(alertId: string): Promise<void>;
  linkLogsToAlert(alertId: string, logIds: string[]): Promise<void>;
  upsertMany(logs: LogEntry[], source: DataSource): Promise<void>;   // new (seed): INSERT OR REPLACE, clears link
}
export interface MetricFilter { service?: string; environment?: string; limit?: number }
export interface MetricRepository {
  query(filter: MetricFilter): Promise<MetricSnapshot[]>;
  upsertMany(metrics: MetricSnapshot[], source: DataSource): Promise<void>;   // new (seed)
}
export interface UsageRepository {
  all(): Promise<UsageRecord[]>;                                       // ORDER BY date DESC
  upsertMany(records: UsageRecord[], source: DataSource): Promise<void>;   // new (seed)
}

// ---- AI analyses ----
export interface AIAnalysisRecord {
  id: string; alertId: string | null; timestamp: string; service: string; environment: string;
  modelId: string; provider: string; anomalyType: string | null; confidence: number | null;
  finding: UrbaniIncidentAlert | null; inputTokens: number; outputTokens: number; dataSource: DataSource;
}
export type NewAIAnalysis = Omit<AIAnalysisRecord, 'id'> & { id?: string };
export interface AIAnalysisRepository {
  insert(rec: NewAIAnalysis): Promise<string>;
  query(opts: { page?: number; pageSize?: number }): Promise<PageResult<AIAnalysisRecord>>;
  findById(id: string): Promise<AIAnalysisRecord | null>;
  count(): Promise<number>;
}

// ---- Audit ----
export interface AuditEventRecord extends AuditEvent { result: AuditResult }
export interface AuditQuery { action?: string; actor?: string; page?: number; pageSize?: number }
export interface AuditRangeQuery extends CursorOptions { from?: string; to?: string; actor?: string }
export interface AuditRepository {
  /** result defaults to 'SUCCESS'. */
  record(actor: string, action: AuditAction, target?: string,
         metadata?: Record<string, unknown>, result?: AuditResult): Promise<void>;
  /** Legacy (GET /api/audit). Items are exactly AuditEvent: no `result` key (API shape parity). */
  query(opts: AuditQuery): Promise<PageResult<AuditEvent>>;
  /** New (item 3): newest first, inclusive bounds, optional actor (= by user). limit 1..200, default 50. */
  listByTimeRange(opts: AuditRangeQuery): Promise<CursorPage<AuditEventRecord>>;
}

// ---- Integrations ----
export interface IntegrationRow {
  id: string; kind: string; display_name: string; mode: string; status: string; config_json: string; updated_at: string;
}
export interface IntegrationRepository {
  all(): Promise<IntegrationRow[]>;          // ORDER BY kind
  upsert(row: IntegrationRow): Promise<void>; // new (seed): INSERT OR REPLACE
  delete(id: string): Promise<void>;          // new (seed): replaces the raw stale-row DELETE
}

// ---- Users, roles ----
export interface RoleRow { id: string; name: string; description: string | null; permissions: string; created_at: string }
export interface UserRow {
  id: string; email: string; display_name: string; password_hash: string; role_id: string;
  is_active: number; last_login_at: string | null; created_at: string;
  /** DPI 2 RBAC role. Stored only; AuthUser.role and the JWT still come from role_id → roles.name (item 2 decides the switch). */
  role: UserRole;
}
/** role omitted: new user → SUPER_ADMIN; existing user → stored role kept. */
export type UserUpsert = Omit<UserRow, 'role'> & { role?: UserRole };
export interface AuthUser { id: string; email: string; displayName: string; role: string; permissions: string[] }
export interface UserRepository {
  findByEmail(email: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
  getRole(roleId: string): Promise<RoleRow | null>;
  toAuthUser(user: UserRow): Promise<AuthUser>;
  recordLogin(id: string): Promise<void>;
  upsertRole(row: RoleRow): Promise<void>;
  upsertUser(row: UserUpsert): Promise<void>;
}

// ---- Preferences ----
export interface UserPreferences { userId: string; theme: Theme | null; widgetLayout: unknown; updatedAt: string } // widgetLayout null = unset
export interface PreferencesPatch { theme?: Theme | null; widgetLayout?: unknown }   // undefined = keep, null = clear
export interface PreferencesRepository {
  get(userId: string): Promise<UserPreferences | null>;
  update(userId: string, patch: PreferencesPatch): Promise<UserPreferences>;
}

// ---- Chat ----
export interface ChatSession {
  id: string; userId: string; title: string | null; service: string | null; environment: string | null;
  messageCount: number; createdAt: string; updatedAt: string;
}
export interface ChatMessage {
  id: string; sessionId: string; role: ChatMessageRole; content: string; citations: string[];
  provider: string | null; modelId: string | null; source: DataSource | null; latencyMs: number | null;
  inputTokens: number | null; outputTokens: number | null; createdAt: string;
}
export interface ChatFeedback {
  messageId: string; sessionId: string; userId: string; rating: ChatRating; comment: string | null;
  createdAt: string; updatedAt: string;
}
export interface NewChatSession { id?: string; userId: string; title?: string | null; service?: string | null; environment?: string | null }
export interface NewChatMessage {
  sessionId: string; role: ChatMessageRole; content: string; citations?: string[]; provider?: string | null;
  modelId?: string | null; source?: DataSource | null; latencyMs?: number | null;
  inputTokens?: number | null; outputTokens?: number | null;
}
export interface ChatFeedbackInput { sessionId: string; messageId: string; userId: string; rating: ChatRating; comment?: string | null }
export interface ChatRepository {
  createSession(input: NewChatSession): Promise<ChatSession>;
  getSession(sessionId: string): Promise<ChatSession | null>;
  /** Most recent activity first; limit 1..100, default 20. */
  listSessionsByUser(userId: string, opts?: CursorOptions): Promise<CursorPage<ChatSession>>;
  /** Message id is repository-generated and time-ordered (§4.5). */
  appendMessage(input: NewChatMessage): Promise<ChatMessage>;
  /** Oldest first; limit 1..500, default 200. */
  listMessages(sessionId: string, opts?: CursorOptions): Promise<CursorPage<ChatMessage>>;
  /** One feedback per message; create or update. */
  setFeedback(input: ChatFeedbackInput): Promise<ChatFeedback>;
  listFeedback(sessionId: string): Promise<ChatFeedback[]>;   // ordered by messageId
}

// ---- Health ----
export interface HealthRepository { ping(): Promise<void> }

export interface Repositories {
  readonly driver: DbDriver;
  alerts: AlertRepository; services: ServiceRepository; environments: EnvironmentRepository;
  logs: LogRepository; metrics: MetricRepository; usage: UsageRepository; aiAnalyses: AIAnalysisRepository;
  audit: AuditRepository; integrations: IntegrationRepository; users: UserRepository;
  preferences: PreferencesRepository; chat: ChatRepository; health: HealthRepository;
  /** SQLite: closeDb(); DynamoDB: client.destroy(). Used by CLIs and tests. */
  close(): Promise<void>;
}
```

These are added to `packages/shared/src/domain.ts` and exported through the existing `export * from './domain'`:

```ts
export const USER_ROLES = ['SUPER_ADMIN', 'INFRA_ADMIN', 'QA_OPERATOR', 'READER_AUDITOR'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const AUDIT_RESULTS = ['SUCCESS', 'FAILURE', 'DENIED'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const CHAT_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];
export const CHAT_RATINGS = ['LIKE', 'DISLIKE'] as const;
export type ChatRating = (typeof CHAT_RATINGS)[number];
```

The rule for placement: enum vocabularies that later items will show in the UI go to `shared`. New entity record types stay in the backend until the item that owns them exposes them over HTTP.

### 3.3 Registry, startup selection, caller access, test injection

`src/repositories/index.ts` copies the shape of `integrations/index.ts`:

```ts
let cached: Repositories | null = null;

function build(): Repositories {
  if (config.db.driver === 'dynamodb') {
    const { tableName, endpoint } = config.db.dynamodb;
    logger.info('Persistence driver: dynamodb', { table: tableName, region: config.aws.region, endpoint: endpoint ?? 'aws-default-chain' });
    if (endpoint && config.isProd) logger.warn('DYNAMODB_ENDPOINT override is set in production', { endpoint });
    return createDynamoRepositories(createDynamoContext({ region: config.aws.region, endpoint, tableName }));
  }
  logger.info('Persistence driver: sqlite', { path: config.db.sqlitePath });
  return createSqliteRepositories();
}
export function getRepositories(): Repositories { return (cached ??= build()); }
export function setRepositoriesForTesting(overrides: Partial<Repositories>): void { cached = { ...(cached ?? build()), ...overrides }; }
export function resetRepositories(): void { cached = null; }
export * from './types';
```

- **Driver selection.** The choice happens once, on the first `getRepositories()` call. `server.ts` makes that call at startup, so a bad configuration fails immediately. Note that the real config key is `config.db.driver`; the brief calls it `config.dbDriver`. Constructing the DynamoDB repositories creates an SDK client but makes no network call. Credentials resolve lazily on the first request.
- **Callers.** Callers use `const repos = getRepositories();` inside each function, never at module scope, and then `await repos.alerts.query(...)`. They do not destructure, because `correlateLiveAlerts(alerts, …)` already has a parameter named `alerts` and destructuring would shadow it.
- **Tests.** `test/testDb.ts` `freshTestDb()` additionally calls `resetRepositories()`, so the next `getRepositories()` returns SQLite repositories on the fresh in-memory database. SQLite repositories call `getDb()` on every method call, as today, so `setDbForTesting` keeps working. Tests swap a single repository with `setRepositoriesForTesting({ audit: fake })` and call `resetRepositories()` in `afterEach`. The contract, migration and seed-on-DynamoDB tests build repositories directly with the factories.
- **Factories.** `createSqliteRepositories(opts?: RepositoryOptions): Repositories` lives in `sqlite/index.ts`. `createDynamoContext({ region, endpoint, tableName }): DynamoContext` lives in `dynamodb/client.ts`. `createDynamoRepositories(ctx: DynamoContext, opts?: RepositoryOptions): Repositories` lives in `dynamodb/index.ts`. Each repository file exports a factory such as `sqliteAlertRepository(ctx)`. Repositories are built from closures over local functions, not object literals that use `this`, so `acknowledge` and `toAuthUser` call local `findById` and `getRole` functions.
- **Startup probe.** `repositories/index.ts` also exports:

  ```ts
  /** DynamoDB startup probe (server.ts, §9.4). Resolves when health.ping succeeds. A PersistenceError with
   *  fatal: true (table missing, access denied, bad credentials) is rethrown; any other error is logged at warn
   *  ('DynamoDB not reachable at startup; /ready reports 503 until it is', { awsError }) and swallowed. */
  export async function assertDynamoReachable(repos: Repositories): Promise<void>;
  ```

### 3.4 Caller conversion

Every repository call becomes `await repos.<entity>.<method>(...)`. Service functions that were synchronous become `async` and declare `Promise<...>` return types. Statement order and `try`/`catch` placement stay as they are; independent calls are not parallelized. The per-file changes:

- `alertService.ts`:
  - `syncLiveAlerts` awaits `deleteByDataSource` and awaits each upsert in the existing sequential loop. A failure still aborts the rest of the sync into the existing `catch`.
  - `correlateLiveAlerts` awaits the three calls inside the existing per-alert `try`.
  - `get` is typed `Promise<Sourced<PersistedAlert & { relatedLogs: LogEntry[] }>>`.
  - The header comment changes from "into SQLite" to "into the configured store". This is comment-only.
- `telemetryService.ts`: `metrics`, `services` and `service` become async.
- `aiService.ts`: `listAnalyses` and `getAnalysis` become async. `analyze` awaits the four repository calls.
- `chatService.ts`: awaits all calls. The failure-path `record(...)` at line 80 passes `'FAILURE'` as its fifth argument. This is the only call site whose recorded data changes. It keeps the new `result` column truthful.
- `dashboardService.ts`: `summary` and `health` become async. `recentIncidents` becomes `await repos.alerts.countAll()`, which returns the same number as `query({pageSize:200}).total` without loading the children of up to 200 alerts. `health` is typed `Promise<Sourced<{ services: ServiceSummary[]; recentMetrics: MetricSnapshot[] }>>`, replacing `ReturnType<typeof serviceRepository.all>` (line 38), which would become a `Promise` type.
- `usageService.ts`: `usage` and `cost` become async.
- `settingsService.ts`: `get` and `update` become async.
- `authService.ts`: `login` awaits its calls. `me` and `logout` become async. `verify` stays synchronous because `requireAuth` uses it.
- `apiRoutes.ts`: lines 32, 36, 93, 100, 104, 111, 116, 158, 159, 180 and 184 change to `res.json(await …)`. Line 170 becomes `await getRepositories().audit.query(q)`.
- `authRoutes.ts`: lines 36 and 45 await.
- `healthRoutes.ts`: the `/ready` handler becomes `async`. It wraps `await getRepositories().health.ping()` in the existing try/catch, so the response body is unchanged.
- `MockDynamoDBAdapter.ts`: its three methods await `getRepositories().alerts.*`. Provenance stays `MOCK`.
- `server.ts`: `main` becomes async (§9.4).
- `db/seed.ts`: §9.3.

Every repository promise must be awaited or returned. On Node 20 an unhandled rejection terminates the process, so a floating repository call that fails would crash the API. Verification checks this (§14, step 4).

## 4. SQLite driver

### 4.1 Strategy
Each of the six existing files moves to `repositories/sqlite/` and becomes a factory that returns the interface:
- method bodies keep their SQL and their synchronous transactions verbatim, wrapped as `async` methods;
- `new Date().toISOString()` inside the repositories becomes `ctx.now()`, which by default is the same expression;
- `rowToAlert`, `mapService`, `mapMetric` and `mapRow` keep their per-row child queries.

Nothing in the SQL changes, except the `upsertUser` SQL (§4.3) and the `role`/`result` columns that the new migration adds.

### 4.2 Methods that absorb the seed's raw SQL
These reproduce the statements in `db/seed.ts`. `upsertMany` methods run their statements in one synchronous transaction; the seed ran them as autocommit statements, and the end state is identical.
- `services.upsert`: `INSERT OR REPLACE INTO services (id, name, environment, status, error_rate, last_telemetry_at, last_incident_at, data_source, created_at)`.
- `environments.ensure`: `INSERT OR IGNORE INTO environments (id, name, created_at)`.
- `environments.all`: `SELECT … ORDER BY name`.
- `logs.upsertMany`: `INSERT OR REPLACE INTO log_references (id, timestamp, level, service, environment, message, data_source)`. The omitted `alert_id` resets to NULL, as today.
- `metrics.upsertMany`: `INSERT OR REPLACE INTO metric_snapshots (…)`, with `alert_id` NULL.
- `usage.upsertMany`: `INSERT OR REPLACE INTO usage_records (…)`.
- `integrations.upsert`: `INSERT OR REPLACE INTO integrations (id, kind, display_name, mode, status, config_json, updated_at)`.
- `integrations.delete`: `DELETE FROM integrations WHERE id = ?`.
- `alerts.countAll`: `SELECT COUNT(*) AS c FROM alerts`.

### 4.3 Users: role column and the upsert fix
`findByEmail`, `findById` and `getRole` are unchanged. Their `SELECT *` now also returns `role`. `upsertUser` becomes:

```sql
INSERT INTO users (id, email, display_name, password_hash, role_id, is_active, last_login_at, created_at, role)
VALUES (@id, @email, @display_name, @password_hash, @role_id, @is_active, @last_login_at, @created_at, COALESCE(@role, 'SUPER_ADMIN'))
ON CONFLICT(id) DO UPDATE SET
  email = excluded.email, display_name = excluded.display_name, password_hash = excluded.password_hash,
  role_id = excluded.role_id, is_active = excluded.is_active, last_login_at = excluded.last_login_at,
  created_at = excluded.created_at, role = COALESCE(@role, users.role)
```

`@role` is `null` when the caller omits it. Before binding, `role` is validated against `USER_ROLES`, and an invalid value raises `PersistenceError` `INVALID_ARGUMENT`. The CHECK constraint is the backstop. This statement was run on SQLite 3.49.2. A new row defaults to SUPER_ADMIN, an omitted role keeps the stored one, and the user's preferences row survives. A duplicate email is rejected with `SQLITE_CONSTRAINT_UNIQUE` and the other user is left untouched.

This is the one deliberate SQLite semantic change (requirements FR2.5). A same-id upsert has the same effect as before. An upsert that collides with another user's email now fails with the SQLite UNIQUE error, where today it silently deletes the other user. No application flow can reach this path: the seed is guarded by `findByEmail` and no code ever deactivates a user. The change also aligns SQLite with the DynamoDB lock-item semantics.

`upsertRole` keeps `INSERT OR REPLACE`. A same-id replace is safe because the row is re-inserted within the same statement and foreign keys are checked at the end of the statement.

### 4.4 Migration `002_dpi2_persistence_foundation.sql`
`runMigrations` applies the file once, inside its existing transaction, and records it in `schema_migrations`. The ADD COLUMN with CHECK, the defaulting of existing rows and the guarded `json_extract` backfill were all verified on SQLite 3.49.2. The migration is backward compatible: DPI 1 code names its INSERT columns explicitly and ignores extra columns from `SELECT *`.

```sql
-- Migration 002 — DPI 2 persistence foundation (item 1). Forward-only.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'SUPER_ADMIN'
  CHECK (role IN ('SUPER_ADMIN','INFRA_ADMIN','QA_OPERATOR','READER_AUDITOR'));

ALTER TABLE audit_events ADD COLUMN result TEXT NOT NULL DEFAULT 'SUCCESS'
  CHECK (result IN ('SUCCESS','FAILURE','DENIED'));
-- Failed chat turns were recorded with metadata.outcome = 'unavailable'. The CASE guard keeps
-- malformed JSON from aborting the migration (json_extract throws on it).
UPDATE audit_events SET result = 'FAILURE'
 WHERE CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.outcome') END = 'unavailable';
CREATE INDEX idx_audit_actor_ts ON audit_events (actor, timestamp DESC);

-- user_id deliberately has NO foreign key to users, so no write to users can cascade into
-- preferences/chats. That includes DPI 1 code's INSERT OR REPLACE on a migrated DB. It also
-- matches DynamoDB, which has no cascades. Both drivers check user existence explicitly.
CREATE TABLE user_preferences (
  user_id            TEXT PRIMARY KEY,
  theme              TEXT CHECK (theme IN ('light','dark')),
  widget_layout_json TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT,
  service       TEXT,
  environment   TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_chat_sessions_user ON chat_sessions (user_id, updated_at DESC, id DESC);

CREATE TABLE chat_messages (
  id             TEXT PRIMARY KEY,  -- time-ordered: <13-digit epoch ms>-<uuid>
  session_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content        TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  provider       TEXT,
  model_id       TEXT,
  data_source    TEXT CHECK (data_source IN ('LIVE','MOCK','WAITING_FOR_INTEGRATION')),
  latency_ms     INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_session ON chat_messages (session_id, id);

CREATE TABLE chat_feedback (
  message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  rating     TEXT NOT NULL CHECK (rating IN ('LIKE','DISLIKE')),
  comment    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chat_feedback_session ON chat_feedback (session_id, message_id);
```

### 4.5 New entities on SQLite and the shared helpers
Each new write method validates its input first with the shared zod schemas (§7.3), then runs its checks and writes in one synchronous transaction. Both drivers raise the same `PersistenceError`.

- **Audit.**
  - `record` adds the `result` column to its INSERT; the value defaults to `'SUCCESS'` and is validated.
  - `query` keeps its SQL and its `rowTo` mapper, which never emits `result`.
  - `listByTimeRange` runs:

    ```sql
    SELECT * FROM audit_events
     WHERE (@from IS NULL OR timestamp >= @from)
       AND (@to IS NULL OR timestamp <= @to)
       AND (@actor IS NULL OR actor = @actor)
       AND [cursor: (timestamp < @cts OR (timestamp = @cts AND id < @cid))]
     ORDER BY timestamp DESC, id DESC
     LIMIT @limit + 1
    ```

    The extra row decides whether `nextCursor` is set. Before the query, `validation.ts` validates and normalizes the options and decodes the cursor with the audit cursor schema, which includes the `from <= ts <= to` check (§7.3). An out-of-range cursor therefore raises `INVALID_CURSOR` on SQLite too, although SQLite could simply return rows, so both drivers answer the same.
- **"User exists".** The new tables have no foreign key to `users` (FR2.4). A user exists when a `users` row with that id exists, whatever `is_active` is. That is what a foreign key would check; being active is an authentication rule. Preferences, `createSession` and `setFeedback` check `SELECT 1 FROM users WHERE id = ?`. No code deletes users in item 1, so these checks cannot race with a delete.
- **Preferences.** `get` validates `userId` (§7.3) and selects the row. `update` runs in one transaction:
  1. check that the user exists, otherwise `REFERENCE_NOT_FOUND`;
  2. read the current row and merge the patch (`undefined` keeps a field, `null` clears it);
  3. write with `INSERT … ON CONFLICT(user_id) DO UPDATE`.
  `widgetLayout` is stored as `JSON.stringify(value)`.
- **Chat.**
  - `createSession` sets `id = input.id ?? randomUUID()`, checks that the user exists (otherwise `REFERENCE_NOT_FOUND`), rejects a duplicate id with `DUPLICATE`, then runs a plain INSERT.
  - `appendMessage` checks that the session exists, otherwise `REFERENCE_NOT_FOUND`. It inserts the message and runs `UPDATE chat_sessions SET updated_at = @now, message_count = message_count + 1 WHERE id = @sessionId`.
  - `setFeedback` checks `SELECT 1 FROM chat_messages WHERE id = ? AND session_id = ?` and `SELECT 1 FROM users WHERE id = ?`; either miss raises `REFERENCE_NOT_FOUND`. It then runs `INSERT … ON CONFLICT(message_id) DO UPDATE SET rating, comment, user_id, updated_at`, which keeps `created_at`, and re-selects the row. The two checks, the write and the re-select run in one synchronous transaction.
  - The read methods `getSession`, `listSessionsByUser`, `listMessages` and `listFeedback` validate their `userId`/`sessionId` argument (1–128 characters, §7.3) before querying, so both drivers reject the same inputs with `INVALID_ARGUMENT`.
  - The list methods use the keyset pagination of the indexes above: sessions by `(updated_at DESC, id DESC)`, messages by `id ASC`, feedback by `message_id`.
- **Health.** `ping` runs `getDb().prepare('SELECT 1').get()`, which is today's readiness check.
- **`src/repositories/common.ts`** holds helpers shared by both drivers:
  - `clampPage(page, pageSize, defaultSize)` mirrors §2.5-7.
  - `compareBinary(a, b)` is `Buffer.compare` on UTF-8, which equals SQLite BINARY collation.
  - `compileLike(term)` emulates SQLite `LIKE '%term%'` with a linear matcher and no regular expression built from input. A regex mapping of `%` to a backtracking wildcard took 56.9 s on one pathological term in the review (finding 1), so it is not used. `alerts.query` and `logs.query` compile the term once per request; `likeContains(value, term)` is `compileLike(term)(value)`.

    ```ts
    /** SQLite `LIKE '%term%'` without regex: ASCII-only case folding, `_` = one code point, `%` = any run.
     *  The `%`-separated segments are matched left to right, each at its leftmost position. Each segment has a
     *  fixed length in code points, so the leftmost placement never blocks a later segment and the result
     *  equals LIKE without backtracking. Cost per value: O(|value| · |term|) code-point comparisons. */
    export function compileLike(term: string): (value: string) => boolean {
      const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
      const segments = fold(term).split('%').filter((s) => s !== '').map((s) => Array.from(s));
      const minLength = segments.reduce((n, p) => n + p.length, 0);
      return (value: string): boolean => {
        const text = Array.from(fold(value));
        if (text.length < minLength) return false;           // segments never overlap
        let pos = 0;
        for (const p of segments) {
          let hit = -1;
          for (let i = pos; hit < 0 && i + p.length <= text.length; i++) {
            let j = 0;
            while (j < p.length && (p[j] === '_' || p[j] === text[i + j])) j++;
            if (j === p.length) hit = i;
          }
          if (hit < 0) return false;
          pos = hit + p.length;
        }
        return true;
      };
    }
    ```

    The only regex is the constant `/[A-Z]/g`. Measured on this machine with Node 24 and better-sqlite3 11.10 (SQLite 3.49.2):
    - 247,000 random (value, term) pairs gave 0 mismatches against `SELECT ? LIKE ?`. The alphabet covered ASCII letters in both cases, `é`/`É`, an astral emoji, `%`, `_` and `. * ( [`, in terms and in values.
    - The review's pathological term `%e%e%e%e%e%e%e%e%z` returned `false` in 0.8 ms.
    - Three crafted 1,000-character terms against a 2,000-character value took 0.8–4.8 ms; SQLite took 0.04–1.6 ms on the same inputs.

    SQLite's `LIKE` also does per-row work that grows with value length times term length, so the DynamoDB driver's exposure stays within a small constant factor of DPI 1's.
  - `encodeCursor(parts: string[])` / `decodeCursor(cursor, schema)` encode base64url JSON `{ v: 1, k: [...] }`. `schema` is the per-list zod tuple from `validation.ts`: audit, sessions or messages (§7.3). Any decode or schema failure throws `INVALID_CURSOR`.
  - `newTimeOrderedId(nowIso)` returns `<epoch ms zero-padded to 13>-<randomUUID>`. A per-process guard makes it strictly increasing (when `ms <= last`, it uses `last + 1`).
  - `buildAuthUser(user, role)` holds the role-name and permission-parsing logic that `toAuthUser` uses today.

## 5. DynamoDB driver

### 5.1 Decision: one table, one overloaded GSI
Three models are viable: one table per entity (about 15 tables), a single table, or a hybrid with alerts in the existing `UrbaniAlerts` table and everything else in new tables.

The access patterns in §5.3 decide between them:

- **Collection reads.** Every legacy list endpoint (alerts, logs, metrics, AI analyses, audit, services, usage, integrations) reads a whole entity collection and then filters, sorts, counts and pages it to match the SQL. In DynamoDB that is one Query on a constant partition key per entity type. Per-entity tables would need the same constant-key partitions, or Scans, just spread over 15 tables.
- **The alert relationship.** It spans three entity types: logs, metrics and analyses point at an alert, and alert replace or delete must unlink all of them. A single table serves this with one reverse index (`ALERTLINK#<alertId>`) and one query per alert. Per-entity tables would need a GSI on each of three tables and three queries per cascade.
- **Transactions.** The writes that need transactions (user + email lock, chat message + session counter, feedback + message check) touch different entity types. They are simpler within one table.
- **Operations.** One table means one CDK resource with CMK, PITR and RETAIN; one IAM resource pair; one create call for local tooling and tests; one isolated test table per run; and one migration target.
- **Cost.** On-demand pricing is per request, and PITR is per GB, so the number of tables does not change cost. One GSI means less write amplification than the 3 to 5 GSIs a per-entity design needs.

The single table has costs. Keys are less readable in the console, so the key schema lives in one module (`dynamodb/keys.ts`) and in the ADR. Throughput, backup and restore cannot be separated per entity. A future Streams consumer (item 6) receives every entity type and must filter on `entityType = 'ALERT'`, which Lambda event filtering supports. The hybrid option is rejected in §5.9.

**Chosen:** a single table named `${DYNAMODB_TABLE_PREFIX}App`, `UrbaniApp` by default:
- keys: `PK` (S) as partition key and `SK` (S) as sort key;
- one GSI, `GSI1`, with `GSI1PK` (S) and `GSI1SK` (S) and projection ALL;
- on-demand billing.

Every item except the never-written health sentinel carries an `entityType` attribute. The §5.4 rule "`entityType` on every item" covers every write path that can create an item, including three UpdateItems, and tests pin it (§8.3). Entities that are always read as a whole collection use the entity type as the partition key (`PK = 'ALERT'`, `SK = <alertId>`), so list reads can be strongly consistent base-table Queries. The chat aggregate (session, messages, feedback) uses a per-session partition (`PK = CHAT#<sessionId>`).

### 5.2 Key schema

| Entity (`entityType`) | PK | SK | GSI1PK | GSI1SK | Attributes |
|---|---|---|---|---|---|
| Role `ROLE` | `ROLE` | `<roleId>` | – | – | `id, name, description, permissions` (JSON string, as in SQLite), `createdAt` |
| User `USER` | `USER` | `<userId>` | – | – | `id, email, displayName, passwordHash, roleId, role, isActive` (BOOL, written as `row.is_active === 1`, because SQLite treats only `1` as active; read back as `is_active: isActive ? 1 : 0`), `lastLoginAt, createdAt` |
| Email lock `USER_EMAIL` | `USER_EMAIL` | `<email>` (exact case) | – | – | `userId` |
| Preferences `PREFS` | `PREFS` | `<userId>` | – | – | `userId, theme, widgetLayoutJson, updatedAt` |
| Audit event `AUDIT` | `AUDIT` | `<timestamp>#<id>` | `ACTOR#<actor>` | `<timestamp>#<id>` | `id, timestamp, actor, action, target, metadata` (JSON string or null), `result, createdAt` |
| Alert `ALERT` | `ALERT` | `<alertId>` | `ALERTSRC#<dataSource>` | `<alertId>` | all `UrbaniIncidentAlert` fields, `evidence` (L of S), `recommendedActions` (L of S), `status, acknowledgedBy, acknowledgedAt, dataSource, createdAt` |
| Service `SERVICE` | `SERVICE` | `<id>` | – | – | `id, name, environment, status, errorRate, lastTelemetryAt, lastIncidentAt, dataSource, createdAt` |
| Environment `ENVIRONMENT` | `ENVIRONMENT` | `<id>` | – | – | `id, name, createdAt` |
| Log reference `LOG` | `LOG` | `<id>` | `ALERTLINK#<alertId>`, only while linked | `LOG#<timestamp>#<id>`, always | `id, timestamp, level, service, environment, message, dataSource, alertId` |
| Metric snapshot `METRIC` | `METRIC` | `<id>` | `ALERTLINK#<alertId>`, only while linked | `METRIC#<timestamp>#<id>` | the `MetricSnapshot` fields, `dataSource, alertId` |
| AI analysis `AI_ANALYSIS` | `AI_ANALYSIS` | `<id>` | `ALERTLINK#<alertId>` when `alertId` is set | `AI#<timestamp>#<id>` | the `AIAnalysisRecord` fields, `findingJson` (JSON string, as SQLite), `createdAt` |
| Usage record `USAGE` | `USAGE` | `<date>#<modelId>` | – | – | `id, date, modelId, aiRequestCount, inputTokens, outputTokens, estimatedCostUsd, dataSource` |
| Integration `INTEGRATION` | `INTEGRATION` | `<id>` | – | – | `id, kind, displayName, mode, status, configJson, updatedAt` |
| Chat session `CHAT_SESSION` | `CHAT#<sessionId>` | `SESSION` | `CHATUSER#<userId>` | `<updatedAt>#<sessionId>` | `id, userId, title, service, environment, messageCount, createdAt, updatedAt` |
| Chat message `CHAT_MESSAGE` | `CHAT#<sessionId>` | `MSG#<messageId>` | – | – | the `ChatMessage` fields; `citations` is L of S |
| Chat feedback `CHAT_FEEDBACK` | `CHAT#<sessionId>` | `FEEDBACK#<messageId>` | – | – | `messageId, sessionId, userId, rating, comment, createdAt, updatedAt` |
| Health sentinel | `HEALTH` | `PING` | – | – | never written; GetItem only |

Every item except the health sentinel also carries `entityType`, set to the value in the first column. An email lock, for example, is `{ PK: 'USER_EMAIL', SK: <email>, entityType: 'USER_EMAIL', userId }`. `keys.ts` exports the 16 values as `ENTITY_TYPES`.

A GSI only indexes items that have both of its key attributes. The `ALERTLINK` entries are therefore sparse: logs and metrics always carry `GSI1SK`, and get `GSI1PK` only while linked. The usage SK is the natural key `(date, modelId)`. That reproduces the `UNIQUE(date, model_id)` half of SQLite's REPLACE behavior, but not the `id` half (§2.5, accepted divergences). It is also the key that future per-day usage counters would update. No item's keys are ever parsed back; ids and timestamps are always stored as separate attributes. Each item-to-record mapper emits exactly the keys that the SQLite mapper for that entity emits (for example `rowTo` in `auditRepository.ts` always emits `target` and `metadata`, as `null` when empty), with `null` where the attribute is absent or NULL. A DynamoDB response therefore has the same JSON keys as the SQLite one; the key-set comparison of §14 step 8.6 depends on this. The repository generates all audit timestamps as `toISOString()` strings, and normalizes caller-supplied range bounds the same way, so lexicographic order equals time order.

### 5.3 Access patterns

"Strong" means `ConsistentRead: true` on a base-table read. Reads on `GSI1` are always eventually consistent, and a GSI Query never sets `ConsistentRead`, because DynamoDB rejects it. Every Query goes through one of three helpers in `dynamodb/ops.ts` (§5.7), named in the table: `queryAll` reads every page, `queryCount` sums `Select: 'COUNT'` over every page, and `queryUpTo(n)` reads pages until it has n items. No repository sends a `QueryCommand` itself. "Filter in memory" means applying the shared predicates (equality, `compareBinary` ranges, `compileLike`) that mirror the SQL WHERE clauses, then sorting with `compareBinary` and paging with `clampPage`.

| # | Access pattern | Caller | DynamoDB operation | Consistency |
|---|---|---|---|---|
| 1 | Get role by id | `users.toAuthUser` ← `authService.login`/`me` | GetItem `ROLE`/`<id>` | strong |
| 2 | Upsert role | seed, migration | PutItem | – |
| 3 | Active user by email | `authService.login`, seed | GetItem `USER_EMAIL`/`<email>`, then always a second GetItem `USER`/`<lock?.userId ?? '#none'>`, so known and unknown emails cost the same two calls. The user is returned only if its stored email equals `email` and `isActive` (§5.4) | strong |
| 4 | Active user by id | `authService.me` | GetItem `USER`/`<id>` | strong |
| 5 | Record login | `authService.login` | UpdateItem SET `lastLoginAt`, condition `attribute_exists(PK)`; a condition failure is a no-op | – |
| 6 | Upsert user, unique email | seed, tests, item 2 | GetItem current user, then TransactWriteItems: Put user with condition `attribute_not_exists(PK)` (new user) or `email = :prevEmail` (existing user); Put lock (`items.emailLockItem`, which carries `entityType` and `userId`) with condition `attribute_not_exists(PK) OR userId = :id`; Delete the old lock with condition `userId = :id` if the email changed. Cancellation handling in §5.4 | strong |
| 7 | List users | item 2 | **Not implemented in item 1.** The key schema serves it with `queryAll` Query `PK = USER`; item 2 adds `users.list()` | strong |
| 8 | Get preferences | items 10, 12 | GetItem `PREFS`/`<userId>` | strong |
| 9 | Patch preferences | items 10, 12 | GetItem `USER`/`<userId>` (exists, whatever `isActive`), then UpdateItem SET the supplied fields, `updatedAt`, `#userId = :userId` and `#entityType = :prefs`, so an item created by this call is complete. ReturnValues ALL_NEW | strong check |
| 10 | Record audit event | auth, alert, chat, settings services | PutItem `AUDIT`/`<ts>#<id>` with condition `attribute_not_exists(PK)`; on a condition failure the id is regenerated once | – |
| 11 | Audit list (action?, actor?), paged with total | `GET /api/audit` | No actor: `queryAll` Query `PK = AUDIT`, descending. With actor: `queryAll` Query GSI1 `GSI1PK = ACTOR#<actor>`, descending. Action filter, count and slice in memory | strong / eventual (actor) |
| 12 | Audit by time range | item 3 (`listByTimeRange`) | `queryUpTo(limit + 1)` Query `PK = AUDIT AND SK BETWEEN :from AND :to$`, descending, `ExclusiveStartKey` from a validated cursor | strong |
| 13 | Audit by user and range | item 3 | `queryUpTo(limit + 1)` Query GSI1 `GSI1PK = ACTOR#<actor> AND GSI1SK BETWEEN …`, descending | eventual |
| 14 | Insert or replace alert | seed, `MockDynamoDBAdapter.putAlert` ← `aiService.analyze` | `unlinkAll(id)` (§5.4), then PutItem | – |
| 15 | Upsert live alert, preserving lifecycle | `syncLiveAlerts` | `unlinkAll(id)`, then UpdateItem SET body… (including `entityType`), `#status = if_not_exists(#status, :open)` | – |
| 16 | Alert by id with children and related ids | `alertService.get`/`acknowledge`, mock adapter | GetItem `ALERT`/`<id>` plus `queryAll` Query GSI1 `ALERTLINK#<id>` | strong (alert) / eventual (links) |
| 17 | Filtered, paged alert list with total | `alertService.list`, mock adapter | `queryAll` Query `PK = ALERT`, filter in memory, then the pattern-16 link query for the page items only | strong |
| 18 | Replace derived evidence | `correlateLiveAlerts` | UpdateItem SET `evidence`, condition `attribute_exists(PK)` | – |
| 19 | Delete by data source, with cascade | `syncLiveAlerts` | `queryAll` Query GSI1 `ALERTSRC#<src>`, then per id: `unlinkAll` and a conditional DeleteItem | eventual (selection) |
| 20 | Acknowledge OPEN → ACKNOWLEDGED | `alertService.acknowledge` | UpdateItem with condition `attribute_exists(PK) AND #status = :open`, ReturnValues ALL_NEW | – |
| 21 | Count all / active / by severity | `dashboardService.summary` | `queryCount` Query `PK = ALERT`, with FilterExpression for active/severity | strong |
| 22 | Services sorted by name, with alertCount | `telemetryService.services`, dashboard | `queryAll` Query `PK = SERVICE`, plus `queryAll` Query `PK = ALERT` with ProjectionExpression `service`, grouped in memory | strong |
| 23 | Service by id | `telemetryService.service` | GetItem `SERVICE`/`<id>` plus `queryCount` Query `PK = ALERT`, filter `service = :name` | strong |
| 24 | Count services | dashboard | `queryCount` Query `PK = SERVICE` | strong |
| 25 | Upsert service / ensure environment | seed, migration | PutItem / PutItem with condition `attribute_not_exists(PK)`; only `ConditionalCheckFailedException` is ignored | – |
| 26 | Logs query with total | `aiService.analyze` | `queryAll` Query `PK = LOG`, filter in memory | strong |
| 27 | Logs by alert, newest first | `alertService.get` | `queryAll` Query GSI1 `ALERTLINK#<id>`, `begins_with(GSI1SK,'LOG#')`, descending | eventual |
| 28 | Clear log links of an alert | `correlateLiveAlerts` | Pattern 27 selection, then UpdateItem REMOVE `alertId`, `GSI1PK` with condition `alertId = :id` | eventual (selection) |
| 29 | Link logs to an alert | `correlateLiveAlerts` | `batchGetAll` the log keys; if any exist, GetItem the alert, then conditional UpdateItem per existing log | strong |
| 30 | Bulk upsert logs / metrics / usage | seed | `batchWriteAll` PutRequests, deduplicated by key | – |
| 31 | Metrics query (limit, newest first) | `telemetryService.metrics`, dashboard health, `aiService.analyze` | `queryAll` Query `PK = METRIC`, filter in memory, then slice | strong |
| 32 | Usage, newest date first | `usageService.usage`/`cost` | `queryAll` Query `PK = USAGE`, `ScanIndexForward=false` | strong |
| 33 | Insert AI analysis | `aiService.analyze`, `chatService.ask` | If `alertId` is set: GetItem the alert (must exist). Then PutItem with condition `attribute_not_exists(PK)` | strong check |
| 34 | AI analyses, paged with total | `aiService.listAnalyses` | `queryAll` Query `PK = AI_ANALYSIS`, sort and slice in memory | strong |
| 35 | AI analysis by id | `aiService.getAnalysis`/`analyze` | GetItem | strong |
| 36 | Count analyses | dashboard | `queryCount` Query `PK = AI_ANALYSIS` | strong |
| 37 | Integrations sorted by kind | `settingsService.get`, seed | `queryAll` Query `PK = INTEGRATION`, sort in memory | strong |
| 38 | Upsert / delete integration | seed | PutItem / DeleteItem | – |
| 39 | Create chat session | item 7 | GetItem `USER`/`<userId>` (exists, whatever `isActive`), then PutItem with condition `attribute_not_exists(PK)` | strong check |
| 40 | Get chat session | item 7 | GetItem `CHAT#<id>`/`SESSION` | strong |
| 41 | A user's sessions, most recent first | item 7 | `queryUpTo(limit + 1)` Query GSI1 `CHATUSER#<userId>`, descending | eventual |
| 42 | Append message | item 7 | TransactWriteItems: Put message with condition `attribute_not_exists(PK)`; Update session with condition `attribute_exists(PK)`, SET `updatedAt`, `GSI1SK`, ADD `messageCount :1` | – |
| 43 | Messages, oldest first | item 7 | `queryUpTo(limit + 1)` Query `PK = CHAT#<id> AND begins_with(SK,'MSG#')`, ascending | strong |
| 44 | Set feedback | item 7 | TransactWriteItems: ConditionCheck the message exists; ConditionCheck `USER`/`<userId>` exists (whatever `isActive`); Update the feedback (its SET includes `entityType`), keeping `createdAt` via `if_not_exists`. Then GetItem the feedback | strong |
| 45 | Session feedback | item 7 | `queryAll` Query `PK = CHAT#<id> AND begins_with(SK,'FEEDBACK#')` | strong |
| 46 | Readiness ping | `/ready`, server start, seed | GetItem `HEALTH`/`PING` with `ConsistentRead: true` and a 2 s `AbortSignal` | strong |
| 47 | Environments sorted by name | contract tests, migration check | `queryAll` Query `PK = ENVIRONMENT` | strong |

### 5.4 Operation algorithms (non-trivial cases)

Every expression uses `#name` placeholders, because many attribute names here are DynamoDB reserved words (`timestamp`, `status`, `name`, `role`, `result`, `level`, `date`, `comment`, `source`, `action`). Every UpdateItem that mirrors a SQL `UPDATE` carries `attribute_exists(#pk)`, so it can never create a phantom item.

- **Rule: `entityType` on every item.** Every write that can create an item sets `entityType`. Item 6's Streams filter (§5.1) then sees every item, and no backfill is ever needed.
  - Every PutItem, transactional Put and `batchWriteAll` PutRequest builds its item with an `items.ts` builder. Each of the 16 builders sets `entityType` to its §5.2 value: `roleItem`, `userItem`, `emailLockItem`, `preferencesItem`, `auditItem`, `alertItem`, `serviceItem`, `environmentItem`, `logItem`, `metricItem`, `usageItem`, `analysisItem`, `integrationItem`, `chatSessionItem`, `chatMessageItem` and `feedbackItem`. The migration Puts `preferencesItem` and `feedbackItem` items (§10). The driver creates those two entities with the UpdateItems below, which set the same attributes.
  - Three UpdateItems can create an item, because they have no existence condition: `upsertLivePreservingStatus`, `preferences.update` and `chat.setFeedback` [2]. Each one SETs `#entityType = :entityType` (`'ALERT'`, `'PREFS'`, `'CHAT_FEEDBACK'`) on every call, which is idempotent. `preferences.update` also SETs `#userId = :userId`, so `preferences.get()` returns `userId` from an attribute and never parses a key (§5.2).
  - Every other UpdateItem requires the item to exist: `attribute_exists(#pk)`, or `#alertId = :id` in `unlinkAll` and `clearAlertLinks`. None of them can create an item.
  - The health sentinel is never written.
- **`unlinkAll(alertId)`** (`dynamodb/links.ts`). `queryAll` on GSI1 `GSI1PK = ALERTLINK#<id>`. For each item, with concurrency 8, run UpdateItem `REMOVE #alertId, #gsi1pk` with condition `#alertId = :id`, and ignore `ConditionalCheckFailedException`, which means the item was relinked meanwhile. This reproduces §2.5-1 and §2.5-2 for logs, metrics and analyses.
- **`alerts.insert(alert, source = 'MOCK', status = 'OPEN')`**:
  1. `unlinkAll`.
  2. PutItem the full item from `items.alertItem`. The evidence budget (§5.8) applies. `acknowledgedBy` and `acknowledgedAt` are null, `createdAt = now()`, `GSI1PK = ALERTSRC#<source>`.

  The order is crash-safe. If the process stops between steps 1 and 2, the links are already gone and the old body remains, which matches the end state of SQLite's REPLACE minus the body refresh.
- **`alerts.upsertLivePreservingStatus(alert)`**:
  1. `unlinkAll`.
  2. UpdateItem whose `SET` list is generated from `items.alertItem(alert, 'LIVE', 'OPEN')`. It contains every attribute of that item except `PK`, `SK`, `status`, `acknowledgedBy` and `acknowledgedAt`: every body attribute, `evidence` and `recommendedActions` (budgeted, §5.8), `#entityType = :alert`, `#dataSource = :live`, `#createdAt = :now`, `#gsi1pk = :srcLive` and `#gsi1sk = :id`. `#status = if_not_exists(#status, :open)` is appended. Because the list comes from the builder, an item this update creates has the same attributes as one written by `insert`, apart from the absent ack attributes. The builder maps every `UrbaniIncidentAlert` field explicitly (all are required in `packages/shared/src/alerts.ts`, and `confidence` is nullable, not optional), so a null `confidence` is SET to `NULL` and the update overwrites every column, as SQLite's REPLACE does.

  The update has no condition. `acknowledgedBy` and `acknowledgedAt` are never touched, so an existing acknowledgement survives. The update is a single atomic write, so a concurrent acknowledge on another task cannot be lost. When reading, absent ack attributes map to `null`.
- **`alerts.query(filter)`**:
  1. Strong `queryAll` Query `PK = ALERT`.
  2. Filter in memory with the same truthiness rules as the SQL: equality on service, environment, severity, anomalyType and status; `from`/`to` via `compareBinary`; `search` via `compileLike(search)`, compiled once and applied to summary, anomalyType and probableCause.
  3. Sort by timestamp descending, breaking ties by alertId descending.
  4. `total` = the filtered length. Slice with `clampPage(…, 25)`.
  5. Attach `relatedLogIds`/`relatedMetricIds` for the page items only: one `queryAll` on GSI1 `ALERTLINK#<id>` each, with concurrency 8, split by the `LOG#`/`METRIC#` SK prefix.
- **`alerts.replaceDerivedEvidence(id, lines)`**. UpdateItem `SET #evidence = :ev` (budgeted) with condition `attribute_exists(#pk)`. On a condition failure: return when `lines` is `[]`, otherwise throw `REFERENCE_NOT_FOUND`. This is §2.5-8.
- **`alerts.deleteByDataSource(src)`**:
  1. `queryAll` on GSI1 `ALERTSRC#<src>`.
  2. For each id, with concurrency 8: `unlinkAll(id)`, then DeleteItem with condition `#dataSource = :src`.
  3. Return the number of successful deletes. A failed condition (the alert flipped to LIVE meanwhile) is not counted.

  BatchWriteItem was considered and rejected for these deletes. It cannot carry a condition, so a race with an upsert could delete an alert that just became LIVE and lose its acknowledgement. It also reports nothing per item, so the returned count would be wrong. Unlinking before deleting makes a crash or retry idempotent: the next sync finds the alert again and finishes the job.
- **`alerts.acknowledge(id, actor)`**. UpdateItem `SET #status = :ack, #acknowledgedBy = :actor, #acknowledgedAt = :now`, with condition `attribute_exists(#pk) AND #status = :open` and `ReturnValues: 'ALL_NEW'`. On success, map the result and attach links. On a condition failure, return `findById(id)`, which is the current alert or `null`.
- **`logs.linkLogsToAlert(alertId, logIds)`**:
  1. If the list is empty, return. Deduplicate.
  2. `batchGetAll` (strongly consistent) the keys `LOG`/`<id>`, projecting only `PK`.
  3. If no log exists, return. This covers LIVE log ids, which are never persisted, and costs one call.
  4. Strong GetItem of the alert. If it is missing, throw `REFERENCE_NOT_FOUND`. This is the exact FK parity of §2.5-8.
  5. For each existing log, with concurrency 8: UpdateItem `SET #alertId = :id, #gsi1pk = :link` with condition `attribute_exists(#pk)`, ignoring condition failures.

  `GSI1SK` is already present on every log item.
- **`logs.clearAlertLinks(alertId)`**. The pattern-28 selection restricted to `begins_with(GSI1SK, 'LOG#')`, then the same conditional REMOVE as `unlinkAll`.
- **`logs`/`metrics`/`usage` `upsertMany`**. Deduplicate by key with last-wins, matching sequential REPLACE. `batchWriteAll` then sends the Puts (chunks of 25, retries in §5.7). A Put replaces the whole item, which drops any link exactly like REPLACE.
- **`users.upsertUser(row)`**. Validate `role` (§7.3) and check key sizes. Then run at most two attempts, plus one final send in the inconsistent-lock case below. Each attempt does:
  1. Strong GetItem of the current user (`current`).
  2. Resolve `role = row.role ?? current?.role ?? 'SUPER_ADMIN'` and `isActive = row.is_active === 1`.
  3. Send TransactWriteItems:
     - [0] Put the user item. The condition is `attribute_not_exists(#pk)` when `current` is null, otherwise `#email = :prevEmail` with `:prevEmail = current.email`. The write therefore commits only if the user is still in the state that step 1 read;
     - [1] Put the lock `items.emailLockItem(row.email, row.id)`, which is `{ PK: 'USER_EMAIL', SK: row.email, entityType: 'USER_EMAIL', userId: row.id }`, with condition `attribute_not_exists(#pk) OR #userId = :id`;
     - [2] only if `current` exists and `current.email !== row.email`: Delete the old lock `USER_EMAIL`/`<current.email>` with condition `#userId = :id`.

  On `TransactionCanceledException`, the `CancellationReasons` codes decide. "Failed" means `ConditionalCheckFailed`. A `TransactionConflict` code on any item counts as a failed [0], because another writer was changing the user or one of its locks at that moment. Any other code goes through `translateAwsError` (§5.10).

  | Failed items | First attempt | Second attempt |
  |---|---|---|
  | only [1] | `DUPLICATE` (409), no retry | `DUPLICATE` |
  | [0], with or without others | re-read and retry | `UNAVAILABLE` (503), warn `{ op, userId }` |
  | [2], not [0] (with or without [1]) | re-read and retry | If [1] also failed: `DUPLICATE`. Otherwise strong GetItem of the old lock. If it is missing or names another user, the data was already inconsistent: warn `upsertUser: old email lock not owned by user` with `{ userId, lockOwner }` (ids only), then send the transaction once more without [2] and map its outcome by this column. If the lock names this user, `UNAVAILABLE` |

  A plain `TransactionConflictException` that is not a cancellation gets one immediate retry, then `UNAVAILABLE`.

  Two concurrent email changes of one user (O→A and O→B) both read O. The faster one commits U=A, creates lock A and deletes lock O. The slower one fails [0] (the email is no longer O) and [2] (lock O is gone). It re-reads U=A and commits U=B, creating lock B and deleting lock A. Two concurrent creates of one new id behave the same way through `attribute_not_exists`. In both cases no old lock survives (contract cases C-UR-10 and C-UR-11), so a stale lock cannot keep logging the user in. The final state matches SQLite's sequential result (last writer wins) and its UNIQUE email index.
- **`users.findByEmail(email)`**. If the lock key does not fit (key-size guard below), return `null` without a call. Otherwise:
  1. Strong GetItem of the lock `USER_EMAIL`/`<email>`.
  2. Always a second strong GetItem, of `USER`/`<lock?.userId ?? '#none'>`. A known and an unknown email therefore cost the same two calls, which keeps the constant-ish timing that `authService.login` aims for.
  3. Return the user only if the lock exists, the user exists, `user.email === email` and `user.isActive`.

  When the lock names a user whose stored email differs, log `warn('findByEmail: email lock does not match user', { userId })` (ids only, no email) and return `null`. Login then fails exactly as for an unknown email. `UserRow` is rebuilt in snake_case with `is_active: isActive ? 1 : 0`.
- **`aiAnalyses.insert(rec)`**. Set `id = rec.id ?? randomUUID()`. If `rec.alertId` is set, a strong GetItem checks the alert exists, otherwise `REFERENCE_NOT_FOUND`. PutItem with condition `attribute_not_exists(#pk)`; a condition failure throws `DUPLICATE`, matching the PK error in §2.5-8. `findingJson` is `JSON.stringify(rec.finding)`, so the string `'null'` round-trips to `null` exactly as in SQLite.
- **`audit.listByTimeRange({from, to, actor, limit, cursor})`**:
  1. Validate and normalize the options, then decode the cursor with the audit cursor schema, which also checks `from <= ts <= to` (§7.3). Any failure raises `INVALID_ARGUMENT` or `INVALID_CURSOR` before a query is sent, on both drivers. Without that check, a cursor reused with other bounds, or a crafted one, would become an `ExclusiveStartKey` outside the key condition, which DynamoDB rejects with a `ValidationException` (HTTP 500). `limit` defaults to 50, range 1..200.
  2. Build the key condition: `from` maps to `SK >= :from`. `to` maps to `SK <= :toHi` with `:toHi = to + '$'`, because `'$'` (0x24) sorts right after the `'#'` (0x23) delimiter, so every `<to>#<id>` key is included. Both bounds together use BETWEEN.
  3. On the GSI1 actor variant, the same bounds apply to `GSI1SK`.
  4. Set `ScanIndexForward: false`. Build `ExclusiveStartKey` from the cursor `[ts, id]`: base keys `{PK:'AUDIT', SK:'<ts>#<id>'}`, plus `{GSI1PK, GSI1SK}` for the actor variant.
  5. `queryUpTo(n + 1)`. `nextCursor` = encode(`[items[n-1].timestamp, items[n-1].id]`) when n+1 items came back, otherwise `null`. A cursor built this way always passes step 1's range check for the same bounds: the last returned item lies within them.
- **`chat.appendMessage(input)`**. Validate. `id = newTimeOrderedId(now)`. TransactWriteItems [Put the message with condition `attribute_not_exists(#pk)`; Update the session with `SET #updatedAt = :now, #gsi1sk = :gsk ADD #messageCount :one` and condition `attribute_exists(#pk)`], where `:gsk = '<now>#<sessionId>'`. Cancellation handling:
  - reason[1] → `REFERENCE_NOT_FOUND`;
  - reason[0] (id collision) → regenerate the id once;
  - `TransactionConflict` → retry once, then `UNAVAILABLE`.

  `listSessionsByUser` builds its cursor from `[updatedAt, id]`, giving `ExclusiveStartKey {GSI1PK, GSI1SK, PK:'CHAT#<id>', SK:'SESSION'}`. `listMessages` builds it from `[id]`, giving `{PK, SK:'MSG#<id>'}`.
- **`chat.createSession(input)`**. Validate. Set `id = input.id ?? randomUUID()`. Strong GetItem `USER`/`<userId>`; if it is absent, raise `REFERENCE_NOT_FOUND` (an inactive user still exists, §4.5). PutItem the session with condition `attribute_not_exists(#pk)`; a condition failure raises `DUPLICATE`. No code deletes users in item 1, so this check-then-write cannot race with a delete. Item 2 must revisit it if it adds user deletion.
- **`chat.setFeedback(input)`**. Validate. Send TransactWriteItems:
  - [0] ConditionCheck `CHAT#<sid>`/`MSG#<mid>`, `attribute_exists(#pk)`;
  - [1] ConditionCheck `USER`/`<userId>`, `attribute_exists(#pk)`;
  - [2] Update `CHAT#<sid>`/`FEEDBACK#<mid>`: SET `entityType = 'CHAT_FEEDBACK'`, `rating`, `comment`, `userId`, `sessionId`, `messageId`, `updatedAt = :now`, `createdAt = if_not_exists(createdAt, :now)`.

  A failed reason[0] or reason[1] raises `REFERENCE_NOT_FOUND`. `TransactionConflict` gets one retry, then `UNAVAILABLE`. On success, a strong GetItem of the feedback item returns it, because TransactWriteItems cannot return the new values. The transaction has 3 items, so §5.5's limit holds.
- **`environments.ensure(env)`**. PutItem with condition `attribute_not_exists(#pk)`. Only `ConditionalCheckFailedException` is ignored, because it means the environment exists. Every other error goes through §5.10.
- **`audit.record(...)`**. Validate `result`. PutItem with condition `attribute_not_exists(#pk)`. On `ConditionalCheckFailedException`, which means an id collision, regenerate the id once and retry. A second failure raises `DUPLICATE`.
- **Key-size guard.** `keys.fitsKey(pk, sk)` is true when the UTF-8 length of the partition key is at most 2,048 bytes and that of the sort key at most 1,024 bytes. Lookups by caller-supplied ids or emails check it first. When the key does not fit, they return their not-found result without a call, which is what SQLite returns for those inputs:
  - `null`: `alerts.findById`, `alerts.acknowledge`, `services.findById`, `aiAnalyses.findById`, `users.findByEmail`, `users.findById`, `users.getRole`;
  - an empty page: `audit.query` with `actor`;
  - `[]`: `logs.byAlert`;
  - a no-op: `logs.clearAlertLinks`, `users.recordLogin`, `integrations.delete`.

  The `items.ts` builders check the same limits for every key attribute, including `GSI1PK`/`GSI1SK`, and raise `INVALID_ARGUMENT` before a write (§2.5, accepted divergences). The new methods validate ids to at most 128 characters (§7.3), which always fits.
- **`health.ping`**. GetItem `HEALTH`/`PING` with `ConsistentRead: true` and `abortSignal: AbortSignal.timeout(2000)`. Errors are translated (§5.10). The strong read keeps §5.6 free of exceptions. It costs 1 read unit per probe instead of 0.5. Only `/ready`, server start and the seed call it; the ECS container health check probes `/health` (`deploy-ecs.sh:259`).
- **`metrics.query(filter)`**. Strong `queryAll` Query `PK = METRIC`, filter on service and environment, sort by timestamp descending (ties by id). Then apply `limit = Math.min(filter.limit ?? 200, 500)`: a negative limit returns everything, which is SQLite's `LIMIT -1`, and 0 returns `[]`.
- **Services, environments, integrations, roles, preferences.** These are direct Get, Put, Update and Query calls as listed in §5.3, with in-memory sorting by `compareBinary` (name or kind, tie-broken by id).

### 5.5 Conditional writes and transactions (summary)

| Need | Mechanism |
|---|---|
| Unique email | `USER_EMAIL` lock item, written in the same TransactWriteItems as the user, with condition `attribute_not_exists OR userId = :id`. The user Put is conditioned on the state read before it (`attribute_not_exists` or `email = :prevEmail`), so a concurrent upsert forces a re-read instead of leaving an old lock behind (§5.4). `findByEmail` ignores a lock whose user has another email |
| Status-preserving live upsert | One UpdateItem with `if_not_exists(status)`; ack attributes untouched |
| Acknowledge only once, only from OPEN | Condition `#status = :open` |
| Delete only alerts that still have the data source | Condition `#dataSource = :src` on each DeleteItem |
| Idempotent upserts | Put or Update keyed by natural ids. `environments.ensure`, audit and analysis inserts are create-only (`attribute_not_exists`) |
| No phantom items from updates | `attribute_exists(#pk)` on every update that mirrors SQL `UPDATE` |
| Chat message and session counter stay consistent | TransactWriteItems (Put + Update) |
| Feedback only for a message in the session, by an existing user | TransactWriteItems (ConditionCheck message + ConditionCheck user + Update) |
| Referential checks that SQLite does with FKs | Check-then-write: strong GetItem or BatchGetItem, then write (`linkLogsToAlert`, analysis insert, preferences, `createSession`). "User exists" means a `USER` item with that id, whatever `isActive` (§4.5); no code deletes users in item 1. The window between check and write is accepted. The only concurrent deleter, `deleteByDataSource('MOCK')`, never targets LIVE alerts that are being linked. The same race already exists in SQLite at the `await` between `putAlert` and `aiRepository.insert` in `aiService.analyze`. |

No transaction ever includes more than 3 items. Concurrent requests, in one task or across tasks, can conflict on the same item: a double-submitted chat message runs two `appendMessage` transactions on one session item, and C-UR-10 runs two `upsertUser` calls at once in one process. Each transactional method retries once and then raises `UNAVAILABLE`. For `upsertUser` the retry is the re-read of its decision table (§5.4).

### 5.6 Consistency
Every base-table read uses `ConsistentRead: true`. That gives read-after-write parity with SQLite in the same request, for example `syncLiveAlerts` upserts followed by `alerts.query`, or `acknowledge` followed by `findById`.

GSI1 reads are eventually consistent: alert links, audit by actor, chat sessions by user, and the `deleteByDataSource` selection. AWS documents GSI propagation as typically well under one second. The effects:
- a just-written link can be missed by an immediate `byAlert` or `clearAlertLinks`. In live mode links are a no-op anyway, because LIVE log ids are not persisted;
- a just-created MOCK alert can survive one sync and is deleted on the next;
- a just-updated chat session can appear briefly in its old position in the list;
- two `POST /api/ai/analyze` calls that derive the same alert id (§2.5-1) within the propagation window can both keep `alertId`. The second call's `unlinkAll` may not yet see the first analysis's link, whereas SQLite keeps `alertId` only on the newest analysis. The first analyze after propagation unlinks both. The stale `alertId` points at an alert that exists, so nothing dangles.

DynamoDB Local updates GSIs synchronously, so contract tests are deterministic. They are only run against Local.

### 5.7 Pagination and counts
- **Helpers.** `dynamodb/ops.ts` is the only module that sends `QueryCommand`, `BatchGetCommand` or `BatchWriteCommand` (a §14 grep gate checks this). A Query page stops after 1 MB of data read, and with `Select: 'COUNT'` that limit applies before the filter, so single-page reads would silently undercount at about 400 LIVE alerts. Every helper sends through `send(ctx, command, op)`, which applies `translateAwsError` (§5.10).

  ```ts
  type QueryInput = Omit<QueryCommandInput, 'TableName'>;   // TableName always comes from ctx
  /** Every page until LastEvaluatedKey is absent; Items concatenated in page order. */
  export function queryAll<T = Record<string, unknown>>(ctx: DynamoContext, input: Omit<QueryInput, 'Select'>, op: string): Promise<T[]>;
  /** Select: 'COUNT' on every page; returns the sum of the per-page Count values. */
  export function queryCount(ctx: DynamoContext, input: Omit<QueryInput, 'Select' | 'ProjectionExpression' | 'ExclusiveStartKey'>, op: string): Promise<number>;
  /** Pages until `want` items or the end; each page sets Limit = want minus the items so far. Returns at most
   *  `want` items. `input` may carry a cursor's ExclusiveStartKey. Used with want = limit + 1 (patterns 12, 13, 41, 43). */
  export function queryUpTo<T = Record<string, unknown>>(ctx: DynamoContext, input: Omit<QueryInput, 'Select' | 'Limit'>, want: number, op: string): Promise<T[]>;
  /** BatchGetItem in chunks of 100 with ConsistentRead: true. UnprocessedKeys are retried up to 5 times
   *  (backoff 50 ms·2^n plus jitter), then UNAVAILABLE. Returns the items found, in any order. */
  export function batchGetAll<T = Record<string, unknown>>(ctx: DynamoContext, keys: Array<{ PK: string; SK: string }>, opts: { projection?: string[] }, op: string): Promise<T[]>;
  /** BatchWriteItem in chunks of 25; UnprocessedItems are retried the same way. Callers pass unique keys,
   *  because a batch with duplicate keys is rejected. */
  export function batchWriteAll(ctx: DynamoContext, requests: Array<{ put: Record<string, unknown> } | { delete: { PK: string; SK: string } }>, op: string): Promise<void>;
  ```

  `commands.test.ts` drives each helper with a fake `send` that returns two pages (§8.3).
- **Legacy offset APIs** (`alerts.query`, `logs.query`, `aiAnalyses.query`, `audit.query`) must return `total`. DynamoDB has no cheap count, so these read the whole collection partition with `queryAll` and slice in memory. This is O(n) per request.
- **Counts** use `queryCount`, which sums `Count` over every page. That avoids transferring items, but read units are still charged on the size of every item read.
- **New APIs** (`listByTimeRange`, chat lists) use opaque cursors with `queryUpTo(limit + 1)`, so their cost does not grow with collection size.
- **Scale limits.** A mock alert is about 1 KB. A LIVE alert with 10 derived evidence lines is about 2–3 KB. A strongly consistent Query costs one read unit per 4 KB read, and one page holds at most 1 MB.

  | Alerts | `ALERT` partition | Read units per full read | Pages per full read |
  |---|---|---|---|
  | 1,000 | 1–3 MB | 250–750 | 1–3 |
  | 5,000 | 5–15 MB | 1,250–3,750 | 5–15 |

  `GET /api/alerts` reads the `ALERT` partition once, plus one GSI1 link query per page item. `GET /api/dashboard/summary` reads it 4 times: `countAll`, `countActive`, `countBySeverity`, and the services' `alertCount`. At 5,000 alerts one dashboard load therefore costs 5,000–15,000 read units, and DynamoDB documents a maximum of 3,000 read units per second for one partition. LIVE alerts are never deleted by the sync, so the partition grows over time.

  The ADR sets the threshold for changing the collection-read patterns at about 1,000 alerts, or 3 MB in any one entity partition (alerts, logs, metrics, AI analyses, audit), whichever comes first. An audit event is about 0.5 KB, so the audit partition reaches 3 MB at roughly 6,000 events. The mitigation path, in later items: time-bounded default windows and cursor endpoints (item 3 for audit), maintained counters for the dashboard, and TTL retention once the client decides retention. All of this is out of scope here.

### 5.8 Item size limits
DynamoDB rejects items over 400 KB. Item size is estimated as `Buffer.byteLength(JSON.stringify(item))`, which over-estimates the real size.

- **Alert evidence.** It comes from upstream alerts and from LIVE log lines, and neither is length-capped in `HttpUrbaniAlertsAdapter.ts` or `logLineParser.ts`. `items.budgetEvidence(lines)` keeps lines in order while their cumulative UTF-8 size is at most `EVIDENCE_BUDGET_BYTES = 256 * 1024`. It drops the first line that would exceed the budget and every line after it, and never edits text. When lines are dropped, it logs `warn('Alert evidence trimmed to fit DynamoDB item limit', { alertId, keptLines, droppedLines })`. This applies to `insert`, `upsertLivePreservingStatus`, `replaceDerivedEvidence` and the migration. Trimming is chosen over failing because a single oversized LIVE alert would otherwise make every `syncLiveAlerts` abort at the same alert. The upsert loop is not caught per alert, and changing that would change service behavior.
- **Every other item.** This includes `LOG` items (log message text), audit `metadata` and analysis `findingJson`. If the estimate exceeds `ITEM_SIZE_LIMIT_BYTES = 380 * 1024`, the write fails with `PersistenceError('ITEM_TOO_LARGE')` before any call. Today's writers never come close: seeded log lines are under 200 bytes, and audit metadata holds a few numeric or label fields. A DynamoDB `ValidationException` about item size, for example from `replaceDerivedEvidence` on an alert with a huge body, is translated to the same error.
- **New entities** have validated caps (§7.3) that keep them far below the limit: chat content 64 KiB, at most 50 citations of 4 KiB each, widget layout 16 KiB.
- **Keys.** A partition key may hold at most 2,048 bytes and a sort key at most 1,024 bytes (UTF-8), and the same limits apply to `GSI1PK`/`GSI1SK`. The key-size guard in §5.4 keeps reads at parity with SQLite and rejects oversized writes with `INVALID_ARGUMENT`.
- **The SQLite driver applies no budget.** Its behavior is unchanged.

### 5.9 Relationship to `UrbaniAlerts` and the existing config
The CDK `UrbaniAlerts` table (`PK service_id`, `SK timestamp`, GSI `anomaly_type-index`) is the output table of the planned collector → writer Lambda pipeline. Its handlers are still `NOT_IMPLEMENTED` placeholders and the table is not deployed. The app does not reuse it, for these reasons:
- its key cannot serve the app's main pattern, get-by-`alertId`, without another GSI;
- two alerts for the same service and timestamp would collide;
- it would mix app lifecycle state (status, acknowledgement, links, `dataSource`) into a table that the writer Lambda owns and overwrites.

`DYNAMODB_ALERTS_TABLE` and `DYNAMODB_GSI_ANOMALY_TYPE` keep their current role. They are shown on the Settings page (`settingsService.get().dynamodb`, whose shape is unchanged) and are reserved for the pipeline. The app driver never reads them. When the pipeline is built (a later item), the writer either feeds the app through the existing ingest path or writes `ALERT` items into the app table. That decision is out of scope. The live alerts the app shows today come from the Urbani QA `/alerts` HTTP API, and that does not change.

### 5.10 Client, credentials, retries, timeouts, error translation
`createDynamoContext` in `dynamodb/client.ts`:

```ts
const client = new DynamoDBClient({
  region,
  maxAttempts: 3,                                         // SDK standard retry: throttling, 5xx, network
  requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 },
  ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});
const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
  unmarshallOptions: { wrapNumbers: false },
});
return { client, doc, tableName, destroy: () => client.destroy() };
// DynamoContext = { client: DynamoDBClient; doc: Pick<DynamoDBDocumentClient, 'send'>; tableName: string; destroy(): void }
// `client` is used only by local tooling and tests (Describe/Create/DeleteTable in db/dynamoTables.ts, Scan purge);
// repositories use `doc` exclusively.
```

- Without an endpoint, the SDK default credential chain applies: the ECS task role in AWS, or SSO/env for a developer. No credentials appear in code. The dummy `local`/`local` pair is used only when `DYNAMODB_ENDPOINT` is set. DynamoDB Local v2 accepts letters-only key ids.
- Repositories depend on `doc: Pick<DynamoDBDocumentClient, 'send'>`. That lets unit tests inject a recording fake (§8.3).
- `ops.translateAwsError(err, op)` handles anything that is not consumed by the operation-specific handling above (`ConditionalCheckFailedException`, `TransactionCanceledException` reasons):

| AWS error (`err.name` / `err.code`) | Result | Fatal? | Log |
|---|---|---|---|
| `ProvisionedThroughputExceededException`, `ThrottlingException`, `RequestLimitExceeded`, `InternalServerError`, `ServiceUnavailable`, `TimeoutError`, `AbortError`, `TransactionConflictException`, network `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`ENOTFOUND` (after SDK retries) | `PersistenceError('UNAVAILABLE')`, HTTP 503 | no | `warn('DynamoDB call failed', { op, awsError, requestId })` |
| `ResourceNotFoundException`, `AccessDeniedException`, `UnrecognizedClientException`, `InvalidSignatureException`, `MissingAuthenticationTokenException`, `ExpiredTokenException`, `CredentialsProviderError` | `PersistenceError('UNAVAILABLE', { fatal: true })`, HTTP 503 | yes | `error(…, { op, awsError, hint })`. Hints: "create the table (dynamo:tables / IaC)" or "check the task-role policy" |
| `ValidationException` mentioning item size | `PersistenceError('ITEM_TOO_LARGE')`, HTTP 500 | no | handler logs at error level |
| any other `ValidationException` (a bug in an expression) | rethrown unchanged, HTTP 500 `INTERNAL_ERROR` | – | `error('DynamoDB call failed', { op, awsError: err.name })` at translation, then the handler |
| any other error (default row) | rethrown unchanged, HTTP 500 `INTERNAL_ERROR` | – | `error('DynamoDB call failed', { op, awsError: err.name })` at translation, then the handler |

Item contents are never logged.

## 6. Configuration (`packages/backend/src/config/index.ts`)

Added to the zod schema:

```ts
// DynamoDB driver (DB_DRIVER=dynamodb). The single app table is `${DYNAMODB_TABLE_PREFIX}App`.
DYNAMODB_TABLE_PREFIX: z.string().max(252).regex(/^[A-Za-z0-9_.-]*$/, 'letters, digits, _ . - only').default('Urbani'),
// Only for DynamoDB Local (e.g. http://127.0.0.1:8000). Empty = unset = AWS endpoint + default credential chain.
DYNAMODB_ENDPOINT: z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL').optional(),
),
```

Added to `config.db`:

```ts
dynamodb: {
  tableName: `${env.DYNAMODB_TABLE_PREFIX}App`,   // UrbaniApp by default
  endpoint: env.DYNAMODB_ENDPOINT ?? null,
},
```

`region` reuses `config.aws.region` (`AWS_REGION`, default `us-east-1`). `config.dynamodb.alertsTable` and `config.dynamodb.anomalyTypeGsi` are unchanged (§5.9). Invalid values hit the existing fail-fast path, which reports `Invalid environment configuration: - DYNAMODB_ENDPOINT: …` and refuses to boot. The prefix length cap keeps table names within DynamoDB's 255-character limit, and the prefix may be empty, giving `App`.

## 7. Errors, validation, invariants

### 7.1 `PersistenceError` (added to `src/lib/errors.ts`)

```ts
export type PersistenceReason =
  | 'DUPLICATE' | 'REFERENCE_NOT_FOUND' | 'INVALID_ARGUMENT' | 'INVALID_CURSOR' | 'ITEM_TOO_LARGE' | 'UNAVAILABLE';
const PERSISTENCE_STATUS: Record<PersistenceReason, number> = {
  DUPLICATE: 409, REFERENCE_NOT_FOUND: 404, INVALID_ARGUMENT: 400, INVALID_CURSOR: 400, ITEM_TOO_LARGE: 500, UNAVAILABLE: 503,
};
export class PersistenceError extends AppError {
  readonly fatal: boolean;
  readonly awsErrorName?: string;          // e.g. 'ResourceNotFoundException'; never the raw message/item
  constructor(readonly reason: PersistenceReason, message: string,
              opts: { details?: unknown; fatal?: boolean; awsErrorName?: string } = {}) {
    super(`PERSISTENCE_${reason}`, message, PERSISTENCE_STATUS[reason], opts.details);
    this.fatal = opts.fatal ?? false;
    this.awsErrorName = opts.awsErrorName;
  }
}
```

The class has no `cause` field, which avoids clashing with `Error.cause` typings. The AWS request id and error name are logged once, at the point of translation (§5.10).

`PersistenceError` extends `AppError`, so the existing `errorHandler` already maps it to its status and `{ error: { code, message, details, correlationId } }` with no change. It logs 5xx at error level and 4xx at warn level. Messages are generic, for example "Persistence temporarily unavailable", "Referenced record not found", "Record already exists", "Invalid cursor". They never include table names, keys of other users, or item contents. `details` is only set to the zod issues of the caller's own input.

Error classes differ by path:
- The **legacy SQLite paths** keep raising the raw `SqliteError`, which becomes HTTP 500 `INTERNAL_ERROR` as today. That keeps parity.
- **New methods** (preferences, chat, `listByTimeRange`, `record`'s result validation, `upsertUser`'s role validation) raise `PersistenceError` on both drivers, from the explicit checks in §4.5.
- Where a **legacy rejection** differs in error class between drivers (FK and UNIQUE cases), the contract asserts only that the promise rejects.

### 7.2 Error handling per operation

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| Any DynamoDB call | Throttling, 5xx, network or timeout after 3 SDK attempts | yes (retry later) | `UNAVAILABLE` → 503 | warn at translation (op, AWS error, requestId), then error from the handler |
| Any DynamoDB call | Table missing, access denied, bad or expired credentials | no (configuration) | `UNAVAILABLE` with `fatal` → 503 | error, with a hint |
| `alerts.acknowledge` | Not OPEN or missing (condition failed) | expected | the current alert, or `null` → service throws `NotFoundError` 404 (unchanged) | none |
| `alerts.insert` / `upsertLivePreservingStatus` | Evidence over budget | degraded | write succeeds with fewer lines | warn `{alertId, keptLines, droppedLines}` |
| `alerts.insert` / `upsertLivePreservingStatus` | Still over 380 KiB | no (for that alert) | `ITEM_TOO_LARGE` → `syncLiveAlerts` catch (existing warn) or 500 | warn (sync) / error (handler) |
| `alerts.replaceDerivedEvidence` | Alert missing | expected | `[]` → resolves; lines → rejects. `correlateLiveAlerts` catches it per alert (existing warn) | existing warn |
| `alerts.deleteByDataSource` | One item's condition fails (flipped source) | expected race | not counted | none |
| `logs.linkLogsToAlert` | Alert missing while some log exists | expected | rejects. `correlateLiveAlerts` catches it (existing warn) | existing warn |
| `logs.linkLogsToAlert` | A log id is absent (LIVE ids) | expected | skipped silently | none |
| `users.upsertUser` | Email owned by another user | expected | rejects: SQLite UNIQUE error / DynamoDB `DUPLICATE` 409 | handler |
| `users.upsertUser` | The user changed between read and write (failed [0] or [2], or a `TransactionConflict`) | yes | re-read and retry once; then `UNAVAILABLE` 503 (§5.4) | warn `{ op, userId }` |
| `users.upsertUser` | Old email lock missing or owned by another user (data already inconsistent) | degraded | the write succeeds without deleting that lock | warn `{ userId, lockOwner }` |
| `users.findByEmail` | The lock names a user whose stored email differs | degraded | `null`, so login fails as for an unknown email | warn `{ userId }` |
| Legacy lookups (DynamoDB) | Id or email longer than the DynamoDB key limit | expected | the not-found result, without a call (parity with SQLite) | none |
| Any DynamoDB write | A key longer than the DynamoDB key limit | caller | `INVALID_ARGUMENT` 400 (inside `syncLiveAlerts`: the existing catch) | handler warn / existing sync warn |
| `environments.ensure` | Condition failure (the environment exists) | expected | resolves | none |
| `audit.record` (DynamoDB) | Id collision | expected (rare) | regenerate the id once; then `DUPLICATE` 409 | handler |
| `users.upsertUser`, `audit.record` | Invalid role or result value | caller bug | `INVALID_ARGUMENT` 400 | handler warn |
| `users.recordLogin` | User missing | expected | resolves (no-op) | none |
| `aiAnalyses.insert` | Alert missing or id duplicate | expected race / bug | rejects: SQLite FK/PK error / DynamoDB `REFERENCE_NOT_FOUND` or `DUPLICATE` | handler |
| `preferences.update` | Invalid or empty patch, too large | caller | `INVALID_ARGUMENT` 400 | handler warn |
| `preferences.update` | User missing | caller | `REFERENCE_NOT_FOUND` 404 | handler warn |
| `chat.createSession` | Invalid input / user missing / duplicate id | caller | 400 / 404 / 409 | handler warn |
| `chat.appendMessage` | Invalid input / session missing / conflict | caller / transient | 400 / 404 / one retry then 503 | handler |
| `chat.setFeedback` | Message not in that session, or user missing | caller | `REFERENCE_NOT_FOUND` 404 | handler warn |
| `preferences.get`, chat reads | `userId`/`sessionId` empty or longer than 128 characters | caller | `INVALID_ARGUMENT` 400 | handler warn |
| `listByTimeRange`, chat lists | Malformed cursor, an audit cursor outside `from`/`to`, `from > to`, unparseable date | caller | `INVALID_CURSOR` / `INVALID_ARGUMENT` 400, before any query | handler warn |
| `health.ping` | Any error or a 2 s timeout | – | `/ready` returns 503 `not-ready` (it never throws to Express) | none in the route |
| `batchWriteAll` / `batchGetAll` | Unprocessed after 5 retries | yes | `UNAVAILABLE` 503 | warn |
| Server start, DynamoDB | `ping` fails with `fatal` | no | process exits 1 | error "Startup failed" with the hint |
| Server start, DynamoDB | `ping` fails transiently | yes | starts listening; `/ready` is 503 until DynamoDB is reachable | warn |
| `npm run seed`, DynamoDB | Target is AWS (no `DYNAMODB_ENDPOINT`) and no `--allow-aws` | no | exit 2, before any repository is built | error with the refusal message (§9.3) |
| `npm run seed`, DynamoDB | Table missing or unreachable | no | exit 1 | error "Seed failed" with the hint |
| `npm run reset --workspace @urbani/backend`, DynamoDB | Not supported | – | exit 1, before any SQLite file is opened | error naming `dynamo:tables -- --reset` |
| `dynamo:tables` | Configuration error, no endpoint, bad flag, table definition mismatch | no | exit 2 | error |
| `dynamo:tables` | A DynamoDB Local call fails (for example `ECONNREFUSED`) | no | exit 1 | error |
| `dynamo:migrate` | Configuration error, bad args, source missing, table missing (fatal `PersistenceError`), AWS target without `--allow-aws` | no | exit 2 | error |
| `dynamo:migrate` | Unexpected error mid-run | no | exit 1 | error `{ message }` |
| `dynamo:migrate` | One row fails to map or write | per item | counted `failed`; exit 1 at the end | error `{entity, id}` without contents |

### 7.3 Validation of external inputs
- **Environment variables.** Validated with zod in `config/index.ts` (§6). A failure stops startup, as today.
- **HTTP.** No new or changed routes. The existing route zod schemas stay the trust boundary.
- **CLI flags.** Parsed by hand from `process.argv`.
  - `dynamo:tables` accepts only `--reset` and requires `DYNAMODB_ENDPOINT` (a presence check, §9.5).
  - `dynamo:migrate` requires `--source <path>`, which must name an existing regular file. A relative path resolves against `process.env.INIT_CWD ?? process.cwd()` (§10), and the script prints the resolved absolute path before it checks or opens the file. There is no default: `config.db.sqlitePath` resolves to `packages/backend/data/urbani.sqlite` in a checkout without `DATABASE_URL`, and NFR5 forbids opening that folder. It also accepts `--dry-run` and `--allow-aws`.
  - `seed` reads only `--allow-aws` (§9.3) and ignores other arguments, as today.
  - An unknown flag or a missing value prints usage and exits 2. So does an invalid environment, through `db/cli.ts` (§9.5).
- **Repository inputs for new entities.** These use zod schemas in `repositories/validation.ts`, shared by both drivers. A failure throws `INVALID_ARGUMENT` with the issues.

| Input | Rules |
|---|---|
| `UserUpsert.role` | optional; must be one of `USER_ROLES` |
| `record(…, result)` | optional, default `SUCCESS`; must be one of `AUDIT_RESULTS` |
| `AuditRangeQuery` | `from`/`to` optional, `z.string().datetime({ offset: true })`, normalized with `new Date(x).toISOString()`, and `from <= to`; `actor` optional, 1–320 chars; `limit` optional int, clamped to 1..200 (default 50); `cursor` optional, decoded with the audit cursor schema (row "Cursor" below) |
| `PreferencesPatch` | at least one of `theme`/`widgetLayout` present; `theme` ∈ `THEMES` or `null`; `widgetLayout` is `null` or a value whose `JSON.stringify` is a string of ≤ 16,384 UTF-8 bytes (functions and `undefined` rejected); `userId` 1–128 chars |
| `NewChatSession` | `id` optional, `^[A-Za-z0-9_-]{1,128}$`; `userId` 1–128; `title` ≤ 200; `service`/`environment` ≤ 64 |
| `NewChatMessage` | `sessionId` 1–128; `role` ∈ `CHAT_MESSAGE_ROLES`; `content` 1..65,536 UTF-8 bytes; `citations` ≤ 50 items of ≤ 4,096 bytes each; `provider`/`modelId` ≤ 128; `source` ∈ `DATA_SOURCES` or `null`; `latencyMs` int 0..600,000 or `null`; token counts int ≥ 0 or `null` |
| `ChatFeedbackInput` | `sessionId`/`messageId`/`userId` 1–128; `rating` ∈ `CHAT_RATINGS`; `comment` ≤ 2,000 chars or `null` |
| Cursor (all lists) | At most 1,024 characters of base64url JSON `{ v: 1, k: [...] }`. `k` must match the list's zod tuple, otherwise `INVALID_CURSOR`, on both drivers, before any query. A canonical timestamp passes `z.string().datetime()` and equals `new Date(ts).toISOString()`. **Audit** `[ts, id]`: canonical `ts`; `id` 1–64 characters; `from <= ts <= to` under `compareBinary` for each bound that is present. **Sessions** `[updatedAt, id]`: canonical `updatedAt`; `id` matches `^[A-Za-z0-9_-]{1,128}$`. **Messages** `[id]`: matches `^[A-Za-z0-9_-]{1,128}$`. These limits keep every `ExclusiveStartKey` inside the key condition and inside the key-size limits |
| Read-method ids | `preferences.get(userId)`, `getSession(sessionId)`, `listSessionsByUser(userId)`, `listMessages(sessionId)`, `listFeedback(sessionId)`: 1–128 characters, otherwise `INVALID_ARGUMENT`. Without this, a DynamoDB key over its byte limit would raise a `ValidationException` (HTTP 500) where SQLite returns nothing |
| Chat list `limit` | sessions 1..100 (default 20); messages 1..500 (default 200); clamped, never rejected |

Legacy methods get no new validation. Their behavior does not change.

### 7.4 Invariant ownership

| Invariant | Owner | SQLite | DynamoDB | Why this layer |
|---|---|---|---|---|
| Request shape and types | routes (zod) | – | – | trust boundary, unchanged |
| Provenance labels (`Sourced<T>`, LIVE/MOCK) | services | – | – | business rule, unchanged |
| Role-based authorization; only assistant messages get feedback; session ownership | services and middleware (items 2, 7) | – | – | business rules; the repository stays policy-free |
| Unique user email | repository | UNIQUE + `ON CONFLICT(id)` upsert | lock item + transaction | must hold for every writer: seed, migration, item 2 |
| A live re-sync never reverts status or acknowledgement | repository | read + REPLACE in one synchronous method | single UpdateItem with `if_not_exists` | must be atomic across concurrent tasks |
| Acknowledge only from OPEN | repository | `UPDATE … WHERE status='OPEN'` | condition expression | atomic compare-and-set |
| Cascade on alert replace or delete (evidence, actions, links) | repository | FK `CASCADE` / `SET NULL` | inline children + `unlinkAll` before Put/Delete | storage-level referential semantics |
| Links only to existing parents | repository | foreign keys | check-then-write | parity with SQLite |
| Preferences, sessions and feedback reference an existing user (any `is_active`) | repository | `SELECT 1 FROM users WHERE id = ?` in the method's transaction | GetItem (preferences, sessions) or ConditionCheck in the transaction (feedback) on `USER`/`<id>` | the new tables have no FK to `users` (FR2.4) |
| Keys within DynamoDB's limits | repository (DynamoDB) | – | `fitsKey` on reads, builder checks on writes | a storage constraint; reads keep SQLite's not-found answer |
| Updates never create items | repository | `UPDATE` semantics | `attribute_exists(#pk)` | DynamoDB UpdateItem upserts by default |
| Stored enum domains (role, result, theme, rating, message role) | repository | CHECK + zod | zod | data integrity regardless of caller |
| Item size | repository | – (unchanged) | evidence budget + size guard | the 400 KB limit is a storage constraint |
| Timestamps are ISO UTC with ms | repository (`now()`) | – | – | keys and sorting depend on it |
| Every item carries `entityType`; preferences items carry `userId` | repository (DynamoDB) | – | `items.ts` builders on every Put; `#entityType` (and `#userId` for preferences) in the SET of the 3 create-capable UpdateItems (§5.4 rule) | item 6 filters its Streams consumer on `entityType`; an item written without it would need a backfill |

## 8. Tests

### 8.1 Contract suite design
- `src/test/repositoryContract.ts` exports `defineRepositoryContract(harness: RepositoryHarness): void`. It registers `describe`/`it` blocks that use only the `Repositories` interface. It lives under `src/test/` next to `setup.ts` and `testDb.ts`. The backend build type-checks it, which gives extra safety. It is never imported at runtime.
- `src/test/repositoryHarness.ts` defines:

  ```ts
  export interface RepositoryHarness {
    readonly name: 'sqlite' | 'dynamodb';
    setupSuite(): Promise<void>;                               // beforeAll (timeout 60 s)
    fresh(now: () => string): Promise<Repositories>;           // beforeEach: empty store + repos bound to the clock
    cleanup(): Promise<void>;                                  // afterEach
    teardownSuite(): Promise<void>;                            // afterAll
  }
  export function sqliteHarness(): RepositoryHarness;           // fresh = freshTestDb() + createSqliteRepositories({ now }); cleanup = db.close()
  export interface DynamoHarness extends RepositoryHarness {
    readonly name: 'dynamodb';
    readonly tableName: string;                                // UrbaniTest<runId>App, fixed when the harness is built
    context(): DynamoContext;                                  // valid after setupSuite; throws before it
    scanAll(): Promise<Array<Record<string, unknown>>>;        // every item in the test table, for assertions
  }
  export function dynamoHarness(endpoint: string): DynamoHarness;
  export function makeTestClock(startIso = '2026-10-01T00:00:00.000Z', stepMs = 1000): () => string; // strictly increasing
  ```

  `dynamoHarness` works like this:
  - `setupSuite` creates a context with `tableName = UrbaniTest<runId>App`, where `runId = Date.now().toString(36) + 4 random hex chars`. It then calls `ensureAppTable` from `db/dynamoTables.ts`, so the test table and the dev table come from the same definition.
  - `fresh` purges every item with a paginated Scan plus `batchWriteAll` deletes. Scans happen in the harness only (`fresh` and `scanAll`); repositories never Scan. It then builds repositories with `createDynamoRepositories(ctx, { now })`.
  - `teardownSuite` deletes the table and destroys the client.
  - Factories are lazy. Collecting a skipped suite opens no connection.
- **One table per opt-in test file.** Every test file with a DynamoDB block builds its own `dynamoHarness(endpoint)` and wires it as `beforeAll(setupSuite)`, `beforeEach(fresh)`, `afterEach(cleanup)` and `afterAll(teardownSuite)`. Those files are the contract suite, the DynamoDB blocks of `seed.test.ts` and `migrateSqliteToDynamo.test.ts`, and `dynamoOnly.test.ts` (§8.3). Each file therefore works in its own `UrbaniTest<runId>App` table, purged before each test and deleted after the file. No test builds a DynamoDB context from `config.db.dynamodb.tableName`. The developer's `UrbaniApp` table on DynamoDB Local (§12.2) is therefore never read or written by a test, and its contents cannot change a count assertion. `vitest.config.ts` sets `fileParallelism: false`, so the files run one after another; separate tables keep them independent regardless.
- `src/repositories/repositories.contract.test.ts`:

  ```ts
  describe('repository contract [sqlite]', () => defineRepositoryContract(sqliteHarness()));
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  // DynamoDB Local's JVM is slow on its first calls: 20 s per test (hooks: 60 s, set in the harness).
  // vitest 2.1.9 accepts the options object as the second argument (SuiteCollectorCallable).
  describe.skipIf(!endpoint)('repository contract [dynamodb] (set DYNAMODB_ENDPOINT to run)', { timeout: 20_000 }, () =>
    defineRepositoryContract(dynamoHarness(endpoint!)));
  ```

  Without the variable, vitest reports every DynamoDB case as skipped, which is visible in the output and not counted as passed. `npm test` then needs no Docker, AWS or network. The registry is not involved: `test/setup.ts` pins `DB_DRIVER=sqlite`, so the registry stays SQLite even when the endpoint variable is set. Only `repositories/index.test.ts` flips the driver, through a fresh-config dynamic import.
- **Determinism.** Each `fresh` gets a new `makeTestClock()`. Every repository-generated timestamp is then unique and increasing, so no assertion depends on tie order. Fixtures that carry their own timestamps (alerts, logs, metrics, analyses) use distinct values. Assertions on `relatedLogIds` compare sorted arrays, because SQLite returns them in rowid order.

### 8.2 Contract cases (both drivers)

Unless a case names a typed `PersistenceError`, "rejects" means `await expect(p).rejects.toThrow()`, because the two drivers raise different error classes on legacy paths.

**Alerts**
- C-AL-01: `insert` → `findById` returns every field. Evidence and actions keep their order. Status is OPEN, ack is null, `relatedLogIds` and `relatedMetricIds` are `[]`, and a null `confidence` round-trips.
- C-AL-02: `insert` defaults are source MOCK and status OPEN; `deleteByDataSource('MOCK')` removes the alert.
- C-AL-03: `insert` over an existing id replaces body, evidence and actions, sets the given status and clears the ack fields.
- C-AL-04: `insert` and also `upsertLivePreservingStatus` over an existing id clear links: `logs.byAlert(id)` returns `[]` and `aiAnalyses.findById(a).alertId` is `null` (REPLACE semantics).
- C-AL-05: `upsertLivePreservingStatus` on a new id gives OPEN; `deleteByDataSource('MOCK')` keeps it and `deleteByDataSource('LIVE')` removes it.
- C-AL-06: `upsertLivePreservingStatus` keeps ACKNOWLEDGED, `acknowledgedBy` and `acknowledgedAt`, and refreshes summary, evidence and actions (AC7 of DPI 1).
- C-AL-07: `upsertLivePreservingStatus` over a MOCK alert flips it to LIVE and keeps its status.
- C-AL-08: `acknowledge` moves OPEN → ACKNOWLEDGED with the actor and `acknowledgedAt` equal to the clock value. A second call returns the unchanged alert with the original actor. A missing id returns `null`.
- C-AL-09: `query` single filters: service, environment, severity, anomalyType and status match exactly and case-sensitively. An empty-string filter is ignored.
- C-AL-10: `query` `from`/`to` bounds are inclusive and compared as strings.
- C-AL-11: `query` `search` is case-insensitive for ASCII across summary, anomalyType and probableCause. `_` matches one character and `%` any run. A miss returns total 0.
- C-AL-12: `query` sorts by timestamp descending and `total` counts all matches. Clamps: pageSize 0 → 1, 500 → 200, page 0 → 1. A page past the end returns `[]` with the full total.
- C-AL-13: `replaceDerivedEvidence` writes, replaces and clears (`[]`). On a missing id it never creates the alert: `[]` resolves, lines reject.
- C-AL-14: `deleteByDataSource` returns the count and deletes only that source. A deleted alert's `findById` is `null`, its logs are unlinked and its analyses get `alertId = null`.
- C-AL-15: `countAll`, `countActive` and `countBySeverity` (the last two count OPEN and ACKNOWLEDGED only).
- C-AL-16: `relatedLogIds` reflects links in both `findById` and `query` items.

**Logs**
- C-LG-01: `upsertMany` then `query` with the filters service, environment, level and search (LIKE); total; descending order; default pageSize 50; clamps.
- C-LG-02: `upsertMany` over an existing id replaces the row and clears its link.
- C-LG-03: `linkLogsToAlert` links existing ids, `byAlert` sorts descending, absent ids are ignored.
- C-LG-04: `linkLogsToAlert` with `[]` is a no-op. A missing alert with an existing log rejects. A missing alert with only absent logs resolves.
- C-LG-05: `clearAlertLinks` clears only that alert's links.
- C-LG-06: re-linking to a different alert moves the link.

**Metrics**
- C-MT-01: filter by service and environment; descending; default limit 200; clamp to 500; limit 0 returns `[]`.
- C-MT-02: an alert's `relatedMetricIds` is `[]`, because no API links metrics.

**Services and environments**
- C-SV-01: `upsert` then `all` sorted by name; `alertCount` counts alerts with that service name in any status.
- C-SV-02: `findById` includes `alertCount`; a missing id returns `null`; `count`.
- C-SV-03: `environments.ensure` is idempotent and does not overwrite; `all` sorts by name.

**Usage**
- C-US-01: `upsertMany` then `all` sorted by date descending.

**AI analyses**
- C-AI-01: `insert` generates an id; `findById` round-trips a finding object and a null finding.
- C-AI-02: a provided id is used; a duplicate id rejects.
- C-AI-03: `query` sorts descending, returns total, default pageSize 25.
- C-AI-04: `count`.
- C-AI-05: `alertId` pointing at a missing alert rejects.

**Audit**
- C-AU-01: `record` then `query` round-trips actor, action, target (null by default) and metadata; timestamp equals the clock value.
- C-AU-02: `query` filters by action, actor and both; descending; total; default pageSize 50; clamps.
- C-AU-03: `query` items have exactly the `AuditEvent` keys and no `result`.
- C-AU-04: `result` defaults to SUCCESS, FAILURE and DENIED are stored, and an invalid value raises `INVALID_ARGUMENT`.
- C-AU-05: `listByTimeRange` with inclusive `from`/`to`, descending, with and without `actor`.
- C-AU-06: with limit 2 over 5 events, `listByTimeRange` yields 3 pages with no duplicates or gaps, and the last `nextCursor` is `null`.
- C-AU-07: a malformed cursor raises `INVALID_CURSOR`. So does a well-formed cursor whose timestamp is after `to` or before `from`, and one whose timestamp is not canonical ISO (for example `2026-10-01T00:00:00Z`, without milliseconds). `from > to` raises `INVALID_ARGUMENT`; limit is clamped.

**Integrations**
- C-IN-01: `upsert` then `all` sorted by kind; the same id replaces; `delete` removes; deleting a missing id is a no-op.

**Users and roles**
- C-UR-01: `upsertRole` then `getRole`; a missing id returns `null`.
- C-UR-02: `upsertUser` then `findByEmail` and `findById`; `role` defaults to SUPER_ADMIN; all 4 roles are accepted.
- C-UR-03: an inactive user is invisible to both lookups.
- C-UR-04: `toAuthUser` takes the role name from the roles table and parses permissions. A missing role gives `UNKNOWN` and `[]`; invalid permissions JSON gives `[]`.
- C-UR-05: `recordLogin` sets `last_login_at` to the clock value; a missing id resolves and creates no user.
- C-UR-06: an email owned by another id rejects, and the original user is unchanged.
- C-UR-07: changing the email frees the old one: `findByEmail(old)` returns `null` and another user can take it.
- C-UR-08: an upsert that omits `role` keeps the stored role. An invalid role raises `INVALID_ARGUMENT`.
- C-UR-09: re-upserting an existing user keeps that user's preferences and chat sessions.
- C-UR-10: two concurrent email changes of one user (O→A and O→B, through `Promise.allSettled`). At least one fulfills. Afterwards `findByEmail(O)` is `null`, exactly one of A and B resolves to the user and equals `findById(u).email`, and a new user can take the other email.
- C-UR-11: two concurrent creates of one new id with emails A and B. At least one fulfills. Afterwards exactly one of A and B resolves to that id, and a new user can take the other email.

**Preferences**
- C-PF-01: an unknown user returns `null`.
- C-PF-02: patching the theme and then the layout keeps both; `updatedAt` equals the clock value. The first `update` creates the record, and both its return value and `(await repos.preferences.get(u)).userId` equal `u`.
- C-PF-03: `null` clears a field; nested JSON round-trips.
- C-PF-04: an invalid theme, an oversized or non-serializable layout, or an empty patch raises `INVALID_ARGUMENT`. An unknown user raises `REFERENCE_NOT_FOUND`.
- C-PF-05: an inactive user (`is_active = 0`) can still create and update preferences.

**Chat**
- C-CH-01: `createSession` then `getSession`. An unknown user raises `REFERENCE_NOT_FOUND`; a duplicate id raises `DUPLICATE`.
- C-CH-02: `appendMessage` returns an id and `createdAt`, increments `messageCount` and bumps `updatedAt`.
- C-CH-03: `listMessages` returns messages oldest first, with cursor pages.
- C-CH-04: `listSessionsByUser` returns the most recent first, only that user's sessions, with cursor pages.
- C-CH-05: appending to a missing session raises `REFERENCE_NOT_FOUND`; a bad role or oversized content raises `INVALID_ARGUMENT`.
- C-CH-06: `setFeedback` creates and then updates: `createdAt` is kept, `updatedAt` bumped, one feedback per message.
- C-CH-07: feedback for a message outside the session raises `REFERENCE_NOT_FOUND`.
- C-CH-08: `listFeedback` sorts by message id.
- C-CH-09: `setFeedback` with an unknown `userId` raises `REFERENCE_NOT_FOUND`; feedback by an inactive user is accepted.
- C-CH-10: `getSession`, `listSessionsByUser`, `listMessages`, `listFeedback` and `preferences.get` reject an empty or a 129-character id with `INVALID_ARGUMENT`.

**Keys**
- C-KY-01: over-long keys behave as not found. With a 2,000-character id, `alerts.findById`, `alerts.acknowledge`, `services.findById`, `aiAnalyses.findById` and `users.findById` return `null`, and `logs.byAlert` returns `[]`. `users.findByEmail` with a 2,000-character email returns `null`, `audit.query({ actor })` with a 2,100-character actor returns total 0, and `users.recordLogin` resolves.

**Health**
- C-HL-01: `ping` resolves.

That is 69 cases per driver.

### 8.3 Other new tests

Unless marked skip-if, each file runs in the default `npm test`.

| File | Cases | Kind |
|---|---|---|
| `src/db/migrations.test.ts` | Apply 001 alone (exec the file, insert into `schema_migrations`), insert a user and 3 audit rows (outcome `unavailable`, other metadata, and NULL), then run `runMigrations` and assert: the user's role is SUPER_ADMIN; results are FAILURE, SUCCESS, SUCCESS; the 4 tables exist. Re-running applies nothing. The CHECK rejects `role = 'BOGUS'`. | unit (SQLite in memory) |
| `src/db/seed.test.ts` | On SQLite: the counts match `mockData` (2 roles, 1 admin with role SUPER_ADMIN, 4 services, 3 alerts, 60 logs, 24 metrics, 7 usage, 4 integrations) and a second run leaves them unchanged. `assertSeedTarget`: `dynamodb` with no endpoint and no flag throws `CliPreconditionError` with the refusal message; `--allow-aws`, a set endpoint, or the `sqlite` driver passes. A skip-if-no-endpoint block (timeout 20 s) runs the same counts on DynamoDB Local with its own `dynamoHarness` (§8.1): `beforeEach` passes `await harness.fresh(clock)` to `setRepositoriesForTesting`, and `afterEach` calls `resetRepositories()` and `harness.cleanup()`. `seed()` therefore writes into this file's `UrbaniTest<runId>App` table, which is empty before each test. | unit + opt-in integration |
| `src/repositories/index.test.ts` | Default is `driver === 'sqlite'`. `DB_DRIVER=dynamodb` with a fresh-config dynamic import (the pattern of `integrations/index.test.ts`) gives `'dynamodb'` with no network. Override and reset work. | unit |
| `src/config/index.test.ts` | Empty `DYNAMODB_ENDPOINT` becomes `null`; `ftp://x` and `not a url` throw with the variable name; default table name is `UrbaniApp`; a bad prefix throws. | unit |
| `src/repositories/common.test.ts` | `compileLike`/`likeContains`: ASCII folding only (`é` vs `É` stays case-sensitive); `_` matches one code point, including an astral emoji; `%` matches any run; regex metacharacters are literal. A fixed table of (value, term) pairs plus 2,000 pairs from a deterministic pseudo-random generator are cross-checked against better-sqlite3 `SELECT ? LIKE ?` on an in-memory database (`'%' + term + '%'`). Timing: `likeContains('the eerie needle seems free here, see every green tree. '.repeat(4), '%e%e%e%e%e%e%e%e%z')` returns `false` in under 50 ms. Also `compareBinary`; `clampPage`; cursor round-trip and garbage input; the cursor schemas (audit range check, canonical timestamps, id patterns); `newTimeOrderedId` strictly increasing under a frozen clock. | unit |
| `src/repositories/dynamodb/items.test.ts` | Alert item round-trip; `budgetEvidence` drops trailing lines and keeps text intact; a log item has `GSI1SK` always and `GSI1PK` only when linked; audit and chat key formats; usage SK; size guard throws `ITEM_TOO_LARGE`. **`entityType`** (§5.4 rule), table-driven over all 16 builders: each output's `entityType` equals its §5.2 value, and the 16 values are exactly `ENTITY_TYPES`. `emailLockItem('a@x.test', 'u1')` equals `{ PK: 'USER_EMAIL', SK: 'a@x.test', entityType: 'USER_EMAIL', userId: 'u1' }`. | unit |
| `src/repositories/dynamodb/commands.test.ts` | A recording fake `send` asserts command shapes: upsertLive SETs `if_not_exists(#status, …)` and never touches the ack attributes; the acknowledge condition; replaceDerivedEvidence's `attribute_exists`; deleteByDataSource uses conditional DeleteItem, not BatchWrite; the upsertUser transaction has the lock condition and deletes the old lock; recordLogin's `attribute_exists`; the appendMessage transaction; the setFeedback transaction has 3 items, and a failed reason[1] gives `REFERENCE_NOT_FOUND`. **`entityType`** (§5.4 rule): the SET clauses of `upsertLivePreservingStatus`, `preferences.update` and `setFeedback` [2] contain `#entityType`, bound to `'ALERT'`, `'PREFS'` and `'CHAT_FEEDBACK'`; `preferences.update` also SETs `#userId` to the user id; the `upsertUser` lock Put [1] carries `entityType: 'USER_EMAIL'`. `health.ping` sends `ConsistentRead: true`. Error translation: Throttling → UNAVAILABLE (not fatal); ResourceNotFound → UNAVAILABLE fatal; ConditionalCheckFailed on acknowledge → `findById` fallback; an unknown error name is rethrown and logged with `op`. **Pagination** (fake `send` returning two pages with a `LastEvaluatedKey`): `queryAll` concatenates both pages and sends the first page's `LastEvaluatedKey` as `ExclusiveStartKey`; `queryCount` sums `Count` (3 + 4 → `alerts.countActive()` returns 7); `queryUpTo` stops at `want` and sets `Limit`; `services.all()` groups `alertCount` across both pages; no GSI query sets `ConsistentRead`. **`upsertUser`**: [0] has `attribute_not_exists(#pk)` for a new user and `#email = :prevEmail` for an existing one; [2] is present only when the email changes; reasons `[None, ConditionalCheckFailed, None]` → `DUPLICATE` without a retry; `[ConditionalCheckFailed, None, None]` twice → `UNAVAILABLE` after one re-read; `[None, None, ConditionalCheckFailed]` twice, then an old lock owned by another user → a third transaction without [2] commits and one warn with ids only is logged (`vi.spyOn(logger, 'warn')`). **`findByEmail`**: exactly two GetItems for a known and for an unknown email; a lock naming a user with another email gives `null` and a warn. **Key guard**: a 2,000-character id sends no command. | unit (no Docker) |
| `src/repositories/dynamodb/dynamoOnly.test.ts` | skip-if-no-endpoint (timeout 20 s), with its own `dynamoHarness` (§8.1): an oversized-evidence alert is stored trimmed and a warn is logged; an over-limit non-alert item raises `ITEM_TOO_LARGE`. **Every item carries `entityType`:** one test calls every create path once: `upsertRole`, `upsertUser` (user and lock), the first `preferences.update`, `audit.record`, `alerts.insert`, `upsertLivePreservingStatus` on a new id, `services.upsert`, `environments.ensure`, the three `upsertMany` methods, `aiAnalyses.insert`, `integrations.upsert`, `createSession`, `appendMessage` and the first `setFeedback`. `harness.scanAll()` then returns only items whose `entityType` is in `ENTITY_TYPES`, all 16 values appear, the live-upserted alert has `entityType: 'ALERT'`, and the preferences item has `userId`. | opt-in integration |
| `src/db/migrateSqliteToDynamo.test.ts` | `readSqliteSnapshot` on a 001-only DB (roles default, results backfilled, no chat tables) and on a 002 DB. Skip-if-no-endpoint (timeout 20 s), with its own `dynamoHarness` (§8.1). The migration writes through `harness.context()`, and the checks read through the repositories that `harness.fresh()` built for the same table. Cases: a dry run reports counts and leaves the table empty (`scanAll()` returns `[]`); a run creates items (spot-check alert evidence, links, and the user lock, which carries `entityType: 'USER_EMAIL'`); every scanned item has an `entityType`; preferences, chat sessions, messages and feedback read back through the DynamoDB repositories equal what the SQLite repositories return for the source; a re-run reports everything skipped; `relatedMetricIds` survive. | unit + opt-in integration |
| `src/db/cli.test.ts` | Pure functions, source-path resolution and `main()` exit codes. The cases and the re-import mechanics are in §8.3.1. | unit |
| `src/routes/routes.test.ts` | Supertest on `createApp()`. `beforeAll` runs `freshTestDb()` and `seed()`. The file replays the capture sequence of §14 step 1 exactly and in order, one `it` per step (27 steps), carrying the token and the ids `A` and `N` from earlier steps. Each step asserts the status and the recursive key set recorded for its step id in `src/routes/routes.baseline.json`. The fixture is keyed by step (for example `22-get-ai-analyses-after-analyze`), not by endpoint, because several key sets depend on earlier steps: the analyses list is empty before steps 20–21, and audit `metadata` keys appear only after the chat and settings requests. Key sets come from `src/test/keySet.ts`, which implements the key-set algorithm of §14 step 1. Step `02-get-ready` also asserts the body `{ status: 'ready', checks: { database: 'ok' } }`. No response key depends on `NODE_ENV` (checked: only values such as `/health` `env` do), so the test-mode run compares directly with the development-mode baseline. | integration (in-process, SQLite) |

#### 8.3.1 `cli.test.ts`
- **Pure functions.** These are imported statically at the top of the file, together with `CliPreconditionError`, so all of them come from one module graph.
  - `parseTablesArgs` rejects unknown flags.
  - `assertLocalEndpoint(null)` throws `CliPreconditionError`. Any non-empty endpoint passes, including `http://dynamodb-local:8000`.
  - `parseMigrateArgs` requires `--source` and rejects unknown flags and missing values.
- **Source path resolution** (§10). `parseMigrateArgs(['--source', 'x.sqlite'], base)` returns `path.resolve(base, 'x.sqlite')`. Without a `base` argument it resolves against `process.env.INIT_CWD`, and against `process.cwd()` when `INIT_CWD` is unset. An absolute path comes back unchanged.
- **`main()` from `db/cli.ts`**, one test per case:
  - `['tables']` without an endpoint resolves 2, and a `vi.mock` of `repositories/dynamodb/client` records no `createDynamoContext` call;
  - `['migrate', '--source', <missing file>]` resolves 2;
  - `['migrate', '--source', <existing file>]` without an endpoint and without `--allow-aws` resolves 2;
  - `['bogus']` resolves 2;
  - with `DYNAMODB_ENDPOINT='ftp://x'`, `['migrate', '--source', <existing file>]` resolves 2;
  - with `INIT_CWD` set to a temporary folder `T`, `['migrate', '--source', 'rel.sqlite']` resolves 2, and a `console.log` spy shows `Source (read-only): ${path.join(T, 'rel.sqlite')}`.
- **Re-import after every reset.** Each `main()` test snapshots `process.env`, sets or deletes `DYNAMODB_ENDPOINT` and `INIT_CWD`, and then runs:

  ```ts
  vi.resetModules();
  const { main } = await import('./cli');   // never call a main imported before the reset
  expect(await main(['tables'])).toBe(2);
  ```

  `main()` maps errors with `instanceof` (§9.5). After `vi.resetModules()`, the command modules load a fresh copy of `cliErrors.ts`. A `main` imported before the reset would test against the old `CliPreconditionError` class and resolve 1; the review reproduced this with vitest 2.1.9. Re-importing `./cli` after the reset is the pattern `integrations/index.test.ts` already uses for `./index`. The `vi.mock` factory result survives the reset, so the `createDynamoContext` spy assertion still works. `finally` restores `process.env` and calls `vi.resetModules()` again. The cases therefore behave the same when the opt-in run sets `DYNAMODB_ENDPOINT` in the shell.
- **Files.** Existing-file cases create an empty file in a folder from `fs.mkdtempSync(path.join(os.tmpdir(), 'urbani-cli-'))`, removed in `afterEach`. An empty file is enough, because the AWS guard runs before the file is opened (§10). No file is created in the worktree.

### 8.4 Existing tests: edits allowed
- `repositories/alertCorrelation.test.ts`: make `it` callbacks `async`; `await` repository calls through `const repos = getRepositories()`, created in `beforeEach` after `freshTestDb()`. The raw-SQL helpers `seedLog`/`evidenceLines` stay; they are SQLite-specific by design. Assertions are unchanged.
- `services/alertService.test.ts`: `beforeEach` becomes async with `await repos.alerts.insert(...)`. The test "a live re-sync does NOT revert…" becomes async with awaits. `matchEvidence` tests are untouched.
- `services/authService.test.ts`: await `upsertRole` and `upsertUser`. The `UserRow` literal without `role` still compiles because the input type is `UserUpsert`.
- **The one edit beyond async/await and registry access** (requirements FR5.4) applies to `services/alertService.test.ts`, `services/authService.test.ts` and `services/chatService.test.ts`. Each file deletes `import type Database from 'better-sqlite3'` and declares `let db: ReturnType<typeof freshTestDb>;` instead of `let db: Database.Database;`. `freshTestDb()` returns `Database.Database`, so the type is identical and no assertion changes. Without this edit the AC5 import gate fails on these three files. The alternative, excluding `*.test.ts` from the gate, contradicts the literal AC5 text. `routes/routes.test.ts` is written the same way from the start. The item report lists this edit against FR5.4.
- `services/chatService.test.ts` gets only that type-only edit. `integrations/*.test.ts` and `lib/markdown.test.ts`: no change.

The test count only grows: 73 existing, plus 69 SQLite contract cases, plus roughly 90 other default-suite tests (27 of them are the route steps), plus opt-in DynamoDB tests that are reported as skipped.

### 8.5 What is unit-tested and what is integration-tested
- **Unit, default suite, no I/O:** helpers, key builders, item mappers, the evidence budget, cursor codec, error translation, config, registry, CLI argument guards, and DynamoDB command shapes through a fake client. This exercises the DynamoDB driver's logic even when Docker is unavailable.
- **In-process integration, default suite:** SQLite contract, SQLite migration 002, seed, route shapes.
- **Opt-in integration, `DYNAMODB_ENDPOINT` set:** DynamoDB contract, seed on DynamoDB, migration end to end, DynamoDB-only size cases.
- **Manual smoke:** API on port 4100 for both drivers (§14).

## 9. Dev tooling

### 9.1 docker-compose profile (`docker-compose.yml`, new service)

```yaml
  # DynamoDB Local for DB_DRIVER=dynamodb development/tests. Not started by default:
  #   docker compose --profile dynamodb up -d dynamodb-local
  dynamodb-local:
    image: amazon/dynamodb-local:2.5.2
    profiles: ["dynamodb"]
    command: ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"]
    ports:
      - "127.0.0.1:8000:8000"   # loopback only
    networks:
      - urbani_net
```

`-sharedDb` makes every client see one database whatever its credentials or region. `-inMemory` keeps it disposable. The `backend` service is unchanged and stays `DB_DRIVER: sqlite`. Developers run the backend on the host against `http://127.0.0.1:8000`. UNVERIFIED: Compose interpolates the whole file, so the existing `JWT_SECRET: ${JWT_SECRET:?…}` may fail even when only `dynamodb-local` starts. The documented command therefore sets it. bash: `JWT_SECRET=dev docker compose --profile dynamodb up -d dynamodb-local`. PowerShell: `$env:JWT_SECRET='dev'; docker compose --profile dynamodb up -d dynamodb-local`.

### 9.2 Equivalent `docker run`, and the jar fallback

```
docker run -d --rm --name urbani-dynamodb-local -p 127.0.0.1:8000:8000 amazon/dynamodb-local:2.5.2 -jar DynamoDBLocal.jar -sharedDb -inMemory
docker stop urbani-dynamodb-local
```

The command is the same in bash and PowerShell.

**Jar fallback (decision: allowed).** When no Docker engine can be started, DynamoDB Local 2.x runs from the official jar, which needs Java 11 or later. The jar zip comes from the public download link on the AWS documentation page "Deploying DynamoDB locally on your computer". That link is AWS-hosted, and fetching it anonymously over plain HTTPS is allowed: no AWS account, credentials, CLI or SDK is involved, and no resource is read or changed. This is how NFR1 now defines an AWS call. A portable JRE that is not AWS-hosted, for example Eclipse Temurin 17, may be unpacked under `<worktree>\.tmp\`. Run it from the unpacked jar folder:

```
java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -sharedDb -inMemory -port 8000
```

Unlike the container, the jar listens on every network interface. It holds only in-memory test data behind dummy credentials, and it is stopped right after the checks by ending that process.

### 9.3 Seed for both drivers (`db/seed.ts`)
The existing production refusal stays: with `NODE_ENV=production` the seed needs `FORCE_DB_SEED=yes`. A new guard enforces NFR1 for the seed. It runs first, in the CLI block, before any repository is built:

```ts
/** Refuses to seed a real AWS table by accident. Throws CliPreconditionError, and the CLI exits 2. */
export function assertSeedTarget(db: { driver: DbDriver; dynamodb: { endpoint: string | null } }, argv: string[]): void {
  if (db.driver === 'dynamodb' && !db.dynamodb.endpoint && !argv.includes('--allow-aws')) {
    throw new CliPreconditionError(
      'Refusing: seeding an AWS DynamoDB table needs --allow-aws (set DYNAMODB_ENDPOINT for DynamoDB Local)');
  }
}
```

Without the guard, `DB_DRIVER=dynamodb` with no endpoint would use the AWS default credential chain and write MOCK demo data into whatever `UrbaniApp` table those credentials reach. `seed()` itself does not read argv, so tests call it directly. The steps:

1. Get the repositories with `const repos = getRepositories()`.
2. Prepare the store. On SQLite, run `runMigrations()`. On DynamoDB, run `await repos.health.ping()`. If the ping fails, the error carries the hint "run `npm run dynamo:tables` first" and the CLI exits 1.
3. Upsert the two roles as before.
4. If `findByEmail` finds no admin, call `upsertUser({... , role: 'SUPER_ADMIN'})`.
5. Write the reference data:
   - `environments.ensure` for each environment;
   - `services.upsert(s, 'MOCK')`;
   - `alerts.insert(a, 'MOCK', 'OPEN')`;
   - `logs.upsertMany(mockLogs, 'MOCK')`, `metrics.upsertMany(...)` and `usage.upsertMany(...)`.
6. Clean up stale integration rows. The raw `DELETE` becomes: `for (const r of await repos.integrations.all()) if (r.kind === 'URBANI_APP' && r.id !== 'int-urbani-ecs') await repos.integrations.delete(r.id);`
7. Upsert the 4 integration rows.
8. Log the same `Seed complete` line as before.

The CLI block runs `assertSeedTarget(config.db, process.argv.slice(2))`, which exits 2 on refusal. It then runs `seed()` and finally `await getRepositories().close()`. Other failures exit 1 as today. Seeding is idempotent on both drivers. Do not seed a table that will receive `dynamo:migrate`: the seeded admin owns the admin email lock, so a DPI 1 user with that email would be counted as a conflict (§10). From the repository root, flags reach the seed only through the compiled form, `node packages/backend/dist/db/seed.js --allow-aws`, because the root `seed` alias does not forward arguments. That alias is unchanged.

### 9.4 Startup and the other CLIs
- **`server.ts`.** `main` becomes `async`: `const repos = getRepositories();`, then `repos.driver === 'sqlite' ? runMigrations() : await assertDynamoReachable(repos)`. A fatal `PersistenceError` is rethrown, and any other error logs warn and continues. The "listening" log line gains a `dbDriver` field. Call it as `main().catch((err) => { logger.error('Startup failed', { message }); process.exit(1); })`. Graceful shutdown is unchanged.
- **`db/migrate.ts`.** The CLI block only: when `config.db.driver !== 'sqlite'`, log info "no SQL migrations for DB_DRIVER=dynamodb (table schema: dynamo:tables / IaC)" and exit 0. This check runs before `runMigrations()`, so no SQLite file is opened. `runMigrations()` itself is unchanged, because tests and `server.ts` call it directly.
- **`db/reset.ts`.** `reset()` throws "reset is SQLite-only. For DynamoDB Local run `npm run dynamo:tables -- --reset`" when the driver is not `sqlite`, and the CLI exits 1. The driver check is the first statement of `reset()`, before the production guard and before `getDb()`, so the refusal never opens or creates a SQLite file. The root `package.json` has no `reset` script, so the command is `npm run reset --workspace @urbani/backend`. The SQLite behavior is unchanged.

### 9.5 The DynamoDB CLIs: `db/cli.ts` and the table script `db/dynamoTables.ts`
- **Entry point `src/db/cli.ts`.** It serves `npm run dynamo:tables` (`ts-node src/db/cli.ts tables`) and `npm run dynamo:migrate` (`ts-node src/db/cli.ts migrate`); the compiled form is `node packages/backend/dist/db/cli.js <tables|migrate> …`. The root aliases forward flags with a trailing `--` (§3.1). Its only top-level value imports are `./cliErrors` and `../lib/errors`, which import nothing. `config/index.ts` validates the environment when it is imported, and `lib/logger.ts`, the registry and the DynamoDB driver all import it. A top-level import would therefore turn an invalid variable into an uncaught exit 1, where FR7.3 requires exit 2. `main()` loads everything with `await import()` inside a try/catch:

  ```ts
  /** Resolves the process exit code. Top-level imports: only ./cliErrors and ../lib/errors (see above). */
  export async function main(argv: string[]): Promise<number>;
  // 1. argv[0] must be 'tables' or 'migrate'; otherwise print usage on stderr and return 2.
  // 2. const { config } = await import('../config'). If it throws, print its message on stderr and return 2.
  // 3. Import ../lib/logger and the command's module, then return runTables(config, rest) or runMigrate(config, rest).
  // 4. Map errors: CliPreconditionError → logger.error(message) → 2; PersistenceError with fatal → logger.error(…, { awsError, hint }) → 2;
  //    anything else → logger.error('<command> failed', { message }) → 1. runMigrate itself returns 1 when report.totals.failed > 0.
  if (require.main === module) void main(process.argv.slice(2)).then((code) => process.exit(code));
  ```

  `CliPreconditionError` lives in `src/db/cliErrors.ts`, which has no imports, so `seed.ts`, `dynamoTables.ts` and `migrateSqliteToDynamo.ts` can throw it. `runTables` and `runMigrate` destroy their DynamoDB client in `finally`.

  Error mapping uses `instanceof`, so `cli.ts` and the command modules must come from the same module instance. In production one Node module cache serves the static and the dynamic imports, so they always do. Tests re-import `./cli` after every `vi.resetModules()` (§8.3.1).
- **`db/dynamoTables.ts` signatures:**

  ```ts
  export interface TablesArgs { reset: boolean }
  export function parseTablesArgs(argv: string[]): TablesArgs;   // only --reset; anything else → CliPreconditionError(usage)
  /** Presence check only (see below). Throws CliPreconditionError when endpoint is null. */
  export function assertLocalEndpoint(endpoint: string | null): asserts endpoint is string;
  export function ensureAppTable(client: DynamoDBClient, tableName: string, opts: { reset: boolean }): Promise<'created' | 'exists' | 'recreated'>;
  export function runTables(cfg: AppConfig, argv: string[]): Promise<number>;   // used by db/cli.ts
  ```

  `assertLocalEndpoint` checks presence only, for two reasons. With an endpoint set, the client always uses the dummy `local`/`local` credentials (§5.10), which no real AWS account accepts. A loopback-only rule would also reject the compose-network form `http://dynamodb-local:8000`.
- **Table definition.** `buildCreateTableInput(tableName)` comes from `repositories/dynamodb/tableDefinition.ts`. It defines `PK`/`SK`/`GSI1PK`/`GSI1SK` as S, `GSI1` with projection ALL, and `PAY_PER_REQUEST`, mirroring the CDK definition, and each file has a comment pointing to the other. `ensureAppTable(client, tableName, { reset })` does the work:
  - it calls DescribeTable;
  - if the table exists, it verifies that the key schema and the GSI name match; otherwise it throws `CliPreconditionError` ("run with --reset"), which exits 2;
  - with `reset`, it deletes the table, waits, and recreates it;
  - if the table is missing, it creates it and waits with `waitUntilTableExists` (maxWaitTime 60 s).
- **CLI** (`npm run dynamo:tables [-- --reset]`). `runTables` parses the flags, then calls `assertLocalEndpoint(config.db.dynamodb.endpoint)`. Without an endpoint it fails with "Refusing: dynamo:tables only targets DynamoDB Local (set DYNAMODB_ENDPOINT). Cloud tables come from infra/ (CDK)." and exits 2 before any client is created. It prints the table name, the endpoint and the action taken (created, exists, recreated). A failed DynamoDB Local call, for example `ECONNREFUSED` when Local is not running, exits 1. The configuration needs `JWT_SECRET`, so it must be set in the shell (any value locally).

## 10. SQLite → DynamoDB migration script (`db/migrateSqliteToDynamo.ts`)

- **Invocation.**
  - `npm run dynamo:migrate -- --source <path> [--dry-run] [--allow-aws]`. `--source` is required (§7.3).
  - Compiled form, for an operator host or a container: `node packages/backend/dist/db/cli.js migrate --source <path> …` (§9.5).
  - The target is `config.db.dynamodb`, meaning `DYNAMODB_TABLE_PREFIX`, `DYNAMODB_ENDPOINT` and `AWS_REGION`, independent of `DB_DRIVER`.
  - **Relative `--source` paths.** npm runs the backend script with `packages/backend` as its working directory, so `process.cwd()` is not the folder where the operator typed the command. `parseMigrateArgs` therefore resolves `path.resolve(process.env.INIT_CWD ?? process.cwd(), source)`. Verified with npm 11.6.2 on this machine (scratch project under `%TEMP%`, deleted afterwards):
    - `npm run dynamo:migrate --workspace @urbani/backend -- …` sets `INIT_CWD` to the folder npm was run from, including a subfolder;
    - the root alias `npm run dynamo:migrate -- …` starts a second npm in the repository root, and that npm resets `INIT_CWD` to the repository root, even when the outer command was typed in a subfolder;
    - the compiled form runs without npm, so `INIT_CWD` is normally unset and the working directory applies.

    Because of the second case, the documented commands use absolute paths (§12.2). The script prints `Source (read-only): <absolute path>` before it checks the file, so the operator always sees which file is used.
- **Exports** (`db/migrateSqliteToDynamo.ts`):

  ```ts
  export interface MigrateArgs { source: string; dryRun: boolean; allowAws: boolean }
  /** No file-system access. `source` comes back absolute: path.resolve(baseDir ?? process.env.INIT_CWD ?? process.cwd(), raw).
   *  Throws CliPreconditionError on a missing --source, a missing value or an unknown flag. */
  export function parseMigrateArgs(argv: string[], baseDir?: string): MigrateArgs;
  export const MIGRATION_ENTITIES = ['roles', 'users', 'preferences', 'environments', 'services', 'alerts', 'logs',
    'metrics', 'aiAnalyses', 'usage', 'audit', 'integrations', 'chatSessions', 'chatMessages', 'chatFeedback'] as const;
  export type MigrationEntity = (typeof MIGRATION_ENTITIES)[number];
  /** In a dry run, created/skipped mean would-create/would-skip. */
  export interface EntityCounts { source: number; created: number; skipped: number; failed: number; trimmedEvidence: number }
  export interface MigrationReport {
    dryRun: boolean; sourcePath: string; table: string; endpoint: string | null;
    entities: Record<MigrationEntity, EntityCounts>; totals: EntityCounts; startedAt: string; finishedAt: string;
  }
  /** Raw snake_case rows per entity. Alerts carry evidence[] and recommendedActions[] (read ORDER BY ordinal);
   *  logs, metrics and analyses keep alert_id. role/result are already defaulted for 001-only sources. */
  export type SqliteSnapshot = Record<MigrationEntity, Array<Record<string, unknown>>>;
  export function readSqliteSnapshot(db: Database.Database): SqliteSnapshot;
  export function migrateSqliteToDynamo(opts: {
    snapshot: SqliteSnapshot; ctx: DynamoContext; dryRun: boolean; sourcePath: string; endpoint: string | null;
  }): Promise<MigrationReport>;
  export function runMigrate(cfg: AppConfig, argv: string[]): Promise<number>;   // used by db/cli.ts
  ```
- **Preconditions, in this order. Each failed check exits 2:**
  1. the configuration loads and the arguments parse (§9.5);
  2. `runMigrate` prints `Source (read-only): <absolute path>` with `console.log`;
  3. `fs.statSync(source).isFile()` is true. Otherwise: "`--source` is not a regular file: <absolute path>";
  4. without `DYNAMODB_ENDPOINT`, `--allow-aws` is required, even with `--dry-run`. This check runs before the file is opened and before any DynamoDB client exists. In this item the script only runs against Local;
  5. the source opens with `new Database(source, { readonly: true, fileMustExist: true })`. The script never writes the SQLite database. SQLite may still create `-shm`/`-wal` sidecar files next to a WAL-mode source, so it runs on a copy (Appendix B) or on a `.tmp/` file;
  6. the target table answers `health.ping`, otherwise "create the table first". A fatal `PersistenceError` also exits 2.
- **Read.** `readSqliteSnapshot` uses SQL directly. This is persistence tooling, like seed and migrate. Schema detection uses `PRAGMA table_info`:
  - when `users.role` is missing, the role is `SUPER_ADMIN`;
  - when `audit_events.result` is missing, the result is `SUCCESS`, or `FAILURE` when `metadata.outcome === 'unavailable'` (the 002 rule);
  - missing `user_preferences`/`chat_*` tables count as 0 rows;
  - alert evidence and actions are read `ORDER BY ordinal`;
  - links come from `log_references.alert_id`, `metric_snapshots.alert_id` and `ai_analyses.alert_id`;
  - `created_at` values are preserved.
- **Map.** Rows go through the same `dynamodb/items.ts` builders the driver uses, so there is one source of truth for item shapes, and every item carries `entityType` (§5.4 rule). Preferences and feedback use `preferencesItem` and `feedbackItem`. These set the same attributes as the driver's create-capable UpdateItems, and the opt-in test compares their read-back with SQLite (§8.3). The evidence budget applies and every trimmed alert is counted as `trimmedEvidence`.
- **Write.** Entities are written in dependency order: roles, users and their email locks, preferences, environments, services, alerts, logs, metrics, AI analyses, usage, audit, integrations, chat sessions, messages, feedback. Within an entity the concurrency is 8. Every write is create-only:
  - PutItem with condition `attribute_not_exists(#pk)`; a condition failure counts as `skipped`;
  - users use TransactWriteItems with a create-only user plus a create-only lock built by `items.emailLockItem`, so the lock carries `entityType: 'USER_EMAIL'`. If reason[0] fails the user is `skipped`. If only reason[1] fails, the email belongs to a different user: counted `failed` and logged as a conflict;
  - chat messages keep their source ids and sessions keep their source `messageCount`. Nothing is incremented.

  Do not seed the target table first. The seeded admin owns its email lock, so a DPI 1 user with the same email would fail [1], be counted as a conflict, and make the run exit 1.
- **Idempotence.** A re-run creates nothing and skips everything. Rows added to SQLite since the last run are created. Rows that were already copied are never overwritten, because DynamoDB may hold newer state such as a later acknowledgement. For the final cut-over, writes to the SQLite app are stopped before the last run (Appendix B).
- **Dry run.** It maps everything and checks existence with `batchGetAll` (strongly consistent, keys only). It reports `wouldCreate`/`wouldSkip` and performs no write.
- **Output.**
  - A `console.table` per entity with the columns `entity | source | created | skipped | failed | trimmedEvidence` (`wouldCreate`/`wouldSkip` in a dry run).
  - A final JSON summary line via `logger.info('Migration summary', report)`.
  - Exit 0 if `failed === 0`, otherwise 1.
  - Errors are logged with entity and id only.
- **Scale.** The snapshot is read fully into memory. That is fine at DPI scale: 100k audit rows are about 30 MB. The ADR notes the limit.

## 11. IaC (authored only)

`infra/config/index.ts`: add `dynamoTablePrefix: ctx(scope, 'dynamoTablePrefix', process.env.URBANI_DYNAMODB_TABLE_PREFIX, 'Urbani')` and the derived `appTableName = \`${dynamoTablePrefix}App\``, typed in `UrbaniConfig`.

`infra/lib/persistence-construct.ts` (the existing alerts table is untouched):

```ts
export const APP_TABLE_GSI1 = 'GSI1'; // mirrors packages/backend/src/repositories/dynamodb/tableDefinition.ts

readonly appTable: dynamodb.Table;
private readonly key: kms.IKey;
// in the constructor, after alertsTable:
this.key = key;
this.appTable = new dynamodb.Table(this, 'UrbaniApp', {
  tableName: cfg.appTableName,
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
  encryptionKey: key,
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.RETAIN,   // app data is never destroyed by a stack teardown
});
this.appTable.addGlobalSecondaryIndex({
  indexName: APP_TABLE_GSI1,
  partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

/** Least-privilege data access for the dashboard backend (no Scan, no admin, no Streams). */
grantAppDataAccess(grantee: iam.IGrantable): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'UrbaniAppTableData',
    actions: [
      'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query',
      'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
      'dynamodb:BatchWriteItem', 'dynamodb:ConditionCheckItem',
    ],
    resources: [this.appTable.tableArn, `${this.appTable.tableArn}/index/${APP_TABLE_GSI1}`],
  }));
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'UrbaniAppTableKmsViaDynamoDb',
    actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
    resources: [this.key.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${Stack.of(this).region}.amazonaws.com` } },
  }));
}
```

The action list matches exactly what the driver sends. `TransactWriteItems` is authorized through its member actions (Put, Update, Delete, ConditionCheckItem), and BatchGet/BatchWrite are used by the seed, the link check and the migration dry run. The app never Scans and never calls DescribeTable at runtime: `ping` uses GetItem. The table script is local-only. The KMS statement grants CDK's `grantReadWriteData` key actions minus `kms:DescribeKey`. CDK 2.271.0 (`aws-dynamodb/lib/perms.js`) lists `kms:Decrypt` and `kms:DescribeKey` as key read actions and `kms:Encrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*` as key write actions. Item reads and writes are not expected to need `kms:DescribeKey`. The statement is narrowed with `kms:ViaService`, so the key can only be used through DynamoDB in that region. Whether the caller needs KMS permissions at all, and whether `kms:DescribeKey` is ever needed at runtime, are UNVERIFIED (§15.1). If go-live testing shows `AccessDenied` on `kms:DescribeKey`, add it to this statement.

`infra/lib/security-construct.ts`:

```ts
readonly dashboardTaskRole: iam.Role;
this.dashboardTaskRole = new iam.Role(this, 'UrbaniDashboardTaskRole', {
  roleName: 'UrbaniDashboardTaskRole',
  assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com', {
    conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },   // confused-deputy guard
  }),
  description: 'Dashboard backend task role: least-privilege data access to the UrbaniApp DynamoDB table only.',
});
```

`infra/lib/dashboard-construct.ts`:
- The constructor becomes `(scope, id, cfg, taskRole?: iam.IRole)`, and `new ecs.FargateTaskDefinition(this, 'DashboardTaskDef', { cpu, memoryLimitMiB, taskRole })`.
- The backend env keeps `DB_DRIVER: 'sqlite'`. A comment is added: "DPI 2 item 14: set DB_DRIVER=dynamodb, DYNAMODB_TABLE_PREFIX, remove the /data volume, raise desiredCount ≥ 2."
- The existing persistence NOTE comment is updated to point to the app table.

`infra/lib/urbani-dpi-stack.ts`: add `persistence.grantAppDataAccess(security.dashboardTaskRole)`, pass `security.dashboardTaskRole` to `DashboardConstruct`, and add `new CfnOutput(this, 'AppTableName', { value: persistence.appTable.tableName })`.

`infra/README.md`: the `SecurityConstruct` and `PersistenceConstruct` rows mention the dashboard task role and the `UrbaniApp` table with `GSI1`.

**Verification** is `cd infra && npm ci && npx tsc --noEmit && npm run check`.

The CDK CLI is not run, neither `cdk synth` nor anything else. The lockfile pins `aws-cdk` 2.1143.0. That CLI fetches notices from an AWS-hosted endpoint and, when credentials exist, resolves the default account with STS `GetCallerIdentity`, which NFR1 forbids. Instead, `infra/test/app-table.check.ts` synthesizes the stack in process with `aws-cdk-lib` and asserts on the template:
- Script: `"check": "ts-node test/app-table.check.ts"` in `infra/package.json`. `infra/tsconfig.json` adds `test/**/*.ts` to `include`, so `tsc --noEmit` type-checks the file.
- Tools: `Template` and `Match` from `aws-cdk-lib/assertions`, and `node:assert/strict`. No new dependency.
- Why it is offline: the library makes no network calls. The stack has no context lookups and no Docker bundling. `lambda.Code.fromAsset` only copies the two Lambda folders into the app's temporary output directory.

The check makes these assertions:
1. `new UrbaniDpiStack(new App(), 'UrbaniDpiCheck')` is built without `env`, so the template is account- and region-agnostic and needs no lookups.
2. Exactly one `AWS::DynamoDB::Table` has `TableName: 'UrbaniApp'`, and it has:
   - `KeySchema` `PK` HASH / `SK` RANGE and `BillingMode: 'PAY_PER_REQUEST'`;
   - `PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled: true`;
   - `SSESpecification` `{ SSEEnabled: true, SSEType: 'KMS' }` with a `KMSMasterKeyId`;
   - one GSI `GSI1` (`GSI1PK` HASH, `GSI1SK` RANGE, projection `ALL`);
   - `DeletionPolicy` and `UpdateReplacePolicy` `Retain`.
3. The `UrbaniAlerts` table keeps its key schema and its `anomaly_type-index` GSI.
4. The role `UrbaniDashboardTaskRole` trusts `ecs-tasks.amazonaws.com` under an `aws:SourceAccount` condition, and the dashboard task definition's `TaskRoleArn` references it.
5. The statements in every `AWS::IAM::Policy` whose `Roles` include that role are exactly two:
   - `UrbaniAppTableData`: the 8 FR8.2 actions, compared as a sorted list, on 2 resources that reference the app table's logical id; the second ends in `/index/GSI1`;
   - `UrbaniAppTableKmsViaDynamoDb`: the 4 KMS actions on the key, with a `kms:ViaService` condition.

   No statement on the role references the `UrbaniAlerts` logical id or grants `dynamodb:Scan`, `dynamodb:DescribeTable` or `dynamodb:*`.
6. The backend container environment still has `DB_DRIVER: 'sqlite'`.

`deploy-ecs.sh` and `redeploy.sh` are not modified. For the deploy-script path, the equivalent policy for the `urbaniqa-dpi-task-role` role is in Appendix A.

## 12. Documentation

### 12.1 `docs/adr/0001-dynamodb-persistence.md` (outline)
1. **Title, status, date.** Status: "Accepted (DPI 2 item 1); deployment pending client AWS account".
2. **Context.**
   - DPI 1 runs SQLite on task-local storage; deploy-ecs.sh uses `host: {}`, so data is lost when the task is replaced, and SQLite is single-writer, so only one task can run;
   - DPI 2 adds RBAC, audit, chat history and preferences;
   - the existing `UrbaniAlerts` table is pipeline scaffolding.
3. **Decision.** A single table `${DYNAMODB_TABLE_PREFIX}App` with `PK`/`SK` and one GSI `GSI1`; SQLite stays the default driver behind the same async repository interfaces.
4. **Key schema.** The table from §5.2.
5. **Access patterns.** The table from §5.3, with caller, operation, pagination helper and consistency. Pattern 7 (list users) is marked "not implemented in item 1; item 2 adds `users.list()`".
6. **Correctness.** Conditional writes and transactions (§5.5), the `upsertUser` concurrency handling (§5.4), and the cascade emulation (`unlinkAll`).
7. **Accepted divergences** (§2.5): no secondary UNIQUE constraints (`roles.name`, `services(name, environment)`, `environments.name`, the `id` side of usage records); key-length limits. Each says why it is harmless today: the only writers are the seed and the migration.
8. **Consistency.** Strong base reads; the GSI caveats (§5.6), including the AI-analysis `alertId` effect.
9. **Pagination, counts and scale limits** (§5.7): the helpers, the size and read-unit table, the threshold (about 1,000 alerts, or 3 MB in any one entity partition) and the mitigation path.
10. **Item size and key policy** (§5.8).
11. **Relationship to `UrbaniAlerts`** and the `DYNAMODB_ALERTS_TABLE`/`DYNAMODB_GSI_ANOMALY_TYPE` config (§5.9).
12. **Security.** CMK, PITR, RETAIN, the least-privilege task role, dummy credentials only for Local, no item contents in logs, the seed and CLI guards, and the LIKE emulation without regex (§4.5).
13. **Alternatives considered.**
    - per-entity tables: rejected for the reasons in §5.1;
    - storing alerts in `UrbaniAlerts`: rejected (§5.9);
    - keeping SQLite on EFS: survives task replacement but is still single-writer, so it cannot run 2+ tasks.
14. **Consequences and follow-ups.**
    - item 2's create-user path must require an explicit role. Migration 002 keeps `DEFAULT 'SUPER_ADMIN'` on `users.role` so that existing users become Super Admin (FR3.1), and the repository applies the same default. Any insert that forgets the role therefore creates a Super Admin. Once item 2 requires the role, it can drop the column default with a migration;
    - orphan email locks cannot arise from the repository or the migration. If one appears through a manual edit, `findByEmail` ignores it (with a warn) and it blocks that email until it is deleted by hand;
    - item 6 enables Streams and filters on `entityType`. Every item carries it, including items created by an UpdateItem (§5.4 rule, pinned by tests);
    - item 3 adds retention and TTL (`expiresAt`, which can be enabled without a data migration) and cursor UI;
    - item 14 flips `DB_DRIVER` and scales to ≥ 2 tasks;
    - rollback: setting `DB_DRIVER=sqlite` again does not copy DynamoDB data back.

### 12.2 `.env.example` changes
- Database block: `DB_DRIVER=sqlite  # sqlite (default; DPI 1 behaviour) | dynamodb (DPI 2)`, then `DYNAMODB_TABLE_PREFIX=Urbani` and `DYNAMODB_ENDPOINT=` with one-line comments.
- The existing "DynamoDB (alerts persistence upstream)" block gets one clarifying line: `UrbaniAlerts` is the future pipeline's table; app data uses `<prefix>App`.
- A new "Persistence drivers" comment section:

```
# ---- Persistence drivers (DPI 2) ---------------------------------------------
# DB_DRIVER=sqlite (default) keeps DPI 1 behaviour: one SQLite file at DATABASE_URL.
# DB_DRIVER=dynamodb stores everything in ONE table "<DYNAMODB_TABLE_PREFIX>App" (default UrbaniApp).
#   Design: docs/adr/0001-dynamodb-persistence.md
# AWS: leave DYNAMODB_ENDPOINT empty; credentials come from the default chain (ECS task role,
#   SSO, env). Never put AWS keys in this file for deployed environments.
# Local (no AWS account needed). Each step shows bash, then PowerShell (PS>).
# With DYNAMODB_ENDPOINT set, dummy local credentials are used automatically.
# The CLIs need JWT_SECRET too (any value locally), e.g. in packages/backend/.env.
#   1) Start DynamoDB Local (Docker Hub image), either directly:
#        docker run -d --rm --name urbani-dynamodb-local -p 127.0.0.1:8000:8000 amazon/dynamodb-local:2.5.2 -jar DynamoDBLocal.jar -sharedDb -inMemory
#      or with compose:
#        JWT_SECRET=dev docker compose --profile dynamodb up -d dynamodb-local
#        PS> $env:JWT_SECRET='dev'; docker compose --profile dynamodb up -d dynamodb-local
#   2) Create the table (refuses without DYNAMODB_ENDPOINT; add "-- --reset" to recreate it):
#        DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run dynamo:tables
#        PS> $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm run dynamo:tables
#   3) Seed demo data. Set the endpoint in the same command: without it the seed would target
#      AWS, and it refuses unless --allow-aws is passed.
#        DB_DRIVER=dynamodb DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run seed
#        PS> $env:DB_DRIVER='dynamodb'; $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm run seed
#   4) Run the API. The startup log "Persistence driver: dynamodb" must show the local endpoint.
#        DB_DRIVER=dynamodb DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run dev:backend
#        PS> $env:DB_DRIVER='dynamodb'; $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm run dev:backend
# Copy an existing SQLite DB into DynamoDB. --source is required. The run is idempotent and opens
# the source read-only, but run it on a copy, because SQLite may create -wal/-shm files beside it.
# Use an absolute path: this alias resolves a relative path against the repository root, whatever
# folder you run it from. The script prints the path it resolved before it starts.
#        DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run dynamo:migrate -- --source /srv/backups/urbani-copy.sqlite --dry-run
#        DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run dynamo:migrate -- --source /srv/backups/urbani-copy.sqlite
#        PS> $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm run dynamo:migrate -- --source C:\backups\urbani-copy.sqlite --dry-run
#        PS> $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm run dynamo:migrate -- --source C:\backups\urbani-copy.sqlite
# Contract tests against DynamoDB Local:
#        DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm test
#        PS> $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm test
# PowerShell keeps $env: values for the rest of the session. Clear them with:
#        PS> Remove-Item Env:DB_DRIVER, Env:DYNAMODB_ENDPOINT -ErrorAction SilentlyContinue
# Switching back to sqlite does not copy DynamoDB data back.
```

## 13. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| A missed `await` serializes `{}` or leaves a floating promise; an unhandled rejection crashes Node 20 | medium / high | `Promise` return types; supertest route shape tests; grep and review gate (§14 step 4); smoke diff against the baseline |
| Behavior drifts between drivers (ties, LIKE, FK edges) | medium / medium | 69 shared contract cases; documented, test-pinned emulation helpers; the LIKE emulation cross-checked against SQLite in the default suite; unavoidable differences (error classes, tie order, the accepted divergences of §2.5) kept out of assertions and listed in the ADR |
| A crafted search term makes the in-memory LIKE filter slow (DynamoDB driver) | low / medium | Linear matcher with no backtracking (§4.5): 0.8 ms for the review's pathological term, at most 4.8 ms for a crafted 1,000-character term against a 2,000-character field (SQLite: at most 1.6 ms); SQLite's own `LIKE` also scales with value length times term length; timing test in `common.test.ts` |
| A Query result above 1 MB is silently truncated | high without the helpers / high | `queryAll`, `queryCount` and `queryUpTo` are the only way to query (§5.7); grep gate (§14 step 4); two-page fake-client tests |
| Concurrent user upserts leave a stale email lock | low / high (a stale lock could still log the user in) | Conditioned user Put plus re-read (§5.4); `findByEmail` checks the stored email; contract cases C-UR-10 and C-UR-11 |
| On a machine with AWS credentials, `DB_DRIVER=dynamodb` without `DYNAMODB_ENDPOINT` targets that account | low / high | The seed refuses without `--allow-aws` (§9.3), `dynamo:tables` refuses without an endpoint, `dynamo:migrate` refuses without `--allow-aws`; the API logs the endpoint at startup; every verification command sets the endpoint in the same invocation (§14). This machine has no AWS credentials (verified by the review) |
| DynamoDB driver never runs against a real engine (no Docker engine, no Java) | high / medium | Command-shape and error-path unit tests with a fake client; the opt-in suite is ready; try starting Docker Desktop first, then the jar fallback with a portable JRE (§9.2). Otherwise the report says DynamoDB was NOT exercised, and the driver must not be enabled live until the contract passes on Local |
| GSI eventual consistency surprises (links, audit by actor, chat lists) | low / low | Strong base reads wherever SQLite parity needs read-after-write; caveats in the ADR |
| Collection reads grow linearly (alerts list, audit list, analyses) | medium over months / medium | Thresholds in the ADR; cursor APIs for new patterns; follow-ups in items 3 and 14 |
| Live mode on DynamoDB makes about 5 calls per live alert per Alerts request (unlink, upsert, evidence, clear, link check), about 50–80 calls and 0.3–0.5 s for 10 alerts | medium / low | The link check costs one BatchGet; sequential order is kept for parity. Throttling the sync per refresh window is a candidate for item 14 (service change, out of scope) |
| Oversized upstream evidence | low / low | 256 KiB budget, whole-line trimming, warn log; `ITEM_TOO_LARGE` for anything else |
| A write path creates an item without `entityType`, so item 6's Streams filter misses it and a backfill is needed | low / medium | §5.4 rule: builders on every Put, `#entityType` in the 3 create-capable UpdateItems; `items.test.ts` and `commands.test.ts` in the default suite; the `scanAll()` check over every create path in `dynamoOnly.test.ts` and after the migration |
| The stale tracked WAL/SHM files in `packages/backend/data/` get opened | medium / high (DPI 1 data replay, dirty tracked files) | Every runtime check uses `DATABASE_URL` under `.tmp/`; the report flags the tracked files for a separate cleanup |
| `upsertUser` SQL change (§4.3) is seen as a behavior change | low / low | Not reachable from app flows; it removes a silent-delete bug; called out in requirements FR2.5 for review |
| Region mismatch: CDK defaults to `ap-south-1`, deploy-ecs.sh runs in `us-east-1` | medium / medium at go-live | Listed in "To go LIVE"; `AWS_REGION` and CDK context must match the ECS region |
| Item 14 multi-task concerns beyond the DB (in-memory rate limiter, adapter caches per task) | known / low | Noted for item 14; out of scope |
| SDK option or version drift (`requestHandler` object form) | low / low | Fallback in §15 |

## 14. Verification plan

Run everything in `C:\Antigravity\Urbani DPI\.worktrees\dpi2` with absolute paths; `<wt>` stands for that path. Never touch the main workspace or `packages/backend/data/*`. Use ports 4100 (API) and 8000 (DynamoDB Local). Never create a committed `.env`.

The host shell is PowerShell. Each command below runs from `<wt>` in a fresh PowerShell process that sets its own variables in the same invocation, so nothing leaks from one step into the next. Where a step names variables in prose, they are set this way. Check exit codes with `$LASTEXITCODE`; npm passes a script's exit code through, including through the root aliases (verified with npm on this machine: a script exiting 2 gives 2, directly and nested).

**Runtime environments.** Every seed, server and CLI command sets one of these complete sets, plus the variables its step names. Each set includes a `DATABASE_URL` under `.tmp\`. Without it the default `./data/urbani.sqlite` resolves against the working directory. For a `node` command run from `<wt>` that is a new, empty `<wt>\data\` database, where login fails. For an npm workspace script, which runs in `packages/backend`, it is the folder §2.6 forbids.
- **ENV-SQLITE(`<db>`):** `$env:JWT_SECRET='dev'; $env:NODE_ENV='development'; $env:INTEGRATION_MODE='mock'; $env:DB_DRIVER='sqlite'; $env:DATABASE_URL='<wt>\.tmp\smoke\<db>\urbani.sqlite'`
- **ENV-DYNAMO(`<prefix>`):** `$env:JWT_SECRET='dev'; $env:NODE_ENV='development'; $env:INTEGRATION_MODE='mock'; $env:DB_DRIVER='dynamodb'; $env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; $env:DYNAMODB_TABLE_PREFIX='<prefix>'; $env:DATABASE_URL='<wt>\.tmp\smoke\dynamo-unused\urbani.sqlite'`. Here the `DATABASE_URL` is a tripwire: no DynamoDB-mode command may create that file (checked in step 8.7).
- A server start adds `$env:PORT='4100'` and runs `node packages/backend/dist/server.js` in the background, for example with `Start-Process -NoNewWindow -PassThru`, which inherits the variables. Before sending requests, wait until `GET http://127.0.0.1:4100/health` returns 200. To stop it, run `Stop-Process -Id <pid>`, then confirm that `Get-NetTCPConnection -LocalPort 4100 -ErrorAction SilentlyContinue` returns nothing.

1. **Baseline, before any code change.**
   1. **Mandatory first action, before any runtime file is created:** append `.tmp/` to `<wt>\.gitignore`. The existing `*.sqlite` rule does not match the `-wal`/`-shm` sidecars, which is how `packages/backend/data/*.sqlite-wal`/`-shm` came to be tracked (§2.6). Then create an empty probe file `<wt>\.tmp\smoke\probe.sqlite-wal`. Confirm that `git -C <wt> check-ignore -v .tmp/smoke/probe.sqlite-wal` names the `.tmp/` rule and that `git -C <wt> status --short` does not list the probe, then delete it. (An empty folder proves nothing, because git never lists empty folders.) The edit does not change the build. It is committed with the item.
   2. Run `npm run build`.
   3. Seed: ENV-SQLITE(`baseline`); `node packages/backend/dist/db/seed.js`.
   4. Start the server with ENV-SQLITE(`baseline`) and `PORT='4100'`.
   5. Run the capture script (below) with base URL `http://127.0.0.1:4100` and output folder `.tmp\smoke\baseline\`. It writes every response body to `<step>.json` and every status and key set to `keysets.json`.
   6. Stop the server.
   7. Copy `.tmp\smoke\baseline\keysets.json` to `packages/backend/src/routes/routes.baseline.json`. The file holds step ids, statuses and key paths, and no values. It is committed as the `routes.test.ts` fixture.

   **Capture script.** A throwaway Node script, `<wt>\.tmp\smoke\capture.mjs`, never committed. Its arguments are the base URL and the output folder. It logs in as the seed admin, with `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` or the config defaults when they are unset. From step 04 on it sends `Authorization: Bearer <token>`. It replays this sequence, in this order:

   | Step id | Request | Status | Captured for later steps |
   |---|---|---|---|
   | `01-get-health` | `GET /health` | 200 | |
   | `02-get-ready` | `GET /ready` | 200 | |
   | `03-post-auth-login` | `POST /api/auth/login` with the seed admin's email and password | 200 | `token` |
   | `04-get-auth-me` | `GET /api/auth/me` | 200 | |
   | `05-get-dashboard-summary` | `GET /api/dashboard/summary` | 200 | |
   | `06-get-dashboard-health` | `GET /api/dashboard/health` | 200 | |
   | `07-get-alerts` | `GET /api/alerts` | 200 | `A` = `data.items[0].alertId` |
   | `08-get-alert-detail` | `GET /api/alerts/<A>` | 200 | |
   | `09-get-alert-missing` | `GET /api/alerts/ALT-DOES-NOT-EXIST` | 404 | |
   | `10-get-logs` | `GET /api/logs` | 200 | |
   | `11-get-metrics` | `GET /api/metrics` | 200 | |
   | `12-get-services` | `GET /api/services` | 200 | |
   | `13-get-service-detail` | `GET /api/services/svc-main` | 200 | |
   | `14-get-service-missing` | `GET /api/services/svc-does-not-exist` | 404 | |
   | `15-get-usage` | `GET /api/usage` | 200 | |
   | `16-get-usage-cost` | `GET /api/usage/cost` | 200 | |
   | `17-get-settings` | `GET /api/settings` | 200 | |
   | `18-get-ai-analyses-before-analyze` | `GET /api/ai/analyses` (empty list) | 200 | |
   | `19-get-audit-before-writes` | `GET /api/audit` | 200 | |
   | `20-post-ai-analyze` | `POST /api/ai/analyze` `{ "service": "main", "environment": "qa" }` | 200 | `N` = `data.id` |
   | `21-post-chat` | `POST /api/chat` `{ "question": "Why is main failing?", "service": "main", "environment": "qa" }` | 200 | |
   | `22-get-ai-analyses-after-analyze` | `GET /api/ai/analyses` | 200 | |
   | `23-get-ai-analysis-detail` | `GET /api/ai/analyses/<N>` | 200 | |
   | `24-post-alert-acknowledge` | `POST /api/alerts/<A>/acknowledge` | 200 | |
   | `25-put-settings` | `PUT /api/settings` `{ "theme": "dark" }` | 200 | |
   | `26-get-audit-after-writes` | `GET /api/audit` | 200 | |
   | `27-post-auth-logout` | `POST /api/auth/logout` | 200 | |

   Several key sets depend on earlier steps. The analyses list is empty before steps 20 and 21. Audit `metadata` keys appear only after the chat and settings requests: step 19 holds only `LOGIN` and the `ALERT_VIEWED` event from step 08, neither with metadata. The fixture is therefore keyed by step, never by endpoint.

   **Key-set algorithm.** `src/test/keySet.ts` implements it, and the capture script carries an identical copy:
   - an object adds the path of each key (`parent.key`, or `key` at the top level) and recurses into the value;
   - an array recurses into each element under the path `parent[]`, and a primitive element adds `parent[]`;
   - a primitive or `null` adds nothing at its own level;
   - the result is the sorted list of distinct paths. For example, `{ a: [{ b: 1 }, { c: null }], d: [] }` gives `a`, `a[].b`, `a[].c`, `d`.

   Steps 7 and 8.6 replay the same script against a freshly seeded store, so the key sets are directly comparable.
2. **Build:** `npm run build` at the root succeeds for shared, backend and frontend.
3. **Default tests:** `npm test` at the root, with `DYNAMODB_ENDPOINT` unset. All green. Record the total, passed and skipped counts, and confirm all 73 pre-existing tests are among the passes.
4. **Static gates:**
   - `Select-String` over `packages/backend/src`, test files included, finds no `better-sqlite3`, `db/connection` or `@aws-sdk` import outside `repositories/`, `db/` and `test/`. The three service tests pass this gate after the §8.4 type-only edit;
   - `QueryCommand`, `BatchGetCommand` and `BatchWriteCommand` appear only in `repositories/dynamodb/ops.ts` (requirements AC19). The test harness purges through `batchWriteAll`;
   - `new RegExp` and `RegExp(` do not appear under `repositories/`, so no pattern is built from input (AC18);
   - a grep for repository calls not preceded by `await`/`return`, plus a manual review of every changed caller file;
   - `git diff main -- packages/frontend` is empty.
5. **Frontend:** `npx tsc -b --noEmit` in `packages/frontend` is clean.
6. **Infra:** in `<wt>\infra`, `npm ci`, `npx tsc --noEmit` and `npm run check` each exit 0 (§11). The CDK CLI is not run.
7. **SQLite smoke** on the new build:
   1. Seed: ENV-SQLITE(`sqlite`); `node packages/backend/dist/db/seed.js`.
   2. Start the server with ENV-SQLITE(`sqlite`) and `PORT='4100'`. The startup log line `Persistence driver: sqlite` shows the `.tmp\smoke\sqlite\` path.
   3. Run the capture script with output folder `.tmp\smoke\sqlite\`. For every step, the status and the key set equal `.tmp\smoke\baseline\keysets.json`. Step 02 returns 200.
   4. Stop the server.
8. **DynamoDB, only if an engine is available.** Steps 8.4–8.6 set ENV-DYNAMO in the same invocation as each command, so no `DB_DRIVER='dynamodb'` command runs without `DYNAMODB_ENDPOINT`. Step 8.3 sets only `DYNAMODB_ENDPOINT`, because `test/setup.ts` provides the rest of the test environment.
   1. Start Docker Desktop if it is installed and wait for `docker version` to report a server. Otherwise use the jar fallback (§9.2).
   2. Start `urbani-dynamodb-local` (§9.2), or the jar process.
   3. `$env:DYNAMODB_ENDPOINT='http://127.0.0.1:8000'; npm test`: the DynamoDB contract and the other opt-in tests pass with 0 skipped. Each opt-in file uses its own `UrbaniTest<runId>App` table (§8.1).
   4. ENV-DYNAMO(`UrbaniSmoke`); `npm run dynamo:tables`. Then run ENV-DYNAMO(`UrbaniSmoke`); `npm run seed` twice. Both runs exit 0, the second logs `Admin user already exists; skipping`, and the `Persistence driver: dynamodb` log line shows `endpoint: http://127.0.0.1:8000`. Step 8.6 checks the counts: the alert total in step 07 and the number of services (step 12) and usage records (step 15) equal those of the SQLite smoke (step 7), so the second seed duplicated nothing.
   5. ENV-DYNAMO(`UrbaniMigrate`); `npm run dynamo:tables`. Then run ENV-DYNAMO(`UrbaniMigrate`); `npm run dynamo:migrate -- --source <wt>\.tmp\smoke\sqlite\urbani.sqlite --dry-run` twice. Each run prints `Source (read-only): <wt>\.tmp\smoke\sqlite\urbani.sqlite`. Both runs report the same would-create counts and 0 would-skip, which shows that the first wrote nothing. Then run without `--dry-run` (created counts), and once more (everything skipped).
   6. Start the server with ENV-DYNAMO(`UrbaniSmoke`) and `PORT='4100'`. Before sending requests, check that the startup log line `Persistence driver: dynamodb` shows `endpoint: http://127.0.0.1:8000`. Run the capture script with output folder `.tmp\smoke\dynamodb\`. For every step, the status and the key set equal the baseline. Step 02 returns 200. The totals named in step 8.4 equal those in `.tmp\smoke\sqlite\`.
   7. Stop the server, then `docker stop urbani-dynamodb-local` or end the jar process. Confirm that `<wt>\.tmp\smoke\dynamo-unused\urbani.sqlite` does not exist: no DynamoDB-mode command opened SQLite.

   If no engine can be started, record "DynamoDB Local NOT exercised" in the report, with the reason. Do not claim the driver was verified.
9. **Guards.** Each runs in a fresh process with `$env:JWT_SECRET='dev'; $env:NODE_ENV='development'; $env:DATABASE_URL='<wt>\.tmp\smoke\guard\unused.sqlite'`, and without `DYNAMODB_ENDPOINT` unless stated:
   - `npm run dynamo:tables` exits 2 with the refusal message;
   - `npm run dynamo:migrate -- --source <wt>\.tmp\smoke\sqlite\urbani.sqlite` exits 2, because `--allow-aws` is missing;
   - `$env:DYNAMODB_ENDPOINT='ftp://x'; npm run dynamo:migrate -- --source <wt>\.tmp\smoke\sqlite\urbani.sqlite` exits 2 (configuration error);
   - `$env:DB_DRIVER='dynamodb'; npm run seed` exits 2 with "Refusing: seeding an AWS DynamoDB table needs --allow-aws …";
   - `$env:DB_DRIVER='dynamodb'; npm run reset --workspace @urbani/backend` exits 1, and its message names `dynamo:tables -- --reset`.

   Afterwards no `unused.sqlite` file exists under `.tmp\smoke\guard\`. None of these calls AWS: each refuses before a DynamoDB client exists. This machine also has no AWS credentials (verified by the review).
10. **Hygiene:**
    - `git status` shows no `.env`, `.tmp/` or `packages/backend/data/*` changes, and `git diff -- .gitignore` shows only the added `.tmp/` line;
    - every process started is stopped (ports 4100 and 8000 free);
    - `git -C "C:\Antigravity\Urbani DPI" rev-parse main` is still `5cc5ffa…`.
11. **Commit** on `dpi2` only. Do not push and keep the worktree. Then update the tracker and write the report, including "To go LIVE" (Appendix B).

## 15. UNVERIFIED assumptions
1. Whether DynamoDB requires the calling principal to hold KMS permissions on a CMK-encrypted table, or relies only on the grant created with the table. The task role gets CDK's key actions minus `kms:DescribeKey`, scoped by `kms:ViaService`. Also unverified: that item reads and writes never need `kms:DescribeKey`. Confirm both at go-live. Drop the statement if it is unneeded, or add `kms:DescribeKey` if calls are denied without it.
2. That the installed SDK version accepts `requestHandler` as a plain options object. Fallback: add `@smithy/node-http-handler` (the version npm already resolves for the SDK) as an explicit dependency and pass `new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 5000 })`.
3. That the image tag `amazon/dynamodb-local:2.5.2` exists. Docker could not be queried here. If the pull fails, pin the newest available 2.x tag and record it.
4. That Compose fails on the unrelated `${JWT_SECRET:?}` when starting only `dynamodb-local`. The documented command sets `JWT_SECRET` either way.
5. That DynamoDB Local updates GSIs synchronously, which the contract tests rely on. If not, the GSI-dependent cases (byAlert, actor queries, session lists) get a bounded retry helper, at most 1 s.
6. That DynamoDB Local v2 accepts the access key id `local` (letters only).
7. Replaced in revision 2. `cdk synth` is no longer run. The in-process check (§11) needs no network by construction: an env-agnostic stack, no lookups, no bundling. What remains unverified is only that `Template.fromStack` accepts this stack as written, for example that no construct demands a concrete region. If it fails for that reason, the check passes an explicit dummy `env` (account `111111111111`, region `us-east-1`), which needs no lookups for this stack except the VPC's availability zones. Those fall back to dummy values in process.
8. Real-world sizes of upstream alert evidence. The budget is sized conservatively.
9. That Docker Desktop can be started non-interactively in this environment.
10. That DynamoDB Local reports a code for every item in `CancellationReasons` (`None` for items that passed), as DynamoDB does. The `upsertUser` decision table (§5.4) needs only to know which items failed. If Local reports only the first failure, the table still terminates: an unexpected combination falls into the re-read row, and the second attempt ends in `DUPLICATE`, the inconsistent-lock path, or `UNAVAILABLE`. The fake-client tests pin the logic either way.
11. The exact download URL of the DynamoDB Local jar zip, and its Java requirement (11 or later for 2.x). §9.2 cites the AWS documentation page rather than a URL from memory. If the jar requires a newer Java, use that JRE.

## 16. Suggested implementation order
1. Add `.tmp/` to `.gitignore`, then capture the baseline and the `routes.baseline.json` fixture (§14 step 1).
2. Add the shared enums, `PersistenceError`, `repositories/types.ts`, `common.ts`, `validation.ts` and the registry. Move the SQLite repositories and convert them to async factories. Add migration 002 and the new SQLite entities.
3. Convert every caller (services, routes, seed, mock adapter, health, server, CLIs) and update the four existing test files (async edits in three, the type-only edit of §8.4 in three). `npm test` must be green, with the 73 existing tests passing.
4. Add the contract suite, harness, route tests, migration and seed tests on SQLite.
5. Build the DynamoDB driver (client, keys, items, ops with the pagination and batch helpers, links, repositories) and its unit, pagination and command-shape tests.
6. Add the tooling: `db/cliErrors.ts`, `db/cli.ts`, the table script, the seed guard, the compose profile and the migration script, with `cli.test.ts`.
7. Write the IaC and `infra/test/app-table.check.ts`, then the docs (ADR, `.env.example`, infra README).
8. Run full verification (§14), commit, and write the report.

## Appendix A. Policy for the deploy-script task role (go-live; not applied in this item)
If the table is created outside CDK and used by the `urbaniqa-dpi-task-role` that `deploy-ecs.sh` creates, attach the policy below. Replace the placeholders. Include the second statement only if the table uses a customer-managed key.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UrbaniAppTableData",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:PutItem",
                 "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"],
      "Resource": ["arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/UrbaniApp",
                   "arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/UrbaniApp/index/GSI1"]
    },
    {
      "Sid": "UrbaniAppTableKmsViaDynamoDb",
      "Effect": "Allow",
      "Action": ["kms:Decrypt", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"],
      "Resource": "<CMK_ARN>",
      "Condition": { "StringEquals": { "kms:ViaService": "dynamodb.<REGION>.amazonaws.com" } }
    }
  ]
}
```

## Appendix B. "To go LIVE" checklist (input for the item report)
1. **The client provides:** the AWS account id and the region. The region must equal the ECS service region, `us-east-1` in the current `deploy-ecs.sh`. They also provide permission to create one DynamoDB table and one IAM policy.
2. **Create the table.** Deploy the `PersistenceConstruct` app table with `cdk deploy -c account=… -c region=…` (item 14 decides whether the full stack or a persistence-only stack), or create an identical table: `PK`/`SK` strings, `GSI1` (`GSI1PK`/`GSI1SK`, projection ALL), on-demand, PITR on, deletion protection recommended.
3. **Grant access.** In CDK, `grantAppDataAccess` already covers `UrbaniDashboardTaskRole`. For the deploy-script path, attach Appendix A to `urbaniqa-dpi-task-role`.
4. **Task environment** (item 14 edits deploy-ecs.sh): `DB_DRIVER=dynamodb`, `DYNAMODB_TABLE_PREFIX=Urbani` (or the agreed prefix), `AWS_REGION=<region>`, and no `DYNAMODB_ENDPOINT`. `DATABASE_URL` and the `/data` volume can then be removed, and `desiredCount` can be raised to 2 or more across 2 AZs.
5. **Migrate the data.** The DPI 1 database lives on task-local storage (the `host: {}` volume), so any redeploy loses it. Copy it out of the running task before switching.
   1. `deploy-ecs.sh` creates the service with `--enable-execute-command`. ECS Exec also needs `ssmmessages:*` on the task role, and the current `dpi-task-policy` may not grant that (UNVERIFIED).
   2. Through ECS Exec, checkpoint the WAL so the file is complete: `node -e "const D=require('better-sqlite3');const d=new D('/data/urbani.sqlite');d.pragma('wal_checkpoint(TRUNCATE)');d.close()"`.
   3. Copy the file out, for example by streaming it base64-encoded through the session. Keep this copy as the DPI 1 backup. It must be taken **before the first DPI 2 image starts on that SQLite file**, for example in a staged rollout that keeps `DB_DRIVER=sqlite`. A DPI 2 start applies migration 002 automatically, and 002 is forward-only, so the copy is the only way back to an untouched DPI 1 database.
   4. From a dpi2 build on an operator host, with credentials for the target account, run `npm run dynamo:migrate -- --source <absolute path of the copy> --dry-run --allow-aws`, or the compiled form `node packages/backend/dist/db/cli.js migrate --source <absolute path of the copy> --dry-run --allow-aws`. Check the printed `Source (read-only):` line. Do not seed the target table before migrating (§10).
   5. Run it again without `--dry-run`, then verify the counts. Exit code 0 means no failures.
   6. Deploy with `DB_DRIVER=dynamodb`. Re-running the migration is safe; it only adds missing rows.

   If the file cannot be copied, start fresh. Run the seed once in the new task: `FORCE_DB_SEED=yes node packages/backend/dist/db/seed.js --allow-aws`. `FORCE_DB_SEED` is the DPI 1 production guard; `--allow-aws` is the new guard for an AWS target (§9.3). That recreates the admin and the MOCK reference data. LIVE alerts re-sync from the Urbani API, but their acknowledgements and the DPI 1 audit and AI-analysis history are lost.
6. **Go/no-go:**
   - the DynamoDB contract suite has passed on DynamoDB Local (required if it was not exercised in item 1);
   - `/ready` returns 200 in the new task;
   - login works;
   - the DPI 1 admin password has been rotated (DPI 2 plan §6.5).

## 17. Responses to the first design review (revision 2, findings 1–21)

Source: the first review of revision 1 (CHANGES_REQUESTED, 1 HIGH, 6 MEDIUM, 14 LOW). `design-review.md` now holds the second review, which re-checked all 21 findings and reports them closed. All 21 were addressed in revision 2. None was backlogged or rejected. Finding 14 is adopted with a stronger mechanism than the one suggested, and finding 15 is extended; both are explained in their rows.

| # | Severity | Finding | Response | Where |
|---|---|---|---|---|
| 1 | HIGH | `likeContains` regex is a ReDoS vector | **Addressed.** The regex is replaced by the linear matcher `compileLike`, as proposed in the review, compiled once per request and with an early length exit. No regex is built from input. Measured: 0 mismatches against SQLite `LIKE` on 247,000 random pairs; 0.8 ms for the review's pathological term. Tests: SQLite cross-check, the < 50 ms timing case, and a grep gate for `RegExp` | §4.5, §5.4, §8.3, §13, §14 step 4; FR4.8, AC18 |
| 2 | MEDIUM | Queries do not paginate; counts and lists go wrong above 1 MB | **Addressed.** `queryAll`, `queryCount` and `queryUpTo`, plus `batchGetAll`/`batchWriteAll`, with signatures. Every Query row in §5.3 and `unlinkAll` names its helper. A grep gate keeps `QueryCommand` inside `ops.ts`. Two-page fake-client tests | §5.3, §5.4, §5.7, §8.3, §14 step 4; FR4.7, AC19 |
| 3 | MEDIUM | `upsertUser` can leave an orphan email lock that still logs the user in | **Addressed as proposed.** The user Put is conditioned (`attribute_not_exists` / `email = :prevEmail`). A decision table maps cancellation reasons to one re-read. The inconsistent-lock path skips the delete with an ids-only warn. `findByEmail` returns the user only if the stored email matches. Command-shape and retry-path tests, plus contract cases C-UR-10 and C-UR-11 for the two races | §5.3 (6), §5.4, §5.5, §7.2, §8.2, §8.3; FR4.2 |
| 4 | MEDIUM | Audit cursor not checked against `from`/`to` (DynamoDB 500, SQLite rows) | **Addressed.** Per-list cursor schemas. An audit cursor needs a canonical `ts`, an `id` of 1–64 characters and `from <= ts <= to`; both drivers raise `INVALID_CURSOR` before querying. Session and message cursors get canonical and pattern checks too. C-AU-07 is extended | §4.5, §5.4, §7.3, §8.2; FR3.3, AC9 |
| 5 | MEDIUM | `setFeedback` skips the user check; "exists" undefined | **Addressed.** "User exists" means a user row with that id, whatever `is_active` is; it applies to patterns 9, 39 and 44. SQLite checks the user inside the transaction. DynamoDB uses a 3-item transaction (message check, user check, update). New cases C-CH-09 and C-PF-05 | §4.5, §5.3, §5.4, §5.5, §7.4, §8.2; FR2.4, FR3.4, A8 |
| 6 | MEDIUM | The seed has no AWS guard | **Addressed.** `assertSeedTarget` exits 2 without `--allow-aws`, with unit tests. Appendix B uses `--allow-aws`. §14 sets `DYNAMODB_ENDPOINT` in the same invocation as every `DB_DRIVER=dynamodb` command and checks the startup log line. The `.env.example` recipe does the same | §9.3, §12.2, §14 steps 8–9, Appendix B; FR6.3, AC11 |
| 7 | MEDIUM | AC5 import gate fails on existing service tests | **Addressed with the review's chosen fix.** Type-only edit in three service tests, and `routes.test.ts` written the same way. FR5.4 allows this edit; the report notes it | §2.2, §2.3, §8.4, §16; FR5.4, AC5, AC17 |
| 8 | LOW | Secondary UNIQUE constraints not reproduced on DynamoDB | **Addressed.** Listed as accepted divergences, with the reason they are harmless today; the §2.5 heading and the §5.2 usage sentence are corrected | §2.5, §5.2, §12.1 (7); FR4.10 |
| 9 | LOW | KMS rationale inaccurate | **Addressed.** Reworded to "CDK's key actions minus `kms:DescribeKey`". The runtime need for `DescribeKey` is marked UNVERIFIED, with a go-live fallback | §11, §15.1; FR8.2 |
| 10 | LOW | Optional `cdk synth` and the jar download conflict with NFR1 | **Addressed.** The CDK CLI is dropped. An offline in-process check with `aws-cdk-lib/assertions` (`npm run check`) replaces it, which also makes AC14 executable. Jar decision: the anonymous download is allowed, and NFR1 now defines "AWS call" precisely | §1, §9.2, §11, §14 step 6, §15.7; NFR1, FR6.5, FR8.4, AC4, AC14 |
| 11 | LOW | Missing root `reset` script; bash-only syntax | **Addressed.** `npm run reset --workspace @urbani/backend`, with message and no-file checks. PowerShell forms for every command, compose included. `.env.example` shows bash and PowerShell | §9.1, §9.4, §12.2, §14; FR6.4, FR9.1 |
| 12 | LOW | Helpers referenced but not defined | **Addressed.** Signatures for `assertDynamoReachable`, the five ops helpers, `parseTablesArgs`/`assertLocalEndpoint`/`ensureAppTable`/`runTables`, and `parseMigrateArgs`/`MigrationReport`/`EntityCounts`/`SqliteSnapshot`/`runMigrate`. `assertLocalEndpoint` is presence-only, for the review's reasons | §3.3, §5.7, §9.5, §10 |
| 13 | LOW | `dashboardService.ts:38` `ReturnType` missing from the inventory | **Addressed** | §2.2, §3.4 |
| 14 | LOW | CLI configuration errors exit 1, not 2 | **Addressed, with a stronger mechanism.** Loading config inside `main()` of the existing files is not enough: `lib/logger.ts`, the registry and the DynamoDB driver import `config` at module load, so any top-level import still throws first. Both CLIs therefore run through the new thin entry `db/cli.ts`, whose only top-level imports are two modules that import nothing; it loads `config` inside `main()`. `cli.test.ts` covers the config-error path | §3.1, §9.5, §10, §8.3; FR6.2, FR7.3, AC11 |
| 15 | LOW | Small unspecified details | **Addressed, all eight:** `createSession` id default; the `appendMessage` `WHERE`; `isActive === 1`; `environments.ensure` ignores only `ConditionalCheckFailedException`; `audit.record` regenerates the id once; a default §5.10 row; read-method id validation (C-CH-10); the 20 s DynamoDB timeout. **Extended:** legacy lookups by route parameters hit the same key-length limit on DynamoDB. For example, `GET /api/alerts/<2 KB id>` would be a `ValidationException` (HTTP 500) where SQLite answers 404. A key-size guard keeps the not-found answer (C-KY-01) | §4.5, §5.2, §5.4, §5.8, §5.10, §7.2, §7.3, §8.1, §8.2; FR4.9, FR5.3 |
| 16 | LOW | `unlinkAll` eventual consistency on AI analyses | **Addressed** | §5.6, §12.1 (8) |
| 17 | LOW | Scale estimate too low | **Addressed.** A table in MB and read units, the 4 reads of the `ALERT` partition per dashboard load, and a threshold of about 1,000 alerts or 3 MB per entity partition | §5.7, §12.1 (9); NFR4 |
| 18 | LOW | `findByEmail` timing signal | **Addressed.** Always two GetItems; tested | §5.3 (3), §5.4, §8.3 |
| 19 | LOW | Pattern 7 has no repository method | **Addressed.** Marked "not implemented in item 1" | §5.3 (7), §12.1 (5) |
| 20 | LOW | The `SUPER_ADMIN` column default stays | **Addressed.** Recorded as an item 2 follow-up in the ADR and the item report | §12.1 (14); FR3.1, AC17 |
| 21 | LOW | Go-live: back up SQLite before 002; seed flag | **Addressed.** Backup before the first DPI 2 start, and `--allow-aws` on the fallback seed | Appendix B step 5 |

**Other changes found during revision 2:**
- `dynamo:migrate` requires `--source`. The configured default path resolves to `packages/backend/data/urbani.sqlite` in a checkout, and NFR5 forbids opening that folder (§7.3, §10; FR7.1).
- Seeding a table before migrating into it makes the migrated admin a conflict. This is documented in §9.3, §10 and Appendix B.
- Verified on this machine:
  - npm passes a script's exit code through, both directly and through nested `npm run` (exit 2 stays 2), so the exit-code contracts hold through the root aliases;
  - vitest 2.1.9 accepts `describe(name, options, fn)`, which §8.1 uses for the timeout.

## 18. Responses to the second design review (revision 3, findings 22–29)

Source: the Revision 2 review in `design-review.md` and `design-verdict.json` (CHANGES_REQUESTED: 2 MEDIUM, 6 LOW). All 8 findings are addressed in this revision. None is backlogged or rejected.

| # | Severity | Finding | Response | Where |
|---|---|---|---|---|
| 22 | MEDIUM | `cli.test.ts` gets exit 1 where it expects 2, because `vi.resetModules()` splits the error classes | **Addressed as proposed.** Every `main()` test runs `vi.resetModules()` and then `const { main } = await import('./cli')`, and never calls a `main` imported before the reset. §9.5 states that the `instanceof` mapping needs one module instance. Production keeps `instanceof`, because one module cache serves the static and the dynamic imports. The exit codes that FR7.3 and AC11 require are unchanged | §8.3, §8.3.1, §9.5; AC21 |
| 23 | MEDIUM | Item-creating UpdateItems and the email-lock Put omit `entityType` | **Addressed as proposed, plus an end-to-end check.** A new §5.4 rule: an `items.ts` builder for every Put (the 16 builders are listed); `#entityType` in the SET of `upsertLivePreservingStatus`, `preferences.update` and `setFeedback` [2]; `#userId` in `preferences.update`; `emailLockItem` for the lock in `upsertUser` [1] and in the migration. `upsertLivePreservingStatus` now generates its SET list from `items.alertItem`, so it cannot drift from `insert`. Tests as proposed: `items.test.ts` (every builder), `commands.test.ts` (the 3 SET clauses and the lock Put), C-PF-02 (`userId`). Added: `dynamoOnly.test.ts` calls every create path once and scans the table, and the migration test scans after a run, so a missed path fails on DynamoDB Local | §5.1, §5.2, §5.3 (6, 9, 15, 44), §5.4, §7.4, §8.2, §8.3, §10, §12.1 (14), §13; FR4.11, AC20 |
| 24 | LOW | The readiness ping is the one eventually consistent base-table read | **Addressed with the review's chosen fix.** The ping sets `ConsistentRead: true`, and row 46 says "strong". It costs 1 read unit per probe; ECS probes `/health` (`deploy-ecs.sh:259`) | §5.3 (46), §5.4 |
| 25 | LOW | §5.5 says transactions never run in parallel on one item | **Addressed.** The sentence is replaced with the review's wording and its two examples | §5.5 |
| 26 | LOW | A relative `--source` resolves against `packages/backend` | **Addressed, with one refinement.** `parseMigrateArgs` resolves against `INIT_CWD ?? cwd` and stays free of file-system access, so it is a pure unit. `runMigrate` prints `Source (read-only): <absolute path>` and then checks that it is a regular file, as the review asks. `cli.test.ts` covers both. A scratch-project run showed that the root alias's nested npm resets `INIT_CWD` to the repository root when the command is typed in a subfolder. §10 documents that case, and §12.2 and Appendix B use absolute paths. §10 now lists the preconditions in their checking order | §7.3, §8.3.1, §10, §12.2, Appendix B; FR7.1, AC21 |
| 27 | LOW | Opt-in DynamoDB tests outside the contract suite name no isolated table | **Addressed as proposed.** Every opt-in file builds its own `dynamoHarness`: its own table, purged before each test and deleted after the file. `DynamoHarness` adds `context()` and `scanAll()` for the migration and DynamoDB-only tests. No test uses `config.db.dynamodb.tableName` | §8.1, §8.3; FR5.3 |
| 28 | LOW | `routes.test.ts` leaves its request order open | **Addressed as proposed.** §14 step 1 defines the 27-step sequence, including `POST /api/ai/analyze` and `POST /api/chat`, the ids carried between steps, and the key-set algorithm. `routes.test.ts` replays it, one `it` per step, against `routes.baseline.json`, which is keyed by step id. AC7 lists analyze and chat | §3.1, §8.3, §14 steps 1, 7 and 8.6; AC7 |
| 29 | LOW | Verification steps can leave runtime files outside `.tmp/` or use the default database path | **Addressed.** Adding `.tmp/` to `.gitignore` is the mandatory first action. Two named environments, ENV-SQLITE and ENV-DYNAMO, list every variable, including a `DATABASE_URL` under `.tmp\`, and every seed, server and CLI command uses one. The DynamoDB runs and the guards point `DATABASE_URL` at a tripwire path that must not exist afterwards | §14 steps 1, 7, 8 and 9; NFR5 |

**Verified during this revision** (worktree at `5c81908`, read only; one scratch npm project under `%TEMP%`, deleted afterwards):
- npm 11.6.2 and `INIT_CWD`. A root script that runs `node` directly, started from a subfolder, sees `INIT_CWD` = that subfolder. So does `npm run <script> --workspace <pkg>` started from a subfolder. A root alias that nests `npm run … --workspace …` sees the repository root, because the inner npm resets it. The workspace script's working directory is always the workspace folder.
- No response key depends on `NODE_ENV`. `config.env` appears only as a value (`/health` `env`, settings `general.environment`), so the test-mode `routes.test.ts` run compares directly with the development-mode baseline.
- The capture sequence matches the code:
  - login returns `token`, and protected routes need `Authorization: Bearer <token>`;
  - a missing alert or service raises `NotFoundError` (404);
  - `aiService.analyze` returns the analysis as `data`, with `data.id`, and the alerts list returns `data.items[].alertId`;
  - `LOGIN` and the `ALERT_VIEWED` event of the alert detail view carry no metadata.
- `vitest.config.ts` sets `fileParallelism: false`. The backend `tsconfig.json` excludes `src/**/*.test.ts` and sets `resolveJsonModule: true`, so only vitest reads the JSON fixture and the build is unaffected.
- Every `UrbaniIncidentAlert` field is required and `confidence` is `nullable()`, not optional (`packages/shared/src/alerts.ts`). A SET list generated from `items.alertItem` therefore overwrites every column, as the REPLACE in `alertRepository.upsertLivePreservingStatus` (lines 141–196) does, including `created_at`.

**Other changes found during revision 3:**
- Requirements FR4.2 said "updates never create items". That contradicted the three upsert-style UpdateItems, so it now covers only the updates that mirror a SQL `UPDATE`.
- §14 step 8.4 and requirements AC10 said "the counts are identical" without naming the counts. They now compare the alert, service and usage totals of the DynamoDB smoke test with the SQLite smoke test.
- §14 step 1.1 checks the new ignore rule with a probe file and `git check-ignore`, because git never lists an empty folder, so an empty `.tmp\` would prove nothing.
