#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { UrbaniDpiStack } from '../lib/urbani-dpi-stack';

/**
 * CDK app entry point. Account/region resolve from context or the standard
 * CDK_DEFAULT_* env vars — nothing account-specific is hardcoded. This app is
 * synth-ready but is NOT deployed automatically.
 */
const app = new App();

new UrbaniDpiStack(app, 'UrbaniDpiStack', {
  env: {
    account: app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
  },
  description: 'Urbani Proactive Observability & AI Troubleshooting Assistant — infrastructure',
});
