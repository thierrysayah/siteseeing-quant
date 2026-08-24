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

// Keep in sync with the orchestrator's STAGES. Detect + clean are one step.
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
  // Stages may persist pointers on the run (e.g. detectionsKey, quantitiesKey).
  if (stage.fields) Object.assign(fields, stage.fields);
  await settle(runId, expectedSeq, fields);
};

/**
 * Run one stage. Implemented: detect (P1b), cleanup + quantify (P1c). The rest
 * remain stubs until P2 (VLM stages) / P3 (QA, report).
 */
async function runStage(run, stageIndex) {
  const key = STAGES[stageIndex].key;
  if (key === 'detect') return detectStage(run);   // detect + trim/clean in one
  if (key === 'quantify') return quantifyStage(run);
  const s = STAGES[stageIndex];
  return {
    output: `Stub output for "${s.label}" (stage ${stageIndex + 1}/${STAGES.length}).`,
    evidence: 'No evidence — stub stage (implemented in a later slice).',
    confidence: 1,
    gate: 'approve',
  };
}

// Stage 3 — Detect & clean (one step): fetch the page raster, tile + infer,
// then immediately trim zone overhangs (the app's algorithm) — remove the part
// of a zone poking into a neighbour so areas aren't double-counted, delete
// duplicate zones, leave ambiguous pairs alone — and flag (keep) low-confidence
// items. The user reviews/edits this cleaned set.
async function detectStage(run) {
  const { fetchPagePng, putJsonArtifact, readAutoSimplifyDist } = require('./lib/pageimage');
  const { detectPage } = require('./lib/infer');
  const { trimZoneOverhangsIterative } = require('./lib/trim');

  const { buffer, key } = await fetchPagePng(run);
  const autoEps = await readAutoSimplifyDist(run);   // zone simplification, as in manual run
  const { annotations, meta } = await detectPage(buffer, autoEps);

  // Clean immediately: trim overhangs + drop duplicate zones. Iterate to a fixed
  // point — one pass can miss cascading overlaps (see trim.js).
  const { anns, trimmed, removed, ambiguous, notes } = trimZoneOverhangsIterative(annotations);
  let flagged = 0;
  for (const a of anns) {
    if (a.confidence != null && a.confidence < 0.35) { a.review = 'low_confidence'; flagged++; }
  }

  const byClass = {};
  for (const a of anns) byClass[a.clsName] = (byClass[a.clsName] || 0) + 1;
  const summary = Object.entries(byClass).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`).join(', ') || 'no detections';

  const outKey = await putJsonArtifact(run.runId, 'detections.json', {
    annotations: anns, meta, source: key, cleanupNotes: notes.slice(0, 50),
  });

  const clean = [];
  if (trimmed)   clean.push(`${trimmed} overhang${trimmed > 1 ? 's' : ''} trimmed`);
  if (removed)   clean.push(`${removed} duplicate${removed > 1 ? 's' : ''} removed`);
  if (ambiguous) clean.push(`${ambiguous} ambiguous kept`);
  if (flagged)   clean.push(`${flagged} low-conf flagged`);

  return {
    output: `Detected & cleaned — ${anns.length} objects (${summary}).`
      + (clean.length ? ` [${clean.join(', ')}]` : ''),
    evidence: `Source ${key.split('/').pop()} · ${meta.tiles} tiles · ${meta.raw} raw → `
      + `${annotations.length} after NMS → ${anns.length} after trim.`,
    confidence: 1,
    gate: 'approve',
    fields: { detectionsKey: outKey },
  };
}

// Stage 6 — quantify: counts + areas/perimeters from the cleaned detections,
// in real units when the project has a scale.
async function quantifyStage(run) {
  const { getJsonArtifact, putJsonArtifact, readProjectScale } = require('./lib/pageimage');
  const { quantify } = require('./lib/quantify');
  if (!run.detectionsKey) throw new Error('no detections to quantify');

  const src = await getJsonArtifact(run.detectionsKey);
  const ratio = await readProjectScale(run);
  const q = quantify(src.annotations || [], ratio);
  const outKey = await putJsonArtifact(run.runId, 'quantities.json', q);

  const zone = q.byClass.zone;
  const parts = [];
  const totalCount = Object.values(q.byClass).reduce((s, c) => s + c.count, 0);
  parts.push(`${totalCount} objects`);
  if (zone) parts.push(q.hasScale ? `${zone.areaM2} m² zone` : `${zone.areaPx}px² zone`);
  const counts = Object.entries(q.byClass).sort((a, b) => b[1].count - a[1].count)
    .map(([k, c]) => `${c.count} ${k}`).join(', ');

  return {
    output: `Quantified — ${parts.join(' · ')}. (${counts})`,
    evidence: q.hasScale
      ? `Real units from project scale (px = ${ratio} m).`
      : 'No project scale set — quantities are pixel-based. Set a scale for m²/m.',
    confidence: 1,
    gate: 'approve',
    fields: { quantitiesKey: outKey, hasScale: q.hasScale },
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
