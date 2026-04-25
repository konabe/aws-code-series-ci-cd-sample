import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import { Construct } from 'constructs';

export class SourceStack extends cdk.Stack {
  readonly repository: codecommit.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.repository = new codecommit.Repository(this, 'TodoApiRepo', {
      repositoryName: 'todo-api',
      description: 'TODO API source. Reviewed by Kiro CLI + human approval.',
    });

    new cdk.CfnOutput(this, 'RepositoryCloneUrlHttp', {
      value: this.repository.repositoryCloneUrlHttp,
    });
  }
}
