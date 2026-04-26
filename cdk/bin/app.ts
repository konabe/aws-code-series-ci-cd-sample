#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SourceStack } from '../lib/source-stack';
import { MetricsStack } from '../lib/metrics-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

const source = new SourceStack(app, 'CodeReviewOpt-Source', { env });

const metrics = new MetricsStack(app, 'CodeReviewOpt-Metrics', {
  env,
  repository: source.repository,
});

new PipelineStack(app, 'CodeReviewOpt-Pipeline', {
  env,
  repository: source.repository,
  eventsTable: metrics.eventsTable,
});
