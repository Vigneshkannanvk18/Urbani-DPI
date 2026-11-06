import { Construct } from 'constructs';
import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib';
import {
  AccountRecovery,
  CfnUserPoolGroup,
  Mfa,
  OAuthScope,
  ProviderAttribute,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolIdentityProviderGoogle,
} from 'aws-cdk-lib/aws-cognito';

/** The four RBAC groups (DPI 2 item 2). The IdP group names map to roles via OIDC_GROUP_ROLE_MAP in the app. */
export const COGNITO_GROUPS: { name: string; description: string }[] = [
  { name: 'SuperAdmins', description: 'Maps to SUPER_ADMIN' },
  { name: 'InfraAdmins', description: 'Maps to INFRA_ADMIN' },
  { name: 'QaOperators', description: 'Maps to QA_OPERATOR' },
  { name: 'ReadersAuditors', description: 'Maps to READER_AUDITOR' },
];

export interface CognitoConstructProps {
  /** Hosted-UI domain prefix (globally unique per region), e.g. "urbani-radar". */
  domainPrefix: string;
  /** App callback URLs, e.g. https://radar.example.com/api/auth/sso/callback (must equal OIDC_REDIRECT_URI). */
  callbackUrls: string[];
  logoutUrls: string[];
  /**
   * Optional Google Workspace federation. The secret is a Secrets Manager secret holding JSON
   * {"client_id": "...", "client_secret": "..."}; it is referenced by dynamic reference, never inlined.
   */
  googleSecretArn?: string;
}

/**
 * Cognito user pool for SSO (DPI 2 item 5). AUTHORED, NOT DEPLOYED. Only created when the stack context
 * `enableCognito` is true. Notes:
 *  - Pool MFA (TOTP) is REQUIRED for native Cognito users. Federated Google users do not use pool MFA:
 *    Google Workspace must enforce 2-step verification itself.
 *  - Groups reach the app in the ID token claim `cognito:groups`. For Google-federated users add the user
 *    to a group (console/API or a post-confirmation trigger); Google does not supply groups.
 */
export class CognitoConstruct extends Construct {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoConstructProps) {
    super(scope, id);

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: 'urbani-radar',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    for (const g of COGNITO_GROUPS) {
      new CfnUserPoolGroup(this, `Group${g.name}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: g.name,
        description: g.description,
      });
    }

    const supportedIdentityProviders = [UserPoolClientIdentityProvider.COGNITO];
    let google: UserPoolIdentityProviderGoogle | undefined;
    if (props.googleSecretArn) {
      google = new UserPoolIdentityProviderGoogle(this, 'Google', {
        userPool: this.userPool,
        clientId: SecretValue.secretsManager(props.googleSecretArn, { jsonField: 'client_id' }).unsafeUnwrap(),
        clientSecretValue: SecretValue.secretsManager(props.googleSecretArn, { jsonField: 'client_secret' }),
        scopes: ['openid', 'email', 'profile'],
        attributeMapping: {
          email: ProviderAttribute.GOOGLE_EMAIL,
          fullname: ProviderAttribute.GOOGLE_NAME,
        },
      });
      supportedIdentityProviders.push(UserPoolClientIdentityProvider.GOOGLE);
    }

    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: 'urbani-radar-web',
      generateSecret: true, // authorization code + PKCE with a confidential client; secret goes to Secrets Manager (OIDC_CLIENT_SECRET)
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      supportedIdentityProviders,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1),
      preventUserExistenceErrors: true,
    });
    if (google) this.userPoolClient.node.addDependency(google);

    this.userPool.addDomain('HostedUiDomain', { cognitoDomain: { domainPrefix: props.domainPrefix } });

    const region = Stack.of(this).region;
    new CfnOutput(this, 'OidcIssuer', {
      value: `https://cognito-idp.${region}.amazonaws.com/${this.userPool.userPoolId}`,
      description: 'Set OIDC_ISSUER to this value',
    });
    new CfnOutput(this, 'OidcClientId', { value: this.userPoolClient.userPoolClientId, description: 'Set OIDC_CLIENT_ID' });
    new CfnOutput(this, 'HostedUiBaseUrl', {
      value: `https://${props.domainPrefix}.auth.${region}.amazoncognito.com`,
      description: 'Cognito hosted UI domain',
    });
  }
}
