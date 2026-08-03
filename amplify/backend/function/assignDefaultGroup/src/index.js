

/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    const plan = event.request.userAttributes['custom:plan'] || 'individual';
    const group = plan === 'pro' ? 'Pro' : 'Individual';
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: event.userPoolId,
      Username: event.userName,
      GroupName: group,
    }));
  }
  return event;
};
