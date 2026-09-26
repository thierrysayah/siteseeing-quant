// ── Per-user inference quota (security audit C2) ─────────────────────────────
//
// The size guard and `imgsz` clamp in index.js bound what ONE call can cost.
// They do nothing about volume: without this, a signed-in user (or a stolen set
// of credentials) can loop /infer indefinitely and every call is real GPU spend
// on our Ultralytics account.
//
// The unit users care about is a DETECTION RUN, but the proxy only ever sees a
// single tile — one A3 run is ~18 calls (3 models x 6 tiles), an A0 run can be
// ~105. So the client tags every call of a run with the same `runId` and we
// meter runs, with two backstops that stop a run id being used as an unbounded
// bucket (the client supplies the id, so it cannot be trusted on its own):
//
//   1. RUN_LIMIT      — distinct run ids per user per UTC day.   ← headline
//   2. PER_RUN_CALLS  — calls chargeable to any one run id.      ← anti-abuse
//   3. CALL_CEILING   — total calls per user per UTC day.        ← anti-abuse
//
// Design notes:
//  * One row per user per UTC day, keyed `infer#<sub>#<YYYY-MM-DD>`. The date
//    lives in the key, so the bucket resets itself — no cron, no cleanup job.
//    It also caps the blast radius of stolen credentials at a day, not a month.
//  * `runCalls` is a map of runId -> call count. That single attribute answers
//    all three questions: `size(runCalls)` is the run count, `runCalls.<id>` is
//    the per-run count, and `calls` is the running total. So all three limits
//    are enforced by ONE conditional write, which makes them atomic — two
//    concurrent calls cannot both take the last unit.
//  * Limits are flat across tiers on purpose. Resolving a tier costs two
//    Cognito calls, and a run is ~18 calls, so per-call tier lookups would add
//    ~36 round-trips per analysis to the hot path.
//  * Rows carry a `ttl` attribute. TTL is currently DISABLED on the table;
//    enabling it sweeps these automatically and touches nothing else, because
//    only rows that have the attribute are ever expired.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.REGION || 'eu-west-3';
const TABLE = process.env.STORAGE_TAKEOFFRUNS_NAME
  || process.env.QUOTA_TABLE
  || 'TakeoffRuns-dev';

const RUN_LIMIT = Number(process.env.INFER_DAILY_RUN_LIMIT || 50);
// Above the largest legitimate run: an A0 sheet tiles to ~35 tiles x 3 models.
const PER_RUN_CALLS = Number(process.env.INFER_PER_RUN_CALLS || 150);
// 50 A3 runs is ~900 calls; this leaves generous headroom while still bounding
// the day. A user working exclusively on A0 sheets will hit this before the run
// limit — raise it (env var, no code change) if that turns out to be real usage.
const CALL_CEILING = Number(process.env.INFER_DAILY_CALLS || 1500);
// Keep a fortnight of history for support questions ("why was I cut off?").
const TTL_DAYS = Number(process.env.INFER_QUOTA_TTL_DAYS || 14);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);   // YYYY-MM-DD, UTC
const rowKey = (sub, day) => `infer#${sub}#${day}`;

// Start of the next UTC day — what the client shows as "resets at".
const resetsAt = (day) => new Date(`${day}T00:00:00.000Z`).getTime() + 86400000;

// Run ids come from the client, so they are sanitised before going anywhere
// near a document path. A caller that sends none is bucketed together under one
// id: forgiving for an older client mid-rollout, and still bounded by
// PER_RUN_CALLS rather than becoming a free pass.
function safeRunId(raw) {
  const s = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return s || 'untagged';
}

function view(day, attrs, extra) {
  const runCalls = (attrs && attrs.runCalls) || {};
  const runs = Object.keys(runCalls).length;
  return {
    runs,
    runLimit: RUN_LIMIT,
    runsRemaining: Math.max(0, RUN_LIMIT - runs),
    calls: (attrs && attrs.calls) || 0,
    callCeiling: CALL_CEILING,
    resetsAt: resetsAt(day),
    ...extra,
  };
}

/**
 * Atomically claim one inference call against `runId`'s run.
 * @returns {Promise<{ok:boolean, reason?:string, ...}>}
 *   ok:false means a limit is hit and NOTHING was consumed; `reason` is one of
 *   'run_limit' | 'per_run' | 'call_ceiling'.
 */
