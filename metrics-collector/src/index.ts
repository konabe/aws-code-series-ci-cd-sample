import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cw = new CloudWatchClient({});

const TABLE = requireEnv('EVENTS_TABLE');
const NAMESPACE = requireEnv('METRICS_NAMESPACE');
const REPO = requireEnv('REPOSITORY_NAME');
const TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year retention for raw events

interface CodeCommitEvent {
  source: string;
  'detail-type': string;
  time: string;
  resources?: string[];
  detail: CodeCommitDetail;
}

interface CodeCommitDetail {
  event?: string;
  pullRequestId?: string;
  callerUserArn?: string;
  sourceCommit?: string;
  destinationCommit?: string;
  pullRequestStatus?: string;
  isMerged?: 'True' | 'False';
  approvalStatus?: string;
  commentId?: string;
  inReplyTo?: string;
  repositoryNames?: string[];
  [key: string]: unknown;
}

export const handler = async (event: CodeCommitEvent): Promise<void> => {
  const eventName = event.detail.event ?? event['detail-type'];
  const prId = event.detail.pullRequestId;

  console.log('[collector] received', { eventName, prId, time: event.time });

  if (!prId) {
    console.log('[collector] skipping event without pullRequestId');
    return;
  }

  const pk = `PR#${REPO}#${prId}`;
  const sk = `${event.time}#${eventName}`;

  await persistEvent(pk, sk, eventName, event);
  await emitMetrics(eventName, pk, event);
};

async function persistEvent(
  pk: string,
  sk: string,
  eventName: string,
  event: CodeCommitEvent,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk,
        sk,
        event: eventName,
        time: event.time,
        actor: event.detail.callerUserArn,
        sourceCommit: event.detail.sourceCommit,
        destinationCommit: event.detail.destinationCommit,
        payload: event.detail,
        ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    }),
  );
}

async function emitMetrics(
  eventName: string,
  pk: string,
  event: CodeCommitEvent,
): Promise<void> {
  switch (eventName) {
    case 'pullRequestSourceBranchUpdated':
      await putMetric('ReviewRoundTrips', 1, StandardUnit.Count);
      return;

    case 'commentOnPullRequestCreated':
      await putMetric('PullRequestComments', 1, StandardUnit.Count);
      return;

    case 'pullRequestApprovalStateChanged':
      if (event.detail.approvalStatus === 'APPROVE') {
        await putMetric('ApprovalEvents', 1, StandardUnit.Count);
      }
      return;

    case 'pullRequestStatusChanged': {
      if (event.detail.isMerged !== 'True') return;
      const startTime = await getPrStartTime(pk);
      if (!startTime) return;
      const durationSec = Math.max(
        0,
        (Date.parse(event.time) - Date.parse(startTime)) / 1000,
      );
      await putMetric('TotalReviewDurationSec', durationSec, StandardUnit.Seconds);
      return;
    }

    default:
      // No derived metric for this event; raw event is still persisted.
      return;
  }
}

async function getPrStartTime(pk: string): Promise<string | undefined> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ScanIndexForward: true,
      Limit: 1,
      ProjectionExpression: '#t',
      ExpressionAttributeNames: { '#t': 'time' },
    }),
  );
  const first = res.Items?.[0];
  return first?.time as string | undefined;
}

async function putMetric(
  metricName: string,
  value: number,
  unit: StandardUnit,
): Promise<void> {
  await cw.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: metricName,
          Value: value,
          Unit: unit,
          Dimensions: [{ Name: 'Repository', Value: REPO }],
        },
      ],
    }),
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
