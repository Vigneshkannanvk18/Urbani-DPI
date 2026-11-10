#!/usr/bin/env bash
# =============================================================================
# Urbani DPI 2 — ECS Fargate deployment, as a PARALLEL service next to DPI 1.
#
# AUTHORED AND VALIDATED LOCALLY ONLY. It has never been run against AWS.
#
#   ./deploy-ecs-dpi2.sh                                   # DRY-RUN (default): prints the plan, zero aws calls
#   APPLY=1 CONFIRM_ACCOUNT=<ACCOUNT_ID> ./deploy-ecs-dpi2.sh   # real run (needs approval)
#   STEPS=taskdef,service ./deploy-ecs-dpi2.sh             # run a subset
#   SKIP=images ./deploy-ecs-dpi2.sh                       # skip steps
#
# Steps (default order): ecr images logs kms dynamodb secrets sns iam taskdef bootstrap tg listener service autoscaling
# Opt-in only:           container-insights (shared cluster!), dns (Route 53, needs CONFIRM_DNS=<DOMAIN>)
#
# All configuration comes from deploy/dpi2.env (copy of deploy/dpi2.env.example). Run on Linux/macOS/CloudShell/WSL
# with: bash, aws cli v2, docker (buildx), node >= 18, openssl, git.
# DPI 1 (urbaniqa-dpi-svc, host dpi.urbani.io, priority 400) is never modified by this script.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=deploy/lib.sh
source deploy/lib.sh

STEPS="${STEPS:-ecr,images,logs,kms,dynamodb,secrets,sns,iam,taskdef,bootstrap,tg,listener,service,autoscaling}"
load_config

GEN_DIR="deploy"
TASKDEF_FILE="$GEN_DIR/dpi2.taskdef.generated.json"
BOOTSTRAP_TASKDEF_FILE="$GEN_DIR/dpi2.bootstrap-taskdef.generated.json"
SUBNET_LIST="$SUBNETS"
NET_CONF="awsvpcConfiguration={subnets=[${SUBNET_LIST}],securityGroups=[${TASK_SG}],assignPublicIp=DISABLED}"
EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE_NAME}"
KMS_ARN="${DYNAMODB_KMS_KEY_ARN:-}"
TG_ARN=""
SECRET_ARN_ARGS=()   # --secret-arn VAR=ARN, filled in the secrets step (apply mode)

# ── 1. ECR ─────────────────────────────────────────────────────────────────────
if step_on ecr; then
  log "Step ecr: repositories (own repos, separate from DPI 1; created only if missing)"
  for repo in "$BACKEND_REPO" "$FRONTEND_REPO"; do
    if is_apply && aws_cmd ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1; then
      log "  repository exists: $repo"
    else
      aws_cmd ecr create-repository --repository-name "$repo" \
        --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 \
        --query repository.repositoryUri --output text
    fi
  done
fi

# ── 2. Images ──────────────────────────────────────────────────────────────────
if step_on images; then
  log "Step images: build + push ${IMAGE_TAG} and latest (the task definition uses ${IMAGE_TAG} only)"
  ecr_login
  build_push packages/backend/Dockerfile "$BACKEND_REPO" "$BACKEND_IMAGE"
  build_push packages/frontend/Dockerfile "$FRONTEND_REPO" "$FRONTEND_IMAGE"
fi

# ── 3. CloudWatch log group ────────────────────────────────────────────────────
if step_on logs; then
  log "Step logs: log group ${LOG_GROUP} (${LOG_RETENTION_DAYS} days)"
  if is_apply; then aws_cmd logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || log "  log group exists"
  else aws_cmd logs create-log-group --log-group-name "$LOG_GROUP"; fi
  aws_cmd logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days "$LOG_RETENTION_DAYS"
fi

