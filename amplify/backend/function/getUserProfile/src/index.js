/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const userId = event.requestContext.authorizer.claims.sub;
  const groups = (event.requestContext.authorizer.claims["cognito:groups"] || "").split(",");
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

  // Fetch user profile from DynamoDB
  const { Item: profile } = await client.send(new GetCommand({
    TableName: "UserProfiles",
    Key: { userId },
  }));

  let orgRole = null;
  let orgId = profile?.orgId || null;
  let projectGrants = []; // only for managers

  if (orgId) {
    const { Item: membership } = await client.send(new GetCommand({
      TableName: "OrgMemberships",
      Key: { orgId, userId },
    }));
    orgRole = membership?.role || null;

    // Managers: fetch the list of projects they've been granted access to
    if (orgRole === "manager") {
      const { Items } = await client.send(new QueryCommand({
        TableName: "ProjectGrants",
        IndexName: "managerId-index",
        KeyConditionExpression: "managerId = :mid",
        ExpressionAttributeValues: { ":mid": userId },
      }));
      projectGrants = (Items || []).map(g => ({
        projectId: g.projectId,
        ownerSub: g.ownerSub,
        orgId: g.orgId,
        grantedAt: g.grantedAt,
      }));
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      tier: profile?.tier || "individual",
      role: orgRole,
      orgId,
      projectCount: profile?.projectCount || 0,
      projectGrants, // [] for non-managers
    }),
  };
};
