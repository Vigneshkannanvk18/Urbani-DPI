#!/usr/bin/env bash
# =============================================================================
# Urbani DPI 2 — code-update redeploy (after the first deploy-ecs-dpi2.sh run).
#
# AUTHORED AND VALIDATED LOCALLY ONLY. It has never been run against AWS.
#
#   ./redeploy-dpi2.sh                       # DRY-RUN (default): prints the plan, zero aws calls
#   APPLY=1 CONFIRM_ACCOUNT=<ACCOUNT_ID> ./redeploy-dpi2.sh
#   ./redeploy-dpi2.sh --only backend        # rebuild only the backend (or: --only frontend)
#
# Builds with the git short SHA tag (and latest), registers a new revision of the CURRENT task definition with
# only the image tag(s) changed, updates the service, waits until stable and prints the rollback command.
# Configuration: deploy/dpi2.env. DPI 1 is never touched.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=deploy/lib.sh
source deploy/lib.sh

ONLY="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="${2:-}"; [[ "$ONLY" == "backend" || "$ONLY" == "frontend" ]] || die "--only takes backend or frontend"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
STEPS="build,register,update,wait"
load_config

IMG_ARGS=()
log "Step build: ${ONLY} image(s), tag ${IMAGE_TAG} + latest"
ecr_login
if [[ "$ONLY" != "frontend" ]]; then
  build_push packages/backend/Dockerfile "$BACKEND_REPO" "$BACKEND_IMAGE"
  IMG_ARGS+=(--backend "$BACKEND_IMAGE")
fi
if [[ "$ONLY" != "backend" ]]; then
  build_push packages/frontend/Dockerfile "$FRONTEND_REPO" "$FRONTEND_IMAGE"
  IMG_ARGS+=(--frontend "$FRONTEND_IMAGE")
fi

log "Step register: new revision of ${TASK_FAMILY} from the current definition (only image tags change)"
PREV_TD="arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/${TASK_FAMILY}:<current>"
NEW_TD="arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/${TASK_FAMILY}:<new>"
if is_apply; then
  PREV_TD="$(aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE_NAME" --query 'services[0].taskDefinition' --output text)"
  [[ -n "$PREV_TD" && "$PREV_TD" != "None" ]] || die "service $SERVICE_NAME not found in $CLUSTER: run deploy-ecs-dpi2.sh first"
  TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT   # task definition JSON only: ARNs and images, no secret values
  aws_cmd ecs describe-task-definition --task-definition "$PREV_TD" --query taskDefinition --output json \
    | node scripts/retag-taskdef.mjs "${IMG_ARGS[@]}" > "$TMP"
  NEW_TD="$(aws_cmd ecs register-task-definition --cli-input-json "file://$TMP" --query taskDefinition.taskDefinitionArn --output text)"
else
  aws_cmd ecs describe-services --cluster "$CLUSTER" --services "$SERVICE_NAME" --query 'services[0].taskDefinition' --output text
  aws_cmd ecs describe-task-definition --task-definition "<current ARN>" --query taskDefinition --output json
  echo "  [dry-run] | node scripts/retag-taskdef.mjs ${IMG_ARGS[*]}   (strips read-only fields, swaps image tags)" >&3
  aws_cmd ecs register-task-definition --cli-input-json "file://<retagged.json>" --query taskDefinition.taskDefinitionArn --output text
fi

log "Step update: rolling deployment (circuit breaker rolls back automatically)"
aws_cmd ecs update-service --cluster "$CLUSTER" --service "$SERVICE_NAME" --task-definition "$NEW_TD" \
  --force-new-deployment --query service.serviceArn --output text
log "Step wait: services-stable"
aws_cmd ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE_NAME"

log ""
log "Image tag : ${IMAGE_TAG}"
log "Previous  : ${PREV_TD}"
log "New       : ${NEW_TD}"
log "Rollback  : aws ecs update-service --cluster ${CLUSTER} --service ${SERVICE_NAME} --task-definition ${PREV_TD} --force-new-deployment --region ${AWS_REGION}"
is_apply || log "Dry-run complete: no AWS call was made."