# ── 4. KMS key for the table (customer-managed, like infra/lib/persistence-construct.ts) ──
resolve_kms() {
  [[ -n "$KMS_ARN" ]] && return 0
  if is_apply; then
    KMS_ARN="$(aws_cmd kms describe-key --key-id "$KMS_KEY_ALIAS" --query KeyMetadata.Arn --output text 2>/dev/null || true)"
    if [[ -z "$KMS_ARN" || "$KMS_ARN" == "None" ]]; then
      KMS_ARN="$(aws_cmd kms create-key --description 'Urbani DPI 2 DynamoDB encryption key' \
        --tags TagKey=app,TagValue=urbani-dpi2 --query KeyMetadata.Arn --output text)"
      aws_cmd kms create-alias --alias-name "$KMS_KEY_ALIAS" --target-key-id "$KMS_ARN"
      aws_cmd kms enable-key-rotation --key-id "$KMS_ARN"
      log "  created key ${KMS_ARN}"
    fi
  else
    aws_cmd kms describe-key --key-id "$KMS_KEY_ALIAS"
    echo "  [dry-run] (if the alias is missing) kms create-key + create-alias ${KMS_KEY_ALIAS} + enable-key-rotation" >&3
    KMS_ARN="arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/<resolved-at-apply>"
  fi
}
if step_on kms || step_on dynamodb || step_on iam; then
  log "Step kms: customer-managed key ${DYNAMODB_KMS_KEY_ARN:+(existing ARN given)}${DYNAMODB_KMS_KEY_ARN:-${KMS_KEY_ALIAS}}"
  resolve_kms
fi

# ── 5. DynamoDB: single table (item 1 ADR), mirrors infra/lib/persistence-construct.ts ──
if step_on dynamodb; then
  log "Step dynamodb: table ${TABLE_NAME} (PK/SK + GSI1, on-demand, CMK, PITR, deletion protection)"
  create_table=1
  if is_apply && aws_cmd dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    create_table=0; log "  table exists: $TABLE_NAME"
  fi
  if [[ "$create_table" == "1" ]]; then
    aws_cmd dynamodb create-table --table-name "$TABLE_NAME" \
      --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
                              AttributeName=GSI1PK,AttributeType=S AttributeName=GSI1SK,AttributeType=S \
      --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
      --global-secondary-indexes 'IndexName=GSI1,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
      --billing-mode PAY_PER_REQUEST \
      --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=${KMS_ARN}" \
      --deletion-protection-enabled \
      --tags Key=app,Value=urbani-dpi2 \
      --query TableDescription.TableArn --output text
    aws_cmd dynamodb wait table-exists --table-name "$TABLE_NAME"
  fi
  aws_cmd dynamodb update-continuous-backups --table-name "$TABLE_NAME" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
  if is_apply && [[ "$(aws_cmd dynamodb describe-table --table-name "$TABLE_NAME" --query Table.DeletionProtectionEnabled --output text)" != "True" ]]; then
    aws_cmd dynamodb update-table --table-name "$TABLE_NAME" --deletion-protection-enabled
  fi
fi

# ── 6. Secrets Manager (create-if-missing; values generated and piped straight in, never printed) ──
# ensure_secret <name> <kind: hex32|b64_32|password|shell> <description>
ensure_secret() {
  local name="$1" kind="$2" desc="$3" arn=""
  if is_apply; then
    arn="$(aws_cmd secretsmanager describe-secret --secret-id "$name" --query ARN --output text 2>/dev/null || true)"
  fi
  if [[ -n "$arn" && "$arn" != "None" ]]; then
    log "  secret exists: $name"
  elif [[ "$kind" == "shell" ]]; then
    aws_cmd secretsmanager create-secret --name "$name" --description "$desc" --query ARN --output text
    warn "  $name was created EMPTY. Put its value: aws secretsmanager put-secret-value --secret-id $name --secret-string file://<file>"
  elif is_apply; then
    case "$kind" in
      hex32)    openssl rand -hex 32 | tr -d '\n' ;;
      b64_32)   openssl rand -base64 32 | tr -d '\n' ;;
      password) { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24; printf 'aZ9!'; } ;;
    esac | aws_cmd secretsmanager create-secret --name "$name" --description "$desc" --secret-string file:///dev/stdin \
        --query ARN --output text >/dev/null
    log "  generated secret (value not shown): $name"
  else
    echo "  [dry-run] generate '${kind}' value with openssl (not shown) | aws secretsmanager create-secret --name ${name} --secret-string file:///dev/stdin --region ${AWS_REGION}" >&3
  fi
}
secret_arn() { # <name> -> ARN (apply) or partial ARN (dry-run)
  if is_apply; then aws_cmd secretsmanager describe-secret --secret-id "$1" --query ARN --output text
  else echo "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:$1"; fi
}
secret_populated() { # <name>
  local v; v="$(aws_cmd secretsmanager describe-secret --secret-id "$1" --query VersionIdsToStages --output text)"
  [[ -n "$v" && "$v" != "None" ]]
}
if step_on secrets; then
  log "Step secrets: Secrets Manager (create-if-missing)"
  ensure_secret "$SECRET_NAME_JWT_SECRET" hex32 "DPI 2 JWT signing secret"
  ensure_secret "$SECRET_NAME_MFA_ENCRYPTION_KEY" b64_32 "DPI 2 MFA secret encryption key (32 bytes base64)"
  ensure_secret "$SECRET_NAME_SEED_ADMIN_PASSWORD" password "DPI 2 first Super Admin password (rotate after first login)"
  ensure_secret "$SECRET_NAME_URBANI_API_KEY" shell "Urbani API key (rotated). Value supplied by the operator"
  for v in SLACK_WEBHOOK_URL TEAMS_WEBHOOK_URL OIDC_CLIENT_SECRET; do
    n="SECRET_NAME_${v}"; [[ -n "${!n:-}" ]] && ensure_secret "${!n}" shell "DPI 2 ${v} (optional integration)"
  done
