import { Construct } from 'constructs';
import {
  CfnOutput,
  Duration,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
} from 'aws-cdk-lib';
import type { UrbaniConfig } from '../config';

/**
 * Custom Web Dashboard hosting (DashboardConstruct) — ECS Fargate.
 *
 * The visualization layer is a CUSTOM web application (React SPA + Node API
 * behind an nginx reverse proxy) — explicitly NOT Amazon Managed Grafana or
 * CloudWatch dashboards. It ships as containers (see docker-compose /
 * Dockerfiles in the repo root and packages/*).
 *
 * RUNTIME DECISION: ECS on **Fargate** (serverless containers) — chosen over
 * Elastic Beanstalk and over ECS-on-EC2. There is NO EC2 instance type to
 * select or patch; capacity is expressed as Fargate task size (CPU units +
 * memory MiB) in config. This mirrors the docker-compose topology exactly:
 *
 *   Internet → ALB (:80) → nginx "frontend" container (:8080)
 *                              ├── /        → React SPA static assets
 *                              └── /api/*   → backend container (:4000) over localhost
 *
 * Both containers run in the SAME Fargate task so the frontend reaches the
 * backend over 127.0.0.1 (awsvpc networking shares the task's network
 * namespace) — matching how nginx proxies /api to backend:4000 locally.
 *
 * NOTE on persistence: the backend uses SQLite on a local path. Fargate task
 * storage is ephemeral per task, so for data that must survive deploys either
 * attach EFS to the task (mount at /data) or migrate alerts to the DynamoDB
 * table this stack already provisions. Left as a deploy-time decision rather
 * than silently changing the data layer.
 */
export class DashboardConstruct extends Construct {
  readonly cluster: ecs.Cluster;
  readonly service: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, cfg: UrbaniConfig) {
    super(scope, id);

    // Minimal 2-AZ VPC with public + private subnets. Fargate tasks run in
    // private subnets; the ALB sits in public subnets. One NAT gateway keeps
    // cost down for a low-traffic dashboard.
    const vpc = new ec2.Vpc(this, 'DashboardVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    this.cluster = new ecs.Cluster(this, 'DashboardCluster', {
      vpc,
      clusterName: 'urbani-dashboard',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Fargate task definition — sizing from config (no EC2 instance type).
    const taskDef = new ecs.FargateTaskDefinition(this, 'DashboardTaskDef', {
      cpu: cfg.dashboardCpu,
      memoryLimitMiB: cfg.dashboardMemoryMiB,
    });

    const logGroup = new logs.LogGroup(this, 'DashboardLogs', {
      logGroupName: '/urbani/dashboard',
      retention: logs.RetentionDays.ONE_MONTH,
    });

    // Backend API container (Node/Express). Not browser-facing; the frontend
    // reaches it on localhost:4000 within the task.
    const backend = taskDef.addContainer('backend', {
      image: ecs.ContainerImage.fromRegistry(cfg.backendImage),
      containerName: 'backend',
      essential: true,
      environment: {
        NODE_ENV: 'production',
        PORT: '4000',
        DB_DRIVER: 'sqlite',
        DATABASE_URL: '/data/urbani.sqlite',
        // INTEGRATION_MODE and the URBANI_* / JWT_SECRET secrets are injected at
        // deploy time (prefer ECS Secrets from Secrets Manager / SSM) — never
        // baked into the image or this file.
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'backend', logGroup }),
      portMappings: [{ containerPort: 4000 }],
    });

    // Frontend container (nginx reverse proxy serving the SPA + proxying /api).
    const frontend = taskDef.addContainer('frontend', {
      image: ecs.ContainerImage.fromRegistry(cfg.frontendImage),
      containerName: 'frontend',
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'frontend', logGroup }),
      portMappings: [{ containerPort: 8080 }],
    });
    // Start the backend before the browser-facing frontend.
    frontend.addContainerDependencies({
      container: backend,
      condition: ecs.ContainerDependencyCondition.START,
    });

    this.service = new ecs.FargateService(this, 'DashboardService', {
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: cfg.dashboardDesiredCount,
      serviceName: 'urbani-dashboard',
      // Private subnets; the ALB is the only public entry point.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Fail a bad deployment fast instead of waiting up to 3 hours, and roll back.
      circuitBreaker: { rollback: true },
      // Keep at least the desired count healthy during a rolling deploy.
      minHealthyPercent: 100,
    });

    // Internet-facing ALB → the frontend (nginx) container on :8080.
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'DashboardAlb', {
      vpc,
      internetFacing: true,
      loadBalancerName: 'urbani-dashboard-alb',
    });
    const listener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      open: true,
    });
    listener.addTargets('DashboardTarget', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service.loadBalancerTarget({ containerName: 'frontend', containerPort: 8080 })],
      healthCheck: {
        path: '/',
        interval: Duration.seconds(30),
        healthyHttpCodes: '200-399',
      },
    });

    new CfnOutput(this, 'DashboardUrl', {
      value: `http://${this.loadBalancer.loadBalancerDnsName}`,
      description: 'Public URL of the Urbani dashboard (ECS Fargate behind an ALB)',
    });
    new CfnOutput(this, 'DashboardRuntime', {
      value: `ECS Fargate — ${cfg.dashboardCpu} CPU units / ${cfg.dashboardMemoryMiB} MiB x ${cfg.dashboardDesiredCount} task(s)`,
      description: 'Dashboard hosting runtime (no EC2 instance type — serverless Fargate)',
    });
  }
}
