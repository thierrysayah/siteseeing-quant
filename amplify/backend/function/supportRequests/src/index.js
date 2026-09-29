/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

// ── supportRequests — MFA lockout requests (audit H5) ────────────────────────
//
// Why this exists: Cognito has no TOTP backup codes and no self-service reset.
// If a user loses their authenticator, the ONLY way back in is an operator
// running admin-set-user-mfa-preference. Making MFA mandatory without a way to
// ask for that turns one lost phone into a locked-out paying customer.
//
// The hard constraint: a locked-out user CANNOT sign in, so intake must work
// with no credentials at all. This is the only unauthenticated route in the API,
// which drives most of the design below:
//
//  * The response is ALWAYS the same, whether or not the email has an account.
//    Anything else turns this into an account-enumeration oracle — the H2
//    lesson, in a place where it would be easy to forget.
//  * Nothing here can change an account. It records a request; a human acts on
//    it deliberately, out of band. An unauthenticated endpoint that could touch
//    MFA state would be a far worse hole than the one it closes.
//  * Per-email/day cap plus an API Gateway route throttle, so it cannot be used
//    to flood the table or bill us.
//  * The submitted email is NOT verified and must never be treated as proof of
//    identity. Operators verify the person by other means before resetting.
//
// Reading is admin-only and enforced HERE, from Cognito group membership —
// never from anything the client sends.

const {
  CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, UpdateCommand, ScanCommand, GetCommand,
} = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

const REGION = process.env.REGION || process.env.AWS_REGION || 'eu-west-3';
const USER_POOL_ID = process.env.USER_POOL_ID || 'eu-west-3_jpxbGzhTX';
const TABLE = process.env.SUPPORT_TABLE || 'TakeoffRuns-dev';
const ADMIN_GROUP = process.env.ADMIN_GROUP || 'Admin';
const MAX_PER_EMAIL_PER_DAY = Number(process.env.MAX_PER_EMAIL_PER_DAY || 3);
const MAX_MESSAGE_LEN = 2000;
// Requests are support correspondence, not records to keep forever.
const TTL_DAYS = Number(process.env.SUPPORT_TTL_DAYS || 90);

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
};
const resp = (statusCode, obj) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});

// The single response every intake attempt gets, success or not. Do not make
// this conditional on anything about the account.
const INTAKE_OK = {
  ok: true,
  message: "If that address has an account, we'll be in touch by email to verify "
    + 'your identity and reset your two-factor authentication.',
};

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
// Emails are stored lowercased, and the rate-limit key is a hash so the counter
// row itself is not a list of addresses that have asked.
const emailHash = (e) => crypto.createHash('sha256').update(e.toLowerCase()).digest('hex').slice(0, 32);

function isValidEmail(v) {
  return typeof v === 'string' && v.length <= 254
    && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v);
}

function getCallerSub(event) {
  const claimsSub = event.requestContext?.authorizer?.claims?.sub;
  if (claimsSub) return claimsSub;
  const provider = event.requestContext?.identity?.cognitoAuthenticationProvider;
  const m = provider && provider.match(/CognitoSignIn:([a-f0-9-]+)$/);
  return m ? m[1] : null;
}

// Admin status comes from Cognito groups, resolved server-side. A client claim
// of being an admin is worth nothing.
const adminCache = new Map();
async function isAdmin(sub) {
  const hit = adminCache.get(sub);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const listed = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID, Filter: `sub = "${sub}"`, Limit: 1,
    }));
    const user = listed.Users && listed.Users[0];
    if (!user) return false;
    const g = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID, Username: user.Username,
    }));
    const value = (g.Groups || []).some((x) => x.GroupName === ADMIN_GROUP);
    adminCache.set(sub, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
    return value;
  } catch (err) {
    // Fail CLOSED: an outage must not open the admin view.
    console.error('[supportRequests] admin check failed — denying:', err);
    return false;
  }
}

