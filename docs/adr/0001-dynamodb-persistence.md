# ADR 0001: DynamoDB persistence for the dashboard backend

- **Status:** Accepted (DPI 2 item 1); deployment pending client AWS account
- **Date:** 2026-11-05
- **Scope:** `packages/backend` repository layer, `infra/lib/persistence-construct.ts`, `infra/lib/security-construct.ts`

## 1. Context

- DPI 1 runs SQLite on task-local storage. `deploy-ecs.sh` mounts the `/data` volume as `host: {}`, so the database is lost whenever the ECS task is replaced. SQLite is also single-writer, so only one task can run, and the service cannot scale out or survive an AZ failure.
- DPI 2 adds RBAC, audit history, chat history and user preferences. That data must survive deploys and must be shared by two or more tasks.
- The CDK stack already defines a DynamoDB table, `UrbaniAlerts`. It is scaffolding for the planned collector → writer Lambda pipeline. Its handlers are still placeholders and the table is not deployed.

## 2. Decision

- The backend reaches storage only through async, driver-agnostic repository interfaces (`packages/backend/src/repositories/types.ts`), obtained from a registry (`getRepositories()`).
- `DB_DRIVER=sqlite` stays the default and keeps DPI 1 behaviour exactly: same SQL, same transactions, same HTTP responses.
- `DB_DRIVER=dynamodb` stores every entity in **one table** named `${DYNAMODB_TABLE_PREFIX}App` (`UrbaniApp` by default):
  - partition key `PK` (S) and sort key `SK` (S);
  - one overloaded GSI, `GSI1`, on `GSI1PK` (S) / `GSI1SK` (S), projection ALL;
  - on-demand billing, the stack's customer-managed KMS key, point-in-time recovery, `RETAIN` removal policy.
- Every item except the never-written health sentinel carries `entityType`. Entities read as whole collections use the entity type as partition key (`PK = 'ALERT'`, `SK = <alertId>`), so list reads are strongly consistent base-table Queries. A chat session and its messages and feedback share the partition `CHAT#<sessionId>`.
- The table is authored in CDK (`PersistenceConstruct.appTable`) but not deployed in this item. Item 14 switches the deployed service to `DB_DRIVER=dynamodb`.

## 3. Key schema

