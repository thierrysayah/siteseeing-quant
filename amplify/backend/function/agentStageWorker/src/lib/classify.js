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

// ── zone tagging ──────────────────────────────────────────────────────────────
// One call for the current plan. Zones are given as normalised centroids so the
// downscale the VLM sees doesn't matter. rooms context helps it name them.
function tagPrompt(zones, rooms) {
  const list = zones.map(z => `#${z.i} at (${z.nx.toFixed(3)}, ${z.ny.toFixed(3)})`).join('; ');
  const ctx = (rooms && rooms.length)
    ? '\nKnown rooms from the schedule (for naming, may be incomplete): '
      + rooms.slice(0, 60).map(r => [r.number, r.name].filter(Boolean).join(' ')).filter(Boolean).join('; ')
    : '';
  return 'This is one floor plan. Detected rooms/zones are listed by index with '
    + 'NORMALISED centre coordinates (x,y each 0..1, origin top-left, x right, y down):\n'
    + list + '\n'
    + 'Give EVERY zone a room tag. Return ONLY JSON, no prose:\n'
    + '{"zones": [{"i": number, "label": string, "number": string|null}]}\n'
    + 'For each zone: (1) if a room NAME is printed at or near that point, use it '
    + 'exactly (e.g. "Kitchen", "Office", "WC"); (2) else infer the room type from '
    + 'the fixtures, size and adjacent labels (e.g. a WC pan → "WC", a sink run → '
    + '"Kitchen", a large open area → "Hall"); (3) number is the room number if one '
    + 'is printed (e.g. "101"), else null. Never return an empty label — always '
    + 'assign your best room-type tag.' + ctx;
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

module.exports = { EXTRACT_PROMPT, tagPrompt, centroidOf, mergeReference };
