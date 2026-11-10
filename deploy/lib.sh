#!/usr/bin/env bash
# Shared helpers for deploy-ecs-dpi2.sh and redeploy-dpi2.sh. Sourced, not executed.
#
# SAFETY MODEL
#   * Default = DRY-RUN: every aws_cmd only PRINTS the command it would run. No aws invocation happens.
#   * Apply needs BOTH  APPLY=1  and  CONFIRM_ACCOUNT=<ACCOUNT_ID from the env file>.
#   * Secret values are never echoed, logged or written to disk (generated secrets are piped straight to aws).

APPLY="${APPLY:-0}"
ENV_FILE="${ENV_FILE:-deploy/dpi2.env}"
exec 3>&1   # plan output goes to the original stdout even inside $( ... )

log()  { echo "▶ $*" >&3; }
warn() { echo "⚠ $*" >&3; }
die()  { echo "✖ $*" >&2; exit 2; }
is_apply() { [[ "$APPLY_MODE" == "apply" ]]; }

# Prints one argument, quoted only when needed.
_q() {
  if [[ "$1" =~ ^[A-Za-z0-9_./:=,@%+*?-]+$ ]]; then printf '%s' "$1"; else printf "'%s'" "${1//\'/\'\\\'\'}"; fi
}

# Runs aws in apply mode; in dry-run only prints the command. Never reads stdin in dry-run.
aws_cmd() {
  local profile=() ; [[ -n "${AWS_PROFILE:-}" ]] && profile=(--profile "$AWS_PROFILE")
  if is_apply; then
    aws "${profile[@]}" --region "$AWS_REGION" "$@"
  else
    local out="  [dry-run] aws" a
    for a in "$@"; do out+=" $(_q "$a")"; done
    echo "$out --region $AWS_REGION" >&3
  fi
}

# docker / local commands: executed in apply mode, printed in dry-run.
local_cmd() {
  if is_apply; then "$@"; else
    local out="  [dry-run]" a
    for a in "$@"; do out+=" $(_q "$a")"; done
    echo "$out" >&3
  fi
}

