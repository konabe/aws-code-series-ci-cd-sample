import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

interface MetricsStackProps extends cdk.StackProps {
  repositoryName: string;
}

export const METRICS_NAMESPACE = 'CodeReviewOpt';

export class MetricsStack extends cdk.Stack {
  readonly eventsTable: dynamodb.Table;
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MetricsStackProps) {
    super(scope, id, props);

    this.eventsTable = new dynamodb.Table(this, 'PrEventsTable', {
      tableName: 'code-review-pr-events',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.dashboard = new cloudwatch.Dashboard(this, 'ReviewDashboard', {
      dashboardName: 'code-review-optimization',
    });

    const cost = (metricName: string, label: string) =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName,
        dimensionsMap: { Repository: props.repositoryName },
        statistic: 'Average',
        label,
      });

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Review duration (sec)',
        left: [
          cost('AiReviewDurationSec', 'AI review'),
          cost('HumanReviewDurationSec', 'Human review'),
          cost('TotalReviewDurationSec', 'Total'),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Round trips & queue time',
        left: [cost('ReviewRoundTrips', 'Round trips')],
        right: [cost('QueueTimeSec', 'Queue time (sec)')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'AI cost (USD per PR)',
        left: [cost('AiReviewUsd', 'USD')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Findings: AI vs Human',
        left: [
          cost('AiFindingsCount', 'AI'),
          cost('HumanFindingsCount', 'Human'),
          cost('OverlapFindingsCount', 'Overlap'),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Rework after merge',
        left: [
          cost('PostMergeFixCommits', 'Fix commits'),
          cost('PostMergeIncidents', 'Incidents'),
        ],
        width: 12,
      }),
    );

    new cdk.CfnOutput(this, 'EventsTableName', { value: this.eventsTable.tableName });
    new cdk.CfnOutput(this, 'DashboardName', { value: this.dashboard.dashboardName });
  }
}
