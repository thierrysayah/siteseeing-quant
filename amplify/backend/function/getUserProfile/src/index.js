/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

const { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

const USER_POOL_ID = process.env.USER_POOL_ID || "eu-west-3_jpxbGzhTX";

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

// Map Cognito groups to tier/role
function deriveTierAndRole(groups) {
  if (groups.includes("EnterpriseManager")) return { tier: "enterprise", role: "manager" };
  if (groups.includes("EnterpriseQS"))      return { tier: "enterprise", role: "qs" };
  if (groups.includes("Pro"))               return { tier: "pro", role: null };
  return { tier: "individual", role: null };
}

exports.handler = async (event) => {
  const userId = getCallerSub(event);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

  console.log("[getUserProfile] userId:", userId);

  if (!userId) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ tier: "individual", role: null, orgId: null, projectCount: 0, projectGrants: [] }),
    };
  }

  // ── Look up user by sub, then get attributes + groups ───────────────────────
  let orgId = null;
  let groups = [];
  let cognitoUsername = null;

  try {
    // Step 1: Find user by sub (ListUsers accepts sub filter)
    const listResp = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${userId}"`,
      Limit: 1,
    }));

    if (listResp.Users && listResp.Users.length > 0) {
      const user = listResp.Users[0];
      cognitoUsername = user.Username;
      orgId = user.Attributes?.find(a => a.Name === "custom:orgId")?.Value || null;

      console.log("[getUserProfile] found user:", cognitoUsername, "orgId:", orgId);

      // Step 2: Get groups using the actual Cognito username
      const groupResp = await cognito.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: cognitoUsername,
      }));
      groups = (groupResp.Groups || []).map(g => g.GroupName);
    } else {
      console.warn("[getUserProfile] No user found for sub:", userId);
    }
  } catch (err) {
    console.error("[getUserProfile] Cognito lookup failed:", err);
  }

  const { tier, role: orgRole } = deriveTierAndRole(groups);

  console.log("[getUserProfile] orgId:", orgId, "tier:", tier, "role:", orgRole, "groups:", groups);

  // ── For managers: fetch list of projects they've been granted access to ──────
  let projectGrants = [];

  if (orgRole === "manager") {
    try {
      const { Items } = await dynamo.send(new QueryCommand({
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
      console.log("[getUserProfile] projectGrants:", JSON.stringify(projectGrants));
    } catch (err) {
      console.error("[getUserProfile] ProjectGrants query failed:", err);
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      tier,
      role: orgRole,
      orgId,
      projectCount: 0,
      projectGrants,
    }),
  };
};