| Entity (`entityType`) | PK | SK | GSI1PK | GSI1SK | Attributes |
|---|---|---|---|---|---|
| Role `ROLE` | `ROLE` | `<roleId>` | – | – | `id, name, description, permissions` (JSON string, as in SQLite), `createdAt` |
| User `USER` | `USER` | `<userId>` | – | – | `id, email, displayName, passwordHash, roleId, role, isActive` (BOOL; written as `is_active === 1`, read back as `1`/`0`), `lastLoginAt, createdAt` |
| Email lock `USER_EMAIL` | `USER_EMAIL` | `<email>` (exact case) | – | – | `userId` |
| Preferences `PREFS` | `PREFS` | `<userId>` | – | – | `userId, theme, widgetLayoutJson, updatedAt` |
| Audit event `AUDIT` | `AUDIT` | `<timestamp>#<id>` | `ACTOR#<actor>` | `<timestamp>#<id>` | `id, timestamp, actor, action, target, metadata` (JSON string or null), `result, createdAt` |
| Alert `ALERT` | `ALERT` | `<alertId>` | `ALERTSRC#<dataSource>` | `<alertId>` | all `UrbaniIncidentAlert` fields, `evidence` (list), `recommendedActions` (list), `status, acknowledgedBy, acknowledgedAt, dataSource, createdAt` |
| Service `SERVICE` | `SERVICE` | `<id>` | – | – | `id, name, environment, status, errorRate, lastTelemetryAt, lastIncidentAt, dataSource, createdAt` |
| Environment `ENVIRONMENT` | `ENVIRONMENT` | `<id>` | – | – | `id, name, createdAt` |
| Log reference `LOG` | `LOG` | `<id>` | `ALERTLINK#<alertId>`, only while linked | `LOG#<timestamp>#<id>`, always | `id, timestamp, level, service, environment, message, dataSource, alertId` |
| Metric snapshot `METRIC` | `METRIC` | `<id>` | `ALERTLINK#<alertId>`, only while linked | `METRIC#<timestamp>#<id>` | the `MetricSnapshot` fields, `dataSource, alertId` |
| AI analysis `AI_ANALYSIS` | `AI_ANALYSIS` | `<id>` | `ALERTLINK#<alertId>` when `alertId` is set | `AI#<timestamp>#<id>` | the `AIAnalysisRecord` fields, `findingJson` (JSON string), `createdAt` |
| Usage record `USAGE` | `USAGE` | `<date>#<modelId>` | – | – | `id, date, modelId, aiRequestCount, inputTokens, outputTokens, estimatedCostUsd, dataSource` |
| Integration `INTEGRATION` | `INTEGRATION` | `<id>` | – | – | `id, kind, displayName, mode, status, configJson, updatedAt` |
| Chat session `CHAT_SESSION` | `CHAT#<sessionId>` | `SESSION` | `CHATUSER#<userId>` | `<updatedAt>#<sessionId>` | `id, userId, title, service, environment, messageCount, createdAt, updatedAt` |
| Chat message `CHAT_MESSAGE` | `CHAT#<sessionId>` | `MSG#<messageId>` | – | – | the `ChatMessage` fields; `citations` is a list |
| Chat feedback `CHAT_FEEDBACK` | `CHAT#<sessionId>` | `FEEDBACK#<messageId>` | – | – | `messageId, sessionId, userId, rating, comment, createdAt, updatedAt` |
| Health sentinel | `HEALTH` | `PING` | – | – | never written; GetItem only |

Notes:
- The key schema lives in one module, `packages/backend/src/repositories/dynamodb/keys.ts`, which exports the 16 `ENTITY_TYPES`. The table definition used by local tooling is `repositories/dynamodb/tableDefinition.ts`; the CDK table mirrors it (`APP_TABLE_GSI1`).
- A GSI only indexes items that have both of its key attributes, so the `ALERTLINK` entries are sparse: logs and metrics always carry `GSI1SK` and get `GSI1PK` only while linked.
- Keys are never parsed back. Ids and timestamps are always stored as separate attributes.
- Each item-to-record mapper emits exactly the keys the SQLite mapper emits, with `null` for absent values, so both drivers return the same JSON key sets.
- Audit timestamps are `toISOString()` strings, so lexicographic order equals time order.

## 4. Access patterns

"Strong" means `ConsistentRead: true` on a base-table read. GSI1 reads are always eventually consistent. Every Query goes through one of three helpers in `repositories/dynamodb/ops.ts`: `queryAll` reads every page, `queryCount` sums `Select: 'COUNT'` over every page, and `queryUpTo(n)` reads pages until it has n items. "Filter in memory" means applying the shared predicates that mirror the SQL WHERE clauses, then sorting and paging exactly as SQLite does.

