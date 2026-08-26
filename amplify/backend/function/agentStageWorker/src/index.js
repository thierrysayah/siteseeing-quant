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
  if (key === 'classify_tag') return classifyTagStage(run);
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

// Stage 4 — Classify & tag (VLM): read EVERY sheet in the set to pull out the
// reference schedules (doors, windows, rooms/finishes, legend) — they usually
// live on their own sheets — then tag the current plan's detected zones with a
// room name/number. Degrades gracefully: any VLM failure still Approves so the
// pipeline isn't blocked; the reference is advisory + editable downstream.
const MAX_CLASSIFY_PAGES = Number(process.env.CLASSIFY_MAX_PAGES || 12);

async function classifyTagStage(run) {
  const {
    listProjectPages, fetchPngByKey, fetchPagePng, getJsonArtifact, putJsonArtifact,
  } = require('./lib/pageimage');
  const Jimp = require('jimp');
  const { askVlmImage, extractJson, imageSize, MODEL } = require('./lib/vlm');
  const {
    EXTRACT_PROMPT, tagPrompt, montageTagPrompt, buildMontage, centroidOf, mergeReference,
  } = require('./lib/classify');

  // Zones: read the room NAME off the whole plan by centroid (names are large).
  async function tagZones(buffer, W, H, group, context) {
    if (!group.length) return 0;
    const items = [];
    group.forEach((a, idx) => {
      const c = centroidOf(a);
      if (c) items.push({ i: idx, _ref: a, nx: c[0] / W, ny: c[1] / H });
    });
    if (!items.length) return 0;
    const text = await askVlmImage(buffer, tagPrompt(items, 'room', context), { maxTokens: 1500 });
    const parsed = extractJson(text);
    const tags = (parsed && Array.isArray(parsed.tags)) ? parsed.tags : [];
    const byIndex = new Map(items.map(it => [it.i, it._ref]));
    let n = 0;
    for (const t of tags) {
      const a = byIndex.get(t.i);
      if (!a) continue;
      const label = [t.number, t.label].filter(Boolean).join(' ').trim();
      if (label) { a.zoneTag = label; n++; }
    }
    return n;
  }

  // A door/window whose bbox is far larger than its peers is almost always a
  // false detection (e.g. a whole room caught as a "door"). Flag those for review
  // and exclude them from tagging — a room-sized crop can't yield a real mark.
  const areaOf = (a) => {
    if (a.shapeType === 'polygon' && a.points) {
      const xs = a.points.map(p => p[0]), ys = a.points.map(p => p[1]);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    }
    return Math.abs((a.x2 - a.x1) * (a.y2 - a.y1));
  };
  function dropOversized(group) {
    if (group.length < 3) return { keep: group, flagged: 0 };
    const areas = group.map(areaOf).sort((x, y) => x - y);
    const median = areas[Math.floor(areas.length / 2)] || 0;
    const keep = []; let flagged = 0;
    for (const a of group) {
      if (median > 0 && areaOf(a) > 6 * median) { a.review = 'oversized'; flagged++; }
      else keep.push(a);
    }
    return { keep, flagged };
  }

  // Doors/windows: the schedule MARK is small text in/near a ~40px bbox — reading
  // it off the whole downscaled plan is unreliable. Crop each element (zoomed,
  // padded to catch nearby marks) into a numbered montage and read per cell.
  // Chunked so each cell stays legible. A read mark of the WRONG kind (a W## on a
  // door, or D## on a window) flags a probable misclassification rather than
  // silently forcing a same-kind mark.
  async function tagByMontage(image, font, group, kind, marks) {
    if (!group.length) return { tagged: 0, mismatched: 0 };
    const CAP = 20;
    const wrongKind = kind === 'door' ? /^\s*W\s*\d/i : /^\s*D\s*\d/i;
    let tagged = 0, mismatched = 0;
    for (let start = 0; start < group.length; start += CAP) {
      const chunk = group.slice(start, start + CAP);
      const buf = await buildMontage(Jimp, image, chunk, font);
      const text = await askVlmImage(buf, montageTagPrompt(kind, chunk.length, marks), { maxTokens: 1200 });
      const parsed = extractJson(text);
      const tags = (parsed && Array.isArray(parsed.tags)) ? parsed.tags : [];
      const byIdx = new Map(chunk.map((a, i) => [i, a]));
      for (const t of tags) {
        const a = byIdx.get(t.i);
        const label = t.label != null ? String(t.label).trim() : '';
        if (!a || !label) continue;
        a.zoneTag = label; tagged++;
        if (wrongKind.test(label)) { a.review = 'class_mismatch'; mismatched++; }  // likely mis-detected class
      }
    }
    return { tagged, mismatched };
  }

  // 1) Read every sheet (capped) for schedules/legends.
  const pageKeys = await listProjectPages(run);
  const scan = pageKeys.slice(0, MAX_CLASSIFY_PAGES);
  const perPage = [];
  let readOk = 0;
  for (const key of scan) {
    try {
      const buf = await fetchPngByKey(key);
      const text = await askVlmImage(buf, EXTRACT_PROMPT, { maxTokens: 1500 });
      const data = extractJson(text);
      if (data) {
        perPage.push({ sheet: key.split('/').pop(), ...data });
        readOk++;
      }
    } catch (e) {
      console.warn('[classify] page read failed', key, e.message);
    }
  }
  const reference = mergeReference(perPage);
  const sheetTypes = perPage.map(p => p.sheetType).filter(Boolean);

  // 2) Tag the current plan's zones (room name), doors and windows (schedule
  //    mark) — one VLM call per kind, best-effort. Marks come from the schedule.
  let tagged = 0, oversized = 0, mismatched = 0, detectionsKey = run.detectionsKey;
  try {
    if (run.detectionsKey) {
      const det = await getJsonArtifact(run.detectionsKey);
      const anns = det.annotations || [];
      const zones   = anns.filter(a => a.clsName === 'zone');
      const doors   = anns.filter(a => a.clsName === 'door');
      const windows = anns.filter(a => a.clsName === 'window');
      if (zones.length || doors.length || windows.length) {
        const { buffer } = await fetchPagePng(run);
        const { w, h } = await imageSize(buffer);
        const roomCtx = reference.rooms.map(r => [r.number, r.name].filter(Boolean).join(' '));
        const doorCtx = reference.doors.map(d => d.mark);
        const winCtx  = reference.windows.map(x => x.mark);
        // Load the plan + a bitmap font once for the door/window montages.
        const image = await Jimp.read(buffer);
        const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
        // Flag & exclude room-sized false doors/windows before tagging.
        const d = dropOversized(doors), wg = dropOversized(windows);
        oversized = d.flagged + wg.flagged;
        tagged += await tagZones(buffer, w, h, zones, roomCtx);
        const dr = await tagByMontage(image, font, d.keep,  'door',   doorCtx);
        const wr = await tagByMontage(image, font, wg.keep, 'window', winCtx);
        tagged += dr.tagged + wr.tagged;
        mismatched = dr.mismatched + wr.mismatched;
        if (tagged) {
          detectionsKey = await putJsonArtifact(run.runId, 'detections-tagged.json', {
            annotations: anns, meta: det.meta || null, taggedAt: new Date().toISOString(),
          });
        }
      }
    }
  } catch (e) {
    console.warn('[classify] tagging failed', e.message);
  }
  const taggedZones = tagged;   // keep the summary field name below

  const referenceKey = await putJsonArtifact(run.runId, 'reference.json', {
    reference, sheetTypes, pagesScanned: scan.length, pagesRead: readOk,
    generatedAt: new Date().toISOString(),
  });

  const bits = [];
  if (reference.doors.length)   bits.push(`${reference.doors.length} door type${reference.doors.length > 1 ? 's' : ''}`);
  if (reference.windows.length) bits.push(`${reference.windows.length} window type${reference.windows.length > 1 ? 's' : ''}`);
  if (reference.rooms.length)   bits.push(`${reference.rooms.length} room${reference.rooms.length > 1 ? 's' : ''}`);
  if (reference.legend.length)  bits.push(`${reference.legend.length} legend item${reference.legend.length > 1 ? 's' : ''}`);
  if (taggedZones)              bits.push(`${taggedZones} element${taggedZones > 1 ? 's' : ''} tagged`);
  const flags = [];
  if (oversized)   flags.push(`${oversized} oversized door/window flagged`);
  if (mismatched)  flags.push(`${mismatched} possible mis-detected class flagged`);

  return {
    output: `Read ${readOk}/${scan.length} sheet${scan.length > 1 ? 's' : ''}`
      + (bits.length ? ` — ${bits.join(', ')}.` : ' — no schedules found.')
      + (flags.length ? ` ⚠ ${flags.join('; ')}.` : '')
      + ' Approve, or Adjust the tags.',
    evidence: `Schedules/legend by ${MODEL.split('.').slice(-1)[0].split(':')[0]} (Bedrock)`
      + (pageKeys.length > scan.length ? `; scanned first ${scan.length} of ${pageKeys.length} sheets.` : '.'),
    confidence: 1,
    gate: 'approve',
    fields: { referenceKey, detectionsKey, taggedZones },
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
