/**
 * Report helpers (pipeline stage 8).
 *
 * The report has two halves with a hard line between them:
 *   1. The QUANTITY SCHEDULE — computed deterministically from the annotations
 *      and the calibrated scale. Every number in the report comes from here.
 *   2. The NARRATIVE — LLM-drafted prose (summary, inclusions, exclusions,
 *      assumptions, items to verify) written FROM the schedule. The model is
 *      told it may not invent or restate quantities beyond the headline totals.
 *
 * Pricing (stage 7) is not built yet; the report is explicitly "quantities
 * only, unpriced". When pricing lands it adds a section — nothing here changes.
 */
const { polyAreaPerim, bbox } = require('./quantify');

const r2 = (v) => Math.round(v * 100) / 100;

// Length of a wall detection: walls are thin boxes, so the longer side.
function wallLengthPx(a) {
  const [x1, y1, x2, y2] = bbox(a);
  return Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
}
function areaPerimPx(a) {
  if (a.shapeType === 'polygon' && a.points && a.points.length >= 3) return polyAreaPerim(a.points);
  const [x1, y1, x2, y2] = bbox(a);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  return { area: w * h, perim: 2 * (w + h) };
}

/**
 * Build the quantity schedule. `ratio` is m/px (null → pixel units, flagged).
 * Groups: rooms by tag, doors/windows by schedule mark (enriched from the
 * extracted schedule), walls by class. Also counts outstanding review flags so
 * the narrative can qualify the takeoff honestly.
 */
function buildSchedule(anns, ratio, reference) {
  const hasScale = typeof ratio === 'number' && ratio > 0;
  const m  = (px) => hasScale ? r2(px * ratio) : null;
  const m2 = (px) => hasScale ? r2(px * ratio * ratio) : null;

  const rooms = new Map(), doors = new Map(), windows = new Map(), walls = new Map();
  let outstanding = 0;
  for (const a of anns) {
    if (a.review) outstanding++;
    if (a.clsName === 'zone') {
      const k = (a.zoneTag || 'Untagged zone').trim();
      const { area, perim } = areaPerimPx(a);
      const g = rooms.get(k) || { tag: k, count: 0, areaPx: 0, perimPx: 0 };
      g.count++; g.areaPx += area; g.perimPx += perim; rooms.set(k, g);
    } else if (a.clsName === 'door' || a.clsName === 'window') {
      const map = a.clsName === 'door' ? doors : windows;
      const k = (a.zoneTag || 'Unmarked').trim().toUpperCase();
      const g = map.get(k) || { mark: k, count: 0 };
      g.count++; map.set(k, g);
    } else if (/wall/i.test(a.clsName || '')) {
      const g = walls.get(a.clsName) || { cls: a.clsName, count: 0, lengthPx: 0 };
      g.count++; g.lengthPx += wallLengthPx(a); walls.set(a.clsName, g);
    }
  }

  // Enrich door/window rows from the extracted schedule (size, type).
  const enrich = (map, rows) => {
    const byMark = new Map((rows || []).map(x => [String(x.mark || '').trim().toUpperCase(), x]));
    return [...map.values()].map(g => {
      const s = byMark.get(g.mark) || {};
      return {
        mark: g.mark, count: g.count,
        width_mm: s.width_mm ?? null, height_mm: s.height_mm ?? null, type: s.type ?? null,
        scheduleCount: s.count ?? null,
      };
    }).sort((a, b) => a.mark.localeCompare(b.mark));
  };

  const roomRows = [...rooms.values()].map(g => ({
    tag: g.tag, count: g.count, areaM2: m2(g.areaPx), perimM: m(g.perimPx), areaPx: Math.round(g.areaPx),
  })).sort((a, b) => (b.areaM2 ?? b.areaPx) - (a.areaM2 ?? a.areaPx));
  const wallRows = [...walls.values()].map(g => ({
    cls: g.cls, count: g.count, lengthM: m(g.lengthPx), lengthPx: Math.round(g.lengthPx),
  }));

  const totals = {
    zones: roomRows.reduce((s, x) => s + x.count, 0),
    floorAreaM2: hasScale ? r2(roomRows.reduce((s, x) => s + (x.areaM2 || 0), 0)) : null,
    doors: [...doors.values()].reduce((s, x) => s + x.count, 0),
    windows: [...windows.values()].reduce((s, x) => s + x.count, 0),
    wallLengthM: hasScale ? r2(wallRows.reduce((s, x) => s + (x.lengthM || 0), 0)) : null,
    outstandingReviewFlags: outstanding,
  };
  return {
    hasScale, units: hasScale ? 'metric' : 'pixels',
    rooms: roomRows, doors: enrich(doors, reference?.doors), windows: enrich(windows, reference?.windows),
    walls: wallRows, totals,
  };
}

// The narrative prompt. The schedule is handed over as JSON; the model writes
// prose around it and is forbidden from inventing numbers.
function narrativePrompt({ project, schedule, qa, scaleDenom }) {
  const data = JSON.stringify({ project, scaleDenom, schedule, qa }, null, 1);
  return `You are a quantity surveyor writing the covering narrative for a quantity takeoff `
    + `produced from an architectural drawing. You are given the takeoff DATA as JSON. Write `
    + `in clear professional English, in Markdown, with exactly these H2 sections in order:\n`
    + `## Summary\n## Basis & Scale\n## Quantities\n## Inclusions\n## Exclusions\n`
    + `## Assumptions & Qualifications\n## Items to Verify\n\n`
    + `Rules:\n`
    + `- Use ONLY numbers present in the data. Never invent, estimate, or round further.\n`
    + `- In Quantities give the headline totals (floor area, door/window counts, wall length) `
    + `and refer the reader to the attached schedule for the per-room/per-mark breakdown — `
    + `do not reproduce the whole table.\n`
    + `- This takeoff is QUANTITIES ONLY and UNPRICED. Say so in the Summary.\n`
    + `- Inclusions: what was measured (zones/rooms, doors, windows, walls) from this sheet only.\n`
    + `- Exclusions: state clearly what is NOT measured — anything not on this sheet, MEP, `
    + `finishes, external works, and any class with zero detections.\n`
    + `- Assumptions: the scale basis (stated on drawing vs project setting), that quantities `
    + `are measured from the drawing not verified on site, wall length is centre-line from `
    + `detected extents, and areas are net internal from detected zone outlines.\n`
    + `- Items to Verify: list the QA findings and any outstanding review flags plainly, `
    + `each as one bullet. If none, say the QA pass raised nothing.\n`
    + `- If units are pixels (no scale), say prominently that no scale was set and quantities `
    + `are not in real units.\n`
    + `- No preamble, no closing sign-off. Markdown only.\n\n`
    + `DATA:\n${data}`;
}

module.exports = { buildSchedule, narrativePrompt };
