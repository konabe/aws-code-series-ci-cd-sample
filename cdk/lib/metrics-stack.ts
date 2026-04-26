import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface MetricsStackProps extends cdk.StackProps {
  repository: codecommit.IRepository;
}

export const METRICS_NAMESPACE = 'CodeReviewOpt';

export class MetricsStack extends cdk.Stack {
  readonly eventsTable: dynamodb.Table;
  readonly dashboard: cloudwatch.Dashboard;
  readonly collector: lambda.IFunction;

  constructor(scope: Construct, id: string, props: MetricsStackProps) {
    super(scope, id, props);

    this.eventsTable = this.createEventsTable();
    this.collector = this.createCollector(props.repository);
    this.createEventRules(props.repository, this.collector);
    this.dashboard = this.createDashboard(props.repository.repositoryName);

    new cdk.CfnOutput(this, 'EventsTableName', { value: this.eventsTable.tableName });
    new cdk.CfnOutput(this, 'DashboardName', { value: this.dashboard.dashboardName });
  }

  private createEventsTable(): dynamodb.Table {
    return new dynamodb.Table(this, 'PrEventsTable', {
      tableName: 'code-review-pr-events',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  private createCollector(repository: codecommit.IRepository): lambda.IFunction {
    const collectorRoot = path.join(__dirname, '..', '..', 'metrics-collector');
    const fn = new nodejs.NodejsFunction(this, 'CollectorFunction', {
      functionName: 'code-review-metrics-collector',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(collectorRoot, 'src', 'index.ts'),
      projectRoot: collectorRoot,
      depsLockFilePath: path.join(collectorRoot, 'package-lock.json'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        target: 'node20',
        minify: false,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        EVENTS_TABLE: this.eventsTable.tableName,
        METRICS_NAMESPACE: METRICS_NAMESPACE,
        REPOSITORY_NAME: repository.repositoryName,
      },
    });

    this.eventsTable.grantReadWriteData(fn);

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE },
        },
      }),
    );

    return fn;
  }

  private createEventRules(
    repository: codecommit.IRepository,
    target: lambda.IFunction,
  ): void {
    new events.Rule(this, 'PrStateChangeRule', {
      ruleName: 'code-review-pr-state-change',
      description: 'CodeCommit PR lifecycle events for metrics collection.',
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Pull Request State Change'],
        resources: [repository.repositoryArn],
      },
      targets: [new eventTargets.LambdaFunction(target)],
    });

    new events.Rule(this, 'PrCommentRule', {
      ruleName: 'code-review-pr-comment',
      description: 'CodeCommit PR comment events for metrics collection.',
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Comment on Pull Request'],
        resources: [repository.repositoryArn],
      },
      targets: [new eventTargets.LambdaFunction(target)],
    });
  }

  private createDashboard(repositoryName: string): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'ReviewDashboard', {
      dashboardName: 'code-review-optimization',
    });

    const metric = (metricName: string, label: string, statistic = 'Average') =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName,
        dimensionsMap: { Repository: repositoryName },
        statistic,
        label,
      });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Review duration (sec)',
        left: [
          metric('AiReviewDurationSec', 'AI review'),
          metric('HumanReviewDurationSec', 'Human review'),
          metric('TotalReviewDurationSec', 'Total'),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Round trips & approvals',
        left: [metric('ReviewRoundTrips', 'Round trips', 'Sum')],
        right: [metric('ApprovalEvents', 'Approvals', 'Sum')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Comments per PR (Sum)',
        left: [metric('PullRequestComments', 'Comments', 'Sum')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'AI cost (USD per PR)',
        left: [metric('AiReviewUsd', 'USD')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Findings: AI vs Human',
        left: [
          metric('AiFindingsCount', 'AI', 'Sum'),
          metric('HumanFindingsCount', 'Human', 'Sum'),
          metric('OverlapFindingsCount', 'Overlap', 'Sum'),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Rework after merge',
        left: [
          metric('PostMergeFixCommits', 'Fix commits', 'Sum'),
          metric('PostMergeIncidents', 'Incidents', 'Sum'),
        ],
        width: 12,
      }),
    );

    return dashboard;
  }
}