// Atomic per-email/day counter, same conditional-ADD pattern as the /infer quota.
async function withinRateLimit(email) {
  const key = `supportrate#${emailHash(email)}#${dayKey()}`;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { runId: key },
      UpdateExpression: 'SET kind = :k, #ttl = :ttl ADD attempts :one',
      ConditionExpression: 'attribute_not_exists(attempts) OR attempts < :max',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1, ':max': MAX_PER_EMAIL_PER_DAY, ':k': 'supportRate',
        ':ttl': Math.floor(Date.now() / 1000) + 2 * 86400,
      },
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    // Fail OPEN on an infrastructure error — a genuinely locked-out user asking
    // for help matters more than a perfect cap, and the route is throttled too.
    console.error('[supportRequests] rate-limit check failed — allowing:', err);
    return true;
  }
}

exports.handler = async (event) => {
  try {
    const method = (event.httpMethod || '').toUpperCase();
    if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    const path = event.path || '';
    const isIntake = path.includes('/support/mfa-reset');

    // ── PUBLIC: intake ───────────────────────────────────────────────────────
    if (isIntake) {
      if (method !== 'POST') return resp(405, { error: 'method not allowed' });
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch { /* treated as empty */ }

      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const message = typeof body.message === 'string' ? body.message.slice(0, MAX_MESSAGE_LEN) : '';

      // Even a malformed address gets the standard reply: telling the caller
      // their input was rejected still leaks something about processing.
      if (!isValidEmail(email)) return resp(200, INTAKE_OK);
      if (!(await withinRateLimit(email))) return resp(200, INTAKE_OK);

      const id = crypto.randomUUID();
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          runId: `support#${id}`,
          kind: 'supportRequest',
          type: 'mfa_reset',
          status: 'open',
          email,                       // UNVERIFIED — not proof of identity
          message,
          createdAt: new Date().toISOString(),
          sourceIp: event.requestContext?.identity?.sourceIp || null,
          userAgent: (event.headers?.['User-Agent'] || '').slice(0, 300),
          ttl: Math.floor(Date.now() / 1000) + TTL_DAYS * 86400,
        },
      }));
      // Log the id, not the address — CloudWatch is a wider audience than DDB.
      console.log('[supportRequests] mfa_reset request recorded', id);
      return resp(200, INTAKE_OK);
    }

    // ── ADMIN: list / resolve ────────────────────────────────────────────────
    const sub = getCallerSub(event);
    if (!sub || !(await isAdmin(sub))) return resp(403, { error: 'forbidden' });

    if (method === 'GET') {
      // Volume is tiny (one row per lockout), so a filtered Scan is right; a GSI
      // would be extra infrastructure for a table that should stay near-empty.
      const out = [];
      let start;
      do {
        const page = await ddb.send(new ScanCommand({
          TableName: TABLE,
          FilterExpression: 'kind = :k',
          ExpressionAttributeValues: { ':k': 'supportRequest' },
          ExclusiveStartKey: start,
        }));
        out.push(...(page.Items || []));
        start = page.LastEvaluatedKey;
      } while (start);
      out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return resp(200, {
        requests: out.map((r) => ({
          id: r.runId.replace(/^support#/, ''),
          type: r.type, status: r.status, email: r.email, message: r.message,
          createdAt: r.createdAt, resolvedAt: r.resolvedAt || null,
          sourceIp: r.sourceIp || null,
        })),
      });
    }

    if (method === 'POST') {
      const id = (path.split('/support/requests/')[1] || '').split('/')[0];
      if (!/^[0-9a-f-]{36}$/.test(id)) return resp(400, { error: 'bad id' });
      const body = JSON.parse(event.body || '{}');
      const status = body.status === 'open' ? 'open' : 'resolved';
      const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { runId: `support#${id}` } }));
      if (!Item || Item.kind !== 'supportRequest') return resp(404, { error: 'not found' });
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { runId: `support#${id}` },
        UpdateExpression: 'SET #s = :s, resolvedAt = :t, resolvedBy = :by',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': status, ':t': status === 'resolved' ? new Date().toISOString() : null, ':by': sub,
        },
      }));
      return resp(200, { ok: true, id, status });
    }

    return resp(405, { error: 'method not allowed' });
  } catch (err) {
    console.error('[supportRequests]', err);
    return resp(500, { error: 'server error' });
  }
};