fi
collect_secret_arns() {
  local v n
  for v in JWT_SECRET MFA_ENCRYPTION_KEY SEED_ADMIN_PASSWORD URBANI_API_KEY $(echo "${ENABLED_OPTIONAL_SECRETS:-}" | tr ',' ' '); do
    n="SECRET_NAME_${v}"
    is_apply && SECRET_ARN_ARGS+=(--secret-arn "${v}=$(secret_arn "${!n}")")
  done
  return 0
}

# ── 7. SNS topic for e-mail alerts (optional) ──────────────────────────────────
if step_on sns && [[ "$ENABLE_SNS" == "1" ]]; then
  log "Step sns: topic ${SNS_TOPIC_NAME} (create is idempotent); subscribers must confirm the e-mail they receive"
  TOPIC_ARN="arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:${SNS_TOPIC_NAME}"
  aws_cmd sns create-topic --name "$SNS_TOPIC_NAME" --attributes KmsMasterKeyId=alias/aws/sns --query TopicArn --output text
  IFS=',' read -ra _emails <<< "${ALERT_EMAILS:-}"
  for e in "${_emails[@]:-}"; do
    [[ -n "$e" ]] && aws_cmd sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$e" --return-subscription-arn
  done
elif step_on sns; then
  log "Step sns: skipped (ENABLE_SNS=0)"
fi

# ── 8. IAM roles (least privilege; documents rendered by scripts/render-policies.mjs) ──
ensure_role() { # <role-name> <policy-name> <policy-json> [managed-policy-arn]
  local role="$1" pname="$2" doc="$3" managed="${4:-}"
  if is_apply && aws_cmd iam get-role --role-name "$role" >/dev/null 2>&1; then
    log "  role exists: $role (policy is re-applied)"
  else
    aws_cmd iam create-role --role-name "$role" --assume-role-policy-document "$(node scripts/render-policies.mjs --which trust)" \
      --tags Key=app,Value=urbani-dpi2 --query Role.Arn --output text
    [[ -n "$managed" ]] && aws_cmd iam attach-role-policy --role-name "$role" --policy-arn "$managed"
  fi
  aws_cmd iam put-role-policy --role-name "$role" --policy-name "$pname" --policy-document "$doc"
}
if step_on iam; then
  log "Step iam: execution role ${EXEC_ROLE_NAME} and task role ${TASK_ROLE_NAME}"
  ensure_role "$EXEC_ROLE_NAME" dpi2-secrets-read "$(node scripts/render-policies.mjs --env "$ENV_FILE" --which exec)" \
    arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  ensure_role "$TASK_ROLE_NAME" dpi2-task-policy "$(node scripts/render-policies.mjs --env "$ENV_FILE" --which task --kms-arn "$KMS_ARN")"
  if is_apply; then
    log "  IAM is eventually consistent: waiting 10 s before the task definition references the roles"; sleep 10
  fi
fi

# ── 9. Task definitions (service + bootstrap), rendered by scripts/render-taskdef.mjs ──
if step_on taskdef || step_on bootstrap || step_on service; then
  collect_secret_arns
