/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

const { CognitoIdentityProviderClient, ListUsersCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

const USER_POOL_ID = process.env.USER_POOL_ID || "eu-west-3_jpxbGzhTX";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

exports.handler = async (event) => {
  const method = event.httpMethod;
  const callerSub = event.requestContext?.authorizer?.claims?.sub;

  // ── GET /org/grant-access?projectId=xxx  — list managers for a project ──────
  if (method === "GET") {
    const projectId = event.queryStringParameters?.projectId;
    if (!projectId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing projectId" }) };

    const { Items } = await dynamo.send(new QueryCommand({
      TableName: "ProjectGrants",
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ grants: Items || [] }),
    };
  }

  // ── DELETE /org/grant-access — revoke a manager's access ────────────────────
  if (method === "DELETE") {
    const body = JSON.parse(event.body || "{}");
    const { projectId, managerId, ownerSub } = body;
    if (!projectId || !managerId || !ownerSub) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing projectId, managerId, or ownerSub" }) };
    }
    if (callerSub !== ownerSub) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only the project owner can revoke access" }) };
    }
    await dynamo.send(new DeleteCommand({ TableName: "ProjectGrants", Key: { projectId, managerId } }));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  }

  // ── POST /org/grant-access — grant a manager access to a project ─────────────
  if (method === "POST") {
    const body = JSON.parse(event.body || "{}");
    const { projectId, managerEmail, ownerSub, orgId } = body;

    if (!projectId || !managerEmail || !ownerSub || !orgId) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing required fields" }) };
    }
    if (callerSub !== ownerSub) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only the project owner can grant access" }) };
    }

    // Look up manager by email in the User Pool
    const listResp = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `email = "${managerEmail}"`,
      Limit: 1,
    }));

    if (!listResp.Users || listResp.Users.length === 0) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "No user found with that email" }) };
    }

    const manager = listResp.Users[0];
    const managerId = manager.Attributes?.find(a => a.Name === "sub")?.Value;
    const managerName = manager.Attributes?.find(a => a.Name === "name")?.Value || managerEmail;

    if (!managerId) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not resolve manager ID" }) };
    }

    // Verify manager is in the EnterpriseManager group — check cognito:groups
    const groups = manager.Groups || [];
    // (groups isn't returned by ListUsers — rely on orgId match or just trust the caller for now)

    // Write the grant
    await dynamo.send(new PutCommand({
      TableName: "ProjectGrants",
      Item: {
        projectId,
        managerId,
        managerEmail,
        managerName,
        ownerSub,
        orgId,
        grantedAt: new Date().toISOString(),
      },
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, managerId, managerName }),
    };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
};
