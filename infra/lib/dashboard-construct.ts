import { Construct } from 'constructs';
import { CfnOutput } from 'aws-cdk-lib';
import type { UrbaniConfig } from '../config';

/**
 * Custom Web Dashboard hosting (DashboardConstruct) — PLACEHOLDER boundary.
 *
 * The visualization layer is a CUSTOM web application (React SPA + Node API
 * behind an nginx reverse proxy) — explicitly NOT Amazon Managed Grafana or
 * CloudWatch dashboards. It is delivered as containers (see docker-compose /
 * Dockerfiles in the repo root and packages/*).
 *
 * For AWS hosting this maps to (choose at deploy time, TODO):
 *   - ECS Fargate service + ALB, or
 *   - App Runner, or
 *   - EKS.
 *
 * We intentionally leave the concrete hosting construct as a documented TODO so
 * the client can pick the runtime; the app images are already build-ready.
 */
export class DashboardConstruct extends Construct {
  constructor(scope: Construct, id: string, _cfg: UrbaniConfig) {
    super(scope, id);

    // TODO(phase2): add ECS Fargate service + ALB (or App Runner) that runs the
    // urbani/frontend + urbani/backend images. The dashboard reads DynamoDB
    // alerts + the live logs API; it is the ONLY browser-facing surface.
    new CfnOutput(this, 'DashboardHostingNote', {
      value:
        'Custom React+Node dashboard (containers) — NOT Grafana/CloudWatch. ' +
        'Add ECS Fargate/App Runner hosting here at deploy time.',
      description: 'Custom Web Dashboard hosting boundary',
    });
  }
}