async function consume(sub, runId) {
  const day = dayKey();
  const rid = safeRunId(runId);
  const now = Date.now();

  const cmd = () => new UpdateCommand({
    TableName: TABLE,
    Key: { runId: rowKey(sub, day) },
    UpdateExpression:
      'SET kind = :kind, userId = :sub, #d = :day, updatedAt = :now, #ttl = :ttl, '
      + 'runCalls.#rid = if_not_exists(runCalls.#rid, :zero) + :one ADD calls :one',
    // NB: if_not_exists() is only legal in an UpdateExpression, never here —
    // compare against the constants instead (this bit the agent quota once).
    ConditionExpression:
      '(attribute_not_exists(calls) OR calls < :callCeiling) AND ('
      + '  (attribute_exists(runCalls.#rid) AND runCalls.#rid < :perRun)'
      + '  OR (attribute_not_exists(runCalls.#rid)'
      + '      AND (attribute_not_exists(runCalls) OR size(runCalls) < :runLimit))'
      + ')',
    ExpressionAttributeNames: { '#d': 'day', '#ttl': 'ttl', '#rid': rid },
    ExpressionAttributeValues: {
      ':one': 1,
      ':zero': 0,
      ':runLimit': RUN_LIMIT,
      ':perRun': PER_RUN_CALLS,
      ':callCeiling': CALL_CEILING,
      ':kind': 'inferQuota',
      ':sub': sub,
      ':day': day,
      ':now': new Date(now).toISOString(),
      ':ttl': Math.floor(now / 1000) + TTL_DAYS * 86400,
    },
    ReturnValues: 'ALL_NEW',
  });

  try {
    let res;
    try {
      res = await ddb.send(cmd());
    } catch (err) {
      // First ever call of the day: `runCalls` does not exist yet, so the
      // document path `runCalls.<rid>` is not addressable. Create the empty map
      // and retry — one extra write per user per day, not per call.
      if (err.name !== 'ValidationException') throw err;
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { runId: rowKey(sub, day) },
        UpdateExpression: 'SET runCalls = if_not_exists(runCalls, :empty)',
        ExpressionAttributeValues: { ':empty': {} },
      }));
      res = await ddb.send(cmd());
    }
    return { ok: true, ...view(day, res.Attributes) };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // One extra read, only on the denial path, so the user is told which
      // limit they actually hit rather than a vague "quota exceeded".
      let attrs = null;
      try {
        const got = await ddb.send(new GetCommand({
          TableName: TABLE, Key: { runId: rowKey(sub, day) },
        }));
        attrs = got.Item;
      } catch { /* fall through to the generic reason */ }
      const runCalls = (attrs && attrs.runCalls) || {};
      const reason = (attrs && attrs.calls >= CALL_CEILING) ? 'call_ceiling'
        : (runCalls[rid] != null ? 'per_run' : 'run_limit');
      return { ok: false, reason, ...view(day, attrs) };
    }
    // Fail OPEN. If DynamoDB is unavailable the choice is between blocking every
    // user's legitimate work and letting metering lapse for the outage; an
    // attacker has no way to cause this, so the outage is the bigger risk.
    console.error('[inferQuota] counter unavailable — allowing call unmetered:', err);
    return { ok: true, degraded: true, ...view(day, null) };
  }
}

/**
 * Hand a claimed call back after an upstream failure, so users are not charged
 * for our errors or Ultralytics'. Best-effort: a lost refund is a rounding
 * error, and the guard stops the counter going negative. The run id stays in
 * the map — a started run is a started run, even if one tile failed.
 */
async function refund(sub, runId) {
  const day = dayKey();
  const rid = safeRunId(runId);
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { runId: rowKey(sub, day) },
      UpdateExpression: 'SET runCalls.#rid = runCalls.#rid - :one ADD calls :minusOne',
      ConditionExpression: 'runCalls.#rid > :zero AND calls > :zero',
      ExpressionAttributeNames: { '#rid': rid },
      ExpressionAttributeValues: { ':one': 1, ':minusOne': -1, ':zero': 0 },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') {
      console.warn('[inferQuota] refund failed:', err.message);
    }
  }
}

const MESSAGES = {
  run_limit: `Daily limit reached: ${RUN_LIMIT} detection runs per day. Resets at midnight UTC.`,
  per_run: `This detection run has made too many requests (limit ${PER_RUN_CALLS}). Start a new run.`,
  call_ceiling: `Daily inference limit reached (${CALL_CEILING} requests). Resets at midnight UTC.`,
};

module.exports = { consume, refund, MESSAGES, RUN_LIMIT, PER_RUN_CALLS, CALL_CEILING };
