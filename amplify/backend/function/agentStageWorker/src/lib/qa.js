/**
 * QA pass helpers (pipeline stage 6) — "find what nothing flagged".
 *
 * Every earlier stage flags problems with its OWN output. QA looks at the whole
 * takeoff — detections + tags + schedules + scale — and reasons across them,
 * catching the class of error a human can't eyeball: things that are MISSING
 * (an undetected door is invisible on the canvas), double-counted zones, and
 * counts/quantities that contradict the drawing's own schedule.
 *
 * Advisory by design (spec §6): it surfaces findings for the user's approval and
 * never silently changes the takeoff. Two kinds of output:
 *   - per-annotation flags   → review/reviewStage on the annotation itself
 *   - standalone findings    → { id, kind, message, bbox?, severity } for things
 *                              with no annotation to attach to (a missing door)
 *
 * Pure functions here; all I/O (S3, Bedrock) stays in the stage handler.
 */
const polygonClipping = require('polygon-clipping');

// ── geometry ──────────────────────────────────────────────────────────────────
function bboxOf(a) {
  if (a.shapeType === 'polygon' && Array.isArray(a.points) && a.points.length) {
    const xs = a.points.map(p => p[0]), ys = a.points.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [a.x1, a.y1, a.x2, a.y2];
}
// A closed ring for polygon-clipping; boxes become 4-point rings.
function ringOf(a) {
  if (a.shapeType === 'polygon' && Array.isArray(a.points) && a.points.length >= 3) {
    return a.points.map(p => [p[0], p[1]]);
  }
  const [x1, y1, x2, y2] = bboxOf(a);
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}
function shoelace(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
function areaPx(a) { return shoelace(ringOf(a)); }
function mpArea(mp) {
  return (mp || []).reduce((s, poly) => s + (poly || []).reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * shoelace(ring), 0), 0);
}

let fid = 0;
const finding = (kind, message, extra = {}) => ({ id: `qa-${Date.now().toString(36)}-${fid++}`, kind, reviewStage: 'qa', message, ...extra });

// ── 1. schedule reconciliation ───────────────────────────────────────────────
// The door/window schedule says how many of each mark exist ("D04 – 7 off").
// Compare with how many detections carry that mark. A shortfall is the
// strongest "you missed some" signal there is, and it's fully deterministic.
function reconcileSchedule(anns, reference) {
  const out = [];
  const tally = (cls) => {
    const m = new Map();
    for (const a of anns) if (a.clsName === cls && a.zoneTag) {
      const k = String(a.zoneTag).trim().toUpperCase();
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const check = (rows, cls, noun) => {
    const seen = tally(cls);
    for (const r of rows || []) {
      const mark = r.mark && String(r.mark).trim().toUpperCase();
      const want = Number(r.count);
      if (!mark || !(want > 0)) continue;                       // schedule gives no count
      const have = seen.get(mark) || 0;
      if (have < want) {
        out.push(finding('schedule_short',
          `${mark}: schedule lists ${want} ${noun}${want > 1 ? 's' : ''}, ${have} tagged — ${want - have} possibly missing`,
          { severity: 'high', mark, want, have }));
      } else if (have > want) {
        out.push(finding('schedule_over',
          `${mark}: schedule lists ${want} ${noun}${want > 1 ? 's' : ''}, ${have} tagged — ${have - want} extra or mis-tagged`,
          { severity: 'medium', mark, want, have }));
      }
    }
  };
  check(reference?.doors, 'door', 'door');
  check(reference?.windows, 'window', 'window');
  return out;
}

// ── 2. double-counted zones ──────────────────────────────────────────────────
// The deterministic trim resolves clear overhangs and leaves ambiguous pairs
// alone. Any remaining substantial overlap means area is counted twice.
function overlappingZones(anns, { minFrac = 0.15, minPx = 400 } = {}) {
  const zones = anns.map((a, i) => ({ a, i })).filter(z => z.a.clsName === 'zone');
  const out = [];
  for (let p = 0; p < zones.length; p++) {
    for (let q = p + 1; q < zones.length; q++) {
      const A = zones[p].a, B = zones[q].a;
      const [ax1, ay1, ax2, ay2] = bboxOf(A), [bx1, by1, bx2, by2] = bboxOf(B);
      if (ax2 <= bx1 || bx2 <= ax1 || ay2 <= by1 || by2 <= ay1) continue;   // bboxes disjoint
      let inter;
      try { inter = mpArea(polygonClipping.intersection([ringOf(A)], [ringOf(B)])); } catch { continue; }
      if (inter < minPx) continue;
      const small = Math.min(areaPx(A), areaPx(B)) || 1;
      const frac = inter / small;
      if (frac < minFrac) continue;
      const tagA = A.zoneTag || 'zone', tagB = B.zoneTag || 'zone';
      A.review = A.review || 'overlap'; A.reviewStage = A.reviewStage || 'qa';
      B.review = B.review || 'overlap'; B.reviewStage = B.reviewStage || 'qa';
      out.push(finding('overlap',
        `"${tagA}" and "${tagB}" overlap by ${Math.round(frac * 100)}% of the smaller — area counted twice?`,
        { severity: 'medium', bbox: [Math.max(ax1, bx1), Math.max(ay1, by1), Math.min(ax2, bx2), Math.min(ay2, by2)] }));
    }
  }
  return out;
}

// ── 3. tag hygiene ───────────────────────────────────────────────────────────
// Every zone should carry a room tag by now; none is a gap in the takeoff.
function untaggedZones(anns) {
  let n = 0;
  for (const a of anns) if (a.clsName === 'zone' && !a.zoneTag && !a.review) {
    a.review = 'untagged'; a.reviewStage = 'qa'; n++;
  }
  return n;
}

// ── 4. quantity plausibility ─────────────────────────────────────────────────
// Sanity-check zone areas in m² against loose bounds. Slivers and blobs are
// usually detection artefacts; a 200 m² "WC" is a wrong tag or wrong scale.
const ROOM_BOUNDS = [   // [regex on tag, min m², max m²]
  [/\b(wc|toilet|bath|shower|ensuite|powder)\b/i, 1, 30],
  [/\b(closet|wic|store|storage|pantry|utility|laundry|cupboard)\b/i, 0.5, 40],
  [/\b(bed|bedroom)\b/i, 5, 80],
  [/\b(kitchen|dining|office|study|living|lounge|hall|corridor|garage|patio)\b/i, 2, 250],
];
function implausibleAreas(anns, ratio) {
  if (!(ratio > 0)) return 0;
  let n = 0;
  for (const a of anns) {
    if (a.clsName !== 'zone' || a.review) continue;
    const m2 = areaPx(a) * ratio * ratio;
    let bad = null;
    if (m2 < 0.3) bad = `only ${m2.toFixed(2)} m² — a sliver, likely not a room`;
    else if (m2 > 400) bad = `${m2.toFixed(0)} m² — far too large for one room, likely a merged blob`;
    else if (a.zoneTag) {
      for (const [re, lo, hi] of ROOM_BOUNDS) {
        if (re.test(a.zoneTag)) {
          if (m2 < lo) bad = `${m2.toFixed(1)} m² is very small for a "${a.zoneTag}"`;
          else if (m2 > hi) bad = `${m2.toFixed(0)} m² is very large for a "${a.zoneTag}" — wrong tag or wrong scale?`;
          break;
        }
      }
    }
    if (bad) { a.review = 'implausible_area'; a.reviewStage = 'qa'; a.reviewNote = bad; n++; }
  }
  return n;
}

// ── 5. missed-elements sweep (VLM) ───────────────────────────────────────────
// Detections are drawn ONTO the plan so the model can see what's covered, then
// it's asked what's visibly there with no box. Returns approximate positions.
const OVERLAY_COLORS = { door: [155, 89, 255], window: [255, 140, 0], zone: [220, 30, 30] };
function drawRect(img, x1, y1, x2, y2, [r, g, b], t = 3) {
  const W = img.bitmap.width, H = img.bitmap.height;
  const px = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) img.setPixelColor((r << 24 | g << 16 | b << 8 | 0xff) >>> 0, x, y); };
  for (let k = 0; k < t; k++) {
    for (let x = Math.round(x1); x <= Math.round(x2); x++) { px(x, Math.round(y1) + k); px(x, Math.round(y2) - k); }
    for (let y = Math.round(y1); y <= Math.round(y2); y++) { px(Math.round(x1) + k, y); px(Math.round(x2) - k, y); }
  }
}
function drawDetections(img, anns) {
  for (const a of anns) {
    const c = OVERLAY_COLORS[a.clsName];
    if (!c) continue;
    const [x1, y1, x2, y2] = bboxOf(a);
    if ([x1, y1, x2, y2].some(v => v == null || !isFinite(v))) continue;
    drawRect(img, x1, y1, x2, y2, c, a.clsName === 'zone' ? 2 : 3);
  }
  return img;
}
const MISSED_PROMPT =
  'This is a floor plan with the elements a detector ALREADY found drawn as boxes: '
  + 'PURPLE = door, ORANGE = window, RED = room/zone outline. '
  + 'Your job is to find what the detector MISSED. Look for any door swing, window '
  + 'opening in a wall, or enclosed room that is clearly visible in the drawing but has '
  + 'NO box of the matching colour on it. Return ONLY JSON, no prose:\n'
  + '{"missed":[{"kind":"door"|"window"|"room","label":string|null,"nx":number,"ny":number}]}\n'
  + 'nx,ny are the element\'s approximate centre as fractions 0..1 of image width/height '
  + '(origin top-left). label is the printed name/mark if there is one. Only report '
  + 'elements you can clearly see are unboxed; if everything is boxed return {"missed":[]}. '
  + 'Do not report elements that already have a box.';

// Turn the model's normalised hits into findings with a small focus bbox.
function missedToFindings(missed, W, H) {
  const out = [];
  for (const m of missed || []) {
    const kind = ['door', 'window', 'room'].includes(m.kind) ? m.kind : null;
    const nx = Number(m.nx), ny = Number(m.ny);
    if (!kind || !(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) continue;
    const cx = nx * W, cy = ny * H, r = kind === 'room' ? 60 : 25;
    out.push(finding('missed',
      `possible undetected ${kind}${m.label ? ` "${m.label}"` : ''} — nothing boxed here`,
      { severity: 'high', kind, bbox: [cx - r, cy - r, cx + r, cy + r] }));
  }
  return out;
}

module.exports = {
  reconcileSchedule, overlappingZones, untaggedZones, implausibleAreas,
  drawDetections, MISSED_PROMPT, missedToFindings, bboxOf, areaPx,
};
