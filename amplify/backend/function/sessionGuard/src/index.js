/* Amplify Params - DO NOT EDIT
	ENV
	REGION
	STORAGE_USERSESSIONS_ARN
	STORAGE_USERSESSIONS_NAME
	STORAGE_USERSESSIONS_STREAMARN
Amplify Params - DO NOT EDIT */

/**
 * sessionGuard — enforces a single active browser session per Cognito user.
 *
 * Routes (both mounted on quantApi as POST):
 *   /session/claim     — body: { sessionId, deviceLabel? }
 *                        Overwrites this user's row in UserSessions with the
 *                        new sessionId. Called once per device on login.
 *
 *   /session/heartbeat — body: { sessionId }
 *                        Returns { valid: true } if the row's sessionId still
 *                        matches the caller's; { valid: false } otherwise.
 *                        The client polls this every 30s + on tab refocus.
 *
 * The caller is identified by the Cognito Identity ID injected by API Gateway
 * (SigV4 / IAM auth). Unauthenticated callers are rejected at the gateway
 * before reaching this handler — we still defend with a 401 just in case.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.REGION || 'eu-west-3' }));
const TABLE = process.env.STORAGE_USERSESSIONS_NAME;

// CORS headers returned on every response — same pattern as inferProxy.
// API Gateway's auto-generated OPTIONS handler covers preflight, but the
// Lambda proxy integration requires us to set Access-Control-Allow-Origin
// on the actual POST response too.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
};

// Extract the Cognito User Pool `sub` (the canonical user id used everywhere
// else in this app — S3 paths, getUserProfile, etc.) from an IAM-authorized
// API Gateway request. Same pattern as getUserProfile/src/index.js.
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

exports.handler = async (event) => {
  try {
    const userId = getCallerSub(event);
    if (!userId) return resp(401, { error: 'not authenticated' });

    const body = safeParse(event.body);
    const path = event.path || '';

    if (path.endsWith('/session/claim')) {
      const { sessionId, deviceLabel } = body;
      if (!sessionId || typeof sessionId !== 'string') {
        return resp(400, { error: 'sessionId required' });
      }
      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          UserId: userId,
          sessionId,
          deviceLabel: typeof deviceLabel === 'string' ? deviceLabel.slice(0, 200) : '',
          claimedAt: now,
          lastSeenAt: now,
        },
      }));
      return resp(200, { ok: true });
    }

    if (path.endsWith('/session/heartbeat')) {
      const { sessionId } = body;
      if (!sessionId || typeof sessionId !== 'string') {
        return resp(400, { error: 'sessionId required' });
      }
      const { Item } = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { UserId: userId },
      }));
      if (!Item || Item.sessionId !== sessionId) {
        return resp(200, { valid: false, reason: Item ? 'replaced' : 'missing' });
      }
      // Best-effort lastSeenAt refresh — failure here doesn't matter for the
      // single-session guarantee, so we don't await separately.
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { ...Item, lastSeenAt: new Date().toISOString() },
      }));
      return resp(200, { valid: true });
    }

    return resp(404, { error: 'unknown route', path });
  } catch (err) {
    console.error('[sessionGuard]', err);
    return resp(500, { error: String(err?.message || err) });
  }
};

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
