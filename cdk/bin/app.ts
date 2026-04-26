#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SourceStack } from '../lib/source-stack';
import { MetricsStack } from '../lib/metrics-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

new GithubOidcStack(app, 'CodeReviewOpt-GithubOidc', {
  env,
  githubOwner: app.node.tryGetContext('github:owner') ?? 'konabe',
  githubRepo:
    app.node.tryGetContext('github:repo') ?? 'aws-code-series-ci-cd-sample',
  githubBranch: app.node.tryGetContext('github:branch') ?? 'main',
  existingProviderArn: app.node.tryGetContext('github:existingProviderArn'),
});

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
