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
MFA_KEY_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:urbaniqa/dpi/mfa-encryption-key-SMtzM5"
SEED_ADMIN_PASS_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:urbaniqa/dpi/seed-admin-password-R8SjOs"
OIDC_SECRET_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:urbaniqa/dpi/oidc-client-secret-DIYFAN"
SMTP_PASS_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:urbaniqa/dpi/smtp-password-2uhwUh"
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
  docker build --no-cache -f packages/frontend/Dockerfile -t "$FRONTEND_IMAGE" .
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
        {"name": "JWT_EXPIRES_IN",      "value": "8h"},
        {"name": "AUTH_PROVIDER",       "value": "oidc"},
        {"name": "AUTH_LOCAL_ENABLED",  "value": "true"},
        {"name": "OIDC_ISSUER",         "value": "https://accounts.google.com"},
        {"name": "OIDC_CLIENT_ID",      "value": "241884732688-93di0ikd3u6dgqc2qa8tss194qicsje6.apps.googleusercontent.com"},
        {"name": "OIDC_REDIRECT_URI",   "value": "https://dpi.urbani.io/api/auth/sso/callback"},
        {"name": "OIDC_ALLOWED_EMAIL_DOMAIN", "value": "gmail.com"},
        {"name": "OIDC_AUTO_PROVISION",  "value": "false"},
        {"name": "OIDC_EMAIL_ROLE_MAP", "value": "{\"first.superadmin@urbani.io\":\"SUPER_ADMIN\"}"},
        {"name": "MFA_REQUIRED_ROLES",  "value": "SUPER_ADMIN,INFRA_ADMIN"},
        {"name": "SMTP_HOST",           "value": "smtp.gmail.com"},
        {"name": "SMTP_PORT",           "value": "587"},
        {"name": "SMTP_USER",           "value": "dpiurbani@gmail.com"},
        {"name": "SMTP_FROM",           "value": "Urbani Radar <dpiurbani@gmail.com>"},
        {"name": "ALERT_EMAIL_ROLES",   "value": "SUPER_ADMIN,QA_OPERATOR,INFRA_ADMIN"},
        {"name": "DASHBOARD_BASE_URL",  "value": "https://dpi.urbani.io"},
        {"name": "NOTIFICATIONS_ENABLED",     "value": "true"},
        {"name": "NOTIFICATIONS_DRY_RUN",     "value": "false"},
        {"name": "NOTIFICATIONS_ALLOW_MOCK",  "value": "false"},
        {"name": "ALERT_POLL_MINUTES",        "value": "5"},
        {"name": "NOTIFICATIONS_MAX_ALERT_AGE_MINUTES", "value": "60"},
        {"name": "NOTIFICATIONS_LOG_RETENTION_DAYS",    "value": "90"},
        {"name": "HEALTH_TARGETS",      "value": "[{\"id\":\"qa\",\"type\":\"http\",\"url\":\"https://main-qa.urbani.io/health\"},{\"id\":\"main\",\"type\":\"http\",\"url\":\"https://main-qa.urbani.io/health\"},{\"id\":\"payment\",\"type\":\"http\",\"url\":\"https://payments-qa.urbani.io/health\"}]"},
        {"name": "HEALTH_PROBES_ENABLED",          "value": "true"},
        {"name": "HEALTH_PROBE_INTERVAL_SECONDS",   "value": "60"},
        {"name": "HEALTH_RETENTION_DAYS",           "value": "30"},
        {"name": "AUDIT_RETENTION_DAYS",            "value": "365"},
        {"name": "AUDIT_RETENTION_JOB",             "value": "true"},
        {"name": "CHAT_HISTORY_ENABLED",            "value": "true"},
        {"name": "CHAT_RETENTION_DAYS",             "value": "90"},
        {"name": "EXPORT_MAX_ROWS",                 "value": "10000"},
        {"name": "EXPORT_PDF_MAX_ROWS",             "value": "2000"},
        {"name": "EXPORT_RATE_LIMIT_PER_MIN",       "value": "10"},
        {"name": "EXPORT_TIMEOUT_MS",               "value": "60000"},
        {"name": "LOGS_SOURCE",                     "value": "default"}
      ],
      "secrets": [
        {"name": "URBANI_API_KEY",       "valueFrom": "${URBANI_API_KEY_SECRET_ARN}"},
        {"name": "JWT_SECRET",           "valueFrom": "${JWT_SECRET_ARN}"},
        {"name": "MFA_ENCRYPTION_KEY",   "valueFrom": "${MFA_KEY_ARN}"},
        {"name": "SEED_ADMIN_PASSWORD",  "valueFrom": "${SEED_ADMIN_PASS_ARN}"},
        {"name": "OIDC_CLIENT_SECRET",   "valueFrom": "${OIDC_SECRET_ARN}"},
        {"name": "SMTP_PASSWORD",        "valueFrom": "${SMTP_PASS_ARN}"}
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
      "environment": [
        {"name": "BACKEND_UPSTREAM", "value": "127.0.0.1:4000"}
      ],
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
