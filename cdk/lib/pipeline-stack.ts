import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { METRICS_NAMESPACE } from './metrics-stack';

interface PipelineStackProps extends cdk.StackProps {
  repository: codecommit.IRepository;
  eventsTable: dynamodb.ITable;
}

export class PipelineStack extends cdk.Stack {
  readonly aiReviewProject: codebuild.Project;
  readonly deployPipeline: codepipeline.Pipeline;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    this.aiReviewProject = this.createAiReviewProject(props);
    this.createPrTrigger(this.aiReviewProject, props.repository);
    this.deployPipeline = this.createDeployPipeline(props.repository);
  }

  private createAiReviewProject(props: PipelineStackProps): codebuild.Project {
    const project = new codebuild.Project(this, 'AiReviewProject', {
      projectName: 'todo-api-ai-review',
      description: 'Run Kiro CLI on a PR and post review comments. Records review metrics.',
      source: codebuild.Source.codeCommit({ repository: props.repository }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        EVENTS_TABLE: { value: props.eventsTable.tableName },
        METRICS_NAMESPACE: { value: METRICS_NAMESPACE },
        REPOSITORY_NAME: { value: props.repository.repositoryName },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        env: {
          shell: 'bash',
        },
        phases: {
          install: {
            'runtime-versions': { nodejs: '20' },
            commands: [
              'echo "[install] Kiro CLI installation goes here (placeholder)"',
              '# npm install -g @aws/kiro-cli  # adjust to actual package',
            ],
          },
          pre_build: {
            commands: [
              'export REVIEW_START_TS=$(date -u +%s)',
              'echo "[pre_build] PR_ID=${PR_ID:-unknown} SOURCE_COMMIT=${SOURCE_COMMIT:-unknown} DEST_COMMIT=${DEST_COMMIT:-unknown}"',
              'aws dynamodb put-item --table-name "$EVENTS_TABLE" --item "{\\"pk\\":{\\"S\\":\\"PR#${REPOSITORY_NAME}#${PR_ID}\\"},\\"sk\\":{\\"S\\":\\"$(date -u +%FT%TZ)#aiReviewStarted\\"},\\"event\\":{\\"S\\":\\"aiReviewStarted\\"}}" || true',
            ],
          },
          build: {
            commands: [
              'echo "[build] Run Kiro review (placeholder)"',
              '# kiro review --pr "$PR_ID" --output kiro-output.json',
              '# parse findings + post comments via aws codecommit post-comment-for-pull-request',
            ],
          },
          post_build: {
            commands: [
              'export REVIEW_END_TS=$(date -u +%s)',
              'export DURATION=$((REVIEW_END_TS - REVIEW_START_TS))',
              'aws cloudwatch put-metric-data --namespace "$METRICS_NAMESPACE" --metric-name AiReviewDurationSec --dimensions Repository=$REPOSITORY_NAME --value $DURATION --unit Seconds || true',
              'aws dynamodb put-item --table-name "$EVENTS_TABLE" --item "{\\"pk\\":{\\"S\\":\\"PR#${REPOSITORY_NAME}#${PR_ID}\\"},\\"sk\\":{\\"S\\":\\"$(date -u +%FT%TZ)#aiReviewFinished\\"},\\"event\\":{\\"S\\":\\"aiReviewFinished\\"},\\"durationSec\\":{\\"N\\":\\"${DURATION}\\"}}" || true',
            ],
          },
        },
      }),
    });

    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'codecommit:PostCommentForPullRequest',
          'codecommit:PostCommentReply',
          'codecommit:GetPullRequest',
          'codecommit:GetDifferences',
          'codecommit:GetCommit',
          'codecommit:GetBlob',
          'codecommit:GetFile',
          'codecommit:GetMergeConflicts',
        ],
        resources: [props.repository.repositoryArn],
      }),
    );

    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE },
        },
      }),
    );

    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }),
    );

    props.eventsTable.grantWriteData(project);

    return project;
  }

  private createPrTrigger(project: codebuild.Project, repository: codecommit.IRepository): void {
    new events.Rule(this, 'PrChangedRule', {
      ruleName: 'todo-api-pr-changed',
      description: 'Trigger AI review when a PR is created or its source branch is updated.',
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Pull Request State Change'],
        resources: [repository.repositoryArn],
        detail: {
          event: ['pullRequestCreated', 'pullRequestSourceBranchUpdated'],
        },
      },
      targets: [
        new eventTargets.CodeBuildProject(project, {
          event: events.RuleTargetInput.fromObject({
            environmentVariablesOverride: [
              { name: 'PR_ID', value: events.EventField.fromPath('$.detail.pullRequestId'), type: 'PLAINTEXT' },
              { name: 'SOURCE_COMMIT', value: events.EventField.fromPath('$.detail.sourceCommit'), type: 'PLAINTEXT' },
              { name: 'DEST_COMMIT', value: events.EventField.fromPath('$.detail.destinationCommit'), type: 'PLAINTEXT' },
              { name: 'SOURCE_REFERENCE', value: events.EventField.fromPath('$.detail.sourceReference'), type: 'PLAINTEXT' },
            ],
            sourceVersion: events.EventField.fromPath('$.detail.sourceCommit'),
          }),
        }),
      ],
    });
  }

  private createDeployPipeline(repository: codecommit.IRepository): codepipeline.Pipeline {
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    const buildProject = new codebuild.PipelineProject(this, 'DeployBuild', {
      projectName: 'todo-api-deploy-build',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      // buildspec.yml lives at the root of the todo-api repo
    });

    const sourceArtifact = new codepipeline.Artifact('Source');
    const buildArtifact = new codepipeline.Artifact('Build');

    return new codepipeline.Pipeline(this, 'DeployPipeline', {
      pipelineName: 'todo-api-deploy',
      artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new actions.CodeCommitSourceAction({
              actionName: 'CodeCommit',
              repository,
              branch: 'main',
              output: sourceArtifact,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'Build',
              project: buildProject,
              input: sourceArtifact,
              outputs: [buildArtifact],
            }),
          ],
        },
        // TODO: add Lambda deploy action once the TODO API is implemented.
      ],
    });
  }
}
