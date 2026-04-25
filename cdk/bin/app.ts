#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SourceStack } from '../lib/source-stack';
import { MetricsStack } from '../lib/metrics-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

const source = new SourceStack(app, 'CodeReviewOpt-Source', { env });

new MetricsStack(app, 'CodeReviewOpt-Metrics', {
  env,
  repositoryName: source.repository.repositoryName,
});