fi
if step_on taskdef || step_on bootstrap; then
  log "Step taskdef: rendering ${TASKDEF_FILE} (no host volume, DB_DRIVER=dynamodb, secrets by valueFrom)"
  node scripts/render-taskdef.mjs --env "$ENV_FILE" --tag "$IMAGE_TAG" --out "$TASKDEF_FILE" ${SECRET_ARN_ARGS[@]+"${SECRET_ARN_ARGS[@]}"}
  node scripts/render-taskdef.mjs --env "$ENV_FILE" --tag "$IMAGE_TAG" --mode bootstrap --out "$BOOTSTRAP_TASKDEF_FILE" ${SECRET_ARN_ARGS[@]+"${SECRET_ARN_ARGS[@]}"}
  log "  wrote ${TASKDEF_FILE} and ${BOOTSTRAP_TASKDEF_FILE} (gitignored; contain ARNs only)"
  aws_cmd ecs register-task-definition --cli-input-json "file://${TASKDEF_FILE}" --query taskDefinition.taskDefinitionArn --output text
  aws_cmd ecs register-task-definition --cli-input-json "file://${BOOTSTRAP_TASKDEF_FILE}" --query taskDefinition.taskDefinitionArn --output text
fi

# ── 10. Bootstrap: one-off tasks with the backend image (seed admin + reference data) ──
# The table itself is created in the dynamodb step: `cli.js tables` deliberately refuses AWS endpoints.
run_bootstrap_task() { # <label> <env-json> <command words...>
  local label="$1" envjson="$2"; shift 2
  local cmd; cmd="$(printf '"%s",' "$@")"; cmd="[${cmd%,}]"
  local overrides="{\"containerOverrides\":[{\"name\":\"backend\",\"command\":${cmd},\"environment\":${envjson}}]}"
  if is_apply; then
    local task; task="$(aws_cmd ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "${TASK_FAMILY}-bootstrap" \
      --network-configuration "$NET_CONF" --overrides "$overrides" --query 'tasks[0].taskArn' --output text)"
    [[ -n "$task" && "$task" != "None" ]] || die "bootstrap task '$label' did not start"
    aws_cmd ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
    local code; code="$(aws_cmd ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)"
    [[ "$code" == "0" ]] || die "bootstrap task '$label' exited with code $code (logs: stream prefix bootstrap in $LOG_GROUP)"
    log "  bootstrap '$label' finished OK ($task)"
  else
    aws_cmd ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "${TASK_FAMILY}-bootstrap" \
      --network-configuration "$NET_CONF" --overrides "$overrides" --query 'tasks[0].taskArn' --output text
    echo "  [dry-run] aws ecs wait tasks-stopped, then require container exit code 0" >&3
  fi
}
if step_on bootstrap; then
  log "Step bootstrap: seed the first Super Admin (password from Secrets Manager) and reference data"
  do_seed=1
  if is_apply && [[ "${FORCE_BOOTSTRAP:-0}" != "1" ]]; then
    count="$(aws_cmd dynamodb scan --table-name "$TABLE_NAME" --limit 1 --select COUNT --query Count --output text)"
    if [[ "$count" != "0" ]]; then do_seed=0; log "  table already has data; seed skipped (FORCE_BOOTSTRAP=1 to run anyway)"; fi
  fi
  if [[ "$do_seed" == "1" ]]; then
    if is_apply; then
      for v in JWT_SECRET MFA_ENCRYPTION_KEY SEED_ADMIN_PASSWORD; do n="SECRET_NAME_${v}"; secret_populated "${!n}" || die "secret ${!n} has no value"; done
    fi
    # seed.js loads the admin plus MOCK-labelled demo rows; NODE_ENV=production needs FORCE_DB_SEED, AWS needs --allow-aws.
    run_bootstrap_task seed '[{"name":"FORCE_DB_SEED","value":"yes"}]' node packages/backend/dist/db/seed.js --allow-aws
  fi
fi

# ── 11. Target group ───────────────────────────────────────────────────────────
resolve_tg() {
  if is_apply; then
    TG_ARN="$(aws_cmd elbv2 describe-target-groups --names "$TG_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
  fi
  [[ -n "$TG_ARN" && "$TG_ARN" != "None" ]] || TG_ARN="arn:aws:elasticloadbalancing:${AWS_REGION}:${ACCOUNT_ID}:targetgroup/${TG_NAME}/<resolved-at-apply>"
}
if step_on tg; then
  log "Step tg: target group ${TG_NAME} (HTTP 8080, /healthz, deregistration delay 30 s)"
  exists=0
  if is_apply && aws_cmd elbv2 describe-target-groups --names "$TG_NAME" >/dev/null 2>&1; then exists=1; log "  target group exists"; fi
  if [[ "$exists" == "0" ]]; then
    aws_cmd elbv2 create-target-group --name "$TG_NAME" --protocol HTTP --port 8080 --vpc-id "$VPC_ID" --target-type ip \
      --health-check-path /healthz --health-check-interval-seconds 30 --health-check-timeout-seconds 5 \
      --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200 --query 'TargetGroups[0].TargetGroupArn' --output text
  fi
  resolve_tg
  aws_cmd elbv2 modify-target-group-attributes --target-group-arn "$TG_ARN" --attributes Key=deregistration_delay.timeout_seconds,Value=30
