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
    // A 'needs_input' gate hard-stops the run: the user must supply input (e.g.
    // calibrate the scale) before it can be approved.
    status: stage.gate === 'needs_input' ? 'needs_input' : 'awaiting_approval',
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
  if (key === 'understand_sheet') return understandSheetStage(run);
  if (key === 'calibrate_scale') return calibrateStage(run);
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

// Stage 1 — Understand sheet (VLM): classify the sheet and read the title block.
// Advisory/informational; a VLM failure never blocks the pipeline.
async function understandSheetStage(run) {
  const { fetchPagePng } = require('./lib/pageimage');
  const { askVlmImage, extractJson, MODEL } = require('./lib/vlm');
  const prompt = 'You are reading one architectural/engineering drawing sheet. '
    + 'Return ONLY compact JSON, no prose:\n'
    + '{"sheetType": one of ["architectural","electrical","plumbing","structural","mechanical","other"],'
    + ' "projectName": string|null, "drawingNumber": string|null, "revision": string|null,'
    + ' "statedScale": string|null}\n'
    + 'Read the title block for the fields. statedScale is the printed scale like "1:100" if present, else null. Use null when unsure.';

  let data = null, text = '';
  try {
    const { buffer } = await fetchPagePng(run);
    text = await askVlmImage(buffer, prompt, { maxTokens: 400 });
    data = extractJson(text);
  } catch (e) {
    console.error('[understandSheet]', e);
    return {
      output: `Sheet analysis unavailable (${e.name || 'error'}) — Approve to continue.`,
      evidence: String(e.message || e).slice(0, 160),
      confidence: 1, gate: 'approve',
    };
  }
  if (!data) {
    return {
      output: 'Read the sheet (structured fields unclear) — Approve to continue.',
      evidence: (text || '').slice(0, 160) || 'no reply',
      confidence: 1, gate: 'approve',
    };
  }
  const bits = [];
  if (data.sheetType) bits.push(data.sheetType);
  if (data.drawingNumber) bits.push(`dwg ${data.drawingNumber}`);
  if (data.revision) bits.push(`rev ${data.revision}`);
  if (data.statedScale) bits.push(`scale ${data.statedScale}`);
  return {
    output: `Sheet: ${data.projectName || '(unnamed)'}${bits.length ? ' — ' + bits.join(' · ') : ''}.`,
    evidence: `Read by ${MODEL.split('.').slice(-1)[0].split(':')[0]} (Bedrock).`,
    confidence: 1, gate: 'approve',
    fields: { sheetInfo: data },
  };
}

// Stage 2 — Calibrate scale (manual, pre-VLM): seed the run's px→m from the
// project scale so quantities are in real units. The user recalibrates by
// drawing (Adjust → Scale Cal.), which sets run.scale via PUT /scale.
// Architectural/engineering scales come in standard denominators — snap to the
// nearest so a noisy 109 reads as 100.
const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000];
function snapStandard(d) {
  if (!d || d <= 0) return null;
  return STANDARD_SCALES.reduce((best, s) => (Math.abs(s - d) < Math.abs(best - d) ? s : best), STANDARD_SCALES[0]);
}
// Parse a "1:100" / "1:100 @ A1" / "1/100" stated scale → the denominator.
function parseStatedScale(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/1\s*[:/]\s*(\d{1,5})/);
  return m ? parseInt(m[1], 10) : null;
}

async function calibrateStage(run) {
  const { readProjectScale } = require('./lib/pageimage');
  const PAPER_MM_PER_PX = 25.4 / 150;               // 150 DPI render (matches client)
  const denomToRatio = (d) => (PAPER_MM_PER_PX / 1000) * d;  // exact px→m from 1:d
  const ratioToDenom = (r) => Math.round(r * 1000 / PAPER_MM_PER_PX);

  // 1) Prefer the drawing's stated scale (read by Understand sheet). Deriving the
  //    ratio from a standard 1:d is more accurate than a hand measurement.
  const stated = snapStandard(parseStatedScale(run.sheetInfo && run.sheetInfo.statedScale));
  if (stated) {
    return {
      output: `Scale: 1 : ${stated} (read from the title block). Approve, or Adjust.`,
      evidence: `From the drawing's stated scale "${run.sheetInfo.statedScale}".`,
      confidence: 1, gate: 'approve',
      fields: { scale: denomToRatio(stated) },   // exact ratio for that 1:d
    };
  }

  // 2) Fall back to the project's calibrated scale, shown as the nearest standard.
  const ratio = await readProjectScale(run);
  if (ratio) {
    const denom = snapStandard(ratioToDenom(ratio));
    return {
      output: `Scale: 1 : ${denom} (from the project). Approve, or Adjust to recalibrate.`,
      evidence: 'From the project scale — Adjust to set it exactly from the drawing.',
      confidence: 1, gate: 'approve',
      fields: { scale: ratio },   // keep the measured ratio for quantify
    };
  }

  // 3) No stated scale and no project scale — HARD STOP. Never guess or silently
  //    fall back to pixels: every downstream quantity depends on this.
  return {
    output: 'Scale required — no scale on the drawing and none set for the project. '
      + 'Set it to continue (enter the drawing ratio 1:N, or measure a known length).',
    evidence: 'No stated scale in the title block and no project scale.',
    confidence: 1, gate: 'needs_input',
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
  // Prefer the run's calibrated scale (set at Calibrate stage / Adjust); fall
  // back to the project scale.
  const ratio = (typeof run.scale === 'number' && run.scale > 0)
    ? run.scale
    : await readProjectScale(run);
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
