# Urbani Observability — AWS CDK Infrastructure

TypeScript AWS CDK app that provisions the documented Urbani architecture. This
is a **synth-ready skeleton** — it is **not deployed automatically**. Lambda
handlers are documented placeholders; real collection/analysis logic is added
once AWS access is confirmed.

## What it provisions (`UrbaniDpiStack`)

| Construct | Resources |
|---|---|
| `SecurityConstruct` | KMS CMK (rotating), CloudTrail, least-privilege collector role (read-only CloudWatch + `bedrock:InvokeModel`), writer role, `UrbaniDashboardTaskRole` (ECS task role trusted by `ecs-tasks.amazonaws.com` under `aws:SourceAccount`; least-privilege data access to the `UrbaniApp` table only, no Scan) |
| `PersistenceConstruct` | DynamoDB `UrbaniAlerts` (PK `service_id`, SK `timestamp`, GSI `anomaly_type-index`), CMK-encrypted, PITR. DPI 2 app table `UrbaniApp` (`<dynamoTablePrefix>App`; PK `PK`, SK `SK`, GSI `GSI1` on `GSI1PK`/`GSI1SK`, projection ALL), on-demand, shared CMK, PITR, RETAIN; see `docs/adr/0001-dynamodb-persistence.md` |
| `OrchestrationConstruct` | EventBridge rule (`rate(5 minutes)`), `UrbaniTelemetryCollectorFn`, `UrbaniAlertWriterFn` |
| `CostConstruct` | AWS Budgets monthly budget with soft ($50) / hard ($100) alerts |
| `DashboardConstruct` | Boundary for the **custom** React+Node dashboard hosting (ECS Fargate / App Runner) — NOT Grafana/CloudWatch |

## Principles honored

- **No hardcoded account/region/model** — everything is config/context-driven (`config/index.ts`).
- **Read-only MVP** — collector role has no write access to production app infra.
- **Human-in-the-loop** — the pipeline only persists advisory alerts; no remediation.
- **Bedrock model + guardrail are config-driven** (`bedrockModelId`, `guardrailId`).

## Usage

```bash
cd infra
npm install
npm run build            # type-check the CDK app
npm run check   # offline template assertions (no AWS)

# Synthesize CloudFormation (no deploy). Provide account/region/model via context:
npx cdk synth \
  -c account=<ACCOUNT_ID> -c region=ap-south-1 \
  -c bedrockModelId=anthropic.claude-3-5-sonnet-20241022-v2:0 \
  -c budgetEmail=ops@urbani.example

# When authorized to deploy:
npx cdk bootstrap        # once per account/region
npx cdk deploy
```

> Do not deploy without confirmed AWS credentials, model access, and a review of
> the least-privilege roles. The guardrail `urbani-dpi-guardrail-v1` is created/
> managed in Bedrock and referenced by ID.