| # | Access pattern | Caller | DynamoDB operation | Consistency |
|---|---|---|---|---|
| 1 | Get role by id | `users.toAuthUser` ← `authService.login`/`me` | GetItem `ROLE`/`<id>` | strong |
| 2 | Upsert role | seed, migration | PutItem | – |
| 3 | Active user by email | `authService.login`, seed | GetItem `USER_EMAIL`/`<email>`, then always a second GetItem `USER`/`<lock?.userId ?? '#none'>` (known and unknown emails cost the same two calls). The user is returned only if its stored email equals `email` and it is active | strong |
| 4 | Active user by id | `authService.me` | GetItem `USER`/`<id>` | strong |
| 5 | Record login | `authService.login` | UpdateItem SET `lastLoginAt`, condition `attribute_exists(PK)`; a condition failure is a no-op | – |
| 6 | Upsert user, unique email | seed, tests, item 2 | GetItem current user, then TransactWriteItems: Put user (`attribute_not_exists(PK)` or `email = :prevEmail`), Put email lock (`attribute_not_exists(PK) OR userId = :id`), Delete the old lock (`userId = :id`) if the email changed | strong |
| 7 | List users | item 2 | **Not implemented in item 1; item 2 adds `users.list()`.** The key schema serves it with `queryAll` Query `PK = USER` | strong |
| 8 | Get preferences | items 10, 12 | GetItem `PREFS`/`<userId>` | strong |
| 9 | Patch preferences | items 10, 12 | GetItem `USER`/`<userId>` (exists, whatever `isActive`), then UpdateItem SET the supplied fields, `updatedAt`, `userId`, `entityType`; ReturnValues ALL_NEW | strong check |
| 10 | Record audit event | auth, alert, chat, settings services | PutItem `AUDIT`/`<ts>#<id>` with `attribute_not_exists(PK)`; on a condition failure the id is regenerated once | – |
| 11 | Audit list (action?, actor?), paged with total | `GET /api/audit` | No actor: `queryAll` Query `PK = AUDIT`, descending. With actor: `queryAll` Query GSI1 `GSI1PK = ACTOR#<actor>`, descending. Action filter, count and slice in memory | strong / eventual (actor) |
| 12 | Audit by time range | item 3 (`listByTimeRange`) | `queryUpTo(limit + 1)` Query `PK = AUDIT AND SK BETWEEN :from AND :to$`, descending, `ExclusiveStartKey` from a validated cursor | strong |
| 13 | Audit by user and range | item 3 | `queryUpTo(limit + 1)` Query GSI1 `GSI1PK = ACTOR#<actor> AND GSI1SK BETWEEN …`, descending | eventual |
| 14 | Insert or replace alert | seed, `MockDynamoDBAdapter.putAlert` ← `aiService.analyze` | `unlinkAll(id)`, then PutItem | – |
| 15 | Upsert live alert, preserving lifecycle | `syncLiveAlerts` | `unlinkAll(id)`, then UpdateItem SET body (including `entityType`), `status = if_not_exists(status, :open)` | – |
| 16 | Alert by id with children and related ids | `alertService.get`/`acknowledge`, mock adapter | GetItem `ALERT`/`<id>` plus `queryAll` Query GSI1 `ALERTLINK#<id>` | strong (alert) / eventual (links) |
| 17 | Filtered, paged alert list with total | `alertService.list`, mock adapter | `queryAll` Query `PK = ALERT`, filter in memory, then the pattern-16 link query for the page items only | strong |
| 18 | Replace derived evidence | `correlateLiveAlerts` | UpdateItem SET `evidence`, condition `attribute_exists(PK)` | – |
| 19 | Delete by data source, with cascade | `syncLiveAlerts` | `queryAll` Query GSI1 `ALERTSRC#<src>`, then per id: `unlinkAll` and a DeleteItem conditioned on `dataSource = :src` | eventual (selection) |
| 20 | Acknowledge OPEN → ACKNOWLEDGED | `alertService.acknowledge` | UpdateItem with condition `attribute_exists(PK) AND status = :open`, ReturnValues ALL_NEW | – |
| 21 | Count all / active / by severity | `dashboardService.summary` | `queryCount` Query `PK = ALERT`, with a FilterExpression for active/severity | strong |
| 22 | Services sorted by name, with alertCount | `telemetryService.services`, dashboard | `queryAll` Query `PK = SERVICE`, plus `queryAll` Query `PK = ALERT` projecting `service`, grouped in memory | strong |
| 23 | Service by id | `telemetryService.service` | GetItem `SERVICE`/`<id>` plus `queryCount` Query `PK = ALERT`, filter `service = :name` | strong |
| 24 | Count services | dashboard | `queryCount` Query `PK = SERVICE` | strong |
| 25 | Upsert service / ensure environment | seed, migration | PutItem / PutItem with `attribute_not_exists(PK)`; only `ConditionalCheckFailedException` is ignored | – |
| 26 | Logs query with total | `aiService.analyze` | `queryAll` Query `PK = LOG`, filter in memory | strong |
| 27 | Logs by alert, newest first | `alertService.get` | `queryAll` Query GSI1 `ALERTLINK#<id>`, `begins_with(GSI1SK,'LOG#')`, descending | eventual |
| 28 | Clear log links of an alert | `correlateLiveAlerts` | Pattern 27 selection, then UpdateItem REMOVE `alertId`, `GSI1PK` with condition `alertId = :id` | eventual (selection) |
| 29 | Link logs to an alert | `correlateLiveAlerts` | `batchGetAll` the log keys; if any exist, GetItem the alert, then a conditional UpdateItem per existing log | strong |
| 30 | Bulk upsert logs / metrics / usage | seed | `batchWriteAll` PutRequests, deduplicated by key | – |
| 31 | Metrics query (limit, newest first) | `telemetryService.metrics`, dashboard health, `aiService.analyze` | `queryAll` Query `PK = METRIC`, filter in memory, then slice | strong |
| 32 | Usage, newest date first | `usageService.usage`/`cost` | `queryAll` Query `PK = USAGE`, `ScanIndexForward=false` | strong |
| 33 | Insert AI analysis | `aiService.analyze`, `chatService.ask` | If `alertId` is set: GetItem the alert (must exist). Then PutItem with `attribute_not_exists(PK)` | strong check |
| 34 | AI analyses, paged with total | `aiService.listAnalyses` | `queryAll` Query `PK = AI_ANALYSIS`, sort and slice in memory | strong |
| 35 | AI analysis by id | `aiService.getAnalysis`/`analyze` | GetItem | strong |
| 36 | Count analyses | dashboard | `queryCount` Query `PK = AI_ANALYSIS` | strong |
| 37 | Integrations sorted by kind | `settingsService.get`, seed | `queryAll` Query `PK = INTEGRATION`, sort in memory | strong |
| 38 | Upsert / delete integration | seed | PutItem / DeleteItem | – |
| 39 | Create chat session | item 7 | GetItem `USER`/`<userId>` (exists, whatever `isActive`), then PutItem with `attribute_not_exists(PK)` | strong check |
| 40 | Get chat session | item 7 | GetItem `CHAT#<id>`/`SESSION` | strong |
| 41 | A user's sessions, most recent first | item 7 | `queryUpTo(limit + 1)` Query GSI1 `CHATUSER#<userId>`, descending | eventual |
| 42 | Append message | item 7 | TransactWriteItems: Put message (`attribute_not_exists(PK)`); Update session (`attribute_exists(PK)`), SET `updatedAt`, `GSI1SK`, ADD `messageCount :1` | – |
| 43 | Messages, oldest first | item 7 | `queryUpTo(limit + 1)` Query `PK = CHAT#<id> AND begins_with(SK,'MSG#')`, ascending | strong |
| 44 | Set feedback | item 7 | TransactWriteItems: ConditionCheck the message exists; ConditionCheck `USER`/`<userId>` exists; Update the feedback (SET includes `entityType`, `createdAt` kept via `if_not_exists`). Then GetItem the feedback | strong |
| 45 | Session feedback | item 7 | `queryAll` Query `PK = CHAT#<id> AND begins_with(SK,'FEEDBACK#')` | strong |
| 46 | Readiness ping | `/ready`, server start, seed | GetItem `HEALTH`/`PING`, `ConsistentRead: true`, 2 s abort signal | strong |
| 47 | Environments sorted by name | contract tests, migration check | `queryAll` Query `PK = ENVIRONMENT` | strong |