fi

# ── 12. Listener rules (host-header), priority from env; DPI 1's rule 400 is untouched ──
rule_exists() { # <listener-arn> -> prints rule arn or empty
  aws_cmd elbv2 describe-rules --listener-arn "$1" --query "Rules[?Priority=='${LISTENER_PRIORITY}'].RuleArn" --output text
}
if step_on listener; then
  log "Step listener: ${DOMAIN} -> ${TG_NAME} (priority ${LISTENER_PRIORITY}); HTTP redirects to HTTPS"
  [[ -n "$TG_ARN" ]] || resolve_tg
  existing=""; is_apply && existing="$(rule_exists "$HTTPS_LISTENER_ARN" || true)"
  if [[ -n "$existing" && "$existing" != "None" ]]; then
    log "  HTTPS rule with priority ${LISTENER_PRIORITY} exists: $existing (not modified; use the runbook cutover commands to change it)"
  else
    aws_cmd elbv2 create-rule --listener-arn "$HTTPS_LISTENER_ARN" --priority "$LISTENER_PRIORITY" \
      --conditions "[{\"Field\":\"host-header\",\"Values\":[\"${DOMAIN}\"]}]" \
      --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TG_ARN}\"}]"
  fi
  existing=""; is_apply && existing="$(rule_exists "$HTTP_LISTENER_ARN" || true)"
  if [[ -n "$existing" && "$existing" != "None" ]]; then
    log "  HTTP redirect rule with priority ${LISTENER_PRIORITY} exists"
  else
    aws_cmd elbv2 create-rule --listener-arn "$HTTP_LISTENER_ARN" --priority "$LISTENER_PRIORITY" \
      --conditions "[{\"Field\":\"host-header\",\"Values\":[\"${DOMAIN}\"]}]" \
      --actions '[{"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}}]'
  fi
fi

# ── 13. ECS service: 2 tasks across 2 AZs, circuit breaker with rollback ────────
if step_on service; then
  log "Step service: ${SERVICE_NAME} desired ${DESIRED_COUNT}, min 100% / max 200%, circuit breaker + rollback, grace ${HEALTH_CHECK_GRACE_SECONDS}s"
  [[ -n "$TG_ARN" ]] || resolve_tg
  if is_apply; then
    secret_populated "$SECRET_NAME_URBANI_API_KEY" || die "secret ${SECRET_NAME_URBANI_API_KEY} has no value yet: put the rotated Urbani API key first (runbook step 6)"
    for v in $(echo "${ENABLED_OPTIONAL_SECRETS:-}" | tr ',' ' '); do n="SECRET_NAME_${v}"; secret_populated "${!n}" || die "optional secret ${!n} is enabled but has no value"; done
  fi
  TD_ARN="arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/${TASK_FAMILY}:<latest-registered>"
  if is_apply; then TD_ARN="$(aws_cmd ecs describe-task-definition --task-definition "$TASK_FAMILY" --query taskDefinition.taskDefinitionArn --output text)"; fi
  EXEC_FLAG=(); [[ "$ENABLE_EXEC" == "1" ]] && EXEC_FLAG=(--enable-execute-command)
  svc=""; is_apply && svc="$(aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE_NAME" --query "services[?status=='ACTIVE'].serviceName" --output text || true)"
  if [[ -n "$svc" && "$svc" != "None" ]]; then
    log "  service exists: updating to ${TD_ARN} (desired count is left to Auto Scaling)"
    aws_cmd ecs update-service --cluster "$CLUSTER" --service "$SERVICE_NAME" --task-definition "$TD_ARN" --force-new-deployment \
      --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200" \
      --health-check-grace-period-seconds "$HEALTH_CHECK_GRACE_SECONDS" ${EXEC_FLAG[@]+"${EXEC_FLAG[@]}"} --query service.serviceArn --output text
  else
    aws_cmd ecs create-service --cluster "$CLUSTER" --service-name "$SERVICE_NAME" --task-definition "$TD_ARN" \
      --desired-count "$DESIRED_COUNT" --launch-type FARGATE --platform-version LATEST \
      --network-configuration "$NET_CONF" \
      --load-balancers "targetGroupArn=${TG_ARN},containerName=frontend,containerPort=8080" \
      --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200" \
      --health-check-grace-period-seconds "$HEALTH_CHECK_GRACE_SECONDS" ${EXEC_FLAG[@]+"${EXEC_FLAG[@]}"} --query service.serviceArn --output text
  fi
  aws_cmd ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE_NAME"
