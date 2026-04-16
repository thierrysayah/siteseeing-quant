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

function ok(data)    { return { statusCode: 200, headers: CORS, body: JSON.stringify(data) }; }
function fail(msg)   { return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: msg }) }; }

// Extract Cognito User Pool sub from IAM-authorized request
function getCallerSub(event) {
  // Try Cognito User Pool authorizer first
  const claimsSub = event.requestContext?.authorizer?.claims?.sub;
  if (claimsSub) return claimsSub;
  // IAM auth: parse from cognitoAuthenticationProvider
  // Format: "...CognitoSignIn:<user-pool-sub>"
  const provider = event.requestContext?.identity?.cognitoAuthenticationProvider;
  if (provider) {
    const match = provider.match(/CognitoSignIn:([a-f0-9-]+)$/);
    if (match) return match[1];
  }
  return null;
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const callerSub = getCallerSub(event);
    console.log("[grantProjectAccess]", method, "caller:", callerSub);

    // ── GET — list managers for a project ─────────────────────────────────────
    if (method === "GET") {
      const projectId = (event.queryStringParameters || {}).projectId;
      if (!projectId) return fail("Missing projectId query param");

      const { Items } = await dynamo.send(new QueryCommand({
        TableName: "ProjectGrants",
        KeyConditionExpression: "projectId = :pid",
        ExpressionAttributeValues: { ":pid": projectId },
      }));
      return ok({ grants: Items || [] });
    }

    // ── DELETE — revoke access ────────────────────────────────────────────────
    if (method === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      const { projectId, managerId, ownerSub } = body;
      if (!projectId || !managerId || !ownerSub) return fail("Missing projectId, managerId, or ownerSub");
      if (callerSub !== ownerSub) return fail("Only the project owner can revoke access");
      await dynamo.send(new DeleteCommand({ TableName: "ProjectGrants", Key: { projectId, managerId } }));
      return ok({ success: true });
    }

    // ── POST — grant access ───────────────────────────────────────────────────
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      console.log("[grantProjectAccess] body:", JSON.stringify(body));
      const { projectId, managerEmail, ownerSub, orgId } = body;

      if (!projectId || !managerEmail || !ownerSub) {
        return fail("Missing projectId, managerEmail, or ownerSub");
      }
      if (callerSub !== ownerSub) {
        return fail("Only the project owner can grant access (caller mismatch)");
      }

      // Look up manager by email in the User Pool
      const listResp = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Filter: `email = "${managerEmail}"`,
        Limit: 1,
      }));

      if (!listResp.Users || listResp.Users.length === 0) {
        return fail(`No user found with email: ${managerEmail}`);
      }

      const manager = listResp.Users[0];
      const managerId = manager.Attributes?.find(a => a.Name === "sub")?.Value;
      const managerName = manager.Attributes?.find(a => a.Name === "name")?.Value || managerEmail;

      if (!managerId) return fail("Could not resolve manager's user ID");

      // Write the grant
      await dynamo.send(new PutCommand({
        TableName: "ProjectGrants",
        Item: {
          projectId,
          managerId,
          managerEmail,
          managerName,
          ownerSub,
          orgId: orgId || "none",
          grantedAt: new Date().toISOString(),
        },
      }));

      console.log("[grantProjectAccess] granted", managerEmail, "->", projectId);
      return ok({ success: true, managerId, managerName });
    }

    return fail("Method not allowed: " + method);
  } catch (err) {
    console.error("[grantProjectAccess] Unhandled error:", err);
    return fail("Internal error: " + err.message);
  }
};