## 5. Correctness mechanisms

Every expression uses `#name` placeholders, because many attribute names are DynamoDB reserved words. Every UpdateItem that mirrors a SQL `UPDATE` carries `attribute_exists(#pk)`, so it never creates a phantom item. The three UpdateItems that can create an item (`upsertLivePreservingStatus`, `preferences.update`, `chat.setFeedback`) always SET `entityType`.

| Need | Mechanism |
|---|---|
| Unique email | A `USER_EMAIL` lock item, written in the same TransactWriteItems as the user, with condition `attribute_not_exists OR userId = :id`. The user Put is conditioned on the state read before it (`attribute_not_exists` or `email = :prevEmail`), so a concurrent upsert forces a re-read instead of leaving an old lock behind. `findByEmail` ignores a lock whose user has another email |
| Status-preserving live upsert | One UpdateItem with `if_not_exists(status)`; acknowledgement attributes untouched |
| Acknowledge only once, only from OPEN | Condition `status = :open` |
| Delete only alerts that still have the data source | Condition `dataSource = :src` on each DeleteItem (BatchWriteItem was rejected: it cannot carry a condition and reports nothing per item) |
| Idempotent upserts | Put or Update keyed by natural ids. `environments.ensure`, audit and analysis inserts are create-only (`attribute_not_exists`) |
| Chat message and session counter stay consistent | TransactWriteItems (Put + Update) |
| Feedback only for a message in the session, by an existing user | TransactWriteItems (ConditionCheck message + ConditionCheck user + Update) |
| Referential checks that SQLite does with foreign keys | Check-then-write: a strong GetItem or BatchGetItem, then the write (`linkLogsToAlert`, analysis insert, preferences, `createSession`). The window between check and write is accepted; the same race exists on SQLite between `putAlert` and the analysis insert in `aiService.analyze` |
| Cascade on alert replace/delete (SQLite `ON DELETE SET NULL`) | `unlinkAll(alertId)` (`dynamodb/links.ts`): query GSI1 `ALERTLINK#<id>` and REMOVE `alertId`/`GSI1PK` from each linked log, metric and analysis, conditioned on `alertId = :id`. It runs before the alert write, so a crash or retry is idempotent |

