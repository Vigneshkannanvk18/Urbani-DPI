#!/usr/bin/env bash
# =============================================================================
# Urbani DPI — ECS Fargate deployment script
# Account : 701179923456  |  Region: us-east-1  |  Profile: urbani
# Domain  : dpi.urbani.io (Route53 + existing ALB + ACM *.urbani.io)
# Cluster : urbaniqa-qa-observability-cluster (existing, 0 services)
# =============================================================================
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
AWS_PROFILE="urbani"
AWS_REGION="us-east-1"
ACCOUNT_ID="701179923456"
ECR_BASE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

FRONTEND_REPO="urbaniqa/dpi-frontend"
BACKEND_REPO="urbaniqa/dpi-backend"
IMAGE_TAG="latest"

CLUSTER="urbaniqa-qa-observability-cluster"
SERVICE_NAME="urbaniqa-dpi-svc"
TASK_FAMILY="urbaniqa-dpi-task"

VPC_ID="vpc-05ffb7ee97c93b14e"
# Private app subnets (two AZs)
SUBNETS="subnet-0136ab68e2ca19b6b,subnet-0e984bc9914fb7096"
# Existing SG for observability ECS tasks (ALB ingress only)
TASK_SG="sg-0dbf0fb741dd92476"
# Existing ALB
ALB_ARN="arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT_ID}:loadbalancer/app/urbaniqa-qa-alb/7f4704aa0b2a97f1"
HTTPS_LISTENER_ARN="arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT_ID}:listener/app/urbaniqa-qa-alb/7f4704aa0b2a97f1/c3325e323fd11bab"
HTTP_LISTENER_ARN="arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT_ID}:listener/app/urbaniqa-qa-alb/7f4704aa0b2a97f1/0347c3d7e6d10c6a"
ACM_CERT_ARN="arn:aws:acm:us-east-1:${ACCOUNT_ID}:certificate/134f8683-5340-4e7e-9673-359de6d100e1"

HOSTED_ZONE_ID="Z0141203QMOLDPQJCKOF"
DOMAIN="dpi.urbani.io"
ALB_DNS="urbaniqa-qa-alb-1567641204.us-east-1.elb.amazonaws.com"
ALB_HOSTED_ZONE="Z35SXDOTRQ7X7K"   # us-east-1 ALB canonical hosted zone

# Existing observability API Gateway
URBANI_API_BASE_URL="https://iq71gvk8oi.execute-api.${AWS_REGION}.amazonaws.com/qa"
URBANI_API_KEY_SECRET_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:urbaniqa/observability/api-key-qN17nL"

LOG_GROUP="/urbani/dpi"

export AWS_PROFILE AWS_REGION

# ── Helper ────────────────────────────────────────────────────────────────────
aws_cmd() { aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"; }
log()     { echo "▶ $*"; }

# =============================================================================
# 1. ECR repositories
# =============================================================================
log "Creating ECR repositories..."
for REPO in "$FRONTEND_REPO" "$BACKEND_REPO"; do
  aws_cmd ecr describe-repositories --repository-names "$REPO" &>/dev/null \
    || aws_cmd ecr create-repository \
        --repository-name "$REPO" \
        --image-scanning-configuration scanOnPush=true \
        --encryption-configuration encryptionType=AES256 \
        --query "repository.repositoryUri" --output text
done

# =============================================================================
# 2. Build & push images
# =============================================================================
log "Authenticating Docker to ECR..."
aws_cmd ecr get-login-password | docker login --username AWS --password-stdin "$ECR_BASE"

log "Building backend image..."
docker build \
  -f packages/backend/Dockerfile \
  -t "${ECR_BASE}/${BACKEND_REPO}:${IMAGE_TAG}" \
  .

log "Building frontend image..."
docker build \
  -f packages/frontend/Dockerfile \
  -t "${ECR_BASE}/${FRONTEND_REPO}:${IMAGE_TAG}" \
  .

log "Pushing images..."
docker push "${ECR_BASE}/${BACKEND_REPO}:${IMAGE_TAG}"
docker push "${ECR_BASE}/${FRONTEND_REPO}:${IMAGE_TAG}"

# =============================================================================
# 3. CloudWatch log group
# =============================================================================
log "Creating CloudWatch log group ${LOG_GROUP}..."
aws_cmd logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
aws_cmd logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30

# =============================================================================
# 4. IAM — execution role
# =============================================================================
EXEC_ROLE_NAME="urbaniqa-dpi-exec-role"
log "Creating ECS execution role ${EXEC_ROLE_NAME}..."

EXEC_ROLE_ARN=$(aws_cmd iam get-role --role-name "$EXEC_ROLE_NAME" \
  --query "Role.Arn" --output text 2>/dev/null || true)

if [[ -z "$EXEC_ROLE_ARN" ]]; then
  EXEC_ROLE_ARN=$(aws_cmd iam create-role \
    --role-name "$EXEC_ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' \
    --query "Role.Arn" --output text)

  aws_cmd iam attach-role-policy \
    --role-name "$EXEC_ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"

  # Allow reading the API key secret
  aws_cmd iam put-role-policy \
    --role-name "$EXEC_ROLE_NAME" \
    --policy-name "dpi-secrets-read" \
    --policy-document "{
      \"Version\":\"2012-10-17\",
      \"Statement\":[{
        \"Effect\":\"Allow\",
        \"Action\":[\"secretsmanager:GetSecretValue\"],
        \"Resource\":\"${URBANI_API_KEY_SECRET_ARN}\"
      }]
    }"
