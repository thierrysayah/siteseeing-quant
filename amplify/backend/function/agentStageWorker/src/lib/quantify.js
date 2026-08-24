/**
 * P1c compute — cleanup (non-destructive hygiene) and quantify.
 *
 * Both operate on the detection array produced by the detect stage. Cleanup
 * never merges distinct zones and never silently deletes real objects — it only
 * drops degenerate slivers and *flags* low-confidence items for review. Quantify
 * turns the (cleaned) detections into takeoff numbers, in real units when the
 * project has a scale, else pixel-based.
 */

const LOW_CONF = 0.35;   // flag (not delete) anything below this
const MIN_AREA_PX = 9;   // drop degenerate boxes smaller than ~3×3 px

function bbox(a) {
  if (a.shapeType === 'polygon' && a.points && a.points.length) {
    const xs = a.points.map(p => p[0]), ys = a.points.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [a.x1, a.y1, a.x2, a.y2];
}

// Shoelace area + edge-sum perimeter for a polygon ring.
function polyAreaPerim(points) {
  let area = 0, perim = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
    perim += Math.hypot(x2 - x1, y2 - y1);
  }
  return { area: Math.abs(area) / 2, perim };
}

/**
 * Non-destructive cleanup. Returns { anns, stats }.
 * - drops degenerate/zero-area detections
 * - flags (keeps) low-confidence detections with `review: 'low_confidence'`
 * - never merges zones, never deletes a real object
 */
function cleanupDetections(anns) {
  let dropped = 0, flagged = 0;
  const kept = [];
  for (const a of anns) {
    if (a.shapeType === 'polygon' && (!a.points || a.points.length < 3)) { dropped++; continue; }
    const [x1, y1, x2, y2] = bbox(a);
    const area = Math.abs((x2 - x1) * (y2 - y1));
    if (!(area >= MIN_AREA_PX)) { dropped++; continue; }
    const copy = { ...a };
    if (a.confidence != null && a.confidence < LOW_CONF) { copy.review = 'low_confidence'; flagged++; }
    kept.push(copy);
  }
  return { anns: kept, stats: { total: kept.length, dropped, flagged } };
}

/**
 * Quantify detections → per-class counts + area/perimeter.
 * ratio = px→m (from the project scale); null → pixel-only.
 */
function quantify(anns, ratio) {
  const byClass = {};
  for (const a of anns) {
    const c = byClass[a.clsName] || (byClass[a.clsName] = { count: 0, areaPx: 0, perimPx: 0 });
    c.count++;
    if (a.shapeType === 'polygon' && a.points && a.points.length >= 3) {
      const { area, perim } = polyAreaPerim(a.points);
      c.areaPx += area; c.perimPx += perim;
    } else if (a.x1 != null) {
      const w = Math.abs(a.x2 - a.x1), h = Math.abs(a.y2 - a.y1);
      c.areaPx += w * h; c.perimPx += 2 * (w + h);
    }
  }
  const r = (typeof ratio === 'number' && ratio > 0) ? ratio : null;
  for (const c of Object.values(byClass)) {
    c.areaM2 = r ? +(c.areaPx * r * r).toFixed(2) : null;
    c.perimM = r ? +(c.perimPx * r).toFixed(2) : null;
    c.areaPx = Math.round(c.areaPx);
    c.perimPx = Math.round(c.perimPx);
  }
  return { byClass, hasScale: !!r, ratio: r };
}

module.exports = { cleanupDetections, quantify };