`upsertUser` concurrency: each call makes at most two attempts. On `TransactionCanceledException` the cancellation reasons decide the outcome: only the lock failed → `DUPLICATE` (409); the user Put failed or conflicted → re-read and retry, then `UNAVAILABLE` (503); only the old-lock delete failed → re-read and retry, and if the old lock is missing or owned by another user, warn (ids only) and send once more without the delete. Two concurrent email changes of one user end in the same state as SQLite's sequential result (last writer wins), and no old lock survives (contract cases C-UR-10 and C-UR-11).

No transaction includes more than 3 items. Each transactional method retries a conflict once, then raises `UNAVAILABLE`.

## 6. Accepted divergences from SQLite

DynamoDB enforces uniqueness only on the primary key and limits key length. The DynamoDB driver reproduces every other shared SQLite semantic (REPLACE cascades, `LIKE` case folding and wildcards, BINARY ordering and equality, clamps, foreign-key outcomes, exact email lookup). These differences remain:

- **`roles.name UNIQUE`.** On SQLite, `upsertRole` with a new id and an existing name fails with a FOREIGN KEY error while users reference the old role; otherwise REPLACE deletes the old role row. DynamoDB stores a second role with that name.
- **`services UNIQUE(name, environment)`.** `services.upsert` with a new id and an existing pair leaves 1 row on SQLite and 2 items on DynamoDB.
- **`environments.name UNIQUE`.** `environments.ensure` with a new id and an existing name is ignored on SQLite and creates a second item on DynamoDB.
- **`usage_records`.** The DynamoDB key is `(date, modelId)`, so the `UNIQUE(date, model_id)` half of REPLACE is reproduced. The `id` half is not: a same-id upsert with a new date leaves 1 row on SQLite and 2 items on DynamoDB.
- **Key length.** DynamoDB limits a partition key (and `GSI1PK`) to 2,048 bytes and a sort key (and `GSI1SK`) to 1,024 bytes of UTF-8. Lookups with a longer id or email return their not-found result without a call, which equals SQLite's answer. Writes with a longer key reject with `INVALID_ARGUMENT`, where SQLite stores them.
- **Empty ids.** DynamoDB rejects empty key values, so the key guard is `1 ≤ UTF-8 bytes ≤ limit` for every key part. An empty-id lookup returns not-found without a call (as SQLite does for an id that no row has); an empty-key write raises `INVALID_ARGUMENT`, where SQLite stores the row. `audit.query({ actor: '' })` is unaffected, because an empty actor means "no filter". Consequence: an upstream alert without an id (or with an over-long id) aborts the DynamoDB live sync at that alert, while SQLite would store it. Skipping id-less upstream alerts in the adapter would change service behaviour, so that decision belongs to a later item.

