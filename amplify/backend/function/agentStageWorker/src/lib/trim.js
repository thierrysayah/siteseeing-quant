/**
 * Zone overhang trimming — a faithful port of the client's trimZoneOverhangs
 * (src/DetectionTool.jsx). Two overlapping zones are almost always either a
 * DUPLICATE (drop the smaller) or an OVERHANG (one zone pokes across the wall
 * into its neighbour — trim the offender). The offender is chosen from geometry
 * (vertex containment + compactness); when the signals disagree the pair is
 * left alone and reported, never guessed.
 *
 * Non-zone annotations pass through untouched.
 */
const polygonClipping = require('polygon-clipping');

function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return a / 2;
}
function ringPerimeterOf(r) {
  let p = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}
const mpAreaOf = (mp) => (mp || []).reduce(
  (s, poly) => s + poly.reduce((t, r, k) => t + (k === 0 ? Math.abs(ringSignedArea(r)) : -Math.abs(ringSignedArea(r))), 0), 0);
const mpPerimeterOf = (mp) => (mp || []).reduce(
  (s, poly) => s + poly.reduce((t, r) => t + ringPerimeterOf(r), 0), 0);
const compactnessOf = (mp) => {
  const A = mpAreaOf(mp), P = mpPerimeterOf(mp);
  return P > 0 ? (4 * Math.PI * A) / (P * P) : 0;
};
function pointInRingOf(pt, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function zoneRingOf(a) {
  if (a.shapeType === 'polygon' && a.points && a.points.length >= 3) {
    return a.points.map(([x, y]) => [x, y]);
  }
  if (a.shapeType === 'box' && a.x1 != null) {
    const { x1, y1, x2, y2 } = a;
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  }
  return null;
}
function dropClosingPt(r) {
  if (r.length > 1) {
    const [f, g] = r[0], [l, m] = r[r.length - 1];
    if (f === l && g === m) return r.slice(0, -1);
  }
  return r;
}

function trimZoneOverhangs(anns, { duplicateFrac = 0.5, minKeepPx = 20 } = {}) {
  const items = [];
  anns.forEach((a, i) => {
    const r = a.clsName === 'zone' ? zoneRingOf(a) : null;
    if (r) items.push({ i, a, ring: r, mp: [[r]], area: Math.abs(ringSignedArea(r)) });
  });
  if (items.length < 2) return { anns, trimmed: 0, removed: 0, ambiguous: 0, notes: [] };

  const dead = new Set(), clippers = new Map(), notes = [];
  let ambiguous = 0;

  for (let x = 0; x < items.length; x++) {
    for (let y = x + 1; y < items.length; y++) {
      const P = items[x], Q = items[y];
      if (dead.has(P.i) || dead.has(Q.i)) continue;
      let inter;
      try { inter = polygonClipping.intersection(P.mp, Q.mp); } catch { continue; }
      const ia = mpAreaOf(inter);
      if (ia < 1) continue;
      const smaller = Math.min(P.area, Q.area);

      if (ia / smaller > duplicateFrac) {
        const drop = P.area <= Q.area ? P : Q;
        const keep = drop === P ? Q : P;
        dead.add(drop.i);
        notes.push(`#${drop.a.numId} removed as duplicate (${(100 * ia / smaller).toFixed(0)}% inside #${keep.a.numId})`);
        continue;
      }

      const vP = P.ring.filter(pt => pointInRingOf(pt, Q.ring)).length;
      const vQ = Q.ring.filter(pt => pointInRingOf(pt, P.ring)).length;
      let dP, dQ;
      try {
        dP = compactnessOf(polygonClipping.difference(P.mp, Q.mp)) - compactnessOf(P.mp);
        dQ = compactnessOf(polygonClipping.difference(Q.mp, P.mp)) - compactnessOf(Q.mp);
      } catch { continue; }
      const byVerts = vP > vQ ? P : (vQ > vP ? Q : null);
      const byShape = dP > dQ ? P : Q;

      let offender = null;
      if (byVerts && byVerts === byShape) offender = byVerts;
      else if (!byVerts) offender = byShape;
      else { ambiguous++; notes.push(`#${P.a.numId}/#${Q.a.numId} ambiguous — left untouched`); continue; }

      const victim = offender === P ? Q : P;
      if (!clippers.has(offender.i)) clippers.set(offender.i, []);
      clippers.get(offender.i).push(victim.mp);
      notes.push(`#${offender.a.numId} overhang into #${victim.a.numId} trimmed (${ia.toFixed(0)}px²)`);
    }
  }

  let trimmed = 0, removed = dead.size;
  const out = anns.map((a, i) => {
    if (dead.has(i)) return null;
    const cl = clippers.get(i);
    if (!cl || !cl.length) return a;
    const me = items.find(t => t.i === i);
    let geom;
    try { geom = polygonClipping.difference(me.mp, ...cl); } catch { return a; }
    if (!geom || !geom.length) { removed++; return null; }
    let best = null, bestA = -1;
    for (const poly of geom) {
      const r = poly[0];
      if (!r || r.length < 4) continue;
      const ar = Math.abs(ringSignedArea(r));
      if (ar > bestA) { bestA = ar; best = r; }
    }
    if (!best || bestA < minKeepPx) { removed++; return null; }
    const pts = dropClosingPt(best.map(([x, y]) => [x, y]));
    if (pts.length < 3) return a;
    trimmed++;
    return { ...a, shapeType: 'polygon', points: pts, x1: null, y1: null, x2: null, y2: null };
  }).filter(Boolean);

  return { anns: out, trimmed, removed, ambiguous, notes };
}

/**
 * Run the trim repeatedly until it converges. A single pass can miss overlaps
 * whose resolution depends on a neighbour that only gets clipped at the end of
 * the pass (this is why pressing "Run trim" a second time fixes more). Iterating
 * to a fixed point resolves those cascades deterministically.
 */
function trimZoneOverhangsIterative(anns, opts = {}, maxPasses = 6) {
  let cur = anns;
  let totalTrimmed = 0, totalRemoved = 0, ambiguous = 0, passes = 0;
  let notes = [];
  for (let p = 0; p < maxPasses; p++) {
    const r = trimZoneOverhangs(cur, opts);
    passes = p + 1;
    totalTrimmed += r.trimmed;
    totalRemoved += r.removed;
    ambiguous = r.ambiguous;        // stable ambiguous set from the last pass
    notes = notes.concat(r.notes);
    cur = r.anns;
    if (r.trimmed === 0 && r.removed === 0) break;   // converged
  }
  return { anns: cur, trimmed: totalTrimmed, removed: totalRemoved, ambiguous, passes, notes };
}

module.exports = { trimZoneOverhangs, trimZoneOverhangsIterative };