fi
log "Execution role: ${EXEC_ROLE_ARN}"

# =============================================================================
# 5. IAM — task role
# =============================================================================
TASK_ROLE_NAME="urbaniqa-dpi-task-role"
log "Creating ECS task role ${TASK_ROLE_NAME}..."

TASK_ROLE_ARN=$(aws_cmd iam get-role --role-name "$TASK_ROLE_NAME" \
  --query "Role.Arn" --output text 2>/dev/null || true)

if [[ -z "$TASK_ROLE_ARN" ]]; then
  TASK_ROLE_ARN=$(aws_cmd iam create-role \
    --role-name "$TASK_ROLE_NAME" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' \
    --query "Role.Arn" --output text)

  # Minimal: write logs + read the API key secret at runtime
  aws_cmd iam put-role-policy \
    --role-name "$TASK_ROLE_NAME" \
    --policy-name "dpi-task-policy" \
    --policy-document "{
      \"Version\":\"2012-10-17\",
      \"Statement\":[
        {
          \"Effect\":\"Allow\",
          \"Action\":[\"logs:CreateLogStream\",\"logs:PutLogEvents\"],
          \"Resource\":\"arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*\"
        },
        {
          \"Effect\":\"Allow\",
          \"Action\":[\"secretsmanager:GetSecretValue\"],
          \"Resource\":\"${URBANI_API_KEY_SECRET_ARN}\"
        }
      ]
    }"
fi
log "Task role: ${TASK_ROLE_ARN}"

# =============================================================================
# 6. Secrets Manager — JWT secret
# =============================================================================
JWT_SECRET_NAME="urbaniqa/dpi/jwt-secret"
log "Ensuring JWT secret exists in Secrets Manager..."
JWT_SECRET_ARN=$(aws_cmd secretsmanager describe-secret \
  --secret-id "$JWT_SECRET_NAME" \
  --query "ARN" --output text 2>/dev/null || true)

if [[ -z "$JWT_SECRET_ARN" ]]; then
  JWT_VALUE=$(openssl rand -hex 32)
  JWT_SECRET_ARN=$(aws_cmd secretsmanager create-secret \
    --name "$JWT_SECRET_NAME" \
    --description "JWT signing secret for Urbani DPI dashboard" \
    --secret-string "$JWT_VALUE" \
    --query "ARN" --output text)
  log "Created JWT secret: ${JWT_SECRET_ARN}"
else
  log "JWT secret already exists: ${JWT_SECRET_ARN}"
fi

# Allow execution role to read JWT secret
aws_cmd iam put-role-policy \
  --role-name "$EXEC_ROLE_NAME" \
  --policy-name "dpi-jwt-secret-read" \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{
      \"Effect\":\"Allow\",
      \"Action\":[\"secretsmanager:GetSecretValue\"],
      \"Resource\":\"${JWT_SECRET_ARN}\"
    }]
  }"

# =============================================================================
# 7. ECS task definition
# =============================================================================
log "Registering ECS task definition ${TASK_FAMILY}..."

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
      "image": "${ECR_BASE}/${BACKEND_REPO}:${IMAGE_TAG}",
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
      "image": "${ECR_BASE}/${FRONTEND_REPO}:${IMAGE_TAG}",
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
  "volumes": [
    {
      "name": "dpi-data",
      "host": {}
    }
  ]
}
EOF
)