fi

# ── 14. Service Auto Scaling (min 2 / max N), target tracking ──────────────────
if step_on autoscaling; then
  log "Step autoscaling: ${MIN_CAPACITY}..${MAX_CAPACITY} tasks; CPU ${SCALE_CPU_TARGET}%, memory ${SCALE_MEMORY_TARGET}%, ${SCALE_REQUESTS_PER_TARGET} req/target"
  [[ -n "$TG_ARN" ]] || resolve_tg
  RES="service/${CLUSTER}/${SERVICE_NAME}"
  LB_PART="${ALB_ARN#*:loadbalancer/}"; TG_PART="${TG_ARN#*:}"
  LABEL="${LB_PART}/${TG_PART}"
  aws_cmd application-autoscaling register-scalable-target --service-namespace ecs --resource-id "$RES" \
    --scalable-dimension ecs:service:DesiredCount --min-capacity "$MIN_CAPACITY" --max-capacity "$MAX_CAPACITY"
  policy() { # <name> <json>
    aws_cmd application-autoscaling put-scaling-policy --service-namespace ecs --resource-id "$RES" \
      --scalable-dimension ecs:service:DesiredCount --policy-name "$1" --policy-type TargetTrackingScaling \
      --target-tracking-scaling-policy-configuration "$2"
  }
  policy dpi2-cpu "{\"TargetValue\":${SCALE_CPU_TARGET},\"PredefinedMetricSpecification\":{\"PredefinedMetricType\":\"ECSServiceAverageCPUUtilization\"},\"ScaleInCooldown\":${SCALE_IN_COOLDOWN},\"ScaleOutCooldown\":${SCALE_OUT_COOLDOWN}}"
  policy dpi2-memory "{\"TargetValue\":${SCALE_MEMORY_TARGET},\"PredefinedMetricSpecification\":{\"PredefinedMetricType\":\"ECSServiceAverageMemoryUtilization\"},\"ScaleInCooldown\":${SCALE_IN_COOLDOWN},\"ScaleOutCooldown\":${SCALE_OUT_COOLDOWN}}"
  policy dpi2-requests "{\"TargetValue\":${SCALE_REQUESTS_PER_TARGET},\"PredefinedMetricSpecification\":{\"PredefinedMetricType\":\"ALBRequestCountPerTarget\",\"ResourceLabel\":\"${LABEL}\"},\"ScaleInCooldown\":${SCALE_IN_COOLDOWN},\"ScaleOutCooldown\":${SCALE_OUT_COOLDOWN}}"
fi

# ── Opt-in: Container Insights on the SHARED cluster ───────────────────────────
if step_on container-insights || [[ "$ENABLE_CONTAINER_INSIGHTS" == "1" ]]; then
  warn "Container Insights is a CLUSTER-wide setting: it also applies to DPI 1 and any other service and adds CloudWatch cost."
  aws_cmd ecs update-cluster-settings --cluster "$CLUSTER" --settings name=containerInsights,value=enabled
fi

# ── Opt-in: Route 53 alias for the parallel hostname (needs approval) ──────────
if step_on dns; then
  [[ "${CONFIRM_DNS:-}" == "$DOMAIN" ]] || die "dns step changes public DNS: pass CONFIRM_DNS=${DOMAIN} (requires client approval)"
  : "${HOSTED_ZONE_ID:?}" "${ALB_DNS:?}" "${ALB_HOSTED_ZONE:?}"
  log "Step dns: ${DOMAIN} -> ALB alias (REQUIRES APPROVAL)"
  aws_cmd route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch \
    "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"${DOMAIN}\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"${ALB_HOSTED_ZONE}\",\"DNSName\":\"${ALB_DNS}\",\"EvaluateTargetHealth\":true}}}]}"
fi

log ""
if is_apply; then
  log "Done. Next: runbook verification checklist (docs/DPI2_DEPLOYMENT_RUNBOOK.md). Rollback: point ${DOMAIN} / the host rule back to DPI 1."
else
  log "Dry-run complete: no AWS call was made. Review the plan, then re-run with APPLY=1 CONFIRM_ACCOUNT=${ACCOUNT_ID}."
fi
