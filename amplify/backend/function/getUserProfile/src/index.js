/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  // Cognito sub comes from the JWT (API Gateway authorizer injects it)
  const userId = event.requestContext.authorizer.claims.sub;

  // Fetch user profile from DynamoDB
  const { Item: profile } = await client.send(new GetCommand({
    TableName: "UserProfiles",
    Key: { userId },
  }));

  if (!profile) {
    return { statusCode: 200, body: JSON.stringify({ tier: "individual", role: null, orgId: null }) };
  }

  // If user belongs to an org, fetch their role
  let orgRole = null;
  let orgMembers = [];
  if (profile.orgId) {
    const { Item: membership } = await client.send(new GetCommand({
      TableName: "OrgMemberships",
      Key: { orgId: profile.orgId, userId },
    }));
    orgRole = membership?.role || null;

    // If manager, also return the list of QS users they oversee
    if (orgRole === "manager") {
      const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
      const { Items } = await client.send(new QueryCommand({
        TableName: "OrgMemberships",
        KeyConditionExpression: "orgId = :org",
        FilterExpression: "#r = :qs",
        ExpressionAttributeNames: { "#r": "role" },
        ExpressionAttributeValues: { ":org": profile.orgId, ":qs": "qs" },
      }));
      orgMembers = (Items || []).map(m => ({ userId: m.userId, name: m.displayName }));
    }
  }

  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      tier: profile.tier,
      role: orgRole,
      orgId: profile.orgId || null,
      projectCount: profile.projectCount || 0,
      orgMembers, // only populated for managers
    }),
  };
};