Why this is harmless today: the only writers of roles, services, environments and usage are the seed, which uses static ids, and the migration, whose SQLite source already satisfies these constraints. The mock usage dates derive from a fixed instant, so each usage id keeps its date. No contract case depends on these divergences.

## 7. Consistency

- Every base-table read uses `ConsistentRead: true`. That gives read-after-write parity with SQLite within a request, for example `syncLiveAlerts` upserts followed by `alerts.query`, or `acknowledge` followed by `findById`.
- GSI1 reads are eventually consistent (typically well under one second): alert links, audit by actor, chat sessions by user, and the `deleteByDataSource` selection. Effects:
  - a just-written link can be missed by an immediate `byAlert` or `clearAlertLinks`. In live mode links are a no-op anyway, because LIVE log ids are not persisted;
  - a just-created MOCK alert can survive one sync and is deleted on the next;
  - a just-updated chat session can briefly appear in its old position in the list;
  - two `POST /api/ai/analyze` calls that derive the same alert id within the propagation window can both keep `alertId`, whereas SQLite keeps it only on the newest analysis. The first analyze after propagation unlinks both. The stale `alertId` points at an alert that exists, so nothing dangles.
- DynamoDB Local updates GSIs synchronously, so the contract tests are deterministic. They run only against DynamoDB Local.

## 8. Pagination, counts and scale limits

