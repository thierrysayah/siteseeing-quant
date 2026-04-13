/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const callerUserId = event.requestContext.authorizer.claims.sub;
  const body = JSON.parse(event.body);
  const { targetUserId, orgId, role } = body; // role = "qs" or "manager"

  if (!targetUserId || !orgId || !["qs", "manager"].includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing targetUserId, orgId, or valid role" }) };
  }

  // Verify caller is a manager or admin in this org
  const { Item: callerMembership } = await client.send(new GetCommand({
    TableName: "OrgMemberships",
    Key: { orgId, userId: callerUserId },
  }));

  if (!callerMembership || callerMembership.role !== "manager") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only managers can grant access" }) };
  }

  // Add or update membership
  await client.send(new PutCommand({
    TableName: "OrgMemberships",
    Item: {
      orgId,
      userId: targetUserId,
      role,
      grantedBy: callerUserId,
      grantedAt: new Date().toISOString(),
    },
  }));

  // Also update the user's profile with their orgId
  await client.send(new PutCommand({
    TableName: "UserProfiles",
    Item: {
      userId: targetUserId,
      orgId,
      tier: "enterprise",
      updatedAt: new Date().toISOString(),
    },
  }));

  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ success: true }),
  };
};
