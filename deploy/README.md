# deploy/

Configuration and helpers for the DPI 2 parallel ECS deployment. Authored and validated locally only; never run against AWS.

| File | Purpose |
|---|---|
| `dpi2.env.example` | Every variable for all 13 items, grouped, with REQUIRED/OPTIONAL and the client input each waits for. Contains no secret values. |
| `dpi2.env` | Your copy (gitignored). `cp dpi2.env.example dpi2.env`. |
| `lib.sh` | Shared helpers: dry-run/apply switch, guards against touching DPI 1, image tag rules. |
| `*.generated.json` | Task definitions rendered by the scripts (gitignored; ARNs and names only). |

Use, from the repository root:

```bash
npm run check:deploy                 # offline cross-check of the config, task definition and IAM documents
./deploy-ecs-dpi2.sh                 # dry-run: prints the plan, makes no aws call
APPLY=1 CONFIRM_ACCOUNT=<ACCOUNT_ID> ./deploy-ecs-dpi2.sh
./redeploy-dpi2.sh --only backend    # code-only update (dry-run by default)
```

Full procedure, verification and rollback: `docs/DPI2_DEPLOYMENT_RUNBOOK.md`. Everything still needed from the client: `docs/DPI2_GO_LIVE_MATRIX.md`.
