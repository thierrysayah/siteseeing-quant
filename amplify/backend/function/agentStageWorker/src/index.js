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
  if (key === 'qa') return qaStage(run);
  if (key === 'report') return reportStage(run);
  const s = STAGES[stageIndex];
  return {
    output: `Stub output for "${s.label}" (stage ${stageIndex + 1}/${STAGES.length}).`,
    evidence: 'No evidence — stub stage (implemented in a later slice).',
    confidence: 1,
    gate: 'approve',
  };
}

// Finding the scale is its own task: asked alongside four title-block fields the
// model skips a scale printed outside the title block (e.g. under a view title);
// asked on its own it finds it. Used as a rescue when the main read returns none.
const SCALE_ONLY_PROMPT =
  'Find the drawing SCALE printed ANYWHERE on this sheet. It is NOT always in the '
  + 'title block — look in (a) the title block, (b) the caption under a drawing/view '
  + 'title, e.g. "01 FLOOR PLAN  Scale 1:100@A3", (c) beside a scale bar. It may read '
  + '1:100, 1/100, 1:100@A3 or "SCALE: 1:50". Return ONLY JSON, no prose: '
  + '{"statedScale": string|null}. Copy it EXACTLY as printed. If views have different '
  + 'scales give the one for the main plan. Use null only if there is genuinely no '
  + 'scale anywhere on the sheet.';

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
    + 'Read the title block for projectName, drawingNumber and revision.\n'
    + 'statedScale: the drawing scale printed ANYWHERE on the sheet — it is NOT always in '
    + 'the title block. Look in (a) the title block, (b) the caption under a drawing/view '
    + 'title, e.g. "01 FLOOR PLAN  Scale 1:100@A3", (c) beside a scale bar. It may read '
    + '1:100, 1/100, 1:100@A3 or "SCALE: 1:50". Copy it EXACTLY as printed. If several '
    + 'views have different scales, give the one for the main plan. Use null only if there '
    + 'is genuinely no scale anywhere on the sheet. Use null for any other field you cannot read.';

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
  // Rescue: no scale from the combined read → ask again with the scale as the
  // only task. Costs one extra call, and only on sheets that need it.
  if (!data.statedScale) {
    try {
      const { buffer } = await fetchPagePng(run);
      const t2 = await askVlmImage(buffer, SCALE_ONLY_PROMPT, { maxTokens: 200 });
      const d2 = extractJson(t2);
      if (d2 && d2.statedScale) data.statedScale = d2.statedScale;
    } catch (e) { console.warn('[understandSheet] scale rescue failed', e.message); }
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

  // 2) Fall back to the project's calibrated scale. This is a value the USER set
  //    (typed 1:N or measured), so show it EXACTLY — never snap it. Snapping is
  //    only for cleaning OCR noise on the VLM-read stated scale in path 1.
  const ratio = await readProjectScale(run);
  if (ratio) {
    const denom = ratioToDenom(ratio);   // already Math.round'ed
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
    if (a.confidence != null && a.confidence < 0.35) { a.review = 'low_confidence'; a.reviewStage = 'detect'; flagged++; }
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
    EXTRACT_PROMPT, montageTagPrompt, buildMontage, mergeReference, verifyKindPrompt, bboxOf,
  } = require('./lib/classify');

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
      if (median > 0 && areaOf(a) > 6 * median) { a.review = 'oversized'; a.reviewStage = 'classify'; flagged++; }
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
  async function tagByMontage(image, font, group, kind, marks, opts = {}) {
    if (!group.length) return { tagged: 0, reclassified: 0 };
    const CAP = opts.cap || 20;
    const other = kind === 'door' ? 'window' : 'door';
    // Door↔window reclass only applies to those two kinds; rooms never reclass.
    const wrongKind = kind === 'door' ? /^\s*W\s*\d/i : kind === 'window' ? /^\s*D\s*\d/i : null;
    let tagged = 0, reclassified = 0;
    for (let start = 0; start < group.length; start += CAP) {
      const chunk = group.slice(start, start + CAP);
      const buf = await buildMontage(Jimp, image, chunk, font, opts.montage);
      const text = await askVlmImage(buf, montageTagPrompt(kind, chunk.length, marks), { maxTokens: 1500 });
      const parsed = extractJson(text);
      const tags = (parsed && Array.isArray(parsed.tags)) ? parsed.tags : [];
      const byIdx = new Map(chunk.map((a, i) => [i, a]));
      for (const t of tags) {
        const a = byIdx.get(t.i);
        if (!a) continue;
        const label = t.label != null ? String(t.label).trim() : '';
        const certain = t.certain !== false;   // field absent → treat as certain

        // Nothing legible labels this element, or the only mark visible belongs
        // to a neighbour → leave it untagged and flag it, rather than guess.
        if (!label || !certain) {
          if (kind !== 'room') { a.review = a.review || 'mark_unclear'; a.reviewStage = a.reviewStage || 'classify'; }
          continue;
        }

        const crossKind = wrongKind && wrongKind.test(label);
        if (!crossKind) {
          // Rooms may also carry a number ("101 Office"); marks don't.
          a.zoneTag = (kind === 'room' && t.number) ? `${t.number} ${label}`.trim() : label;
          tagged++;
          continue;
        }

        // A mark of the OTHER kind suggests the detector mis-classified this
        // element — but the mark may be misread or invented, and acting on it
        // silently changes the class. Verify visually first: ask what the element
        // actually IS from how it is drawn (swing arc vs glazing lines).
        let verdict = null;
        try {
          const vbuf = await buildMontage(Jimp, image, [a], font,
            { cell: 384, cols: 1, padFactor: 0.6, markTarget: true });
          const vres = extractJson(await askVlmImage(vbuf, verifyKindPrompt(), { maxTokens: 200 }));
          if (vres && vres.kind && vres.certain !== false) verdict = String(vres.kind).toLowerCase();
        } catch (e) { console.warn('[classify] kind verify failed', e.message); }

        if (verdict === other) {
          a.zoneTag = label; tagged++;
          a.reclassFrom = a.clsName; a.clsName = other;
          a.review = 'reclassified'; a.reviewStage = 'classify';
          reclassified++;
        } else {
          // The drawing still says it's a `kind` (or we can't tell) — keep the
          // class, drop the contradictory mark, flag it for a human look.
          a.review = 'mark_unclear'; a.reviewStage = 'classify';
        }
      }
    }
    return { tagged, reclassified };
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
  let tagged = 0, oversized = 0, reclassified = 0, detectionsKey = run.detectionsKey;
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
        const zr = await tagByMontage(image, font, zones, 'room', roomCtx,
          { cap: 12, montage: { cell: 300, cols: 4, padFactor: 0.15 } });
        tagged += zr.tagged;
        // Outline the subject + tighter padding: without it a neighbour's mark
        // inside the crop gets read as this element's.
        const MONT = { cap: 16, montage: { cell: 260, cols: 4, padFactor: 0.55, markTarget: true } };
        const dr = await tagByMontage(image, font, d.keep,  'door',   doorCtx, MONT);
        const wr = await tagByMontage(image, font, wg.keep, 'window', winCtx, MONT);
        tagged += dr.tagged + wr.tagged;
        reclassified = dr.reclassified + wr.reclassified;
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
  if (oversized)     flags.push(`${oversized} oversized door/window flagged`);
  if (reclassified)  flags.push(`${reclassified} auto-reclassified door↔window (confirm)`);

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

// Stage 6 — QA pass: "find what nothing flagged". Reads the WHOLE takeoff
// (detections + tags + schedules + scale) and reasons across it. Deterministic
// checks first (schedule counts, double-counted zones, untagged zones, area
// plausibility), then one VLM sweep with the detections drawn on the plan to
// spot elements that were never detected at all — the one error class a human
// can't eyeball. Advisory: flags + findings for approval, never silent fixes.
async function qaStage(run) {
  const Jimp = require('jimp');
  const { fetchPagePng, getJsonArtifact, putJsonArtifact, readProjectScale } = require('./lib/pageimage');
  const { askVlmImage, extractJson, MODEL } = require('./lib/vlm');
  const {
    reconcileSchedule, overlappingZones, untaggedZones, implausibleAreas,
    drawDetections, MISSED_PROMPT, missedToFindings,
  } = require('./lib/qa');
  if (!run.detectionsKey) throw new Error('no detections to QA');

  const det = await getJsonArtifact(run.detectionsKey);
  const anns = det.annotations || [];
  let reference = null;
  if (run.referenceKey) {
    try { reference = (await getJsonArtifact(run.referenceKey)).reference || null; }
    catch (e) { console.warn('[qa] no reference', e.message); }
  }
  const ratio = (typeof run.scale === 'number' && run.scale > 0) ? run.scale : await readProjectScale(run);

  // 1–4: deterministic, cross-cutting checks.
  const findings = [];
  findings.push(...reconcileSchedule(anns, reference));
  findings.push(...overlappingZones(anns));
  const nUntagged = untaggedZones(anns);
  const nArea = implausibleAreas(anns, ratio);

  // 5: missed-elements sweep — best-effort, never blocks.
  let missed = [], sweepNote = 'sweep skipped';
  try {
    const { buffer } = await fetchPagePng(run);
    const img = await Jimp.read(buffer);
    const W = img.bitmap.width, H = img.bitmap.height;
    drawDetections(img, anns);
    const overlaid = await img.quality(90).getBufferAsync(Jimp.MIME_JPEG);
    const text = await askVlmImage(overlaid, MISSED_PROMPT, { maxTokens: 1200 });
    const parsed = extractJson(text);
    missed = missedToFindings(parsed && parsed.missed, W, H);
    findings.push(...missed);
    sweepNote = `sweep by ${MODEL.split('.').slice(-1)[0].split(':')[0]}`;
  } catch (e) {
    console.warn('[qa] missed-elements sweep failed', e.message);
    sweepNote = `sweep unavailable (${e.name || 'error'})`;
  }

  // Persist: flagged annotations (repoint detectionsKey) + standalone findings.
  const detectionsKey = await putJsonArtifact(run.runId, 'detections-qa.json', {
    annotations: anns, meta: det.meta || null, qaAt: new Date().toISOString(),
  });
  const qaKey = await putJsonArtifact(run.runId, 'qa.json', {
    findings, counts: { untagged: nUntagged, implausibleArea: nArea, missed: missed.length },
    generatedAt: new Date().toISOString(),
  });

  const bits = [];
  const short = findings.filter(f => f.kind === 'schedule_short').length;
  const over  = findings.filter(f => f.kind === 'schedule_over').length;
  const ovl   = findings.filter(f => f.kind === 'overlap').length;
  if (short)          bits.push(`${short} schedule shortfall${short > 1 ? 's' : ''}`);
  if (over)           bits.push(`${over} over-count${over > 1 ? 's' : ''}`);
  if (missed.length)  bits.push(`${missed.length} possibly undetected`);
  if (ovl)            bits.push(`${ovl} overlapping zone pair${ovl > 1 ? 's' : ''}`);
  if (nUntagged)      bits.push(`${nUntagged} untagged zone${nUntagged > 1 ? 's' : ''}`);
  if (nArea)          bits.push(`${nArea} implausible area${nArea > 1 ? 's' : ''}`);
  const total = findings.length + nUntagged + nArea;

  return {
    output: total
      ? `QA found ${total} item${total > 1 ? 's' : ''} to check — ${bits.join(', ')}. See Needs review; Approve when satisfied.`
      : 'QA found nothing to flag — counts match the schedule, no double-counted zones, all zones tagged, areas plausible.',
    evidence: `Schedule reconciliation, zone overlap (polygon intersection), tag/area checks; ${sweepNote}.`,
    confidence: 1,
    gate: 'approve',
    fields: { qaKey, detectionsKey },
  };
}

// Stage 8 — Report: turn the run into a deliverable. A deterministic quantity
// schedule (every number computed from the annotations + scale) plus an
// LLM-drafted narrative written FROM that schedule — summary, inclusions,
// exclusions, assumptions, items to verify. Quantities only, unpriced, until
// stage 7 exists. The narrative is best-effort: if the model fails, the
// schedule still ships with a stub narrative.
async function reportStage(run) {
  const { getJsonArtifact, putJsonArtifact, readProjectScale } = require('./lib/pageimage');
  const { askLlm, MODEL } = require('./lib/vlm');
  const { buildSchedule, narrativePrompt } = require('./lib/report');
  if (!run.detectionsKey) throw new Error('no detections to report');

  const det = await getJsonArtifact(run.detectionsKey);
  const anns = det.annotations || [];
  let reference = null, qa = null;
  if (run.referenceKey) { try { reference = (await getJsonArtifact(run.referenceKey)).reference || null; } catch (e) { console.warn('[report] no reference', e.message); } }
  if (run.qaKey)        { try { qa = await getJsonArtifact(run.qaKey); } catch (e) { console.warn('[report] no qa', e.message); } }
  const ratio = (typeof run.scale === 'number' && run.scale > 0) ? run.scale : await readProjectScale(run);
  const PAPER_MM_PER_PX = 25.4 / 150;
  const scaleDenom = (ratio && ratio > 0) ? snapStandard(Math.round(ratio * 1000 / PAPER_MM_PER_PX)) : null;

  const schedule = buildSchedule(anns, ratio, reference);
  const project = {
    name: run.sheetInfo?.projectName || null, drawingNumber: run.sheetInfo?.drawingNumber || null,
    revision: run.sheetInfo?.revision || null, sheetType: run.sheetInfo?.sheetType || null,
    page: run.pageId || null, scaleBasis: run.sheetInfo?.statedScale ? 'stated on drawing' : 'project setting',
  };
  const qaSummary = qa ? {
    findings: (qa.findings || []).map(f => f.message),
    counts: qa.counts || null,
  } : { findings: [], counts: null };

  let narrative = '', narrativeBy = 'stub';
  try {
    narrative = await askLlm(narrativePrompt({ project, schedule, qa: qaSummary, scaleDenom }), { maxTokens: 2000 });
    narrativeBy = MODEL.split('.').slice(-1)[0].split(':')[0];
  } catch (e) {
    console.warn('[report] narrative failed', e.message);
    narrative = '## Summary\nNarrative unavailable — see the quantity schedule below. This takeoff is quantities only and unpriced.';
  }

  const reportKey = await putJsonArtifact(run.runId, 'report.json', {
    project, scaleDenom, schedule, qa: qaSummary, narrative, narrativeBy,
    pricing: null,   // stage 7 not built — quantities only
    generatedAt: new Date().toISOString(),
  });

  const t = schedule.totals;
  const bits = [];
  if (t.floorAreaM2 != null) bits.push(`${t.floorAreaM2} m² over ${t.zones} zone${t.zones === 1 ? '' : 's'}`);
  else bits.push(`${t.zones} zone${t.zones === 1 ? '' : 's'} (no scale — pixel units)`);
  bits.push(`${t.doors} door${t.doors === 1 ? '' : 's'}`, `${t.windows} window${t.windows === 1 ? '' : 's'}`);
  if (t.wallLengthM != null) bits.push(`${t.wallLengthM} m of wall`);
  return {
    output: `Report drafted — ${bits.join(', ')}. Quantities only (unpriced).`
      + (t.outstandingReviewFlags ? ` ${t.outstandingReviewFlags} review flag${t.outstandingReviewFlags > 1 ? 's' : ''} still open — listed under Items to Verify.` : '')
      + ' Approve & finish to close the run.',
    evidence: `Schedule computed from ${anns.length} annotations; narrative by ${narrativeBy}.`,
    confidence: 1,
    gate: 'approve',
    fields: { reportKey },
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
