

/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    // SECURITY (audit C1): never derive the group from `custom:plan`. Cognito's
    // public SignUp API lets a client send arbitrary attributes, so trusting it
    // handed out free Pro. Every new account starts on the trial; paid tiers are
    // granted only by a payment-verified path.
    const group = 'Trial';
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: event.userPoolId,
      Username: event.userName,
      GroupName: group,
    }));
  }
  return event;
};