- **Helpers.** `dynamodb/ops.ts` is the only module that sends `QueryCommand`, `BatchGetCommand` or `BatchWriteCommand` (a grep gate checks this). A Query page stops after 1 MB read, and with `Select: 'COUNT'` that limit applies before the filter, so single-page reads would undercount at about 400 LIVE alerts. `queryAll` and `queryCount` therefore read every page. `batchGetAll` (chunks of 100) and `batchWriteAll` (chunks of 25) retry unprocessed keys up to 5 times with backoff, then raise `UNAVAILABLE`.
- **Legacy offset APIs** (`alerts.query`, `logs.query`, `aiAnalyses.query`, `audit.query`) must return `total`. DynamoDB has no cheap count, so they read the whole entity partition with `queryAll` and slice in memory: O(n) per request.
- **Counts** use `queryCount`, which avoids transferring items, but read units are still charged on the size of every item read.
- **New APIs** (`listByTimeRange`, chat lists) use opaque cursors with `queryUpTo(limit + 1)`, so their cost does not grow with collection size.
- **Sizes.** A mock alert is about 1 KB; a LIVE alert with 10 derived evidence lines is about 2–3 KB. A strongly consistent Query costs one read unit per 4 KB read.

  | Alerts | `ALERT` partition | Read units per full read | Pages per full read |
  |---|---|---|---|
  | 1,000 | 1–3 MB | 250–750 | 1–3 |
  | 5,000 | 5–15 MB | 1,250–3,750 | 5–15 |

  `GET /api/alerts` reads the `ALERT` partition once, plus one GSI1 link query per page item. `GET /api/dashboard/summary` reads it 4 times (`countAll`, `countActive`, `countBySeverity`, and the services' `alertCount`). At 5,000 alerts one dashboard load costs 5,000–15,000 read units, and DynamoDB documents a maximum of 3,000 read units per second for one partition. The sync never deletes LIVE alerts, so the partition grows over time.
- **Threshold.** Change the collection-read patterns at about **1,000 alerts, or 3 MB in any one entity partition** (alerts, logs, metrics, AI analyses, audit), whichever comes first. An audit event is about 0.5 KB, so the audit partition reaches 3 MB at roughly 6,000 events.
- **Mitigation path (later items):** time-bounded default windows and cursor endpoints (item 3 for audit), maintained counters for the dashboard, and TTL retention once the client decides retention.
- **Migration script.** `dynamo:migrate` reads the SQLite snapshot fully into memory. That is fine at DPI scale (100k audit rows are about 30 MB).

## 9. Item size and key policy

DynamoDB rejects items over 400 KB. Item size is estimated as `Buffer.byteLength(JSON.stringify(item))`, which over-estimates.

- **Alert evidence** comes from upstream alerts and LIVE log lines and is not length-capped upstream. `items.budgetEvidence` keeps lines in order while their cumulative UTF-8 size is at most 256 KiB, drops the first line that would exceed it and every later line, never edits text, and logs a warning with `{ alertId, keptLines, droppedLines }`. Trimming is chosen over failing, because one oversized LIVE alert would otherwise abort every live sync at that alert. It applies to `insert`, `upsertLivePreservingStatus`, `replaceDerivedEvidence` and the migration.
- **Every other item** (log messages, audit metadata, analysis `findingJson`): if the estimate exceeds 380 KiB the write fails with `PersistenceError('ITEM_TOO_LARGE')` before any call. A DynamoDB `ValidationException` about item size is translated to the same error. Today's writers stay far below the limit.
- **New entities** have validated caps: chat content 64 KiB, at most 50 citations of 4 KiB each, widget layout 16 KiB, ids at most 128 characters.
- **Keys:** see §6 (key length and empty ids). The guard keeps reads at parity with SQLite and rejects bad writes with `INVALID_ARGUMENT`.
- The SQLite driver applies no budget; its behaviour is unchanged.

## 10. Relationship to `UrbaniAlerts`

The CDK `UrbaniAlerts` table (`PK service_id`, `SK timestamp`, GSI `anomaly_type-index`) is the output table of the planned collector → writer Lambda pipeline. The app does not reuse it:
- its key cannot serve the app's main pattern, get-by-`alertId`, without another GSI;
- two alerts for the same service and timestamp would collide;
- it would mix app lifecycle state (status, acknowledgement, links, `dataSource`) into a table the writer Lambda owns and overwrites.

`DYNAMODB_ALERTS_TABLE` and `DYNAMODB_GSI_ANOMALY_TYPE` keep their current role: they are shown on the Settings page (the `settingsService.get().dynamodb` shape is unchanged) and are reserved for the pipeline. The app driver never reads them. When the pipeline is built, the writer either feeds the app through the existing ingest path or writes `ALERT` items into the app table; that decision is out of scope. Live alerts still come from the Urbani QA `/alerts` HTTP API.

## 11. Security

- **Encryption and durability:** the table uses the stack's customer-managed KMS key, point-in-time recovery, and `RemovalPolicy.RETAIN`, so a stack teardown never deletes app data.
- **Least-privilege task role:** `UrbaniDashboardTaskRole` (`infra/lib/security-construct.ts`) is trusted only by `ecs-tasks.amazonaws.com` under an `aws:SourceAccount` condition (confused-deputy guard). `PersistenceConstruct.grantAppDataAccess` gives it exactly two statements:
  - `UrbaniAppTableData`: `GetItem`, `BatchGetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `ConditionCheckItem` on the table and `index/GSI1`. `TransactWriteItems` is authorized through its member actions. No Scan, no DescribeTable, no admin, no Streams.
  - `UrbaniAppTableKmsViaDynamoDb`: `kms:Decrypt`, `kms:Encrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*` on the key, only via `dynamodb.<region>.amazonaws.com`. Whether the caller needs KMS permissions at all, and whether `kms:DescribeKey` is ever needed, is unverified until go-live; adjust the statement if testing shows `AccessDenied`.
  - `infra/test/app-table.check.ts` (`npm run check` in `infra/`) asserts all of this offline.
  - For a table created outside CDK and used by the `urbaniqa-dpi-task-role` from `deploy-ecs.sh`, the equivalent policy is in the appendix below.
- **Credentials:** none in code. Without `DYNAMODB_ENDPOINT` the SDK default chain applies (ECS task role in AWS). Dummy `local`/`local` credentials are used only when `DYNAMODB_ENDPOINT` points at DynamoDB Local.
- **Logging:** item contents are never logged; warnings carry ids and operation names only.
- **Guards:** `dynamo:tables` refuses without `DYNAMODB_ENDPOINT` (cloud tables come from CDK). `dynamo:migrate` and the seed refuse an AWS target unless `--allow-aws` is passed. `reset` is SQLite-only.
- **LIKE emulation** uses a hand-written matcher, not a regular expression, so a user search term cannot cause regex backtracking.

## 12. Alternatives considered

- **One table per entity (about 15 tables).** Rejected. Collection reads would still need constant-key partitions or Scans, spread over 15 tables. The alert cascade would need a GSI on each of three tables and three queries per cascade. The transactional writes (user + email lock, message + session, feedback + message check) span entity types. Operations would multiply (15 CDK resources, IAM pairs, test tables, migration targets), and 3–5 GSIs mean more write amplification. On-demand and PITR pricing does not favour more tables.
- **Storing alerts in `UrbaniAlerts`** (hybrid). Rejected for the reasons in §10.
- **Keeping SQLite on EFS.** Survives task replacement, but SQLite is still single-writer, so the service cannot run two or more tasks.

## 13. Consequences and follow-ups

- **Item 2: create-user must require an explicit role.** Migration 002 keeps `DEFAULT 'SUPER_ADMIN'` on `users.role`, so existing DPI 1 users become Super Admin (FR3.1), and the DynamoDB repository applies the same default. Any insert that forgets the role therefore creates a Super Admin. Once item 2 requires the role, it can drop the column default with a migration. Item 2 also adds `users.list()` (pattern 7) and must revisit the check-then-write in `createSession` if it adds user deletion.
- **Orphan email locks** cannot arise from the repository or the migration. If one appears through a manual edit, `findByEmail` ignores it (with a warning) and it blocks that email until it is deleted by hand.
- **Item 6** enables Streams and filters on `entityType = 'ALERT'`. Every item carries `entityType`, including items created by an UpdateItem, and tests pin this.
- **Item 3** adds retention and TTL (an `expiresAt` attribute, which can be enabled without a data migration) and the cursor UI.
- **Item 14** sets `DB_DRIVER=dynamodb` and `DYNAMODB_TABLE_PREFIX` in the task definition, removes the `/data` volume, runs `dynamo:migrate` from a WAL-checkpointed copy of the DPI 1 database, and raises `desiredCount` to 2 or more.
- **Rollback:** setting `DB_DRIVER=sqlite` again does not copy DynamoDB data back.
- **Cost of the legacy offset APIs** grows linearly with each entity partition; watch the §8 threshold.

## Appendix. Policy for the deploy-script task role (go-live; not applied)

If the table is created outside CDK and used by the `urbaniqa-dpi-task-role` that `deploy-ecs.sh` creates, attach this policy. Replace the placeholders. Include the second statement only if the table uses a customer-managed key.

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

Local development commands (DynamoDB Local, table creation, seeding, migration, opt-in tests) are listed in bash and PowerShell form in the "Persistence drivers (DPI 2)" section of `.env.example`.
