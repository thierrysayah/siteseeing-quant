/* Amplify Params - DO NOT EDIT
	ENV
	FUNCTION_AGENTSTAGEWORKER_NAME
	REGION
	STORAGE_TAKEOFFRUNS_ARN
	STORAGE_TAKEOFFRUNS_NAME
	STORAGE_TAKEOFFRUNS_STREAMARN
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
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION || 'eu-west-3' }),
);
const lambda = new LambdaClient({ region: process.env.REGION || 'eu-west-3' });
const s3 = new S3Client({ region: process.env.REGION || 'eu-west-3' });
const TABLE = process.env.STORAGE_TAKEOFFRUNS_NAME || 'TakeoffRuns';
const WORKER = process.env.FUNCTION_AGENTSTAGEWORKER_NAME;
const PROJECT_BUCKET = process.env.PROJECT_BUCKET || 'estimation-platform-user-data';

// Fire-and-forget async invoke of the stage worker. The worker flips the run
// from 'running' back to 'awaiting_approval' when the stage finishes; the client
// poll picks it up. (Async so a slow stage can't hit API Gateway's 29s limit.)
async function invokeWorker(runId, stageIndex, expectedSeq) {
  if (!WORKER) { console.error('[orchestrator] FUNCTION_AGENTSTAGEWORKER_NAME missing'); return; }
  await lambda.send(new InvokeCommand({
    FunctionName: WORKER,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ runId, stageIndex, expectedSeq })),
  }));
}

// The nine pipeline stages (spec §3). In P0 each is a stub; the real handlers
// arrive in P1–P3. Order is the pipeline order.
const STAGES = [
  { key: 'understand_sheet', label: 'Understand sheet' },
  { key: 'calibrate_scale',  label: 'Calibrate scale' },
  { key: 'detect',           label: 'Detect & clean' },
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
      if (method === 'GET' && action === 'detections') return getDetections(userId, runId);
      if (method === 'PUT' && action === 'detections') return putDetections(userId, runId, body);
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

  const item = {
    runId,
    userId,
    projectId: String(projectId),
    pageId: pageId != null ? String(pageId) : null,
    pricingRequested: !!pricingRequested,
    stageIndex: 0,
    stageKey: STAGES[0].key,
    stageLabel: STAGES[0].label,
    status: 'running',
    seq: 0,
    stageOutput: `Running ${STAGES[0].label}…`,
    evidence: null,
    confidence: null,
    gate: 'running',
    totalStages: STAGES.length,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(runId)',
  }));

  // Run stage 0 asynchronously.
  await invokeWorker(runId, 0, 0);

  return resp(201, publicView(item));
}

async function getRun(userId, runId) {
  const item = await loadOwned(userId, runId);
  if (!item) return resp(404, { error: 'run not found' });
  if (item === 'forbidden') return resp(403, { error: 'not your run' });
  return resp(200, publicView(item));
}

// Return the detections a run produced (from S3), so the client can render them
// on the canvas as a proposed overlay. Ownership-checked via the run row.
async function getDetections(userId, runId) {
  const item = await loadOwned(userId, runId);
  if (!item) return resp(404, { error: 'run not found' });
  if (item === 'forbidden') return resp(403, { error: 'not your run' });
  if (!item.detectionsKey) return resp(404, { error: 'no detections yet' });
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: PROJECT_BUCKET, Key: item.detectionsKey }));
    const text = await obj.Body.transformToString();
    const data = JSON.parse(text);
    return resp(200, { annotations: data.annotations || [], meta: data.meta || null });
  } catch (err) {
    console.error('[getDetections]', err);
    return resp(500, { error: 'could not read detections' });
  }
}

// Save the user's edited detection set (Adjust). Writes a new artifact and
// repoints detectionsKey so downstream stages (quantify, report) use the edits.
async function putDetections(userId, runId, body) {
  const item = await loadOwned(userId, runId);
  if (!item) return resp(404, { error: 'run not found' });
  if (item === 'forbidden') return resp(403, { error: 'not your run' });
  const anns = body && Array.isArray(body.annotations) ? body.annotations : null;
  if (!anns) return resp(400, { error: 'annotations array required' });
  if (anns.length > 20000) return resp(413, { error: 'too many annotations' });

  const key = `agent-runs/${runId}/detections-adjusted.json`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: PROJECT_BUCKET, Key: key,
      Body: JSON.stringify({ annotations: anns, adjustedAt: new Date().toISOString() }),
      ContentType: 'application/json',
    }));
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { runId },
      UpdateExpression: 'SET detectionsKey = :k, updatedAt = :now',
      ExpressionAttributeValues: { ':k': key, ':now': new Date().toISOString() },
    }));
    return resp(200, { ok: true, count: anns.length, detectionsKey: key });
  } catch (err) {
    console.error('[putDetections]', err);
    return resp(500, { error: 'could not save detections' });
  }
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

  // Move to 'running' for the next stage and hand off to the worker.
  const nextIndex = item.stageIndex + 1;
  const newSeq = expectedSeq + 1;
  const updated = await conditionalUpdate(runId, expectedSeq, {
    stageIndex: nextIndex,
    stageKey: STAGES[nextIndex].key,
    stageLabel: STAGES[nextIndex].label,
    status: 'running',
    seq: newSeq,
    stageOutput: `Running ${STAGES[nextIndex].label}…`,
    evidence: null,
    confidence: null,
    gate: 'running',
    updatedAt: now,
  });
  if (!updated) return resp(409, { error: 'run changed — refresh' });
  await invokeWorker(runId, nextIndex, newSeq);
  return resp(200, publicView(updated));
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
    detectionsKey: item.detectionsKey || null,
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
