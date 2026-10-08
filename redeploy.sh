#!/usr/bin/env bash
# =============================================================================
# Urbani DPI — Redeploy script (code updates only)
#
# Use this for every code change after the initial deploy-ecs.sh run.
# Builds new images tagged with git SHA, pushes to ECR, registers a new
# task definition revision, and does a rolling update of the ECS service.
#
# Usage:
#   ./redeploy.sh              # build both frontend + backend
#   ./redeploy.sh --backend    # rebuild backend only
#   ./redeploy.sh --frontend   # rebuild frontend only
# =============================================================================
set -euo pipefail

AWS_PROFILE="urbani"
AWS_REGION="us-east-1"
ACCOUNT_ID="701179923456"
ECR_BASE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

FRONTEND_REPO="urbaniqa/dpi-frontend"
BACKEND_REPO="urbaniqa/dpi-backend"

CLUSTER="urbaniqa-qa-observability-cluster"
SERVICE_NAME="urbaniqa-dpi-svc"
TASK_FAMILY="urbaniqa-dpi-task"

LOG_GROUP="/urbani/dpi"
URBANI_API_BASE_URL="https://iq71gvk8oi.execute-api.${AWS_REGION}.amazonaws.com/qa"
URBANI_API_KEY_SECRET_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:urbaniqa/observability/api-key-qN17nL"
JWT_SECRET_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:urbaniqa/dpi/jwt-secret-JYHni7"
EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/urbaniqa-dpi-exec-role"
TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/urbaniqa-dpi-task-role"

export AWS_PROFILE AWS_REGION

