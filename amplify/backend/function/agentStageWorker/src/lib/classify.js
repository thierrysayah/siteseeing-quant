/**
 * Classify & tag helpers (pipeline stage 4).
 *
 * Two jobs:
 *   1. Read EVERY sheet in the set and pull out the reference tables an
 *      estimator needs — door schedule, window schedule, room/finish schedule,
 *      and any legend/key. These usually live on their own sheets, not on the
 *      plan being taken off, so the whole set is scanned.
 *   2. Tag the detected zones on the current sheet with a room name/number,
 *      using the schedules as context.
 *
 * Pure functions + prompt builders only; all I/O (S3, Bedrock) stays in the
 * stage handler so this file is unit-testable.
 */

// ── per-sheet extraction ──────────────────────────────────────────────────────
// One call per sheet. The model returns only the tables actually present; empty
// arrays otherwise. Dimensions in millimetres when the schedule states them.
const EXTRACT_PROMPT =
  'You are reading ONE sheet from a set of architectural/engineering drawings, '
  + 'as a quantity surveyor. Extract any REFERENCE TABLES printed on THIS sheet. '
  + 'Return ONLY compact JSON, no prose:\n'
  + '{"sheetType": one of ["plan","door_schedule","window_schedule","room_schedule",'
  + '"finishes","legend","detail","elevation","section","other"],'
  + ' "doors": [{"mark": string, "width_mm": number|null, "height_mm": number|null,'
  + ' "type": string|null, "material": string|null, "fireRating": string|null,'
  + ' "count": number|null, "notes": string|null}],'
  + ' "windows": [{"mark": string, "width_mm": number|null, "height_mm": number|null,'
  + ' "type": string|null, "material": string|null, "notes": string|null}],'
  + ' "rooms": [{"number": string|null, "name": string|null, "finish": string|null,'
  + ' "area_m2": number|null}],'
  + ' "legend": [{"symbol": string, "meaning": string}]}\n'
  + 'Rules: include a table ONLY if it is actually on this sheet; otherwise use []. '
  + 'Read marks/types exactly as printed (e.g. "D1", "W03", "FD30"). '
  + 'Convert dimensions to millimetres. Use null for any field you cannot read. '
  + 'Do not invent rows.';

// ── element tagging ───────────────────────────────────────────────────────────
// One call per element KIND (room/door/window) for the current plan. Elements
// are given as normalised centroids so the downscale the VLM sees doesn't matter;
// the relevant schedule (rooms, or door/window marks) is passed as context.
//   kind:    'room' | 'door' | 'window'
//   context: array of known labels/marks (may be empty/incomplete)
function tagPrompt(items, kind, context) {
  const list = items.map(z => `#${z.i} at (${z.nx.toFixed(3)}, ${z.ny.toFixed(3)})`).join('; ');
  const ctxList = (context && context.length)
    ? context.filter(Boolean).slice(0, 80).join('; ') : '';

  if (kind === 'door' || kind === 'window') {
    const noun = kind;                          // "door" / "window"
    const eg = kind === 'door' ? 'D01, D02' : 'W01, W03';
    return `This is one floor plan. Detected ${noun}s are listed by index with `
      + 'NORMALISED centre coordinates (x,y each 0..1, origin top-left, x right, y down):\n'
      + list + '\n'
      + `Tag each ${noun} with its schedule MARK printed at or beside it on the plan `
      + `(e.g. ${eg}). Return ONLY JSON, no prose:\n`
      + '{"tags": [{"i": number, "label": string, "number": null}]}\n'
      + `label is the ${noun} mark exactly as printed. If no mark is legible next to a `
      + `${noun}, use the single nearest/most likely mark from this schedule list`
      + (ctxList ? ` [${ctxList}]` : '') + '. Never return an empty label.';
  }

  // rooms
  const ctx = ctxList
    ? '\nKnown rooms from the schedule (for naming, may be incomplete): ' + ctxList : '';
  return 'This is one floor plan. Detected rooms/zones are listed by index with '
    + 'NORMALISED centre coordinates (x,y each 0..1, origin top-left, x right, y down):\n'
    + list + '\n'
    + 'Give EVERY zone a room tag. Return ONLY JSON, no prose:\n'
    + '{"tags": [{"i": number, "label": string, "number": string|null}]}\n'
    + 'For each zone: (1) if a room NAME is printed at or near that point, use it '
    + 'exactly (e.g. "Kitchen", "Office", "WC"); (2) else infer the room type from '
    + 'the fixtures, size and adjacent labels (e.g. a WC pan → "WC", a sink run → '
    + '"Kitchen", a large open area → "Hall"); (3) number is the room number if one '
    + 'is printed (e.g. "101"), else null. Never return an empty label — always '
    + 'assign your best room-type tag.' + ctx;
}

