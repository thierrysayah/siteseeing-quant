/* Amplify Params - DO NOT EDIT
	ENV
	REGION
	STORAGE_TAKEOFFRUNS_NAME
	STORAGE_TAKEOFFRUNS_ARN
Amplify Params - DO NOT EDIT */

/**
 * agentOrchestrator — server-authoritative state machine for the Agentic
 * Takeoff pipeline (see AGENTIC-TAKEOFF-SPEC.md).
 *
 * P0 = walking skeleton: real run-state + checkpoint approve/reject loop, but
 * every stage is a STUB (no models, no detection). Proves the machine before
 * any AI is wired in.
 *
 * Routes (all under the /agent/{proxy+} path on quantApi, private/IAM auth):
 *   POST /agent/runs                  { projectId, pageId, pricingRequested? }
 *   GET  /agent/runs/{id}
 *   POST /agent/runs/{id}/approve     { seq }
 *   POST /agent/runs/{id}/reject      { seq }
 *   POST /agent/runs/{id}/cancel
 *
 * Concurrency: every advance is a DynamoDB conditional write on the expected
 * { status, seq }. A double-clicked Approve or duplicate request is a no-op, so
 * no stage runs (or, later, bills) twice.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION || 'eu-west-3' }),
);
const TABLE = process.env.STORAGE_TAKEOFFRUNS_NAME || 'TakeoffRuns';

// The nine pipeline stages (spec §3). In P0 each is a stub; the real handlers
// arrive in P1–P3. Order is the pipeline order.
const STAGES = [
  { key: 'understand_sheet', label: 'Understand sheet' },
  { key: 'calibrate_scale',  label: 'Calibrate scale' },
  { key: 'detect',           label: 'Detect' },
  { key: 'cleanup',          label: 'Clean up' },
  { key: 'classify_tag',     label: 'Classify & tag' },
  { key: 'quantify',         label: 'Quantify' },
  { key: 'qa',               label: 'QA pass' },
  { key: 'price',            label: 'Price' },
  { key: 'report',           label: 'Report' },
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST',
};

exports.handler = async (event) => {
  try {
    const userId = getCallerSub(event);
    if (!userId) return resp(401, { error: 'not authenticated' });

    const method = event.httpMethod;
    const parts = subPathParts(event); // e.g. ['runs'] or ['runs', '<id>', 'approve']
    const body = safeParse(event.body);

    // POST /agent/runs
    if (method === 'POST' && parts.length === 1 && parts[0] === 'runs') {
      return createRun(userId, body);
    }

    // Everything else is /agent/runs/{id}[/action]
    if (parts[0] === 'runs' && parts[1]) {
      const runId = parts[1];
      const action = parts[2] || null;

      if (method === 'GET' && !action) return getRun(userId, runId);
      if (method === 'POST' && action === 'approve') return advanceRun(userId, runId, body, 'approve');
      if (method === 'POST' && action === 'reject')  return advanceRun(userId, runId, body, 'reject');
      if (method === 'POST' && action === 'cancel')  return advanceRun(userId, runId, body, 'cancel');
    }

    return resp(404, { error: 'unknown route', path: event.path });
  } catch (err) {
    console.error('[agentOrchestrator]', err);
    return resp(500, { error: String(err?.message || err) });
  }
};

// ── handlers ─────────────────────────────────────────────────────────────────

async function createRun(userId, body) {
  const { projectId, pageId, pricingRequested } = body || {};
  if (!projectId) return resp(400, { error: 'projectId required' });

  const now = new Date().toISOString();
  const runId = randomUUID();
  const stage = runStubStage(0);

  const item = {
    runId,
    userId,
    projectId: String(projectId),
    pageId: pageId != null ? String(pageId) : null,
    pricingRequested: !!pricingRequested,
    stageIndex: 0,
    stageKey: STAGES[0].key,
    stageLabel: STAGES[0].label,
    status: 'awaiting_approval',
    seq: 0,
    stageOutput: stage.output,
    evidence: stage.evidence,
    confidence: stage.confidence,
    gate: stage.gate,
    totalStages: STAGES.length,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(runId)',
  }));

  return resp(201, publicView(item));
}

async function getRun(userId, runId) {
  const item = await loadOwned(userId, runId);
  if (!item) return resp(404, { error: 'run not found' });
  if (item === 'forbidden') return resp(403, { error: 'not your run' });
  return resp(200, publicView(item));
}

/**
 * Approve → run the next stub stage (or finish). Reject/Cancel → terminate.
 * All variants use an optimistic-concurrency guard on { status, seq } so a
 * duplicate request can't double-advance.
 */