TASK_DEF_ARN=$(aws_cmd ecs register-task-definition \
  --cli-input-json "$TASK_DEF" \
  --query "taskDefinition.taskDefinitionArn" --output text)
log "Task definition: ${TASK_DEF_ARN}"

# =============================================================================
# 8. ALB target group
# =============================================================================
TG_NAME="urbaniqa-dpi-tg"
log "Creating target group ${TG_NAME}..."

TG_ARN=$(aws_cmd elbv2 describe-target-groups \
  --names "$TG_NAME" \
  --query "TargetGroups[0].TargetGroupArn" --output text 2>/dev/null || true)

if [[ -z "$TG_ARN" || "$TG_ARN" == "None" ]]; then
  TG_ARN=$(aws_cmd elbv2 create-target-group \
    --name "$TG_NAME" \
    --protocol HTTP \
    --port 8080 \
    --vpc-id "$VPC_ID" \
    --target-type ip \
    --health-check-path "/healthz" \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --matcher HttpCode=200 \
    --query "TargetGroups[0].TargetGroupArn" --output text)
fi
log "Target group: ${TG_ARN}"

# =============================================================================
# 9. ALB listener rules (HTTPS host-header: dpi.urbani.io, priority 400)
#    HTTP listener: redirect to HTTPS
# =============================================================================
log "Adding HTTPS listener rule for ${DOMAIN}..."
aws_cmd elbv2 create-rule \
  --listener-arn "$HTTPS_LISTENER_ARN" \
  --priority 400 \
  --conditions '[{"Field":"host-header","Values":["'"${DOMAIN}"'"]}]' \
  --actions '[{"Type":"forward","TargetGroupArn":"'"${TG_ARN}"'"}]' \
  2>/dev/null || log "HTTPS rule already exists, skipping."

log "Adding HTTP→HTTPS redirect rule for ${DOMAIN}..."
aws_cmd elbv2 create-rule \
  --listener-arn "$HTTP_LISTENER_ARN" \
  --priority 400 \
  --conditions '[{"Field":"host-header","Values":["'"${DOMAIN}"'"]}]' \
  --actions '[{"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}}]' \
  2>/dev/null || log "HTTP redirect rule already exists, skipping."

# =============================================================================
# 10. ECS service
# =============================================================================
log "Creating/updating ECS service ${SERVICE_NAME}..."

SERVICE_EXISTS=$(aws_cmd ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$SERVICE_NAME" \
  --query "services[?status!='INACTIVE'].serviceName" \
  --output text 2>/dev/null || true)

if [[ -n "$SERVICE_EXISTS" ]]; then
  log "Service exists — updating task definition..."
  aws_cmd ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --force-new-deployment \
    --query "service.serviceArn" --output text
else
  aws_cmd ecs create-service \
    --cluster "$CLUSTER" \
    --service-name "$SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count 1 \
    --launch-type FARGATE \
    --platform-version LATEST \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${TASK_SG}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${TG_ARN},containerName=frontend,containerPort=8080" \
    --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200" \
    --enable-execute-command \
    --query "service.serviceArn" --output text
fi

# =============================================================================
# 11. Route53 — dpi.urbani.io → ALB alias
# =============================================================================
log "Creating Route53 alias record ${DOMAIN} → ALB..."
aws_cmd route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"${DOMAIN}\",
        \"Type\": \"A\",
        \"AliasTarget\": {
          \"HostedZoneId\": \"${ALB_HOSTED_ZONE}\",
          \"DNSName\": \"${ALB_DNS}\",
          \"EvaluateTargetHealth\": true
        }
      }
    }]
  }" \
  --query "ChangeInfo.{Id:Id,Status:Status}" --output table

# =============================================================================
# Done
# =============================================================================
log ""
log "✅ Deployment complete!"
log "   URL      : https://${DOMAIN}"
log "   Cluster  : ${CLUSTER}"
log "   Service  : ${SERVICE_NAME}"
log "   Task def : ${TASK_DEF_ARN}"
log ""
log "Monitor service stabilisation:"
log "  aws ecs wait services-stable --cluster ${CLUSTER} --services ${SERVICE_NAME} --profile ${AWS_PROFILE} --region ${AWS_REGION}"
