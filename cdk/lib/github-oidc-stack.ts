import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface GithubOidcStackProps extends cdk.StackProps {
  githubOwner: string;
  githubRepo: string;
  githubBranch?: string;
  existingProviderArn?: string;
  roleName?: string;
}

export class GithubOidcStack extends cdk.Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const provider = props.existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GitHubOidcProvider',
          props.existingProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const subject = props.githubBranch
      ? `repo:${props.githubOwner}/${props.githubRepo}:ref:refs/heads/${props.githubBranch}`
      : `repo:${props.githubOwner}/${props.githubRepo}:*`;

    this.deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: props.roleName ?? 'github-actions-cdk-deploy',
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': subject,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Assumed by GitHub Actions to run cdk deploy via OIDC.',
    });

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Set this ARN as the AWS_DEPLOY_ROLE_ARN GitHub secret.',
    });
  }
}
