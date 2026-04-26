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
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { METRICS_NAMESPACE } from './metrics-stack';

interface PipelineStackProps extends cdk.StackProps {
  repository: codecommit.IRepository;
  eventsTable: dynamodb.ITable;
}

export class PipelineStack extends cdk.Stack {
  readonly aiReviewProject: codebuild.Project;
  readonly testProject: codebuild.Project;
  readonly deployPipeline: codepipeline.Pipeline;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    this.aiReviewProject = this.createAiReviewProject(props);
    this.testProject = this.createTestProject(props);
    this.attachTestApprovalRuleTemplate(props.repository, this.testProject.role!);
    this.createPrTrigger(
      [this.aiReviewProject, this.testProject],
      props.repository,
    );
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

  private createTestProject(props: PipelineStackProps): codebuild.Project {
    const project = new codebuild.Project(this, 'PrTestProject', {
      projectName: 'todo-api-pr-test',
      description: 'Run automated tests on every PR. Records duration / pass-fail to metrics and posts a summary comment to the PR.',
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
        env: { shell: 'bash' },
        phases: {
          install: {
            'runtime-versions': { nodejs: '20' },
            commands: [
              'echo "[install] npm ci (placeholder until todo-api lands)"',
              '# npm ci',
            ],
          },
          pre_build: {
            commands: [
              'export TEST_START_TS=$(date -u +%s)',
              'echo "[pre_build] PR_ID=${PR_ID:-unknown} SOURCE_COMMIT=${SOURCE_COMMIT:-unknown}"',
              'aws dynamodb put-item --table-name "$EVENTS_TABLE" --item "{\\"pk\\":{\\"S\\":\\"PR#${REPOSITORY_NAME}#${PR_ID}\\"},\\"sk\\":{\\"S\\":\\"$(date -u +%FT%TZ)#testStarted\\"},\\"event\\":{\\"S\\":\\"testStarted\\"}}" || true',
            ],
          },
          build: {
            commands: [
              'echo "[build] Run tests (placeholder)"',
              '# npm test',
            ],
          },
          post_build: {
            commands: [
              'export TEST_END_TS=$(date -u +%s)',
              'export DURATION=$((TEST_END_TS - TEST_START_TS))',
              // CODEBUILD_BUILD_SUCCEEDING is "1" while previous phases passed,
              // "0" once any phase has failed.
              'if [ "${CODEBUILD_BUILD_SUCCEEDING:-0}" = "1" ]; then EVENT="testPassed"; STATUS_LABEL="PASSED"; STATUS_VALUE=1; else EVENT="testFailed"; STATUS_LABEL="FAILED"; STATUS_VALUE=0; fi',
              'aws cloudwatch put-metric-data --namespace "$METRICS_NAMESPACE" --metric-name TestDurationSec --dimensions Repository=$REPOSITORY_NAME --value $DURATION --unit Seconds || true',
              'aws cloudwatch put-metric-data --namespace "$METRICS_NAMESPACE" --metric-name TestPassRate --dimensions Repository=$REPOSITORY_NAME --value $STATUS_VALUE --unit None || true',
              'aws dynamodb put-item --table-name "$EVENTS_TABLE" --item "{\\"pk\\":{\\"S\\":\\"PR#${REPOSITORY_NAME}#${PR_ID}\\"},\\"sk\\":{\\"S\\":\\"$(date -u +%FT%TZ)#${EVENT}\\"},\\"event\\":{\\"S\\":\\"${EVENT}\\"},\\"durationSec\\":{\\"N\\":\\"${DURATION}\\"}}" || true',
              'COMMENT="Automated test: **${STATUS_LABEL}** (duration: ${DURATION}s, build: ${CODEBUILD_BUILD_ID})"',
              'aws codecommit post-comment-for-pull-request --pull-request-id "$PR_ID" --repository-name "$REPOSITORY_NAME" --before-commit-id "$DEST_COMMIT" --after-commit-id "$SOURCE_COMMIT" --content "$COMMENT" || true',
              // On success, satisfy the "todo-api-require-test-pass" approval rule
              // by APPROVing the current revision. On failure, do nothing — the
              // missing approval blocks the merge until the next push re-runs us.
              'if [ "$STATUS_VALUE" = "1" ]; then',
              '  REVISION_ID=$(aws codecommit get-pull-request --pull-request-id "$PR_ID" --query "pullRequest.revisionId" --output text)',
              '  aws codecommit update-pull-request-approval-state --pull-request-id "$PR_ID" --revision-id "$REVISION_ID" --approval-state APPROVE || true',
              'fi',
            ],
          },
        },
      }),
    });

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
        actions: [
          'codecommit:PostCommentForPullRequest',
          'codecommit:GetPullRequest',
          'codecommit:UpdatePullRequestApprovalState',
        ],
        resources: [props.repository.repositoryArn],
      }),
    );

    props.eventsTable.grantWriteData(project);

    return project;
  }

  /**
   * Adds a second approval rule template requiring approval from the test
   * CodeBuild role; the test project's post_build APPROVEs the PR only when
   * tests pass, effectively blocking merges of red builds.
   */
  private attachTestApprovalRuleTemplate(
    repository: codecommit.IRepository,
    testProjectRole: iam.IRole,
  ): void {
    const templateName = 'todo-api-require-test-pass';
    const templateContent = cdk.Stack.of(this).toJsonString({
      Version: '2018-11-08',
      DestinationReferences: ['refs/heads/main'],
      Statements: [
        {
          Type: 'Approvers',
          NumberOfApprovalsNeeded: 1,
          ApprovalPoolMembers: [
            `arn:aws:sts::${this.account}:assumed-role/${testProjectRole.roleName}/*`,
          ],
        },
      ],
    });

    const createTemplate = new cr.AwsCustomResource(this, 'CreateTestApprovalRuleTemplate', {
      onCreate: {
        service: 'CodeCommit',
        action: 'createApprovalRuleTemplate',
        parameters: {
          approvalRuleTemplateName: templateName,
          approvalRuleTemplateContent: templateContent,
          approvalRuleTemplateDescription: 'Require an APPROVE from the automated test CodeBuild role.',
        },
        physicalResourceId: cr.PhysicalResourceId.of(templateName),
      },
      onUpdate: {
        service: 'CodeCommit',
        action: 'updateApprovalRuleTemplateContent',
        parameters: {
          approvalRuleTemplateName: templateName,
          newRuleContent: templateContent,
        },
        physicalResourceId: cr.PhysicalResourceId.of(templateName),
      },
      onDelete: {
        service: 'CodeCommit',
        action: 'deleteApprovalRuleTemplate',
        parameters: { approvalRuleTemplateName: templateName },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    const associate = new cr.AwsCustomResource(this, 'AssociateTestApprovalRuleTemplate', {
      onCreate: {
        service: 'CodeCommit',
        action: 'associateApprovalRuleTemplateWithRepository',
        parameters: {
          approvalRuleTemplateName: templateName,
          repositoryName: repository.repositoryName,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${templateName}-${repository.repositoryName}`),
      },
      onDelete: {
        service: 'CodeCommit',
        action: 'disassociateApprovalRuleTemplateFromRepository',
        parameters: {
          approvalRuleTemplateName: templateName,
          repositoryName: repository.repositoryName,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    associate.node.addDependency(createTemplate);
  }

  private createPrTrigger(
    projects: codebuild.Project[],
    repository: codecommit.IRepository,
  ): void {
    const targetInput = events.RuleTargetInput.fromObject({
      environmentVariablesOverride: [
        { name: 'PR_ID', value: events.EventField.fromPath('$.detail.pullRequestId'), type: 'PLAINTEXT' },
        { name: 'SOURCE_COMMIT', value: events.EventField.fromPath('$.detail.sourceCommit'), type: 'PLAINTEXT' },
        { name: 'DEST_COMMIT', value: events.EventField.fromPath('$.detail.destinationCommit'), type: 'PLAINTEXT' },
        { name: 'SOURCE_REFERENCE', value: events.EventField.fromPath('$.detail.sourceReference'), type: 'PLAINTEXT' },
      ],
      sourceVersion: events.EventField.fromPath('$.detail.sourceCommit'),
    });

    new events.Rule(this, 'PrChangedRule', {
      ruleName: 'todo-api-pr-changed',
      description: 'Trigger AI review and automated tests when a PR is created or its source branch is updated.',
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Pull Request State Change'],
        resources: [repository.repositoryArn],
        detail: {
          event: ['pullRequestCreated', 'pullRequestSourceBranchUpdated'],
        },
      },
      targets: projects.map(
        (project) =>
          new eventTargets.CodeBuildProject(project, { event: targetInput }),
      ),
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
