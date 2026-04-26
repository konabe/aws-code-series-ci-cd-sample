import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export class SourceStack extends cdk.Stack {
  readonly repository: codecommit.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.repository = new codecommit.Repository(this, 'TodoApiRepo', {
      repositoryName: 'todo-api',
      description: 'TODO API source. Reviewed by Kiro CLI + human approval.',
    });

    this.attachApprovalRuleTemplate(this.repository);

    new cdk.CfnOutput(this, 'RepositoryCloneUrlHttp', {
      value: this.repository.repositoryCloneUrlHttp,
    });
  }

  /**
   * Require at least one human approver on every PR.
   * CodeCommit Approval Rule Templates are not natively supported by
   * CloudFormation, so we provision them via SDK calls behind a Custom Resource.
   */
  private attachApprovalRuleTemplate(repository: codecommit.Repository): void {
    const templateName = 'todo-api-require-human-approver';
    const templateContent = JSON.stringify({
      Version: '2018-11-08',
      DestinationReferences: ['refs/heads/main'],
      Statements: [
        {
          Type: 'Approvers',
          NumberOfApprovalsNeeded: 1,
          ApprovalPoolMembers: [
            `arn:aws:sts::${cdk.Stack.of(this).account}:assumed-role/*/*`,
          ],
        },
      ],
    });

    const createTemplate = new cr.AwsCustomResource(this, 'CreateApprovalRuleTemplate', {
      onCreate: {
        service: 'CodeCommit',
        action: 'createApprovalRuleTemplate',
        parameters: {
          approvalRuleTemplateName: templateName,
          approvalRuleTemplateContent: templateContent,
          approvalRuleTemplateDescription: 'Require at least one human approver before merge.',
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

    const associate = new cr.AwsCustomResource(this, 'AssociateApprovalRuleTemplate', {
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
    associate.node.addDependency(repository);
  }
}
