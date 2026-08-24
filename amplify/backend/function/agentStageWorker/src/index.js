/* Amplify Params - DO NOT EDIT
	ENV
	REGION
	STORAGE_TAKEOFFRUNS_NAME
	STORAGE_TAKEOFFRUNS_ARN
Amplify Params - DO NOT EDIT */

/**
 * agentStageWorker — runs exactly ONE pipeline stage, asynchronously.
 *
 * Invoked (InvocationType 'Event') by agentOrchestrator with:
 *   { runId, stageIndex, expectedSeq }
 *
 * P1a: stages are still stubs — this slice only proves the async invoke +
 * poll loop. P1b swaps `runStage` for the real detect/cleanup/quantify work.
 *
 * Safety: every write is guarded on { status:'running', seq:expectedSeq } so a
 * duplicate or stale async invoke (Lambda 'Event' is at-least-once) is a no-op.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION || 'eu-west-3' }),
);
const TABLE = process.env.STORAGE_TAKEOFFRUNS_NAME || 'TakeoffRuns';

// Keep in sync with the orchestrator's STAGES.
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

exports.handler = async (event) => {
  const { runId, stageIndex, expectedSeq } = event || {};
  if (!runId || stageIndex == null || expectedSeq == null) {
    console.error('[stageWorker] bad payload', JSON.stringify(event));
    return;
  }

  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { runId } }));
  if (!Item) { console.warn('[stageWorker] run gone', runId); return; }
  if (Item.status !== 'running' || Item.seq !== expectedSeq) {
    // Duplicate or stale invoke — the run already moved on. No-op.
    console.log('[stageWorker] noop', runId, 'status', Item.status, 'seq', Item.seq, 'expected', expectedSeq);
    return;
  }

  let stage;
  try {
    stage = await runStage(Item, stageIndex);
  } catch (err) {
    console.error('[stageWorker] stage error', err);
    await settle(runId, expectedSeq, {
      status: 'failed',
      failReason: String(err?.message || err).slice(0, 500),
    });
    return;
  }

  const fields = {
    status: 'awaiting_approval',
    stageIndex,
    stageKey: STAGES[stageIndex].key,
    stageLabel: STAGES[stageIndex].label,
    stageOutput: stage.output,
    evidence: stage.evidence,
    confidence: stage.confidence,
    gate: stage.gate,
  };
  // Persist an artifact pointer (e.g. detections key) so later stages can load it.
  if (stage.artifacts && stage.artifacts[0]?.s3Key) {
    fields.detectionsKey = stage.artifacts[0].s3Key;
  }
  await settle(runId, expectedSeq, fields);
};

/**
 * Run one stage. P1b implements `detect`; the rest remain stubs until
 * P1c (cleanup, quantify) and P2 (VLM stages).
 */
async function runStage(run, stageIndex) {
  const key = STAGES[stageIndex].key;
  if (key === 'detect') return detectStage(run);
  const s = STAGES[stageIndex];
  return {
    output: `Stub output for "${s.label}" (stage ${stageIndex + 1}/${STAGES.length}).`,
    evidence: 'No evidence — stub stage (implemented in a later slice).',
    confidence: 1,
    gate: 'approve',
  };
}

// Stage 3 — real detection: fetch the page raster from S3, tile + infer, store.
async function detectStage(run) {
  const { fetchPagePng, putJsonArtifact } = require('./lib/pageimage');
  const { detectPage } = require('./lib/infer');

  const { buffer, key } = await fetchPagePng(run);
  const { annotations, meta } = await detectPage(buffer);

  const byClass = {};
  for (const a of annotations) byClass[a.clsName] = (byClass[a.clsName] || 0) + 1;
  const summary = Object.entries(byClass).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`).join(', ') || 'no detections';

  const outKey = await putJsonArtifact(run.runId, 'detections.json', { annotations, meta, source: key });

  return {
    output: `Detected ${annotations.length} objects — ${summary}.`,
    evidence: `Source ${key.split('/').pop()} · ${meta.tiles} tiles`
      + (meta.failed ? ` (${meta.failed} failed)` : '')
      + ` · ${meta.raw} raw → ${annotations.length} after NMS`,
    confidence: 1,
    gate: 'approve',
    artifacts: [{ s3Key: outKey }],
  };
}

// Conditional write guarded on the running state we were dispatched for.
async function settle(runId, expectedSeq, fields) {
  const names = { '#status': 'status', '#seq': 'seq' };
  const values = { ':running': 'running', ':eseq': expectedSeq, ':nseq': expectedSeq + 1, ':now': new Date().toISOString() };
  const sets = ['#status = :status', '#seq = :nseq', 'updatedAt = :now'];
  values[':status'] = fields.status;
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'status') continue;
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { runId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#status = :running AND #seq = :eseq',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log('[stageWorker] lost race on settle, noop', runId);
      return;
    }
    throw err;
  }
}