async function advanceRun(userId, runId, body, kind) {
  const item = await loadOwned(userId, runId);
  if (!item) return resp(404, { error: 'run not found' });
  if (item === 'forbidden') return resp(403, { error: 'not your run' });

  if (item.status !== 'awaiting_approval') {
    return resp(409, { error: `run is '${item.status}', not awaiting approval` });
  }

  // If the client sent the seq it last saw, enforce it matches (guards against
  // acting on a stale view). If omitted, we still guard on current status+seq.
  const expectedSeq = item.seq;
  if (body && body.seq != null && Number(body.seq) !== expectedSeq) {
    return resp(409, { error: 'stale seq — refresh the run' });
  }

  const now = new Date().toISOString();

  // Reject / Cancel: terminate the run.
  if (kind === 'reject' || kind === 'cancel') {
    const newStatus = kind === 'reject' ? 'rejected' : 'cancelled';
    const updated = await conditionalUpdate(runId, expectedSeq, {
      status: newStatus,
      seq: expectedSeq + 1,
      updatedAt: now,
    });
    if (!updated) return resp(409, { error: 'run changed — refresh' });
    return resp(200, publicView(updated));
  }

  // Approve: advance.
  const isLast = item.stageIndex >= STAGES.length - 1;
  if (isLast) {
    const updated = await conditionalUpdate(runId, expectedSeq, {
      status: 'done',
      seq: expectedSeq + 1,
      updatedAt: now,
    });
    if (!updated) return resp(409, { error: 'run changed — refresh' });
    return resp(200, publicView(updated));
  }

  const nextIndex = item.stageIndex + 1;
  const stage = runStubStage(nextIndex);
  const updated = await conditionalUpdate(runId, expectedSeq, {
    stageIndex: nextIndex,
    stageKey: STAGES[nextIndex].key,
    stageLabel: STAGES[nextIndex].label,
    status: 'awaiting_approval',
    seq: expectedSeq + 1,
    stageOutput: stage.output,
    evidence: stage.evidence,
    confidence: stage.confidence,
    gate: stage.gate,
    updatedAt: now,
  });
  if (!updated) return resp(409, { error: 'run changed — refresh' });
  return resp(200, publicView(updated));
}

// ── stage stub ───────────────────────────────────────────────────────────────

// P0: every stage returns a placeholder. Real stage handlers replace this in
// P1+ (deterministic tools) and P2+ (Bedrock vision/text).
function runStubStage(index) {
  const s = STAGES[index];
  return {
    output: `Stub output for "${s.label}" (stage ${index + 1}/${STAGES.length}).`,
    evidence: 'No evidence — P0 walking skeleton, no models run.',
    confidence: 1,
    gate: 'approve',
  };
}

// ── data helpers ─────────────────────────────────────────────────────────────

// Returns the item, or null (not found), or the string 'forbidden'.
async function loadOwned(userId, runId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { runId } }));
  if (!Item) return null;
  if (Item.userId !== userId) return 'forbidden';
  return Item;
}

// Conditional UPDATE guarded on the expected seq, so concurrent/duplicate
// requests can't both succeed. Returns the updated item or null if the guard
// failed.
async function conditionalUpdate(runId, expectedSeq, fields) {
  const names = {};
  const values = { ':expectedSeq': expectedSeq };
  const sets = [];
  for (const [k, v] of Object.entries(fields)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  names['#seqGuard'] = 'seq';
  try {
    const { Attributes } = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { runId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#seqGuard = :expectedSeq',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return Attributes;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

// Extract the Cognito User Pool `sub` from an IAM-authorized request. Same
// pattern as sessionGuard / getUserProfile.
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

// Path after '/agent/', split into segments. Robust to the API Gateway stage
// prefix (event.path may or may not include it).
function subPathParts(event) {
  const raw = event.path || '';
  const after = raw.split('/agent/')[1];
  if (!after) return [];
  return after.split('/').filter(Boolean);
}

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// What the client sees — the whole item is already safe, but go through an
// explicit projection so we never accidentally leak an internal field later.
function publicView(item) {
  return {
    runId: item.runId,
    projectId: item.projectId,
    pageId: item.pageId,
    pricingRequested: item.pricingRequested,
    stageIndex: item.stageIndex,
    stageKey: item.stageKey,
    stageLabel: item.stageLabel,
    totalStages: item.totalStages,
    status: item.status,
    seq: item.seq,
    output: item.stageOutput,
    evidence: item.evidence,
    confidence: item.confidence,
    gate: item.gate,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