// Bounding box [x1,y1,x2,y2] of an annotation in original pixel space.
function bboxOf(a) {
  if (a.shapeType === 'polygon' && Array.isArray(a.points) && a.points.length) {
    const xs = a.points.map(p => p[0]), ys = a.points.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [a.x1, a.y1, a.x2, a.y2];
}

// Build a numbered montage: each element cropped from the plan with padding (to
// catch a mark written just outside its bbox), zoomed into its own labelled
// cell. This lets the VLM READ each mark instead of guessing by coordinate.
// Returns a JPEG buffer. Cell order == `elements` order (cell label = index).
async function buildMontage(Jimp, image, elements, font, { cell = 224, cols = 5, padFactor = 1.2 } = {}) {
  const n = elements.length;
  const rows = Math.ceil(n / cols);
  const gap = 6, labelH = 20;
  const cellW = cell, cellH = cell + labelH;
  const W = cols * cellW + (cols + 1) * gap;
  const H = rows * cellH + (rows + 1) * gap;
  const canvas = await Jimp.create(W, H, 0xffffffff);
  const IW = image.bitmap.width, IH = image.bitmap.height;

  for (let i = 0; i < n; i++) {
    const [x1, y1, x2, y2] = bboxOf(elements[i]);
    const m = Math.max(x2 - x1, y2 - y1);
    const pad = Math.max(30, m * padFactor);            // include nearby marks
    const cx1 = Math.max(0, Math.round(x1 - pad)), cy1 = Math.max(0, Math.round(y1 - pad));
    const cx2 = Math.min(IW, Math.round(x2 + pad)), cy2 = Math.min(IH, Math.round(y2 + pad));
    if (cx2 <= cx1 || cy2 <= cy1) continue;
    const crop = image.clone().crop(cx1, cy1, cx2 - cx1, cy2 - cy1);
    crop.scaleToFit(cell, cell);
    const col = i % cols, row = Math.floor(i / cols);
    const px = gap + col * (cellW + gap), py = gap + row * (cellH + gap);
    const ox = px + Math.floor((cellW - crop.bitmap.width) / 2);
    const oy = py + labelH + Math.floor((cell - crop.bitmap.height) / 2);
    canvas.composite(crop, ox, oy);
    if (font) canvas.print(font, px + 3, py, String(i));  // black label on white strip
  }
  return canvas.quality(90).getBufferAsync(Jimp.MIME_JPEG);
}

// Prompt for a montage of same-kind elements → per-cell mark.
function montageTagPrompt(kind, count, marks) {
  if (kind === 'room') {
    const clean = (marks || []).filter(Boolean);
    const ctx = clean.length
      ? ` For reference, rooms named on the schedule: [${clean.join('; ')}].` : '';
    return `This image is a numbered grid of ${count} crops. Each cell (labelled 0, 1, 2, …) `
      + `shows ONE room/zone from a floor plan, zoomed in. The room's NAME is usually `
      + `printed inside it (e.g. LIVING ROOM, KITCHEN, BEDROOM #2, WIC), often with a `
      + `size and ceiling height beneath. For each cell give the room tag: `
      + `(1) if a name is printed inside, use it exactly as printed; (2) else infer the `
      + `room type from its fixtures/size (WC pan → "WC", sink run → "Kitchen", large `
      + `open area → "Hall"). Never leave a label empty. `
      + `Return ONLY JSON, no prose: {"tags":[{"i":<cell number>,"label":"<name>","number":<room number or null>}]}.${ctx}`;
  }
  const eg = kind === 'door' ? 'D01, D02' : 'W01, W03';
  const other = kind === 'door' ? 'window (W##)' : 'door (D##)';
  const clean = (marks || []).filter(Boolean);
  const ctx = clean.length
    ? ` For reference the ${kind} schedule marks are: [${clean.join(', ')}]. If the centre `
      + `element's own mark is unclear, prefer the closest of those.`
    : '';
  return `This image is a numbered grid of ${count} crops. Each cell (labelled 0, 1, 2, …) `
    + `shows ONE element from a floor plan (expected to be a ${kind}), zoomed in, with a `
    + `schedule MARK (like ${eg}) written inside or just beside it — read the mark for the `
    + `element at the CENTRE of each cell (ignore neighbouring elements). `
    + `Report EXACTLY what is printed: if the centre element's printed mark is actually a `
    + `${other} mark, report that — do not force it to a ${kind} mark. `
    + `Return ONLY JSON, no prose: {"tags":[{"i":<cell number>,"label":"<mark>"}]}.${ctx}`;
}

// Centroid of an annotation (box or polygon) in original pixel space.
function centroidOf(a) {
  if (a.shapeType === 'polygon' && Array.isArray(a.points) && a.points.length) {
    let sx = 0, sy = 0;
    for (const [x, y] of a.points) { sx += x; sy += y; }
    return [sx / a.points.length, sy / a.points.length];
  }
  if (a.x1 != null && a.x2 != null) return [(a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2];
  return null;
}

// Merge per-sheet extractions into one project reference. Doors/windows dedupe by
// mark (first non-empty row wins, later rows fill blanks); rooms by number+name;
// legend by symbol. Each row records which sheet it came from.
function mergeReference(perPage) {
  const doors = new Map(), windows = new Map(), rooms = new Map(), legend = new Map();
  const upsert = (map, key, row, sheet) => {
    if (!key) return;
    const k = String(key).trim().toLowerCase();
    if (!k) return;
    if (!map.has(k)) { map.set(k, { ...row, sheet }); return; }
    const cur = map.get(k);
    for (const [f, v] of Object.entries(row)) if (cur[f] == null && v != null) cur[f] = v;
  };
  for (const p of perPage) {
    const sheet = p.sheet;
    for (const d of p.doors || [])   upsert(doors, d.mark, d, sheet);
    for (const w of p.windows || []) upsert(windows, w.mark, w, sheet);
    for (const r of p.rooms || [])   upsert(rooms, `${r.number || ''}|${r.name || ''}`, r, sheet);
    for (const l of p.legend || [])  upsert(legend, l.symbol, l, sheet);
  }
  return {
    doors: [...doors.values()],
    windows: [...windows.values()],
    rooms: [...rooms.values()],
    legend: [...legend.values()],
  };
}

module.exports = {
  EXTRACT_PROMPT, tagPrompt, montageTagPrompt, buildMontage,
  centroidOf, bboxOf, mergeReference,
};