aws_cmd() { aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"; }
log()     { echo "▶ $*"; }

# ── Image tag: git SHA (short) + timestamp for uniqueness ────────────────────
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")
IMAGE_TAG="${GIT_SHA}-$(date +%Y%m%d%H%M%S)"
log "Image tag: ${IMAGE_TAG}"

# ── Parse flags ──────────────────────────────────────────────────────────────
BUILD_BACKEND=true
BUILD_FRONTEND=true
if [[ "${1:-}" == "--backend" ]];  then BUILD_FRONTEND=false; fi
if [[ "${1:-}" == "--frontend" ]]; then BUILD_BACKEND=false;  fi

# =============================================================================
# 1. ECR auth
# =============================================================================
log "Authenticating Docker to ECR..."
aws_cmd ecr get-login-password | docker login --username AWS --password-stdin "$ECR_BASE"

# =============================================================================
# 2. Build & push only what changed
# =============================================================================
BACKEND_IMAGE="${ECR_BASE}/${BACKEND_REPO}:${IMAGE_TAG}"
FRONTEND_IMAGE="${ECR_BASE}/${FRONTEND_REPO}:${IMAGE_TAG}"

# Carry forward the current image for whichever service is NOT being rebuilt
CURRENT_TASK=$(aws_cmd ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" \
  --query "taskDefinition.containerDefinitions" 2>/dev/null || echo "[]")

CURRENT_BACKEND_IMAGE=$(echo "$CURRENT_TASK" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(next((c['image'] for c in d if c['name']=='backend'),''))" 2>/dev/null || echo "")
CURRENT_FRONTEND_IMAGE=$(echo "$CURRENT_TASK" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(next((c['image'] for c in d if c['name']=='frontend'),''))" 2>/dev/null || echo "")

if $BUILD_BACKEND; then
  log "Building backend image..."
  docker build -f packages/backend/Dockerfile -t "$BACKEND_IMAGE" .
  docker push "$BACKEND_IMAGE"
  # Also retag as latest
  docker tag "$BACKEND_IMAGE" "${ECR_BASE}/${BACKEND_REPO}:latest"
  docker push "${ECR_BASE}/${BACKEND_REPO}:latest"
  log "Backend pushed: ${BACKEND_IMAGE}"
else
  BACKEND_IMAGE="${CURRENT_BACKEND_IMAGE}"
  log "Skipping backend build, keeping: ${BACKEND_IMAGE}"
fi

if $BUILD_FRONTEND; then
  log "Building frontend image..."
  docker build -f packages/frontend/Dockerfile -t "$FRONTEND_IMAGE" .
  docker push "$FRONTEND_IMAGE"
  docker tag "$FRONTEND_IMAGE" "${ECR_BASE}/${FRONTEND_REPO}:latest"
  docker push "${ECR_BASE}/${FRONTEND_REPO}:latest"
  log "Frontend pushed: ${FRONTEND_IMAGE}"
else
  FRONTEND_IMAGE="${CURRENT_FRONTEND_IMAGE}"
  log "Skipping frontend build, keeping: ${FRONTEND_IMAGE}"
fi

# =============================================================================
# 3. Register new task definition revision with updated image(s)
# =============================================================================
log "Registering new task definition revision..."

TASK_DEF=$(cat <<EOF
{
  "family": "${TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "${EXEC_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "backend",
      "image": "${BACKEND_IMAGE}",
      "essential": true,
      "portMappings": [{"containerPort": 4000, "protocol": "tcp"}],
      "environment": [
        {"name": "NODE_ENV",            "value": "production"},
        {"name": "PORT",                "value": "4000"},
        {"name": "LOG_LEVEL",           "value": "info"},
        {"name": "DB_DRIVER",           "value": "sqlite"},
        {"name": "DATABASE_URL",        "value": "/data/urbani.sqlite"},
        {"name": "INTEGRATION_MODE",    "value": "live"},
        {"name": "URBANI_API_BASE_URL", "value": "${URBANI_API_BASE_URL}"},
        {"name": "URBANI_SERVICE",      "value": "main"},
        {"name": "URBANI_SERVICES",     "value": "main,payments"},
        {"name": "URBANI_ENVIRONMENT",  "value": "qa"},
        {"name": "URBANI_REFRESH_MINUTES",      "value": "5"},
        {"name": "URBANI_LOGS_HISTORY_LIMIT",   "value": "20"},
        {"name": "URBANI_ALERTS_HISTORY_LIMIT", "value": "5"},
        {"name": "URBANI_CHAT_MODEL_ID",        "value": "global.amazon.nova-2-lite-v1:0"},
        {"name": "URBANI_CHAT_TIMEOUT_MS",      "value": "30000"},
        {"name": "AWS_REGION",          "value": "${AWS_REGION}"},
        {"name": "AWS_ACCOUNT_ID",      "value": "${ACCOUNT_ID}"},
        {"name": "BEDROCK_PRIMARY_MODEL_ID",    "value": "global.amazon.nova-2-lite-v1:0"},
        {"name": "BEDROCK_FALLBACK_MODEL_ID",   "value": "global.amazon.nova-2-lite-v1:0"},
        {"name": "BEDROCK_GUARDRAIL_ID",        "value": "0z947gmtk58a"},
        {"name": "BEDROCK_GUARDRAIL_NAME",      "value": "UrbaniQaObservabilityGuardrail"},
        {"name": "BEDROCK_GUARDRAIL_VERSION",   "value": "1"},
        {"name": "DYNAMODB_ALERTS_TABLE",       "value": "UrbaniAlerts"},
        {"name": "CORS_ORIGIN",         "value": ""},
        {"name": "SEED_ADMIN_EMAIL",    "value": "admin@urbani.io"},
        {"name": "JWT_EXPIRES_IN",      "value": "8h"}
      ],
      "secrets": [
        {"name": "URBANI_API_KEY", "valueFrom": "${URBANI_API_KEY_SECRET_ARN}"},
        {"name": "JWT_SECRET",     "valueFrom": "${JWT_SECRET_ARN}"}
      ],
      "mountPoints": [{"sourceVolume": "dpi-data", "containerPath": "/data"}],
      "healthCheck": {
        "command": ["CMD","node","-e","require('http').get('http://127.0.0.1:4000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"],
        "interval": 30,
        "timeout": 5,
        "startPeriod": 30,
        "retries": 3
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "backend"
        }
      }
    },
    {
      "name": "frontend",
      "image": "${FRONTEND_IMAGE}",
      "essential": true,
      "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
      "dependsOn": [{"containerName": "backend", "condition": "HEALTHY"}],
      "healthCheck": {
        "command": ["CMD","wget","-qO-","http://127.0.0.1:8080/healthz"],
        "interval": 30,
        "timeout": 3,
        "startPeriod": 10,
        "retries": 3
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "frontend"
        }
      }
    }
  ],
  "volumes": [{"name": "dpi-data", "host": {}}]
}
EOF
)

NEW_TASK_DEF_ARN=$(aws_cmd ecs register-task-definition \
  --cli-input-json "$TASK_DEF" \
  --query "taskDefinition.taskDefinitionArn" --output text)
log "New task definition: ${NEW_TASK_DEF_ARN}"

# =============================================================================
# 4. Rolling update — ECS replaces old task with new one (zero downtime)
# =============================================================================
log "Triggering rolling update..."
aws_cmd ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE_NAME" \
  --task-definition "$NEW_TASK_DEF_ARN" \
  --force-new-deployment \
  --query "service.{Status:status,Desired:desiredCount}" --output table

# =============================================================================
# 5. Wait for stable
# =============================================================================
log "Waiting for service to stabilise (rolling update in progress)..."
aws_cmd ecs wait services-stable \
  --cluster "$CLUSTER" \
  --services "$SERVICE_NAME"

log ""
log "✅ Redeploy complete!"
log "   Image tag : ${IMAGE_TAG}"
log "   Task def  : ${NEW_TASK_DEF_ARN}"
log "   URL       : https://dpi.urbani.io"
