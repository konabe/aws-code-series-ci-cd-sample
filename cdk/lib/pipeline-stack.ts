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
    // Claude Sonnet 4.5 has no APAC inference profile yet; Sonnet 4.0 does.
    // Override via `-c aiReview:bedrockModelId=...` once a newer profile lands.
    const bedrockModelId =
      this.node.tryGetContext('aiReview:bedrockModelId') ??
      'apac.anthropic.claude-sonnet-4-20250514-v1:0';

    const project = new codebuild.Project(this, 'AiReviewProject', {
      projectName: 'todo-api-ai-review',
      description: 'Run Claude Code (via Amazon Bedrock) on a PR and post a review comment. Records review metrics.',
      source: codebuild.Source.codeCommit({ repository: props.repository }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        EVENTS_TABLE: { value: props.eventsTable.tableName },
        METRICS_NAMESPACE: { value: METRICS_NAMESPACE },
        REPOSITORY_NAME: { value: props.repository.repositoryName },
        // Tells Claude Code to authenticate via Bedrock instead of an Anthropic API key.
        CLAUDE_CODE_USE_BEDROCK: { value: '1' },
        ANTHROPIC_MODEL: { value: bedrockModelId },
        AWS_REGION: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        env: { shell: 'bash' },
        phases: {
          install: {
            'runtime-versions': { nodejs: '20' },
            commands: [
              'curl -fsSL https://claude.ai/install.sh | bash',
              'export PATH="$HOME/.local/bin:$PATH"',
              'claude --version',
            ],
          },
          pre_build: {
            commands: [
              'export PATH="$HOME/.local/bin:$PATH"',
              'export REVIEW_START_TS=$(date -u +%s)',
              'echo "[pre_build] PR_ID=${PR_ID:-unknown} SOURCE_COMMIT=${SOURCE_COMMIT:-unknown} DEST_COMMIT=${DEST_COMMIT:-unknown}"',
              'aws dynamodb put-item --table-name "$EVENTS_TABLE" --item "{\\"pk\\":{\\"S\\":\\"PR#${REPOSITORY_NAME}#${PR_ID}\\"},\\"sk\\":{\\"S\\":\\"$(date -u +%FT%TZ)#aiReviewStarted\\"},\\"event\\":{\\"S\\":\\"aiReviewStarted\\"}}" || true',
              // CodeBuild only checks out the source commit; we need the destination
              // ref locally to compute the diff Claude will review.
              'git fetch origin "$DEST_COMMIT" || git fetch origin "+refs/heads/main:refs/remotes/origin/main" || true',
            ],
          },
          build: {
            commands: [
              'export PATH="$HOME/.local/bin:$PATH"',
              'git diff "$DEST_COMMIT" "$SOURCE_COMMIT" > /tmp/pr.diff || true',
              'DIFF_BYTES=$(wc -c < /tmp/pr.diff)',
              'echo "[build] diff size: ${DIFF_BYTES} bytes"',
              // Cap the diff fed to Claude at ~200 KB to stay well below the model
              // context window and CodeBuild stdout limits.
              'head -c 200000 /tmp/pr.diff > /tmp/pr.diff.trimmed',
              'PROMPT="あなたはシニアコードレビュアーです。次の git diff を読み、バグ・セキュリティ・保守性・テスト不足の観点から Markdown 箇条書きで簡潔に指摘してください。問題が無ければ「特に指摘なし」と返してください。差分:\\n\\n$(cat /tmp/pr.diff.trimmed)"',
              // `--disallowedTools "*"` strips every tool from Claude's context,
              // so the permission system never triggers — required because
              // `--dangerously-skip-permissions` is rejected when running as
              // root, which CodeBuild containers always do.
              'REVIEW=$(printf "%s" "$PROMPT" | claude -p --bare --disallowedTools "*" --no-session-persistence --max-turns 1 --model "$ANTHROPIC_MODEL" 2>&1 || echo "(Claude Code invocation failed; see CodeBuild logs.)")',
              'printf "### AI Review (Claude Code via Bedrock: %s)\\n\\n%s\\n" "$ANTHROPIC_MODEL" "$REVIEW" > /tmp/review.md',
              'aws codecommit post-comment-for-pull-request --pull-request-id "$PR_ID" --repository-name "$REPOSITORY_NAME" --before-commit-id "$DEST_COMMIT" --after-commit-id "$SOURCE_COMMIT" --content file:///tmp/review.md || true',
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
              // Must be one entry: CodeBuild runs each `commands` element as a
              // separate shell, so a multi-line `if ... fi` would be a parse error.
              'if [ "$STATUS_VALUE" = "1" ]; then REVISION_ID=$(aws codecommit get-pull-request --pull-request-id "$PR_ID" --query "pullRequest.revisionId" --output text); aws codecommit update-pull-request-approval-state --pull-request-id "$PR_ID" --revision-id "$REVISION_ID" --approval-state APPROVE || true; fi',
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
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'codecommit:CreateApprovalRuleTemplate',
            'codecommit:UpdateApprovalRuleTemplateContent',
            'codecommit:DeleteApprovalRuleTemplate',
          ],
          resources: ['*'],
        }),
      ]),
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
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'codecommit:AssociateApprovalRuleTemplateWithRepository',
            'codecommit:DisassociateApprovalRuleTemplateFromRepository',
          ],
          resources: [repository.repositoryArn],
        }),
      ]),
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
