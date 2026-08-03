/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

const { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

const USER_POOL_ID = process.env.USER_POOL_ID || "eu-west-3_jpxbGzhTX";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

function ok(data)  { return { statusCode: 200, headers: CORS, body: JSON.stringify(data) }; }
function fail(msg) { return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: msg }) }; }

// Extract Cognito User Pool sub from IAM-authorized request
function getCallerSub(event) {
  const claimsSub = event.requestContext?.authorizer?.claims?.sub;
  if (claimsSub) return claimsSub;
  const provider = event.requestContext?.identity?.cognitoAuthenticationProvider;
  if (provider) {
    const match = provider.match(/CognitoSignIn:([a-f0-9-]+)$/);
    if (match) return match[1];
  }
  return null;
}

// Look up a Cognito user by sub → returns { username, orgId }
async function getUserBySub(sub) {
  const resp = await cognito.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Filter: `sub = "${sub}"`,
    Limit: 1,
  }));
  const user = resp.Users?.[0];
  if (!user) return null;
  const orgId = user.Attributes?.find(a => a.Name === "custom:orgId")?.Value || null;
  return { username: user.Username, orgId };
}

// Look up a Cognito user by email → returns { sub, username, orgId, name }
async function getUserByEmail(email) {
  const resp = await cognito.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Filter: `email = "${email}"`,
    Limit: 1,
  }));
  const user = resp.Users?.[0];
  if (!user) return null;
  const attrs = user.Attributes || [];
  return {
    username: user.Username,
    sub:    attrs.find(a => a.Name === "sub")?.Value || null,
    orgId:  attrs.find(a => a.Name === "custom:orgId")?.Value || null,
    name:   attrs.find(a => a.Name === "name")?.Value || email,
  };
}

// Check if a Cognito user (by username) is in a given group
async function isInGroup(username, groupName) {
  const resp = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
  return (resp.Groups || []).some(g => g.GroupName === groupName);
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const callerSub = getCallerSub(event);
    console.log("[grantProjectAccess]", method, "caller:", callerSub);

    // ── GET — list managers for a project ────────────────────────────────────
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
      const { projectId, managerEmail, ownerSub } = body;

      if (!projectId || !managerEmail || !ownerSub) {
        return fail("Missing projectId, managerEmail, or ownerSub");
      }

      // 1. Caller must be the project owner
      if (callerSub !== ownerSub) {
        return fail("Only the project owner can grant access");
      }

      // 2. Look up caller's org (from Cognito — never trust client-provided orgId)
      const caller = await getUserBySub(callerSub);
      if (!caller) return fail("Could not verify caller identity");
      if (!caller.orgId) return fail("You must belong to an organisation to share projects");

      // 3. Look up manager by email
      const manager = await getUserByEmail(managerEmail);
      if (!manager) return fail(`No user found with email: ${managerEmail}`);
      if (!manager.sub) return fail("Could not resolve manager's user ID");

      // 4. Manager must be in the same organisation
      if (!manager.orgId || manager.orgId !== caller.orgId) {
        return fail("This user does not belong to your organisation");
      }

      // 5. Manager must be in the EnterpriseManager group
      const managerIsValid = await isInGroup(manager.username, "EnterpriseManager");
      if (!managerIsValid) {
        return fail("This user does not have the Enterprise Manager role");
      }

      // All checks passed — write the grant
      await dynamo.send(new PutCommand({
        TableName: "ProjectGrants",
        Item: {
          projectId,
          managerId: manager.sub,
          managerEmail,
          managerName: manager.name,
          ownerSub,
          orgId: caller.orgId,
          grantedAt: new Date().toISOString(),
        },
      }));

      console.log("[grantProjectAccess] granted", managerEmail, "->", projectId, "org:", caller.orgId);
      return ok({ success: true, managerId: manager.sub, managerName: manager.name });
    }

    return fail("Method not allowed: " + method);
  } catch (err) {
    console.error("[grantProjectAccess] Unhandled error:", err);
    return fail("Internal error: " + err.message);
  }
};