# Loads the env file and decides the mode. Call once, early.
load_config() {
  [[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE (cp deploy/dpi2.env.example deploy/dpi2.env, then edit)"
  # tr -d: tolerate an env file saved with Windows (CRLF) line endings.
  set -a; # shellcheck disable=SC1090
  source <(tr -d '\r' < "$ENV_FILE"); set +a
  local v
  for v in AWS_REGION ACCOUNT_ID CLUSTER SERVICE_NAME TASK_FAMILY DOMAIN LISTENER_PRIORITY TG_NAME VPC_ID SUBNETS TASK_SG \
           ALB_ARN HTTPS_LISTENER_ARN HTTP_LISTENER_ARN BACKEND_REPO FRONTEND_REPO LOG_GROUP EXEC_ROLE_NAME TASK_ROLE_NAME \
           DYNAMODB_TABLE_PREFIX SECRET_NAME_JWT_SECRET SECRET_NAME_MFA_ENCRYPTION_KEY SECRET_NAME_SEED_ADMIN_PASSWORD \
           SECRET_NAME_URBANI_API_KEY URBANI_API_BASE_URL SEED_ADMIN_EMAIL; do
    [[ -n "${!v:-}" ]] || die "required variable $v is not set in $ENV_FILE"
  done
  [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "ACCOUNT_ID must be a 12-digit account id"
  : "${TASK_CPU:=512}" "${TASK_MEMORY:=1024}" "${LOG_RETENTION_DAYS:=30}" "${DESIRED_COUNT:=2}" "${MIN_CAPACITY:=2}" \
    "${MAX_CAPACITY:=6}" "${SCALE_CPU_TARGET:=60}" "${SCALE_MEMORY_TARGET:=70}" "${SCALE_REQUESTS_PER_TARGET:=200}" \
    "${SCALE_IN_COOLDOWN:=300}" "${SCALE_OUT_COOLDOWN:=60}" "${HEALTH_CHECK_GRACE_SECONDS:=60}" "${ENABLE_EXEC:=0}" \
    "${ENABLE_CONTAINER_INSIGHTS:=0}" "${ENABLE_SNS:=0}" "${KMS_KEY_ALIAS:=alias/urbaniqa-dpi2}" "${STOP_TIMEOUT_SECONDS:=30}"
  TABLE_NAME="${DYNAMODB_TABLE_PREFIX}App"
  ECR_BASE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
  [[ "$MIN_CAPACITY" -ge 2 ]] || die "MIN_CAPACITY must be >= 2 (two tasks across two AZs)"

  # Never collide with the live DPI 1 deployment.
  [[ "$SERVICE_NAME" != "urbaniqa-dpi-svc" ]] || die "SERVICE_NAME is DPI 1's service; refusing"
  [[ "$TASK_FAMILY" != "urbaniqa-dpi-task" ]] || die "TASK_FAMILY is DPI 1's family; refusing"
  [[ "$TG_NAME" != "urbaniqa-dpi-tg" ]] || die "TG_NAME is DPI 1's target group; refusing"
  [[ "$LOG_GROUP" != "/urbani/dpi" ]] || die "LOG_GROUP is DPI 1's log group; refusing"
  [[ "$EXEC_ROLE_NAME" != "urbaniqa-dpi-exec-role" && "$TASK_ROLE_NAME" != "urbaniqa-dpi-task-role" ]] \
    || die "role names are DPI 1's; refusing"
  [[ "$BACKEND_REPO" != "urbaniqa/dpi-backend" && "$FRONTEND_REPO" != "urbaniqa/dpi-frontend" ]] \
    || die "ECR repos are DPI 1's; DPI 2 uses its own so :latest cannot change DPI 1"
  if [[ "${CUTOVER:-0}" != "1" ]]; then
    [[ "$DOMAIN" != "dpi.urbani.io" ]] || die "DOMAIN=dpi.urbani.io is the production hostname; set CUTOVER=1 only for the approved cutover"
    [[ "$LISTENER_PRIORITY" != "400" ]] || die "LISTENER_PRIORITY=400 is DPI 1's rule; set CUTOVER=1 only for the approved cutover"
  fi

  APPLY_MODE="dry-run"
  if [[ "$APPLY" == "1" ]]; then
    [[ "${CONFIRM_ACCOUNT:-}" == "$ACCOUNT_ID" ]] || die "APPLY=1 also needs CONFIRM_ACCOUNT=$ACCOUNT_ID (typed confirmation); staying out of AWS"
    APPLY_MODE="apply"
  fi
  # Image tag: git short SHA. Never 'latest' alone.
  if [[ -z "${IMAGE_TAG:-}" ]]; then
    IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || true)"
    [[ -n "$IMAGE_TAG" ]] || die "cannot determine the git short SHA; set IMAGE_TAG explicitly"
    if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
      is_apply && [[ "${ALLOW_DIRTY:-0}" != "1" ]] && die "working tree has uncommitted changes; commit first (or ALLOW_DIRTY=1)"
      IMAGE_TAG="${IMAGE_TAG}-dirty"
    fi
  fi
  [[ "$IMAGE_TAG" != "latest" ]] || die "IMAGE_TAG=latest is not allowed; deploy an immutable tag"
  BACKEND_IMAGE="${ECR_BASE}/${BACKEND_REPO}:${IMAGE_TAG}"
  FRONTEND_IMAGE="${ECR_BASE}/${FRONTEND_REPO}:${IMAGE_TAG}"

  echo "════════════════════════════════════════════════════════════════" >&3
  if is_apply; then
    echo " MODE: APPLY  (account $ACCOUNT_ID, $AWS_REGION)  — real AWS changes" >&3
  else
    echo " MODE: DRY-RUN — nothing is executed, no aws call is made." >&3
    echo "       To apply: APPLY=1 CONFIRM_ACCOUNT=$ACCOUNT_ID $0" >&3
  fi
  echo " cluster=$CLUSTER service=$SERVICE_NAME family=$TASK_FAMILY host=$DOMAIN tag=$IMAGE_TAG" >&3
  echo "════════════════════════════════════════════════════════════════" >&3
  if is_apply; then
    local who
    who="$(aws_cmd sts get-caller-identity --query Account --output text)"
    [[ "$who" == "$ACCOUNT_ID" ]] || die "credentials belong to account '$who', not $ACCOUNT_ID"
  fi
}

# step_on <name>: honours STEPS (comma list, default set) and SKIP (comma list).
step_on() {
  local s="$1"
  [[ ",${SKIP:-}," != *",$s,"* ]] && [[ ",$STEPS," == *",$s,"* ]]
}

# Builds the image locally for linux/amd64 (Fargate default) and pushes the SHA tag AND latest.
build_push() { # <dockerfile> <repo> <image-with-tag>
  local dockerfile="$1" repo="$2" image="$3"
  local_cmd docker build --platform linux/amd64 -f "$dockerfile" -t "$image" -t "${ECR_BASE}/${repo}:latest" .
  local_cmd docker push "$image"
  local_cmd docker push "${ECR_BASE}/${repo}:latest"
}

ecr_login() {
  if is_apply; then
    aws_cmd ecr get-login-password | docker login --username AWS --password-stdin "$ECR_BASE"
  else
    echo "  [dry-run] aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_BASE" >&3
  fi
}
