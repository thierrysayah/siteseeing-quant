import { useState, useRef, useEffect, useCallback } from "react";
import { loadProject, saveProject } from "./services/projectStorage";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const WALL_MODEL_URL = "https://predict-69b7f2f29e8ba20d1c3c-dproatj77a-lm.a.run.app/predict";
const WALL_MODEL_HEADERS = { Authorization: "Bearer ul_28460c43f1db933b0dc3c576368ac6ce07f45392" };
const WALL_MODEL_DATA = { conf: 0.5, iou: 0.7, imgsz: 640 };

const ZONE_MODEL_URL = "https://predict-69bbe87c3bb65e1f7377-dproatj77a-nw.a.run.app/predict";
const ZONE_MODEL_HEADERS = { Authorization: "Bearer ul_28460c43f1db933b0dc3c576368ac6ce07f45392" };
const ZONE_MODEL_DATA = { conf: 0.25, iou: 0.7, imgsz: 640 };

// Instance segmentation model — zones only (returns polygons, not boxes)
const ZONE_SEG_MODEL_URL = "https://predict-69d4e9609d26fcda25f5-dproatj77a-od.a.run.app/predict";
const ZONE_SEG_MODEL_HEADERS = { Authorization: "Bearer ul_28460c43f1db933b0dc3c576368ac6ce07f45392" };
const ZONE_SEG_MODEL_DATA = { conf: 0.25, iou: 0.7, imgsz: 640 };

const IMAGE_SEARCH_URL   = ""; // set after ECS deployment — e.g. https://your-alb.amazonaws.com/search
const IMAGE_SEARCH_TOKEN = ""; // API_TOKEN env var value set on the ECS task
const IMAGE_SEARCH_COLOR = "#00FFEE"; // cyan — distinct from TEMP_COLOR red

const CLASSES = ["Internal_Wall", "External_Wall", "zone", "door", "window"];
const UNASSIGNED_CLASS = "Unassigned";
const CLASS_COLORS = {
  Internal_Wall: "#00B050",
  External_Wall: "#0070C0",
  zone: "#C00000",
  door: "#7030A0",
  window: "#ED7D31",
  Unassigned: "#667799",
};
const DEFAULT_COLOR = "#FFAA00";
const HOVER_COLOR = "#FFFF00";
const SELECTED_COLOR = "#FF00FF";
const SELECTED_MULTI_COLOR = "#FF88FF";
const TEMP_COLOR = "#D4263D";
const MEASURE_COLOR = "#00FFFF";
const MIN_BOX_SIZE = 4;
const ZONE_FILL_ALPHA = 0.27; // 70/255
const TILE_SIZE = 1280;
const TILE_OVERLAP = 128;
const NMS_IOU_THRESH = 0.4;

const DEFAULT_ZONE_TAGS = { bathroom: "#4FC3F7", kitchen: "#FFB74D" };
const PDF_RENDER_DPI = 150; // matches Python: fitz.Matrix(150/72, 150/72)
const PDF_SCALE = PDF_RENDER_DPI / 72; // pdf.js uses 72 dpi as base

// ─── PDF.JS LOADER ────────────────────────────────────────────────────────────
// Lazy-loads pdf.js from cdnjs. Returns the pdfjsLib global.
let _pdfJsPromise = null;
function loadPdfJs() {
  if (_pdfJsPromise) return _pdfJsPromise;
  _pdfJsPromise = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return _pdfJsPromise;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const safeColor = (cls) => CLASS_COLORS[cls] || DEFAULT_COLOR;
const hexToRgba = (hex, alpha) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

function pointInPolygon(x, y, pts) {
  if (!pts || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y)) {
      const xInt = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xInt) inside = !inside;
    }
  }
  return inside;
}

function bboxOfPoints(pts) {
  if (!pts || !pts.length) return [0, 0, 0, 0];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function annotationBbox(ann) {
  if (ann.shapeType === "box") return [ann.x1, ann.y1, ann.x2, ann.y2];
  if (ann.shapeType === "line") return [Math.min(ann.x1, ann.x2), Math.min(ann.y1, ann.y2), Math.max(ann.x1, ann.x2), Math.max(ann.y1, ann.y2)];
  return bboxOfPoints(ann.points);
}

function annotationAreaPx(ann) {
  if (ann.shapeType === "box") {
    const [x1, y1, x2, y2] = annotationBbox(ann);
    return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  }
  const pts = ann.points || [];
  if (pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function annotationPerimeterPx(ann) {
  if (ann.shapeType === "box") {
    const [x1, y1, x2, y2] = annotationBbox(ann);
    return 2 * (Math.max(0, x2 - x1) + Math.max(0, y2 - y1));
  }
  if (ann.shapeType === "line") return Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
  const pts = ann.points || [];
  if (pts.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

function annotationContains(ann, x, y) {
  if (ann.shapeType === "box") {
    return ann.x1 <= x && x <= ann.x2 && ann.y1 <= y && y <= ann.y2;
  }
  if (ann.shapeType === "line") {
    const dx = ann.x2 - ann.x1, dy = ann.y2 - ann.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1) return Math.hypot(x - ann.x1, y - ann.y1) < 8;
    const t = Math.max(0, Math.min(1, ((x - ann.x1) * dx + (y - ann.y1) * dy) / lenSq));
    return Math.hypot(x - (ann.x1 + t * dx), y - (ann.y1 + t * dy)) < 8;
  }
  return pointInPolygon(x, y, ann.points || []);
}

function isValidAnnotation(ann) {
  if (ann.shapeType === "line") return Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1) >= MIN_BOX_SIZE;
  const [x1, y1, x2, y2] = annotationBbox(ann);
  const w = x2 - x1, h = y2 - y1;
  if (ann.shapeType === "box") return w >= MIN_BOX_SIZE && h >= MIN_BOX_SIZE;
  return (ann.points || []).length >= 3 && w >= MIN_BOX_SIZE && h >= MIN_BOX_SIZE;
}

function parseModelResponse(json, sourceModel) {
  const result = [];
  if (!json || !json.images) return result;
  for (const img of json.images) {
    for (const item of img.results || []) {
      const cls = item.name || item.class_name || String(item.class || "unknown");
      const { x1, y1, x2, y2 } = item.box || {};
      if (x1 !== undefined) {
        result.push({
          id: Math.random().toString(36).slice(2),
          shapeType: "box",
          clsName: cls,
          confidence: item.confidence ?? null,
          sourceModel,
          zoneTag: null,
          x1: Math.min(x1, x2),
          y1: Math.min(y1, y2),
          x2: Math.max(x1, x2),
          y2: Math.max(y1, y2),
          points: null,
        });
      }
    }
  }
  return result;
}

// Parse segmentation model response — returns polygon annotations
// autoEps > 0 runs RDP simplification on import; pass 0 to skip.
function parseSegmentationResponse(json, sourceModel, autoEps = 5) {
  const result = [];
  if (!json || !json.images) return result;
  for (const img of json.images) {
    for (const item of img.results || []) {
      const rawCls = item.name || item.class_name || String(item.class || "unknown");
      // Remap model-specific class names to the app's class vocabulary
      const cls = rawCls === "room" ? "zone" : rawCls;
      let points = null;

      if (item.segments) {
        if (Array.isArray(item.segments.x) && Array.isArray(item.segments.y)) {
          // Ultralytics format: { x: [...], y: [...] } — may be normalised (0–1) or pixel coords
          const xs = item.segments.x;
          const ys = item.segments.y;
          points = xs.map((x, i) => [x, ys[i]]);
        } else if (Array.isArray(item.segments)) {
          // Flat [[x,y], ...] format
          points = item.segments;
        }
      }

      if (points && points.length >= 3) {
        const simplified = autoEps > 0 ? rdpSimplifyPolygon(points, autoEps) : points;
        result.push({
          id: Math.random().toString(36).slice(2),
          shapeType: "polygon",
          clsName: cls,
          confidence: item.confidence ?? null,
          sourceModel,
          zoneTag: null,
          x1: null, y1: null, x2: null, y2: null,
          points: simplified,
        });
      } else if (item.box) {
        // Fallback to bounding box if no valid polygon returned
        const { x1, y1, x2, y2 } = item.box || {};
        if (x1 !== undefined) {
          result.push({
            id: Math.random().toString(36).slice(2),
            shapeType: "box",
            clsName: cls,
            confidence: item.confidence ?? null,
            sourceModel,
            zoneTag: null,
            x1: Math.min(x1, x2), y1: Math.min(y1, y2),
            x2: Math.max(x1, x2), y2: Math.max(y1, y2),
            points: null,
          });
        }
      }
    }
  }
  return result;
}

// Offset an annotation by tile origin (handles both boxes and polygons)
function offsetAnnotation(ann, tx, ty) {
  if (ann.shapeType === "polygon" && ann.points) {
    return { ...ann, points: ann.points.map(([x, y]) => [x + tx, y + ty]) };
  }
  return { ...ann, x1: ann.x1 + tx, y1: ann.y1 + ty, x2: ann.x2 + tx, y2: ann.y2 + ty };
}

// ─── Ramer-Douglas-Peucker polygon simplification ────────────────────────────
function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const [x1, y1] = points[0];
  const [xn, yn] = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const num = Math.abs((yn - y1) * px - (xn - x1) * py + xn * y1 - yn * x1);
    const den = Math.hypot(yn - y1, xn - x1);
    const dist = den < 1e-10 ? Math.hypot(px - x1, py - y1) : num / den;
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left  = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [points[0], points[points.length - 1]];
}

function rdpSimplifyPolygon(points, epsilon) {
  if (points.length <= 3) return points;
  // Close the polygon, run RDP, then remove the duplicated closing point
  const open       = [...points, points[0]];
  const simplified = rdpSimplify(open, epsilon);
  const result     = simplified.slice(0, -1);
  return result.length >= 3 ? result : points;
}

// IoU for NMS
function iou(a, b) {
  const [ax1, ay1, ax2, ay2] = annotationBbox(a);
  const [bx1, by1, bx2, by2] = annotationBbox(b);
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const aArea = (ax2 - ax1) * (ay2 - ay1);
  const bArea = (bx2 - bx1) * (by2 - by1);
  return inter / (aArea + bArea - inter + 1e-9);
}

function nms(anns, thresh) {
  const sorted = [...anns].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const keep = [];
  const suppressed = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!suppressed.has(j) && sorted[i].clsName === sorted[j].clsName) {
        if (iou(sorted[i], sorted[j]) > thresh) suppressed.add(j);
      }
    }
  }
  return keep;
}

// ─── CANVAS DRAW ──────────────────────────────────────────────────────────────
function drawAnnotations(ctx, anns, scale, {
  ratio, hoverIdx, selectedIdx, selectedIndices,
  tempBox, tempPolyPts, tempPolyMouse, tempLine, tempLineShape, lastMeasureLine,
  hotHandle, zoneTags, classColors, tempCircle, lastLineIsMeasure,
  areaTextColor, perimTextColor, measureTextColor, showConfidence,
}) {
  const getColor = (cls) => (classColors && classColors[cls]) || CLASS_COLORS[cls] || DEFAULT_COLOR;
  // Tagged shape fills (all classes)
  for (const ann of anns) {
    if (ann.zoneTag) {
      const color = zoneTags[ann.zoneTag];
      if (color) {
        ctx.fillStyle = hexToRgba(color, ZONE_FILL_ALPHA);
        const [x1, y1, x2, y2] = annotationBbox(ann);
        if (ann.shapeType === "box") {
          ctx.fillRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
        } else if (ann.points && ann.points.length >= 3) {
          ctx.beginPath();
          ctx.moveTo(ann.points[0][0] * scale, ann.points[0][1] * scale);
          for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i][0] * scale, ann.points[i][1] * scale);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }

  // Annotations
  anns.forEach((ann, i) => {
    let color = getColor(ann.clsName);
    let lw = 2;
    if (i === hoverIdx) { color = HOVER_COLOR; lw = 3; }
    if (selectedIndices && selectedIndices.has(i) && i !== selectedIdx) { color = SELECTED_MULTI_COLOR; lw = 3; }
    if (i === selectedIdx) { color = SELECTED_COLOR; lw = 4; }

    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    const [x1, y1, x2, y2] = annotationBbox(ann);

    if (ann.shapeType === "box") {
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    } else if (ann.shapeType === "line") {
      ctx.beginPath();
      ctx.moveTo(ann.x1 * scale, ann.y1 * scale);
      ctx.lineTo(ann.x2 * scale, ann.y2 * scale);
      ctx.stroke();
      // Endpoint dots
      ctx.fillStyle = color;
      [[ann.x1, ann.y1], [ann.x2, ann.y2]].forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px * scale, py * scale, 4, 0, Math.PI * 2);
        ctx.fill();
      });
      // Length label
      const lineLen = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
      const lmx = ((ann.x1 + ann.x2) / 2) * scale + 4;
      const lmy = Math.max(12, ((ann.y1 + ann.y2) / 2) * scale - 8);
      ctx.font = "bold 11px monospace";
      ctx.fillStyle = color;
      if (ratio) {
        ctx.fillText(`${(lineLen * ratio).toFixed(3)} m`, lmx, lmy);
      } else {
        ctx.fillText(`${lineLen.toFixed(1)} px`, lmx, lmy);
      }
    } else if (ann.points && ann.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(ann.points[0][0] * scale, ann.points[0][1] * scale);
      for (let j = 1; j < ann.points.length; j++) ctx.lineTo(ann.points[j][0] * scale, ann.points[j][1] * scale);
      ctx.closePath();
      ctx.stroke();
    }

    // Label (skip for line — length already shown inline)
    if (ann.shapeType !== "line") {
      let label = ann.clsName;
      if (ann.zoneTag) label += `: ${ann.zoneTag}`;
      if (showConfidence && ann.confidence != null) label += ` ${ann.confidence.toFixed(2)}`;
      if (ann.shapeType === "polygon") label += " [poly]";
      ctx.fillStyle = color;
      ctx.font = "bold 11px monospace";
      ctx.fillText(label, x1 * scale + 3, Math.max(12, y1 * scale - 4));
    }

    // Area/perimeter overlay — all polygons + any box classed as "zone"
    if ((ann.shapeType === "polygon" || ann.clsName === "zone") && ratio) {
      const areaPx = annotationAreaPx(ann);
      const areaM2 = areaPx * ratio * ratio;
      const perimPx = annotationPerimeterPx(ann);
      const perimM = perimPx * ratio;
      const cx = ((x1 + x2) / 2) * scale;
      const cy = ((y1 + y2) / 2) * scale;
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = areaTextColor || "#c0c0c0";
      ctx.fillText(`${areaM2.toFixed(2)} m²`, cx, cy);
      ctx.fillStyle = perimTextColor || "#c0c0c0";
      ctx.fillText(`P: ${perimM.toFixed(2)} m`, cx, cy + 16);
    }
  });

  // Box handles for selected
  if (selectedIdx != null && anns[selectedIdx]?.shapeType === "box") {
    const ann = anns[selectedIdx];
    const [x1, y1, x2, y2] = annotationBbox(ann);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const handlePts = [
      [x1, y1], [mx, y1], [x2, y1],
      [x1, my],           [x2, my],
      [x1, y2], [mx, y2], [x2, y2],
    ];
    handlePts.forEach(([hx, hy], hi) => {
      ctx.fillStyle = hi === hotHandle ? "#FF3300" : "#FFFFFF";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.fillRect(hx * scale - 6, hy * scale - 6, 12, 12);
      ctx.strokeRect(hx * scale - 6, hy * scale - 6, 12, 12);
    });
  }

  // Polygon vertex handles
  if (selectedIdx != null && anns[selectedIdx]?.shapeType === "polygon") {
    const ann = anns[selectedIdx];
    (ann.points || []).forEach(([px, py]) => {
      ctx.fillStyle = "#FFFFFF";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px * scale, py * scale, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  // Line endpoint handles
  if (selectedIdx != null && anns[selectedIdx]?.shapeType === "line") {
    const ann = anns[selectedIdx];
    [[ann.x1, ann.y1], [ann.x2, ann.y2]].forEach(([px, py]) => {
      ctx.fillStyle = "#FFFFFF";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px * scale, py * scale, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  // Temp box
  if (tempBox) {
    const isSearchBox = tempBox._isImageSearch === true;
    ctx.strokeStyle = isSearchBox ? IMAGE_SEARCH_COLOR : TEMP_COLOR;
    ctx.lineWidth = isSearchBox ? 2 : 2;
    if (isSearchBox) ctx.setLineDash([6, 3]);
    const [x1, y1, x2, y2] = annotationBbox(tempBox);
    ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    ctx.setLineDash([]);
    ctx.fillStyle = isSearchBox ? IMAGE_SEARCH_COLOR : "#FFFFFF";
    ctx.font = "bold 11px monospace";
    ctx.fillText(isSearchBox ? "Image Search" : tempBox.clsName, x1 * scale + 3, Math.max(12, y1 * scale - 4));
  }

  // Temp polygon
  if (tempPolyPts && tempPolyPts.length > 0) {
    ctx.strokeStyle = TEMP_COLOR;
    ctx.fillStyle = TEMP_COLOR;
    ctx.lineWidth = 2;
    if (tempPolyPts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(tempPolyPts[0][0] * scale, tempPolyPts[0][1] * scale);
      for (let i = 1; i < tempPolyPts.length; i++) ctx.lineTo(tempPolyPts[i][0] * scale, tempPolyPts[i][1] * scale);
      ctx.stroke();
    }
    tempPolyPts.forEach(([px, py]) => {
      ctx.beginPath();
      ctx.arc(px * scale, py * scale, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    if (tempPolyMouse && tempPolyPts.length > 0) {
      const last = tempPolyPts[tempPolyPts.length - 1];
      ctx.beginPath();
      ctx.moveTo(last[0] * scale, last[1] * scale);
      ctx.lineTo(tempPolyMouse[0] * scale, tempPolyMouse[1] * scale);
      ctx.stroke();
    }
  }

  // Temp circle preview
  if (tempCircle && tempCircle.r > 0) {
    ctx.strokeStyle = TEMP_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.arc(tempCircle.cx * scale, tempCircle.cy * scale, tempCircle.r * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // crosshair at centre
    ctx.fillStyle = TEMP_COLOR;
    ctx.beginPath();
    ctx.arc(tempCircle.cx * scale, tempCircle.cy * scale, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Temp line shape preview (for lineShape draw mode)
  if (tempLineShape && tempLineShape.length === 2) {
    const [p1, p2] = tempLineShape;
    ctx.strokeStyle = TEMP_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(p1[0] * scale, p1[1] * scale);
    ctx.lineTo(p2[0] * scale, p2[1] * scale);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = TEMP_COLOR;
    [p1, p2].forEach(([px, py]) => {
      ctx.beginPath();
      ctx.arc(px * scale, py * scale, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Measure lines
  const drawMeasureLine = (line, isTemp, realM) => {
    if (!line || line.length !== 2) return;
    const [p1, p2] = line;
    const mColor = measureTextColor || MEASURE_COLOR;
    ctx.strokeStyle = mColor;
    ctx.fillStyle = mColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p1[0] * scale, p1[1] * scale);
    ctx.lineTo(p2[0] * scale, p2[1] * scale);
    ctx.stroke();
    [p1, p2].forEach(([px, py]) => {
      ctx.beginPath();
      ctx.arc(px * scale, py * scale, 4, 0, Math.PI * 2);
      ctx.fill();
    });
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const mx = ((p1[0] + p2[0]) / 2) * scale + 4;
    const my = Math.max(12, ((p1[1] + p2[1]) / 2) * scale - 18);
    ctx.font = "bold 11px monospace";
    if (realM != null) {
      ctx.fillText(`${realM.toFixed(3)} m`, mx, my);
      ctx.fillText(`(${len.toFixed(1)} px)`, mx, my + 14);
    } else {
      ctx.fillText(`${len.toFixed(1)} px`, mx, my);
    }
  };
  // Compute real-world distance live so it always reflects the current ratio
  const lastLineRealM = (() => {
    if (!lastLineIsMeasure || !ratio || !lastMeasureLine) return null;
    const [p1, p2] = lastMeasureLine;
    return Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * ratio;
  })();
  drawMeasureLine(lastMeasureLine, false, lastLineRealM);
  drawMeasureLine(tempLine, true);
}

// ─── PDF REGION SELECTOR MODAL ────────────────────────────────────────────────
// Replicates open_pdf_region_selector() from the Python script.
// Props:
//   pdfData  – ArrayBuffer of the uploaded PDF
//   onConfirm(canvas) – called with a HTMLCanvasElement of the cropped region
//   onCancel()
function PdfRegionSelector({ pdfData, onConfirm, onCancel }) {
  const previewCanvasRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageCount, setPageCount] = useState(1);
  const [pageIndex, setPageIndex] = useState(0);          // 0-based
  const [pageCanvas, setPageCanvas] = useState(null);     // full-res rendered page
  const [prevScale, setPrevScale] = useState(1);          // preview / full
  const [rect, setRect] = useState(null);                 // {x1,y1,x2,y2} in PREVIEW coords
  const [selStatus, setSelStatus] = useState("Drag on the preview to select a region.");
  const [loadError, setLoadError] = useState(null);
  const dragStart = useRef(null);
  const isDragging = useRef(false);

  // ── Load pdf.js + parse document ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    loadPdfJs().then(async (pdfjsLib) => {
      // Copy the ArrayBuffer before handing it to pdf.js: the worker transfer
      // detaches the original, causing a DataCloneError on any subsequent load.
      const typedArray = new Uint8Array(pdfData.slice(0));
      const doc = await pdfjsLib.getDocument({ data: typedArray }).promise;
      if (cancelled) return;
      setPdfDoc(doc);
      setPageCount(doc.numPages);
      setPageIndex(0);
    }).catch((err) => {
      console.error('[PdfRegionSelector] Failed to load PDF:', err);
      if (!cancelled) setLoadError(err?.message || 'Failed to parse PDF.');
    });
    return () => { cancelled = true; };
  }, [pdfData]);

  // ── Render a page at PDF_RENDER_DPI onto an offscreen canvas ──────────────
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdfDoc.getPage(pageIndex + 1); // pdf.js is 1-based
        const viewport = page.getViewport({ scale: PDF_SCALE });
        const offscreen = document.createElement("canvas");
        offscreen.width  = Math.round(viewport.width);
        offscreen.height = Math.round(viewport.height);
        await page.render({ canvasContext: offscreen.getContext("2d"), viewport }).promise;
        if (cancelled) return;
        setPageCanvas(offscreen);
        setRect(null);
        setSelStatus("Drag on the preview to select a region, or use 'Full Page'.");
      } catch (err) {
        console.error('[PdfRegionSelector] Failed to render page:', err);
        if (!cancelled) setLoadError(err?.message || 'Failed to render this page.');
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, pageIndex]);

  // ── Scale the full-res page into the preview canvas ───────────────────────
  useEffect(() => {
    if (!pageCanvas || !previewCanvasRef.current) return;
    const container = previewCanvasRef.current.parentElement;
    const maxW = container.clientWidth  - 4;
    const maxH = container.clientHeight - 4;
    const ps   = Math.min(maxW / pageCanvas.width, maxH / pageCanvas.height, 1.0);
    setPrevScale(ps);
    const pw = Math.round(pageCanvas.width  * ps);
    const ph = Math.round(pageCanvas.height * ps);
    const cv = previewCanvasRef.current;
    cv.width  = pw;
    cv.height = ph;
    const ctx = cv.getContext("2d");
    ctx.drawImage(pageCanvas, 0, 0, pw, ph);
    if (rect) drawRect(ctx, rect);
  }, [pageCanvas, rect]);

  // ── Redraw rect overlay ────────────────────────────────────────────────────
  function drawRect(ctx, r) {
    if (!r) return;
    const { x1, y1, x2, y2 } = r;
    ctx.strokeStyle = "#FF3300";
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillStyle = "rgba(255,51,0,0.18)";
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  }

  function repaint(r) {
    const cv = previewCanvasRef.current;
    if (!cv || !pageCanvas) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(pageCanvas, 0, 0, cv.width, cv.height);
    if (r) drawRect(ctx, r);
  }

  // ── Mouse events on the preview canvas ────────────────────────────────────
  function getPreviewXY(e) {
    const rect_ = previewCanvasRef.current.getBoundingClientRect();
    return {
      px: clamp(e.clientX - rect_.left, 0, previewCanvasRef.current.width  - 1),
      py: clamp(e.clientY - rect_.top,  0, previewCanvasRef.current.height - 1),
    };
  }

  function onPreviewMouseDown(e) {
    if (e.button !== 0) return;
    isDragging.current = true;
    const { px, py } = getPreviewXY(e);
    dragStart.current = [px, py];
    setRect(null);
    repaint(null);
  }

  function onPreviewMouseMove(e) {
    if (!isDragging.current || !dragStart.current) return;
    const { px, py } = getPreviewXY(e);
    const [sx, sy] = dragStart.current;
    const r = { x1: Math.min(sx, px), y1: Math.min(sy, py), x2: Math.max(sx, px), y2: Math.max(sy, py) };
    setRect(r);
    repaint(r);
    // status
    if (pageCanvas && prevScale > 0) {
      const fx1 = Math.round(r.x1 / prevScale), fy1 = Math.round(r.y1 / prevScale);
      const fx2 = Math.round(r.x2 / prevScale), fy2 = Math.round(r.y2 / prevScale);
      setSelStatus(`Selection: (${fx1},${fy1}) → (${fx2},${fy2})  |  ${fx2-fx1} × ${fy2-fy1} px at ${PDF_RENDER_DPI} DPI`);
    }
  }

  function onPreviewMouseUp() { isDragging.current = false; }

  // ── Confirm: crop the full-res pageCanvas and return it ───────────────────
  function handleConfirm() {
    if (!pageCanvas) return;
    let fx1 = 0, fy1 = 0, fx2 = pageCanvas.width, fy2 = pageCanvas.height;
    if (rect && prevScale > 0) {
      fx1 = clamp(Math.round(rect.x1 / prevScale), 0, pageCanvas.width);
      fy1 = clamp(Math.round(rect.y1 / prevScale), 0, pageCanvas.height);
      fx2 = clamp(Math.round(rect.x2 / prevScale), 0, pageCanvas.width);
      fy2 = clamp(Math.round(rect.y2 / prevScale), 0, pageCanvas.height);
    }
    const cropW = fx2 - fx1, cropH = fy2 - fy1;
    if (cropW < 4 || cropH < 4) { setSelStatus("Selection too small — use Full Page."); return; }
    const out = document.createElement("canvas");
    out.width = cropW; out.height = cropH;
    out.getContext("2d").drawImage(pageCanvas, fx1, fy1, cropW, cropH, 0, 0, cropW, cropH);
    onConfirm(out);
  }

  function handleFullPage() {
    if (!pageCanvas) return;
    onConfirm(pageCanvas);
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <div style={pdfStyles.overlay}>
      <div style={pdfStyles.modal}>
        <div style={pdfStyles.header}>
          <span style={pdfStyles.title}>📄 PDF REGION SELECTOR</span>
          <span style={pdfStyles.subtitle}>
            Drag a rectangle to select a region for inference, or use the full page.
          </span>
        </div>

        {pageCount > 1 && (
          <div style={pdfStyles.pageRow}>
            <span style={pdfStyles.pageLabel}>Page:</span>
            <button onClick={() => setPageIndex(i => Math.max(0, i - 1))} style={pdfStyles.pageBtn} disabled={pageIndex === 0}>◀</button>
            <span style={pdfStyles.pageNum}>{pageIndex + 1} / {pageCount}</span>
            <button onClick={() => setPageIndex(i => Math.min(pageCount - 1, i + 1))} style={pdfStyles.pageBtn} disabled={pageIndex === pageCount - 1}>▶</button>
          </div>
        )}

        <div style={pdfStyles.canvasWrap}>
          {!pageCanvas && !loadError && (
            <div style={pdfStyles.loading}>⟳ Rendering page…</div>
          )}
          {loadError && (
            <div style={{ ...pdfStyles.loading, color: "#e05555", maxWidth: 480, textAlign: "center", lineHeight: 1.6 }}>
              ✕ Could not render this PDF.<br />
              <span style={{ fontSize: 10, color: "#7a4a4a" }}>{loadError}</span><br /><br />
              <span style={{ fontSize: 11, color: "#5a7a9a" }}>
                Try exporting the drawing as a PNG or TIFF from your CAD software and use Load Image instead.
              </span>
            </div>
          )}
          <canvas
            ref={previewCanvasRef}
            style={{ display: pageCanvas ? "block" : "none", cursor: "crosshair", maxWidth: "100%", maxHeight: "100%" }}
            onMouseDown={onPreviewMouseDown}
            onMouseMove={onPreviewMouseMove}
            onMouseUp={onPreviewMouseUp}
            onMouseLeave={onPreviewMouseUp}
          />
        </div>

        <div style={pdfStyles.statusRow}>{selStatus}</div>

        <div style={pdfStyles.btnRow}>
          <button onClick={handleConfirm} disabled={!pageCanvas} style={pdfStyles.confirmBtn}>✓ Confirm Selection</button>
          <button onClick={handleFullPage} disabled={!pageCanvas} style={pdfStyles.fullBtn}>⬜ Use Full Page</button>
          <button onClick={() => { setRect(null); if (pageCanvas) repaint(null); setSelStatus("Rectangle cleared."); }} style={pdfStyles.clearBtn}>Clear Rect</button>
          <button onClick={onCancel} style={pdfStyles.cancelBtn}>✕ Cancel</button>
        </div>
      </div>
    </div>
  );
}

const pdfStyles = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
  modal: { background: "#0c1020", border: "1px solid #1e3050", borderRadius: 6, display: "flex", flexDirection: "column", width: "92vw", height: "90vh", overflow: "hidden", boxShadow: "0 8px 40px rgba(0,0,0,0.7)" },
  header: { padding: "10px 14px 6px", borderBottom: "1px solid #1a2a40", display: "flex", flexDirection: "column", gap: 2 },
  title: { color: "#4af", fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 13, letterSpacing: 2 },
  subtitle: { color: "#5a7a9a", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 },
  pageRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderBottom: "1px solid #141e30" },
  pageLabel: { color: "#5a7a9a", fontSize: 11, fontFamily: "monospace" },
  pageNum: { color: "#8ab", fontSize: 12, fontFamily: "monospace", minWidth: 60, textAlign: "center" },
  pageBtn: { background: "#152240", border: "1px solid #2a4070", borderRadius: 3, color: "#8ab", padding: "2px 8px", cursor: "pointer", fontSize: 12 },
  canvasWrap: { flex: 1, overflow: "auto", background: "#08101a", display: "flex", alignItems: "flex-start", justifyContent: "flex-start", padding: 8, position: "relative" },
  loading: { color: "#3a5c7a", fontFamily: "monospace", fontSize: 13, padding: 24 },
  statusRow: { padding: "5px 14px", color: "#5a9a7a", fontSize: 10, fontFamily: "monospace", borderTop: "1px solid #141e30", minHeight: 22 },
  btnRow: { display: "flex", gap: 8, padding: "8px 14px", borderTop: "1px solid #1a2a40" },
  confirmBtn: { background: "#0f3460", border: "1px solid #1e5a9a", borderRadius: 3, color: "#7af", padding: "5px 14px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" },
  fullBtn: { background: "#0d3d2a", border: "1px solid #1a6644", borderRadius: 3, color: "#6da", padding: "5px 14px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" },
  clearBtn: { background: "#1a1a2a", border: "1px solid #2a2a44", borderRadius: 3, color: "#7a8a9a", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" },
  cancelBtn: { background: "#2a1010", border: "1px solid #5a2020", borderRadius: 3, color: "#c66", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", marginLeft: "auto" },
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function DetectionTool({ project, user, onBack }) {
  // Image state
  const [originalImg, setOriginalImg] = useState(null); // HTMLImageElement
  const [imgNaturalSize, setImgNaturalSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1.0);
  const [baseScale, setBaseScale] = useState(1.0);
  const scale = baseScale * zoom;

  // Annotations
  const [annotations, setAnnotations] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [hoverIdx, setHoverIdx] = useState(null);

  // Visibility
  const [visibleClasses, setVisibleClasses] = useState(new Set(CLASSES));

  // Drawing
  const [drawMode, setDrawMode] = useState("select"); // select | lineShape | box | polygon | circle | line | measure
  const [newClass, setNewClass] = useState("Internal_Wall");
  const [tempBox, setTempBox] = useState(null);
  const [tempPolyPts, setTempPolyPts] = useState([]);
  const [tempPolyMouse, setTempPolyMouse] = useState(null);
  const [tempLine, setTempLine] = useState(null);
  const [tempLineShape, setTempLineShape] = useState(null); // preview while drawing a line annotation
  const [lastMeasureLine, setLastMeasureLine] = useState(null);
  const [lastMeasurePx, setLastMeasurePx] = useState("");

  // ─── Undo / Redo (up to 10 snapshots each) ───────────────────────────────────
  const [history, setHistory] = useState([]);  // past states (oldest → newest)
  const [future,  setFuture]  = useState([]);  // redo states (most-recent-undone first)
  const preDragSnapshot = useRef(null); // captured at drag-start, pushed at drag-end
  const didDrag = useRef(false);        // true only if the shape actually moved during the drag

  const snapshotAnns = (anns) => anns.map(a => ({
    ...a,
    points: a.points ? a.points.map(p => [...p]) : null,
  }));

  // Every new action pushes to history and wipes the redo stack
  const pushHistory = useCallback((anns) => {
    setHistory(prev => [...prev.slice(-9), snapshotAnns(anns)]);
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    setHistory(prev => {
      if (!prev.length) return prev;
      const snapshot = prev[prev.length - 1];
      // Save current annotations into redo stack before restoring
      setAnnotations(current => {
        setFuture(f => [...f.slice(-9), snapshotAnns(current)]);
        return snapshot;
      });
      setSelectedIdx(null);
      setSelectedIndices(new Set());
      setStatus(`Undo — ${prev.length - 1} step(s) remaining.`);
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture(prev => {
      if (!prev.length) return prev;
      const snapshot = prev[prev.length - 1];
      setAnnotations(current => {
        setHistory(h => [...h.slice(-9), snapshotAnns(current)]);
        return snapshot;
      });
      setSelectedIdx(null);
      setSelectedIndices(new Set());
      setStatus(`Redo — ${prev.length - 1} step(s) remaining.`);
      return prev.slice(0, -1);
    });
  }, []);

  // Box / shape drag internals
  const boxDrawing = useRef(false);
  const boxStart = useRef(null);
  const lineDrawing = useRef(false);
  const lineStart = useRef(null);
  const mouseDown = useRef(false);
  const dragAnnIdx = useRef(null);       // whole-shape move
  const dragStart = useRef(null);        // [ox,oy] image-coords where drag began
  const dragOrigPts = useRef(null);      // polygon: full points snapshot; box: [x1,y1,x2,y2]
  const handleDragging = useRef(null);   // box corner handle index
  const handleAnnIdx = useRef(null);
  const handleOrigBox = useRef(null);
  const handleDragScreenStart = useRef(null);
  // polygon vertex drag
  const polyVtxDragging = useRef(null);  // vertex index, or null
  const polyVtxAnnIdx = useRef(null);
  const polyVtxOrigPts = useRef(null);   // full points snapshot before drag
  const polyVtxDragStart = useRef(null); // [ox,oy] image-coords
  // line endpoint drag
  const lineEndDragging = useRef(null);  // 0 = p1, 1 = p2, null = none
  const lineEndAnnIdx = useRef(null);
  const lineEndOrigCoords = useRef(null); // [x1,y1,x2,y2] before drag
  const lineEndDragStart = useRef(null);  // [ox,oy] image-coords

  // Scale / measure
  const [pixelLength, setPixelLength] = useState("");
  const [realLength, setRealLength] = useState("");
  const [ratio, setRatio] = useState(null);

  // Zone tags
  const [zoneTags, setZoneTags] = useState({ ...DEFAULT_ZONE_TAGS });
  const [showTagManager, setShowTagManager] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#4FC3F7");
  const [selectedZoneTag, setSelectedZoneTag] = useState("");

  // Inference
  const [inferring, setInferring] = useState(false);
  const [imageSearching, setImageSearching] = useState(false);
  const [status, setStatus] = useState("Load an image to begin.");

  // PDF import state
  const [pdfModalData, setPdfModalData] = useState(null); // ArrayBuffer when modal is open
  const [confOverride, setConfOverride] = useState("");
  const [editClass, setEditClass] = useState("Internal_Wall");
  const [editConf, setEditConf] = useState("");

  // Polygon editing
  const [simplifyEpsilon, setSimplifyEpsilon] = useState("3");

  // Settings
  const [showSettings,      setShowSettings]      = useState(false);
  const [showConfidence,    setShowConfidence]    = useState(false);
  const [autoSimplifyDist,  setAutoSimplifyDist]  = useState("0"); // 0 = off
  const [areaTextColor,     setAreaTextColor]     = useState("#c0c0c0");
  const [perimTextColor,    setPerimTextColor]    = useState("#c0c0c0");
  const [measureTextColor,  setMeasureTextColor]  = useState("#00FFFF");
  const [autoSave,          setAutoSave]          = useState(false);
  const [autoSaveInterval,  setAutoSaveInterval]  = useState("30"); // seconds
  const handleSaveRef = useRef(null); // always points to latest handleSave (avoids stale closure)
  const isDirty = useRef(false);      // true when annotations have changed since last save

  // Circle drawing temp state (image coords)
  const [tempCircle, setTempCircle] = useState(null); // {cx, cy, r}

  // Measure tool result
  const [lastLineIsMeasure, setLastLineIsMeasure] = useState(false); // true = measure tool, false = scale cal

  // Custom classes
  const [customClasses, setCustomClasses] = useState([]);
  const [showClassManager, setShowClassManager] = useState(false);
  const [newCustomClassName, setNewCustomClassName] = useState("");
  const [newCustomClassColor, setNewCustomClassColor] = useState("#FF6B6B");

  // File tracking & save state
  const [currentFile, setCurrentFile] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [lastSaveTime, setLastSaveTime] = useState(null); // Date of last successful save
  // Persists file info across re-saves so originalExt is never overwritten with null
  const existingFileInfoRef = useRef({ ext: null, fileName: null });

  // Derived class helpers (updated whenever customClasses changes)
  const allClasses = [...CLASSES, UNASSIGNED_CLASS, ...customClasses.map(c => c.name)];
  const allClassColors = (() => {
    const map = { ...CLASS_COLORS };
    customClasses.forEach(c => { map[c.name] = c.color; });
    return map;
  })();
  const getClassColor = (cls) => allClassColors[cls] || DEFAULT_COLOR;

  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // ─── PDF upload ──────────────────────────────────────────────────────────────
  const handlePdfChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Don't track the raw PDF as currentFile here — we'll save the rendered PNG
    // canvas instead (set in handlePdfConfirm) so re-opening the project restores
    // the image directly without going through the region selector again.
    setStatus(`Opening PDF: ${file.name} …`);
    const reader = new FileReader();
    reader.onload = () => setPdfModalData(reader.result); // ArrayBuffer
    reader.readAsArrayBuffer(file);
    // reset input so same file can be re-uploaded
    e.target.value = "";
  };

  // Called when user confirms crop in the PDF modal
  const handlePdfConfirm = (croppedCanvas) => {
    setPdfModalData(null);
    // Convert the cropped/full-page canvas to a PNG File.  This PNG is what gets
    // uploaded to S3 as "original.png", so re-opening the project restores the
    // image directly (no PDF selector) — exactly like a regular image upload.
    croppedCanvas.toBlob((blob) => {
      if (blob) {
        const pngName = `${project?.name || 'pdf-page'}.png`;
        const pngFile = new File([blob], pngName, { type: 'image/png' });
        setCurrentFile(pngFile);
        existingFileInfoRef.current = { ext: 'png', fileName: pngFile.name };
      }
    }, 'image/png');
    loadImageFromCanvas(croppedCanvas, "PDF page");
  };

  // Load any HTMLCanvasElement as the working image
  const loadImageFromCanvas = (srcCanvas, label = "canvas") => {
    const img = new Image();
    img.onload = () => {
      setOriginalImg(img);
      setImgNaturalSize({ w: srcCanvas.width, h: srcCanvas.height });
      const bs = computeBaseScale(srcCanvas.width, srcCanvas.height);
      setBaseScale(bs);
      setZoom(1.0);
      setAnnotations([]);
      setSelectedIdx(null);
      setSelectedIndices(new Set());
      setHoverIdx(null);
      setTempBox(null);
      setTempPolyPts([]);
      setTempPolyMouse(null);
      setTempLine(null);
      setLastMeasureLine(null);
      setLastMeasurePx("");
      setStatus(`Loaded ${label}: ${srcCanvas.width}×${srcCanvas.height} px — click 'Run Tiled' to analyse.`);
    };
    img.src = srcCanvas.toDataURL("image/png");
  };


  const computeBaseScale = useCallback((imgW, imgH) => {
    const cont = containerRef.current;
    if (!cont) return 1;
    const maxW = cont.clientWidth - 4;
    const maxH = cont.clientHeight - 4;
    return Math.min(maxW / imgW, maxH / imgH, 1.0);
  }, []);

  // ─── Load image from presigned URL (restoring saved project) ─────────────────
  const loadImageFromUrl = useCallback((url, ext) => {
    // Projects saved before the PNG-canvas fix may still have ext === 'pdf'.
    // Re-open the selector for those so the user can re-select the region once;
    // after the next Save the file will be stored as a PNG and won't need this path.
    if (ext === 'pdf') {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          // Copy before giving to PdfRegionSelector to avoid transfer-detach issues.
          setPdfModalData(buf.slice(0));
        })
        .catch(() => setStatus("Failed to restore PDF from saved project."));
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      setOriginalImg(img);
      setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      const bs = computeBaseScale(img.naturalWidth, img.naturalHeight);
      setBaseScale(bs);
      setZoom(1.0);
      setStatus(`Restored saved image: ${img.naturalWidth}×${img.naturalHeight} px`);
    };
    img.onerror = () => setStatus("Failed to restore image from saved project.");
    setStatus("Opening file…");
    img.src = url;
  }, [computeBaseScale]);

  // ─── Load project from S3 on mount ───────────────────────────────────────────
  useEffect(() => {
    if (!project?.id) return;
    let cancelled = false;

    setAnnotations([]);
    setOriginalImg(null);
    setImgNaturalSize({ w: 0, h: 0 });
    setRatio(null);
    setPixelLength("");
    setRealLength("");
    setZoneTags({ ...DEFAULT_ZONE_TAGS });
    setCustomClasses([]);
    setCurrentFile(null);
    setSaveStatus(null);

    loadProject(project.id)
      .then((data) => {
        if (cancelled || !data) return;
        if (data.annotations?.length) setAnnotations(data.annotations);
        if (data.customTags && Object.keys(data.customTags).length)
          setZoneTags(data.customTags);
        if (data.customClasses?.length) {
          setCustomClasses(data.customClasses);
          setVisibleClasses(prev => new Set([...prev, ...data.customClasses.map(c => c.name)]));
        }
        if (data.imageInfo?.w) setImgNaturalSize(data.imageInfo);
        if (data.scale?.pixelToMeter != null) {
          setRatio(data.scale.pixelToMeter);
          setPixelLength(data.scale.pixelLength || "");
          setRealLength(data.scale.realLength || "");
        }
        if (data.settings?.autoSimplifyDist != null) {
          setAutoSimplifyDist(String(data.settings.autoSimplifyDist));
        }
        if (data.settings?.areaTextColor)    setAreaTextColor(data.settings.areaTextColor);
        if (data.settings?.perimTextColor)   setPerimTextColor(data.settings.perimTextColor);
        if (data.settings?.measureTextColor) setMeasureTextColor(data.settings.measureTextColor);
        if (data.settings?.autoSave != null)          setAutoSave(Boolean(data.settings.autoSave));
        if (data.settings?.autoSaveInterval != null)  setAutoSaveInterval(String(data.settings.autoSaveInterval));
        if (data.originalExt) {
          existingFileInfoRef.current = {
            ext: data.originalExt,
            fileName: data.metadata?.fileName || null,
          };
        }
        if (data.originalFileUrl) {
          loadImageFromUrl(data.originalFileUrl, data.originalExt);
        }
      })
      .catch((err) => console.error('[DetectionTool] loadProject failed:', err));

    return () => { cancelled = true; };
  }, [project?.id, loadImageFromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Save project to S3 ───────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!project?.id) return;
    setSaveStatus('saving');
    try {
      await saveProject(project.id, {
        name: project.name,
        annotations,
        scale: { pixelToMeter: ratio, pixelLength, realLength },
        settings: { autoSimplifyDist, areaTextColor, perimTextColor, measureTextColor, autoSave, autoSaveInterval },
        customTags: zoneTags,
        customClasses,
        imageInfo: imgNaturalSize,
        file: currentFile,
        existingExt: existingFileInfoRef.current.ext,
        existingFileName: existingFileInfoRef.current.fileName,
      });
      setSaveStatus('saved');
      setLastSaveTime(new Date());
      setStatus("Save complete.");
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      console.error('Save failed:', err);
      setStatus(`Save failed: ${err?.message || String(err)}`);
      setSaveStatus('error');
    }
  };

  // Keep ref current so the interval always calls the latest version of handleSave
  useEffect(() => { handleSaveRef.current = handleSave; });

  // Mark dirty whenever annotations change
  useEffect(() => { isDirty.current = true; }, [annotations]);

  // Auto-save interval — only saves if something changed since last save
  useEffect(() => {
    if (!autoSave || !project?.id) return;
    const secs = parseInt(autoSaveInterval, 10);
    if (isNaN(secs) || secs < 10) return;
    const id = setInterval(() => {
      if (isDirty.current) {
        isDirty.current = false;
        handleSaveRef.current?.();
      }
    }, secs * 1000);
    return () => clearInterval(id);
  }, [autoSave, autoSaveInterval, project?.id]);

  // ─── Canvas redraw ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !originalImg) return;
    const dispW = Math.round(imgNaturalSize.w * scale);
    const dispH = Math.round(imgNaturalSize.h * scale);
    canvas.width = dispW;
    canvas.height = dispH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(originalImg, 0, 0, dispW, dispH);

    const visAnns = annotations.filter((a) => visibleClasses.has(a.clsName));
    const visIdxMap = [];
    annotations.forEach((a, i) => { if (visibleClasses.has(a.clsName)) visIdxMap.push(i); });

    const visHover = hoverIdx != null && visIdxMap.includes(hoverIdx) ? visIdxMap.indexOf(hoverIdx) : null;
    const visSel = selectedIdx != null && visIdxMap.includes(selectedIdx) ? visIdxMap.indexOf(selectedIdx) : null;
    const visSelSet = new Set([...selectedIndices].filter(i => visIdxMap.includes(i)).map(i => visIdxMap.indexOf(i)));

    drawAnnotations(ctx, visAnns, scale, {
      ratio, hoverIdx: visHover, selectedIdx: visSel,
      selectedIndices: visSelSet,
      tempBox, tempPolyPts, tempPolyMouse, tempLine, tempLineShape, lastMeasureLine,
      hotHandle: handleDragging.current, zoneTags, classColors: allClassColors,
      tempCircle, lastLineIsMeasure,
      areaTextColor, perimTextColor, measureTextColor, showConfidence,
    });
  }, [originalImg, annotations, scale, visibleClasses, hoverIdx, selectedIdx, selectedIndices,
      tempBox, tempPolyPts, tempPolyMouse, tempLine, tempLineShape, lastMeasureLine, ratio, zoneTags, customClasses,
      tempCircle, lastLineIsMeasure, areaTextColor, perimTextColor, measureTextColor, showConfidence]);

  // ─── Image upload ────────────────────────────────────────────────────────────
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setCurrentFile(file);
    existingFileInfoRef.current = { ext: file.name.split('.').pop().toLowerCase(), fileName: file.name };
    setStatus("Opening file…");
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setOriginalImg(img);
      setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      const bs = computeBaseScale(img.naturalWidth, img.naturalHeight);
      setBaseScale(bs);
      setZoom(1.0);
      setAnnotations([]);
      setSelectedIdx(null);
      setSelectedIndices(new Set());
      setHoverIdx(null);
      setTempBox(null);
      setTempPolyPts([]);
      setTempPolyMouse(null);
      setTempLine(null);
      setLastMeasureLine(null);
      setLastMeasurePx("");
      setStatus(`Loaded: ${file.name} (${img.naturalWidth}×${img.naturalHeight})`);
    };
    img.src = url;
  };

  // ─── Canvas coords helper ────────────────────────────────────────────────────
  const canvasCoords = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return { cx, cy, ox: cx / scale, oy: cy / scale };
  };

  // ─── Hit test box handles ────────────────────────────────────────────────────
  const hitHandle = (ann, cx, cy) => {
    if (ann.shapeType !== "box") return null;
    const [x1, y1, x2, y2] = annotationBbox(ann);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const pts = [[x1, y1],[mx, y1],[x2, y1],[x1, my],[x2, my],[x1, y2],[mx, y2],[x2, y2]];
    for (let i = 0; i < pts.length; i++) {
      const [hx, hy] = pts[i];
      if (Math.abs(cx - hx * scale) <= 10 && Math.abs(cy - hy * scale) <= 10) return i;
    }
    return null;
  };

  // Returns the index of the polygon vertex under screen point (cx, cy), or null
  const hitPolyVertex = (ann, cx, cy) => {
    if (ann.shapeType !== "polygon" || !ann.points) return null;
    for (let i = 0; i < ann.points.length; i++) {
      const [px, py] = ann.points[i];
      if (Math.abs(cx - px * scale) <= 10 && Math.abs(cy - py * scale) <= 10) return i;
    }
    return null;
  };

  // Returns edge index i if screen point (cx,cy) is within 8px of edge pts[i]→pts[i+1]
  const hitPolyEdge = (ann, cx, cy) => {
    if (ann.shapeType !== "polygon" || !ann.points) return null;
    const pts = ann.points;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = [pts[i][0] * scale,               pts[i][1] * scale];
      const [bx, by] = [pts[(i + 1) % pts.length][0] * scale, pts[(i + 1) % pts.length][1] * scale];
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1) continue;
      const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lenSq));
      const dist = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
      if (dist <= 8) return i;
    }
    return null;
  };

  // Returns 0 (p1) or 1 (p2) if screen point (cx,cy) is within 10px of a line endpoint, else null
  const hitLineEndpoint = (ann, cx, cy) => {
    if (ann.shapeType !== "line") return null;
    if (Math.hypot(cx - ann.x1 * scale, cy - ann.y1 * scale) <= 10) return 0;
    if (Math.hypot(cx - ann.x2 * scale, cy - ann.y2 * scale) <= 10) return 1;
    return null;
  };

  const applyHandleDrag = (ann, hi, orig, dx, dy) => {
    let [x1, y1, x2, y2] = orig;
    if (hi === 0) { x1 += dx; y1 += dy; }
    else if (hi === 1) { y1 += dy; }
    else if (hi === 2) { x2 += dx; y1 += dy; }
    else if (hi === 3) { x1 += dx; }
    else if (hi === 4) { x2 += dx; }
    else if (hi === 5) { x1 += dx; y2 += dy; }
    else if (hi === 6) { y2 += dy; }
    else if (hi === 7) { x2 += dx; y2 += dy; }
    if (x2 - x1 < MIN_BOX_SIZE) { if ([0,3,5].includes(hi)) x1 = x2 - MIN_BOX_SIZE; else x2 = x1 + MIN_BOX_SIZE; }
    if (y2 - y1 < MIN_BOX_SIZE) { if ([0,1,2].includes(hi)) y1 = y2 - MIN_BOX_SIZE; else y2 = y1 + MIN_BOX_SIZE; }
    return { ...ann, x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) };
  };

  // ─── Mouse handlers ──────────────────────────────────────────────────────────
  const onMouseDown = (e) => {
    if (!originalImg) return;
    if (e.button !== 0) return;
    mouseDown.current = true;
    const { cx, cy, ox, oy } = canvasCoords(e);

    // ── 1. Box corner handle drag ────────────────────────────────────────────
    if (selectedIdx != null && annotations[selectedIdx]?.shapeType === "box") {
      const hi = hitHandle(annotations[selectedIdx], cx, cy);
      if (hi != null) {
        preDragSnapshot.current = snapshotAnns(annotations);
        didDrag.current = false;
        handleDragging.current = hi;
        handleAnnIdx.current = selectedIdx;
        const a = annotations[selectedIdx];
        handleOrigBox.current = [a.x1, a.y1, a.x2, a.y2];
        handleDragScreenStart.current = [cx, cy];
        return; // consumed
      }
    }

    // ── 1b. Line endpoint drag ───────────────────────────────────────────────
    if (drawMode === "select" && selectedIdx != null && annotations[selectedIdx]?.shapeType === "line") {
      const endpt = hitLineEndpoint(annotations[selectedIdx], cx, cy);
      if (endpt != null) {
        preDragSnapshot.current = snapshotAnns(annotations);
        didDrag.current = false;
        lineEndDragging.current = endpt;
        lineEndAnnIdx.current = selectedIdx;
        const ann = annotations[selectedIdx];
        lineEndOrigCoords.current = [ann.x1, ann.y1, ann.x2, ann.y2];
        lineEndDragStart.current = [ox, oy];
        return;
      }
    }

    // ── 2. Polygon vertex / edge editing ────────────────────────────────────
    if (drawMode === "select" && selectedIdx != null && annotations[selectedIdx]?.shapeType === "polygon") {
      const vi = hitPolyVertex(annotations[selectedIdx], cx, cy);
      if (vi != null) {
        // Shift+click on vertex → delete it (keep ≥ 3 vertices)
        if (e.shiftKey) {
          const pts = annotations[selectedIdx].points;
          if (pts.length > 3) {
            pushHistory(annotations);
            const newPts = pts.filter((_, k) => k !== vi);
            setAnnotations(prev => prev.map((a, i) => i === selectedIdx ? { ...a, points: newPts } : a));
            setStatus(`Deleted vertex ${vi}. ${newPts.length} vertices remaining.`);
          } else {
            setStatus("Cannot delete — polygon must have at least 3 vertices.");
          }
          return;
        }
        // Normal click → drag vertex (snapshot captured here, pushed on mouseUp)
        preDragSnapshot.current = snapshotAnns(annotations);
        didDrag.current = false;
        polyVtxDragging.current = vi;
        polyVtxAnnIdx.current = selectedIdx;
        polyVtxOrigPts.current = annotations[selectedIdx].points.map(p => [...p]);
        polyVtxDragStart.current = [ox, oy];
        return; // consumed — do NOT fall through to whole-shape drag
      }
      // Click on edge (no vertex, no shift) → insert new vertex at closest point on edge
      if (!e.shiftKey) {
        const ei = hitPolyEdge(annotations[selectedIdx], cx, cy);
        if (ei != null) {
          pushHistory(annotations);
          const pts = annotations[selectedIdx].points;
          const [ax, ay] = pts[ei];
          const [bx, by] = pts[(ei + 1) % pts.length];
          const dx = bx - ax, dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          const t = lenSq < 1 ? 0 : Math.max(0, Math.min(1,
            ((ox - ax) * dx + (oy - ay) * dy) / lenSq
          ));
          const newPt = [Math.round(ax + t * dx), Math.round(ay + t * dy)];
          const newPts = [...pts.slice(0, ei + 1), newPt, ...pts.slice(ei + 1)];
          setAnnotations(prev => prev.map((a, i) => i === selectedIdx ? { ...a, points: newPts } : a));
          setStatus(`Inserted vertex at edge ${ei}. ${newPts.length} vertices total.`);
          return;
        }
      }
    }

    // ── 3. Drawing modes ─────────────────────────────────────────────────────
    if (drawMode === "box") {
      boxDrawing.current = true;
      boxStart.current = [ox, oy];
      setTempBox({ shapeType: "box", clsName: newClass, x1: ox, y1: oy, x2: ox, y2: oy, points: null });
    } else if (drawMode === "imageSearch") {
      boxDrawing.current = true;
      boxStart.current = [ox, oy];
      setTempBox({ shapeType: "box", clsName: "Image Search", _isImageSearch: true, x1: ox, y1: oy, x2: ox, y2: oy, points: null });
    } else if (drawMode === "circle") {
      boxDrawing.current = true;
      boxStart.current = [ox, oy];
      setTempCircle({ cx: ox, cy: oy, r: 0 });
    } else if (drawMode === "lineShape") {
      lineDrawing.current = true;
      lineStart.current = [ox, oy];
      setTempLineShape([[ox, oy], [ox, oy]]);
    } else if (drawMode === "line") {
      lineDrawing.current = true;
      lineStart.current = [ox, oy];
      setTempLine([[ox, oy], [ox, oy]]);
    } else if (drawMode === "measure") {
      lineDrawing.current = true;
      lineStart.current = [ox, oy];
      setTempLine([[ox, oy], [ox, oy]]);
    } else if (drawMode === "polygon") {
      setTempPolyPts((prev) => [...prev, [Math.round(ox), Math.round(oy)]]);
      setStatus(`Polygon — ${tempPolyPts.length + 1} point(s). Double-click or Finish to close.`);

    // ── 4. Select / whole-shape move ─────────────────────────────────────────
    } else if (drawMode === "select") {
      const visIdxs = annotations.map((a, i) => visibleClasses.has(a.clsName) ? i : -1).filter(i => i >= 0);
      const candidates = visIdxs
        .filter(i => annotationContains(annotations[i], ox, oy))
        .map(i => [Math.max(1, annotationAreaPx(annotations[i])), i]);
      candidates.sort((a, b) => a[0] - b[0]);

      if (candidates.length > 0) {
        const idx = candidates[0][1];
        if (e.ctrlKey || e.metaKey) {
          setSelectedIndices(prev => {
            const s = new Set(prev); s.has(idx) ? s.delete(idx) : s.add(idx); return s;
          });
          setSelectedIdx(idx);
        } else {
          setSelectedIdx(idx);
          setSelectedIndices(new Set([idx]));
          setEditClass(annotations[idx].clsName);
          setEditConf(annotations[idx].confidence != null ? String(annotations[idx].confidence) : "");
        }
        // snapshot for whole-shape drag (undo) + move internals
        preDragSnapshot.current = snapshotAnns(annotations);
        didDrag.current = false;
        dragAnnIdx.current = idx;
        dragStart.current = [ox, oy];
        const ann = annotations[idx];
        dragOrigPts.current = ann.shapeType === "polygon"
          ? ann.points.map(p => [...p])
          : ann.shapeType === "line"
            ? [ann.x1, ann.y1, ann.x2, ann.y2]  // actual endpoints, not bbox
            : [...annotationBbox(ann)];            // box: [x1,y1,x2,y2]
      } else {
        if (!e.ctrlKey && !e.metaKey) { setSelectedIdx(null); setSelectedIndices(new Set()); }
        dragAnnIdx.current = null;
      }
    }
  };

  const onMouseMove = (e) => {
    if (!originalImg) return;
    const { cx, cy, ox, oy } = canvasCoords(e);

    // ── Box corner handle drag ───────────────────────────────────────────────
    if (handleDragging.current != null && mouseDown.current) {
      const [sx, sy] = handleDragScreenStart.current;
      const dxOrig = (cx - sx) / scale;
      const dyOrig = (cy - sy) / scale;
      const updated = applyHandleDrag(
        annotations[handleAnnIdx.current], handleDragging.current,
        handleOrigBox.current, dxOrig, dyOrig
      );
      didDrag.current = true;
      setAnnotations(prev => prev.map((a, i) => i === handleAnnIdx.current ? updated : a));
      return;
    }

    // ── Line endpoint drag ───────────────────────────────────────────────────
    if (lineEndDragging.current != null && mouseDown.current) {
      const [sx, sy] = lineEndDragStart.current;
      const dx = ox - sx, dy = oy - sy;
      const [origX1, origY1, origX2, origY2] = lineEndOrigCoords.current;
      didDrag.current = true;
      setAnnotations(prev => prev.map((a, i) => {
        if (i !== lineEndAnnIdx.current) return a;
        if (lineEndDragging.current === 0) {
          return { ...a, x1: Math.round(origX1 + dx), y1: Math.round(origY1 + dy) };
        } else {
          return { ...a, x2: Math.round(origX2 + dx), y2: Math.round(origY2 + dy) };
        }
      }));
      return;
    }

    // ── Polygon vertex drag ──────────────────────────────────────────────────
    if (polyVtxDragging.current != null && mouseDown.current) {
      const [sx, sy] = polyVtxDragStart.current;
      const dx = ox - sx, dy = oy - sy;
      const origPts = polyVtxOrigPts.current;
      const vi = polyVtxDragging.current;
      didDrag.current = true;
      setAnnotations(prev => prev.map((a, i) => {
        if (i !== polyVtxAnnIdx.current) return a;
        const newPts = origPts.map((p, pi) =>
          pi === vi ? [Math.round(p[0] + dx), Math.round(p[1] + dy)] : [...p]
        );
        return { ...a, points: newPts };
      }));
      return;
    }

    // ── Drawing modes ────────────────────────────────────────────────────────
    if ((drawMode === "box" || drawMode === "imageSearch") && mouseDown.current && boxDrawing.current) {
      const [sx, sy] = boxStart.current;
      const isSearch = drawMode === "imageSearch";
      setTempBox({ shapeType: "box", clsName: isSearch ? "Image Search" : newClass, _isImageSearch: isSearch, x1: sx, y1: sy, x2: ox, y2: oy, points: null });
    } else if (drawMode === "circle" && mouseDown.current && boxDrawing.current) {
      const [cx, cy] = boxStart.current;
      setTempCircle({ cx, cy, r: Math.hypot(ox - cx, oy - cy) });
    } else if (drawMode === "lineShape" && mouseDown.current && lineDrawing.current) {
      const [sx, sy] = lineStart.current;
      setTempLineShape([[sx, sy], [ox, oy]]);
    } else if ((drawMode === "line" || drawMode === "measure") && mouseDown.current && lineDrawing.current) {
      const [sx, sy] = lineStart.current;
      setTempLine([[sx, sy], [ox, oy]]);
    } else if (drawMode === "polygon" && tempPolyPts.length > 0) {
      setTempPolyMouse([ox, oy]);

    // ── Whole-shape move ─────────────────────────────────────────────────────
    } else if (drawMode === "select" && mouseDown.current && dragAnnIdx.current != null) {
      const [sx, sy] = dragStart.current;
      const dx = ox - sx, dy = oy - sy;
      didDrag.current = true;
      setAnnotations(prev => prev.map((a, i) => {
        if (i !== dragAnnIdx.current) return a;
        if (a.shapeType === "box" || a.shapeType === "line") {
          const [x1, y1, x2, y2] = dragOrigPts.current;
          return { ...a, x1: Math.round(x1+dx), y1: Math.round(y1+dy), x2: Math.round(x2+dx), y2: Math.round(y2+dy) };
        }
        // polygon whole-move — use original snapshot, not accumulated delta
        return { ...a, points: dragOrigPts.current.map(([px, py]) => [Math.round(px+dx), Math.round(py+dy)]) };
      }));
    }

    // ── Hover highlight ──────────────────────────────────────────────────────
    if (drawMode === "select") {
      const visIdxs = annotations.map((a, i) => visibleClasses.has(a.clsName) ? i : -1).filter(i => i >= 0);
      const candidates = visIdxs
        .filter(i => annotationContains(annotations[i], ox, oy))
        .map(i => [Math.max(1, annotationAreaPx(annotations[i])), i]);
      candidates.sort((a, b) => a[0] - b[0]);
      setHoverIdx(candidates.length > 0 ? candidates[0][1] : null);
    }
  };

  const onMouseUp = (e) => {
    if (!originalImg) return;
    const { ox, oy } = canvasCoords(e);

    // ── Box handle drag end ──────────────────────────────────────────────────
    if (handleDragging.current != null) {
      if (preDragSnapshot.current && didDrag.current) { pushHistory(preDragSnapshot.current); }
      preDragSnapshot.current = null; didDrag.current = false;
      handleDragging.current = null;
      handleAnnIdx.current = null;
      handleOrigBox.current = null;
      handleDragScreenStart.current = null;
      mouseDown.current = false;
      setStatus("Box resized.");
      return;
    }

    // ── Polygon vertex drag end ──────────────────────────────────────────────
    if (polyVtxDragging.current != null) {
      if (preDragSnapshot.current && didDrag.current) { pushHistory(preDragSnapshot.current); }
      preDragSnapshot.current = null; didDrag.current = false;
      polyVtxDragging.current = null;
      polyVtxAnnIdx.current = null;
      polyVtxOrigPts.current = null;
      polyVtxDragStart.current = null;
      mouseDown.current = false;
      setStatus("Vertex moved.");
      return;
    }

    // ── Line endpoint drag end ───────────────────────────────────────────────
    if (lineEndDragging.current != null) {
      if (preDragSnapshot.current && didDrag.current) { pushHistory(preDragSnapshot.current); }
      preDragSnapshot.current = null; didDrag.current = false;
      lineEndDragging.current = null;
      lineEndAnnIdx.current = null;
      lineEndOrigCoords.current = null;
      lineEndDragStart.current = null;
      mouseDown.current = false;
      setStatus("Line endpoint moved.");
      return;
    }

    // ── Whole-shape drag end — only push if shape actually moved ────────────
    if (preDragSnapshot.current && dragAnnIdx.current != null) {
      if (didDrag.current) pushHistory(preDragSnapshot.current);
      preDragSnapshot.current = null;
      didDrag.current = false;
    }

    // ── Box draw commit ──────────────────────────────────────────────────────
    if (drawMode === "box" && boxDrawing.current) {
      const [sx, sy] = boxStart.current;
      const ann = {
        id: Math.random().toString(36).slice(2), shapeType: "box", clsName: newClass,
        confidence: null, sourceModel: "manual", zoneTag: null,
        x1: Math.min(sx, ox), y1: Math.min(sy, oy), x2: Math.max(sx, ox), y2: Math.max(sy, oy),
        points: null,
      };
      if (isValidAnnotation(ann)) {
        pushHistory(annotations);
        setAnnotations(prev => {
          const next = [...prev, ann];
          setSelectedIdx(next.length - 1);
          setSelectedIndices(new Set([next.length - 1]));
          return next;
        });
      }
      boxDrawing.current = false;
      boxStart.current = null;
      setTempBox(null);
    } else if (drawMode === "imageSearch" && boxDrawing.current) {
      const [sx, sy] = boxStart.current;
      const x1 = Math.round(Math.min(sx, ox));
      const y1 = Math.round(Math.min(sy, oy));
      const x2 = Math.round(Math.max(sx, ox));
      const y2 = Math.round(Math.max(sy, oy));
      boxDrawing.current = false;
      boxStart.current = null;
      setTempBox(null);
      const regionAnn = { shapeType: "box", x1, y1, x2, y2, points: null };
      if (isValidAnnotation(regionAnn)) {
        runImageSearch(x1, y1, x2, y2);
      } else {
        setStatus("Image Search: draw a larger region.");
      }
    } else if (drawMode === "circle" && boxDrawing.current) {
      const [cx, cy] = boxStart.current;
      const r = Math.hypot(ox - cx, oy - cy);
      if (r >= MIN_BOX_SIZE / 2) {
        const N = 18;
        const pts = Array.from({ length: N }, (_, i) => {
          const angle = (2 * Math.PI * i) / N;
          return [Math.round(cx + r * Math.cos(angle)), Math.round(cy + r * Math.sin(angle))];
        });
        const ann = {
          id: Math.random().toString(36).slice(2),
          shapeType: "polygon", clsName: newClass,
          confidence: null, sourceModel: "manual", zoneTag: null,
          x1: null, y1: null, x2: null, y2: null, points: pts,
        };
        pushHistory(annotations);
        setAnnotations(prev => {
          const next = [...prev, ann];
          setSelectedIdx(next.length - 1);
          setSelectedIndices(new Set([next.length - 1]));
          return next;
        });
        setStatus(`Circle added (r≈${r.toFixed(1)} px).`);
      }
      setTempCircle(null);
      boxDrawing.current = false;
      boxStart.current = null;
    } else if (drawMode === "lineShape" && lineDrawing.current) {
      const [sx, sy] = lineStart.current;
      const ann = {
        id: Math.random().toString(36).slice(2),
        shapeType: "line", clsName: newClass,
        confidence: null, sourceModel: "manual", zoneTag: null,
        x1: Math.round(sx), y1: Math.round(sy), x2: Math.round(ox), y2: Math.round(oy),
        points: null,
      };
      if (isValidAnnotation(ann)) {
        pushHistory(annotations);
        setAnnotations(prev => {
          const next = [...prev, ann];
          setSelectedIdx(next.length - 1);
          setSelectedIndices(new Set([next.length - 1]));
          return next;
        });
        const len = Math.hypot(ox - sx, oy - sy);
        if (ratio) setStatus(`Line added: ${len.toFixed(1)} px = ${(len * ratio).toFixed(3)} m`);
        else setStatus(`Line added: ${len.toFixed(1)} px (set scale to see real length)`);
      } else {
        setStatus("Line too short.");
      }
      lineDrawing.current = false;
      lineStart.current = null;
      setTempLineShape(null);
    } else if (drawMode === "line" && lineDrawing.current) {
      const [sx, sy] = lineStart.current;
      const len = Math.hypot(ox - sx, oy - sy);
      setLastMeasureLine([[sx, sy], [ox, oy]]);
      setLastMeasurePx(len.toFixed(2));
      setPixelLength(len.toFixed(2));
      setLastLineIsMeasure(false);
      setStatus(`Scale calibration: ${len.toFixed(2)} px — enter real length and click Set Scale.`);
      lineDrawing.current = false;
      lineStart.current = null;
      setTempLine(null);
    } else if (drawMode === "measure" && lineDrawing.current) {
      const [sx, sy] = lineStart.current;
      const len = Math.hypot(ox - sx, oy - sy);
      setLastMeasureLine([[sx, sy], [ox, oy]]);
      setLastLineIsMeasure(true);
      if (ratio) {
        setStatus(`Measure: ${len.toFixed(2)} px = ${(len * ratio).toFixed(3)} m`);
      } else {
        setStatus(`Measure: ${len.toFixed(2)} px (set scale to get real distance)`);
      }
      lineDrawing.current = false;
      lineStart.current = null;
      setTempLine(null);
    }

    if (dragAnnIdx.current != null) dragAnnIdx.current = null;
    mouseDown.current = false;
  };

  const onDoubleClick = (e) => {
    if (drawMode === "polygon" && tempPolyPts.length >= 3) finishPolygon();
  };

  const onWheel = (e) => {
    if (!originalImg) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom(z => clamp(z * factor, 0.1, 8.0));
  };

  // ─── Polygon finish ──────────────────────────────────────────────────────────
  const finishPolygon = () => {
    if (tempPolyPts.length < 3) { setStatus("Need at least 3 points."); return; }
    const ann = { id: Math.random().toString(36).slice(2), shapeType: "polygon", clsName: newClass, confidence: null, sourceModel: "manual", zoneTag: null, x1: null, y1: null, x2: null, y2: null, points: [...tempPolyPts] };
    if (!isValidAnnotation(ann)) { setStatus("Polygon too small."); return; }
    pushHistory(annotations);
    setAnnotations(prev => { const next = [...prev, ann]; setSelectedIdx(next.length - 1); setSelectedIndices(new Set([next.length - 1])); return next; });
    setTempPolyPts([]);
    setTempPolyMouse(null);
    setStatus("Polygon completed.");
  };

  // ─── Inference ───────────────────────────────────────────────────────────────
  const runInference = async (tiled = false) => {
    if (!originalImg) { setStatus("Load an image first."); return; }
    // Re-encode canvas to blob
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = imgNaturalSize.w;
    tempCanvas.height = imgNaturalSize.h;
    tempCanvas.getContext("2d").drawImage(originalImg, 0, 0);

    // Apply confidence override if provided (must be a valid 0–1 float)
    const confVal = confOverride !== '' ? parseFloat(confOverride) : null;
    const useConf = confVal != null && !isNaN(confVal) && confVal > 0 && confVal <= 1;
    const wallModelData = useConf ? { ...WALL_MODEL_DATA, conf: confVal } : WALL_MODEL_DATA;
    const zoneModelData = useConf ? { ...ZONE_MODEL_DATA, conf: confVal } : ZONE_MODEL_DATA;
    const zoneSegModelData = useConf ? { ...ZONE_SEG_MODEL_DATA, conf: confVal } : ZONE_SEG_MODEL_DATA;

    setInferring(true);
    setStatus(tiled ? "Running tiled inference…" : "Running inference…");

    try {
      const blob = await new Promise((res) => tempCanvas.toBlob(res, "image/jpeg", 0.95));

      const autoEps = (() => { const v = parseInt(autoSimplifyDist, 10); return !isNaN(v) && v > 0 ? v : 0; })();
      if (tiled && (imgNaturalSize.w > TILE_SIZE || imgNaturalSize.h > TILE_SIZE)) {
        const allAnns = await runTiledInference(tempCanvas, blob, wallModelData, zoneModelData, zoneSegModelData, autoEps);
        // Keep manually drawn shapes; replace all AI detections with fresh results
        setAnnotations(prev => { pushHistory(prev); return [...prev.filter(a => a.sourceModel === 'manual'), ...allAnns]; });
        setStatus(`Tiled inference complete — ${allAnns.length} detections.`);
      } else {
        const [wallRes, doorWinRes, zoneSegRes] = await Promise.all([
          postInference(blob, WALL_MODEL_URL, WALL_MODEL_HEADERS, wallModelData),
          postInference(blob, ZONE_MODEL_URL, ZONE_MODEL_HEADERS, zoneModelData),
          postInference(blob, ZONE_SEG_MODEL_URL, ZONE_SEG_MODEL_HEADERS, zoneSegModelData),
        ]);
        const autoEps = (() => { const v = parseInt(autoSimplifyDist, 10); return !isNaN(v) && v > 0 ? v : 0; })();
        const wallAnns    = parseModelResponse(wallRes, "wall_model");
        // Old zone model: keep doors and windows only
        const doorWinAnns = parseModelResponse(doorWinRes, "zone_door_window_model")
          .filter(a => a.clsName === "door" || a.clsName === "window");
        // New seg model: zones as polygons (auto-simplified if setting > 0)
        const zoneSegAnns = parseSegmentationResponse(zoneSegRes, "zone_seg_model", autoEps);
        const allAnns = [...wallAnns, ...doorWinAnns, ...zoneSegAnns];
        // Keep manually drawn shapes; replace all AI detections with fresh results
        setAnnotations(prev => { pushHistory(prev); return [...prev.filter(a => a.sourceModel === 'manual'), ...allAnns]; });
        setStatus(`Inference complete — ${allAnns.length} detections.`);
      }
      setSelectedIdx(null);
      setSelectedIndices(new Set());
    } catch (err) {
      setStatus(`Inference failed: ${err.message}`);
    } finally {
      setInferring(false);
    }
  };

  const postInference = async (blob, url, headers, data) => {
    const fd = new FormData();
    fd.append("file", blob, "image.jpg");
    Object.entries(data).forEach(([k, v]) => fd.append(k, String(v)));
    const res = await fetch(url, { method: "POST", headers, body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const runTiledInference = async (canvas, _blob, wallModelData, zoneModelData, zoneSegModelData, autoEps = 0) => {
    const { w: W, h: H } = imgNaturalSize;
    const stride = TILE_SIZE - TILE_OVERLAP;
    const allAnns = [];
    const offsets = [];
    for (let y = 0; y < H; y += stride) for (let x = 0; x < W; x += stride) offsets.push([x, y]);

    for (let i = 0; i < offsets.length; i++) {
      const [tx, ty] = offsets[i];
      setStatus(`Analysing tile ${i + 1} of ${offsets.length}…`);
      const tw = Math.min(TILE_SIZE, W - tx), th = Math.min(TILE_SIZE, H - ty);
      const tc = document.createElement("canvas");
      tc.width = tw; tc.height = th;
      tc.getContext("2d").drawImage(canvas, tx, ty, tw, th, 0, 0, tw, th);
      const tBlob = await new Promise(res => tc.toBlob(res, "image/jpeg", 0.9));
      try {
        const [wallRes, doorWinRes, zoneSegRes] = await Promise.all([
          postInference(tBlob, WALL_MODEL_URL, WALL_MODEL_HEADERS, wallModelData),
          postInference(tBlob, ZONE_MODEL_URL, ZONE_MODEL_HEADERS, zoneModelData),
          postInference(tBlob, ZONE_SEG_MODEL_URL, ZONE_SEG_MODEL_HEADERS, zoneSegModelData),
        ]);
        const tileAnns = [
          ...parseModelResponse(wallRes, "wall_model"),
          ...parseModelResponse(doorWinRes, "zone_door_window_model").filter(a => a.clsName === "door" || a.clsName === "window"),
          ...parseSegmentationResponse(zoneSegRes, "zone_seg_model", autoEps),
        ];
        tileAnns.forEach(a => allAnns.push(offsetAnnotation(a, tx, ty)));
      } catch (_) {}
    }
    return nms(allAnns, NMS_IOU_THRESH);
  };

  // ─── Image Search ─────────────────────────────────────────────────────────────
  const runImageSearch = async (x1, y1, x2, y2) => {
    if (!originalImg || imageSearching) return;
    if (!IMAGE_SEARCH_URL) {
      setStatus("Image Search: API URL not configured — see image-search-api/DEPLOY.md.");
      return;
    }
    setImageSearching(true);
    setStatus("Image Search: searching for similar objects…");
    try {
      // Draw the original image (no annotations) onto a clean canvas
      const cleanCanvas = document.createElement("canvas");
      cleanCanvas.width  = imgNaturalSize.w;
      cleanCanvas.height = imgNaturalSize.h;
      cleanCanvas.getContext("2d").drawImage(originalImg, 0, 0);
      const blob = await new Promise((res) => cleanCanvas.toBlob(res, "image/jpeg", 0.95));

      const confVal = confOverride !== "" ? parseFloat(confOverride) : 0.25;
      const fd = new FormData();
      fd.append("file", blob, "image.jpg");
      fd.append("x1", String(x1));
      fd.append("y1", String(y1));
      fd.append("x2", String(x2));
      fd.append("y2", String(y2));
      fd.append("conf", String(isNaN(confVal) ? 0.25 : confVal));

      const headers = IMAGE_SEARCH_TOKEN ? { Authorization: `Bearer ${IMAGE_SEARCH_TOKEN}` } : {};
      const res = await fetch(IMAGE_SEARCH_URL, { method: "POST", headers, body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const newAnns = (json.detections || []).map((d) => ({
        id: Math.random().toString(36).slice(2),
        shapeType: "box",
        clsName: UNASSIGNED_CLASS,
        confidence: d.confidence ?? null,
        sourceModel: "image_search",
        zoneTag: null,
        x1: Math.round(d.x1), y1: Math.round(d.y1),
        x2: Math.round(d.x2), y2: Math.round(d.y2),
        points: null,
      }));

      if (newAnns.length > 0) {
        setAnnotations((prev) => [...prev, ...newAnns]);
        setVisibleClasses((prev) => new Set([...prev, UNASSIGNED_CLASS]));
      }
      setStatus(`Image Search: ${newAnns.length} similar object(s) found.`);
    } catch (err) {
      setStatus(`Image Search failed: ${err.message}`);
    } finally {
      setImageSearching(false);
    }
  };

  // ─── Edit / delete ───────────────────────────────────────────────────────────
  const simplifySelected = () => {
    const eps = parseFloat(simplifyEpsilon);
    if (isNaN(eps) || eps <= 0) return;
    pushHistory(annotations);
    let count = 0;
    setAnnotations(prev => prev.map((a, i) => {
      if (!selectedIndices.has(i) || a.shapeType !== "polygon" || !a.points) return a;
      const simplified = rdpSimplifyPolygon(a.points, eps);
      count++;
      return { ...a, points: simplified };
    }));
    setStatus(`Simplified ${count} polygon(s) with ε=${eps}px.`);
  };

  const applyClass = () => {
    if (selectedIndices.size === 0) return;
    pushHistory(annotations);
    setAnnotations(prev => prev.map((a, i) =>
      selectedIndices.has(i) ? { ...a, clsName: editClass } : a
    ));
  };

  const applyTag = () => {
    const targetIndices = new Set(
      [...selectedIndices].filter(i => visibleClasses.has(annotations[i]?.clsName))
    );

    if (targetIndices.size === 0) {
      setStatus("No visible selected shapes to tag.");
      return;
    }

    pushHistory(annotations);
    setAnnotations(prev => prev.map((a, i) =>
      targetIndices.has(i) ? { ...a, zoneTag: selectedZoneTag || null } : a
    ));

    setStatus(
      selectedZoneTag
        ? `Tag "${selectedZoneTag}" applied to ${targetIndices.size} visible shape(s).`
        : `Tag cleared on ${targetIndices.size} visible shape(s).`
    );
  };

  const deleteSelected = () => {
    if (selectedIndices.size === 0) return;
    pushHistory(annotations);
    const toRemove = new Set(selectedIndices);
    setAnnotations(prev => prev.filter((_, i) => !toRemove.has(i)));
    setSelectedIdx(null);
    setSelectedIndices(new Set());
    setHoverIdx(null);
  };

  const calculateRatio = () => {
    const px = parseFloat(pixelLength), rl = parseFloat(realLength);
    if (!px || !rl || px <= 0 || rl <= 0) { setStatus("Enter valid pixel and real lengths."); return; }
    const r = rl / px;
    setRatio(r);
    setStatus(`Ratio: ${r.toFixed(8)} m/px`);
  };

  // ─── Export ──────────────────────────────────────────────────────────────────
  const exportJSON = () => {
    const data = annotations.map(ann => {
      const [x1, y1, x2, y2] = annotationBbox(ann);
      const areaPx = annotationAreaPx(ann);
      const areaM2 = ratio ? areaPx * ratio * ratio : null;
      const perimPx = (ann.shapeType === "polygon" || ann.shapeType === "line" || ann.clsName === "zone") ? annotationPerimeterPx(ann) : null;
      const perimM = ratio && perimPx != null ? perimPx * ratio : null;
      return { shape_type: ann.shapeType, class: ann.clsName, x1, y1, x2, y2, polygon_points: ann.points, confidence: ann.confidence, source_model: ann.sourceModel, zone_tag: ann.zoneTag, area_pixels2: areaPx, area_m2: areaM2, perimeter_pixels: perimPx, perimeter_m: perimM };
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "annotations.json"; a.click();
  };

  const exportCSV = () => {
    const headers = ["shape_type","class","x1","y1","x2","y2","polygon_points","confidence","source_model","zone_tag","area_pixels2","area_m2","perimeter_pixels","perimeter_m"];
    const rows = annotations.map(ann => {
      const [x1, y1, x2, y2] = annotationBbox(ann);
      const areaPx = annotationAreaPx(ann);
      const areaM2 = ratio ? areaPx * ratio * ratio : "";
      const perimPx = (ann.shapeType === "polygon" || ann.shapeType === "line" || ann.clsName === "zone") ? annotationPerimeterPx(ann) : "";
      const perimM = ratio && perimPx !== "" ? perimPx * ratio : "";
      return [ann.shapeType, ann.clsName, x1, y1, x2, y2, ann.points ? JSON.stringify(ann.points) : "", ann.confidence ?? "", ann.sourceModel ?? "", ann.zoneTag ?? "", areaPx, areaM2, perimPx, perimM];
    });
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "annotations.csv"; a.click();
  };

  // ─── Zone area summary ───────────────────────────────────────────────────────
  const zoneSummary = (() => {
    if (!ratio) return null;
    let totalArea = 0, totalPerim = 0, found = false;
    for (const ann of annotations) {
      if (ann.clsName === "zone") {
        totalArea += annotationAreaPx(ann) * ratio * ratio;
        totalPerim += annotationPerimeterPx(ann) * ratio;
        found = true;
      }
    }
    return found ? `Total zone: ${totalArea.toFixed(2)} m²  |  P: ${totalPerim.toFixed(2)} m` : null;
  })();

  // ─── Annotation list ─────────────────────────────────────────────────────────
  const visAnns = annotations.map((a, i) => ({ ann: a, origIdx: i })).filter(({ ann }) => visibleClasses.has(ann.clsName));

  // ─── Keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (document.activeElement.tagName === "INPUT") return;
        deleteSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        if (document.activeElement.tagName === "INPUT") return;
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        if (document.activeElement.tagName === "INPUT") return;
        e.preventDefault();
        redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        const visibleIdxs = annotations
          .map((a, i) => (visibleClasses.has(a.clsName) ? i : -1))
          .filter(i => i >= 0);
        const allIdxs = new Set(visibleIdxs);
        setSelectedIndices(allIdxs);
        setSelectedIdx(visibleIdxs.length > 0 ? visibleIdxs[visibleIdxs.length - 1] : null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [annotations, selectedIndices, undo, redo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── UI ──────────────────────────────────────────────────────────────────────
  const toolBtn = (mode, label) => (
    <button
      onClick={() => { setDrawMode(mode); setTempBox(null); setTempPolyPts([]); setTempPolyMouse(null); setTempLine(null); setTempLineShape(null); setTempCircle(null); }}
      style={{ ...styles.toolBtn, background: drawMode === mode ? "#1e6fff" : "#1a2035", border: drawMode === mode ? "1px solid #1e6fff" : "1px solid #2d3a52" }}
    >{label}</button>
  );

  return (
    <div style={styles.app}>
      {/* PDF Region Selector Modal */}
      {pdfModalData && (
        <PdfRegionSelector
          pdfData={pdfModalData}
          onConfirm={handlePdfConfirm}
          onCancel={() => { setPdfModalData(null); setStatus("PDF import cancelled."); }}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div style={styles.settingsOverlay} onClick={() => setShowSettings(false)}>
          <div style={styles.settingsModal} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ color: "#c8f0fa", fontWeight: 700, fontSize: 13, letterSpacing: 2 }}>SETTINGS</span>
              <button onClick={() => setShowSettings(false)} style={styles.tinyBtn}>✕</button>
            </div>
            <div style={{ color: "#7a9aaa", fontSize: 11, marginBottom: 6 }}>
              Automatic polygon simplification distance
            </div>
            <div style={{ color: "#4a6a7a", fontSize: 10, marginBottom: 10 }}>
              Applied to zone polygons after inference. 0 = disabled.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="number"
                min="0"
                max="999"
                value={autoSimplifyDist}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 0 && v <= 999) setAutoSimplifyDist(String(v));
                  else if (e.target.value === "") setAutoSimplifyDist("0");
                }}
                style={{ ...styles.smallInput, width: 64, fontSize: 14 }}
              />
              <span style={{ color: "#5a7a9a", fontSize: 11 }}>px  (0–999)</span>
            </div>

            <div style={{ borderTop: "1px solid #1a2e50", margin: "14px 0 12px" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={e => setAutoSave(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                <span style={{ color: "#7a9aaa", fontSize: 11 }}>Auto-save</span>
              </label>
            </div>
            {autoSave && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, paddingLeft: 22 }}>
                <span style={{ color: "#4a6a7a", fontSize: 11 }}>Every</span>
                <input
                  type="number"
                  min="10"
                  max="3600"
                  step="10"
                  value={autoSaveInterval}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 10) setAutoSaveInterval(String(v));
                    else if (e.target.value === "") setAutoSaveInterval("");
                  }}
                  style={{ ...styles.smallInput, width: 56 }}
                />
                <span style={{ color: "#4a6a7a", fontSize: 11 }}>seconds</span>
              </div>
            )}

            <div style={{ borderTop: "1px solid #1a2e50", margin: "14px 0 10px" }} />
            <div style={{ color: "#7a9aaa", fontSize: 11, marginBottom: 10 }}>Overlay text colors</div>

            {[
              { label: "Area (m²)",      value: areaTextColor,    set: setAreaTextColor },
              { label: "Perimeter (P:)", value: perimTextColor,   set: setPerimTextColor },
              { label: "Measure line",   value: measureTextColor, set: setMeasureTextColor },
            ].map(({ label, value, set }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <input
                  type="color"
                  value={value}
                  onChange={e => set(e.target.value)}
                  style={{ width: 32, height: 26, padding: 2, border: "none", background: "none", cursor: "pointer" }}
                />
                <span style={{ color: "#8aabbb", fontSize: 11 }}>{label}</span>
                <span style={{ color: value, fontSize: 11, marginLeft: "auto", fontFamily: "monospace" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={styles.header}>
        <span style={styles.logo}>⬡ QUANT 1.0 </span>
        <span style={styles.statusBar}>{status}</span>
        <label style={styles.uploadBtn}>
          📂 Load Image
          <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: "none" }} />
        </label>
        <label style={{ ...styles.uploadBtn, background: "#0d2e4a", borderColor: "#1a5070", color: "#6cf" }}>
          📄 Import PDF
          <input type="file" accept="application/pdf,.pdf" onChange={handlePdfChange} style={{ display: "none" }} />
        </label>
        {project?.id && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <button
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              style={{
                ...styles.uploadBtn,
                background: saveStatus === 'error' ? '#3a0f0f' : saveStatus === 'saved' ? '#0d2a1a' : '#0d1e38',
                borderColor: saveStatus === 'error' ? '#6a1a1a' : saveStatus === 'saved' ? '#1a5a3a' : '#1e3a6a',
                color: saveStatus === 'error' ? '#e05555' : saveStatus === 'saved' ? '#4ada8a' : '#6acf',
                cursor: saveStatus === 'saving' ? 'not-allowed' : 'pointer',
              }}
            >
              {saveStatus === 'saving' ? '⟳ Saving…' : saveStatus === 'saved' ? '✓ Saved' : saveStatus === 'error' ? '✕ Error' : '💾 Save'}
            </button>
            {lastSaveTime && (
              <span style={{ color: "#3a5a6a", fontSize: 9, whiteSpace: "nowrap" }}>
                {lastSaveTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>
        )}
        <button
          onClick={() => setShowSettings(v => !v)}
          title="Settings"
          style={{ ...styles.uploadBtn, padding: "4px 9px", fontSize: 14, lineHeight: 1, background: showSettings ? "#1a3060" : "#152240", borderColor: showSettings ? "#3a6ab0" : "#2a4070" }}
        >⚙</button>
      </div>

      <div style={styles.body}>
        {/* ── Left canvas area ── */}
        <div style={styles.canvasPanel}>
          <div style={styles.canvasToolbar}>
            {toolBtn("select", "↖ Select")}
            {toolBtn("lineShape", "─ Line")}
            {toolBtn("box", "⬜ Box")}
            {toolBtn("polygon", "⬡ Polygon")}
            {toolBtn("circle", "⬤ Circle")}
            {toolBtn("measure", "📏 Measure")}
            {toolBtn("line", "📐 Scale Cal.")}
            {/* Image Search button — hidden until backend is deployed
            <button
              onClick={() => { setDrawMode("imageSearch"); setTempBox(null); setTempPolyPts([]); setTempPolyMouse(null); setTempLine(null); setStatus("Image Search: draw a box around the object to find similar ones."); }}
              disabled={!originalImg || imageSearching}
              style={{
                ...styles.toolBtn,
                background: drawMode === "imageSearch" ? "#004444" : "#1a2035",
                border: drawMode === "imageSearch" ? `1px solid ${IMAGE_SEARCH_COLOR}` : "1px solid #2d3a52",
                color: drawMode === "imageSearch" ? IMAGE_SEARCH_COLOR : "#9ab",
                opacity: (!originalImg || imageSearching) ? 0.5 : 1,
              }}
            >
              {imageSearching ? "⟳ Searching…" : "🔍 Img Search"}
            </button>
            */}
            {drawMode === "polygon" && tempPolyPts.length >= 3 && (
              <button onClick={finishPolygon} style={{ ...styles.toolBtn, background: "#006633" }}>✓ Finish Poly</button>
            )}
            {drawMode === "polygon" && tempPolyPts.length > 0 && (
              <button onClick={() => { setTempPolyPts([]); setTempPolyMouse(null); }} style={{ ...styles.toolBtn, background: "#660022" }}>✕ Cancel</button>
            )}
            <div style={{ flex: 1 }} />
            <button
              onClick={undo}
              disabled={history.length === 0}
              title="Undo (Ctrl+Z)"
              style={{ ...styles.toolBtn, opacity: history.length === 0 ? 0.35 : 1 }}
            >↩ Undo{history.length > 0 ? ` (${history.length})` : ""}</button>
            <button
              onClick={redo}
              disabled={future.length === 0}
              title="Redo (Ctrl+Y)"
              style={{ ...styles.toolBtn, opacity: future.length === 0 ? 0.35 : 1 }}
            >↪ Redo{future.length > 0 ? ` (${future.length})` : ""}</button>
            <button onClick={() => setZoom(z => clamp(z * 1.2, 0.1, 8))} style={styles.toolBtn}>＋</button>
            <button onClick={() => setZoom(1)} style={styles.toolBtn}>⟳ Reset</button>
            <button onClick={() => setZoom(z => clamp(z / 1.2, 0.1, 8))} style={styles.toolBtn}>－</button>
            <span style={styles.zoomLabel}>{(scale * 100).toFixed(0)}%</span>
          </div>

          <div ref={containerRef} style={styles.canvasContainer} onWheel={onWheel}>
            {!originalImg && (
              <label style={styles.dropZone}>
                <div style={styles.dropIcon}>⬡</div>
                <div>Click to upload</div>
                <div style={styles.dropSub}>PNG · JPG · TIFF</div>
                <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: "none" }} />
                <div style={{ marginTop: 12, color: "#2a5070", fontSize: 11 }}>— or —</div>
                <label style={{ ...styles.uploadBtn, marginTop: 6, cursor: "pointer" }} onClick={e => e.stopPropagation()}>
                  📄 Import PDF
                  <input type="file" accept="application/pdf,.pdf" onChange={handlePdfChange} style={{ display: "none" }} />
                </label>
              </label>
            )}
            <canvas
              ref={canvasRef}
              style={{ display: originalImg ? "block" : "none", cursor: drawMode === "select" ? "default" : "crosshair" }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onDoubleClick={onDoubleClick}
            />
          </div>

          {/* Inference buttons */}
          <div style={styles.inferenceBar}>
            <span style={styles.confLabel}>Conf:</span>
            <input value={confOverride} onChange={e => { const v = e.target.value; if (v === '' || /^0?\.?\d*$/.test(v)) setConfOverride(v); }} placeholder="0–1" style={styles.confInput} />
            {/*  this button was removed , it was originally to run image inference separately, however PDFs and images are running from 1 button now
            <button onClick={() => runInference(false)} disabled={inferring || !originalImg} style={styles.inferBtn}>
              {inferring ? "⟳ Running…" : "▶ ⊞ Run Inference"}
            </button> */}
            <button onClick={() => runInference(true)} disabled={inferring || !originalImg} style={{ ...styles.inferBtn, background: "#0e4d6e" }}>
              ▶ Run Analysis
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: "#5a7a9a", fontSize: 11, userSelect: "none" }}>
              <input type="checkbox" checked={showConfidence} onChange={e => setShowConfidence(e.target.checked)} style={{ cursor: "pointer" }} />
              Show confidence
            </label>
            {zoneSummary && <span style={styles.zoneSummary}>{zoneSummary}</span>}
          </div>
        </div>

        {/* ── Right panel ── */}
        <div style={styles.rightPanel}>
          {/* Class visibility */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>VISIBILITY</div>
            {allClasses.map(cls => {
              const color = allClassColors[cls] || DEFAULT_COLOR;
              return (
                <label key={cls} style={styles.visRow}>
                  <input
                    type="checkbox"
                    checked={visibleClasses.has(cls)}
                    onChange={e => {
                      const isChecked = e.target.checked;
                      setVisibleClasses(prev => {
                        const s = new Set(prev);
                        if (isChecked) s.add(cls);
                        else s.delete(cls);

                        setSelectedIndices(prevSel => {
                          const filtered = new Set(
                            [...prevSel].filter(i => s.has(annotations[i]?.clsName))
                          );
                          const nextSelectedIdx =
                            selectedIdx != null && filtered.has(selectedIdx)
                              ? selectedIdx
                              : (filtered.size ? [...filtered][filtered.size - 1] : null);
                          setSelectedIdx(nextSelectedIdx);
                          return filtered;
                        });

                        return s;
                      });
                    }}
                  />
                  <span style={{ ...styles.classChip, borderColor: color, color }}>{cls}</span>
                </label>
              );
            })}
          </div>

          {/* Draw class */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>NEW SHAPE CLASS</div>
            <select value={newClass} onChange={e => setNewClass(e.target.value)} style={styles.select}>
              {allClasses.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Edit selected */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>EDIT SELECTED</div>
            <div style={styles.row}>
              <select value={editClass} onChange={e => setEditClass(e.target.value)} style={{ ...styles.select, flex: 1 }}>
                {allClasses.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <button onClick={applyClass} style={styles.smallBtn}>Apply</button>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Tag:</span>
              <select value={selectedZoneTag} onChange={e => setSelectedZoneTag(e.target.value)} style={{ ...styles.select, flex: 1 }}>
                <option value="">— none —</option>
                {Object.keys(zoneTags).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button onClick={applyTag} style={styles.smallBtn}>Set</button>
            </div>
            <button onClick={deleteSelected} style={{ ...styles.smallBtn, background: "#5c1010", width: "100%", marginTop: 4 }}>🗑 Delete Selected</button>
            <div style={{ ...styles.row, marginTop: 6 }}>
              <span style={styles.label} title="RDP tolerance in image pixels">ε px:</span>
              <input
                value={simplifyEpsilon}
                onChange={e => setSimplifyEpsilon(e.target.value)}
                style={{ ...styles.smallInput, width: 44 }}
                placeholder="3"
                title="Simplify tolerance in image pixels"
              />
              <button onClick={simplifySelected} style={styles.smallBtn} title="Simplify selected polygon(s) with Ramer-Douglas-Peucker">Simplify</button>
            </div>
          </div>

          {/* Tag manager */}
          <div style={styles.section}>
            <div style={{ ...styles.sectionTitle, display: "flex", justifyContent: "space-between" }}>
              TAGS
              <button onClick={() => setShowTagManager(v => !v)} style={styles.tinyBtn}>{showTagManager ? "▲" : "▼"}</button>
            </div>
            {showTagManager && (
              <div>
                {Object.entries(zoneTags).map(([t, c]) => (
                  <div key={t} style={{ ...styles.row, marginBottom: 2 }}>
                    <span style={{ width: 12, height: 12, background: c, display: "inline-block", borderRadius: 2, marginRight: 6 }} />
                    <span style={{ ...styles.label, flex: 1 }}>{t}</span>
                    <button onClick={() => { const copy = { ...zoneTags }; delete copy[t]; setZoneTags(copy); }} style={styles.tinyBtn}>✕</button>
                  </div>
                ))}
                <div style={styles.row}>
                  <input value={tagName} onChange={e => setTagName(e.target.value)} placeholder="tag name" style={{ ...styles.smallInput, flex: 1 }} />
                  <input type="color" value={tagColor} onChange={e => setTagColor(e.target.value)} style={{ width: 28, height: 24, padding: 1, background: "none", border: "none" }} />
                  <button onClick={() => { if (!tagName.trim()) return; setZoneTags(t => ({ ...t, [tagName.trim()]: tagColor })); setTagName(""); }} style={styles.smallBtn}>Add</button>
                </div>
              </div>
            )}
          </div>

          {/* Custom class manager */}
          <div style={styles.section}>
            <div style={{ ...styles.sectionTitle, display: "flex", justifyContent: "space-between" }}>
              CUSTOM CLASSES
              <button onClick={() => setShowClassManager(v => !v)} style={styles.tinyBtn}>{showClassManager ? "▲" : "▼"}</button>
            </div>
            {showClassManager && (
              <div>
                {customClasses.length === 0 && (
                  <div style={{ color: "#3a5070", fontSize: 10, marginBottom: 4 }}>No custom classes yet.</div>
                )}
                {customClasses.map(cc => (
                  <div key={cc.name} style={{ ...styles.row, marginBottom: 2 }}>
                    <span style={{ width: 12, height: 12, background: cc.color, display: "inline-block", borderRadius: 2, marginRight: 6, flexShrink: 0 }} />
                    <span style={{ ...styles.label, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{cc.name}</span>
                    <button onClick={() => {
                      setCustomClasses(prev => prev.filter(c => c.name !== cc.name));
                      setVisibleClasses(prev => { const s = new Set(prev); s.delete(cc.name); s.add(UNASSIGNED_CLASS); return s; });
                      setAnnotations(prev => prev.map(a => a.clsName === cc.name ? { ...a, clsName: UNASSIGNED_CLASS } : a));
                    }} style={styles.tinyBtn}>✕</button>
                  </div>
                ))}
                <div style={styles.row}>
                  <input
                    value={newCustomClassName}
                    onChange={e => setNewCustomClassName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key !== "Enter") return;
                      const name = newCustomClassName.trim();
                      if (!name || allClasses.includes(name)) return;
                      setCustomClasses(prev => [...prev, { name, color: newCustomClassColor }]);
                      setVisibleClasses(prev => new Set([...prev, name]));
                      setNewCustomClassName("");
                    }}
                    placeholder="class name"
                    style={{ ...styles.smallInput, flex: 1, width: "auto" }}
                  />
                  <input type="color" value={newCustomClassColor} onChange={e => setNewCustomClassColor(e.target.value)} style={{ width: 28, height: 24, padding: 1, background: "none", border: "none", cursor: "pointer" }} />
                  <button onClick={() => {
                    const name = newCustomClassName.trim();
                    if (!name || allClasses.includes(name)) return;
                    setCustomClasses(prev => [...prev, { name, color: newCustomClassColor }]);
                    setVisibleClasses(prev => new Set([...prev, name]));
                    setNewCustomClassName("");
                  }} style={styles.smallBtn}>Add</button>
                </div>
              </div>
            )}
          </div>

          {/* Scale calibration */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>SCALE CALIBRATION</div>
            <div style={{ color: "#4a6a7a", fontSize: 10, marginBottom: 6 }}>
              Draw a line with 📐, then enter its real length below.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
              <span style={{ color: "#00ccff", fontSize: 12, whiteSpace: "nowrap" }}>Scale</span>
              <input
                value={realLength}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setRealLength(v); }}
                style={{ ...styles.smallInput, width: 48 }}
                placeholder="1"
                title="Real-world length"
              />
              <span style={{ color: "#5a7a9a", fontSize: 12 }}>:</span>
              <input
                value={pixelLength}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setPixelLength(v); }}
                style={{ ...styles.smallInput, width: 48 }}
                placeholder=""
                title="Pixel length (auto-filled when you draw a line)"
              />
            </div>
            <button onClick={calculateRatio} style={{ ...styles.smallBtn, width: "100%" }}>Set Scale</button>
            {ratio != null && <div style={styles.ratioDisplay}>1 px = {ratio.toFixed(6)} m</div>}
          </div>

          {/* Export */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>EXPORT</div>
            <button onClick={exportJSON} style={{ ...styles.smallBtn, width: "100%", marginBottom: 4 }}>⬇ JSON</button>
            <button onClick={exportCSV} style={{ ...styles.smallBtn, width: "100%", background: "#0d3d2a" }}>⬇ CSV</button>
          </div>

          {/* Annotation list */}
          <div style={{ ...styles.section, flex: 1, minHeight: 0 }}>
            <div style={styles.sectionTitle}>ANNOTATIONS ({visAnns.length})</div>
            <div style={styles.annList}>
              {visAnns.map(({ ann, origIdx }) => {
                const [x1, y1, x2, y2] = annotationBbox(ann);
                const isSel = selectedIdx === origIdx;
                return (
                  <div key={ann.id} onClick={() => { setSelectedIdx(origIdx); setSelectedIndices(new Set([origIdx])); setEditClass(ann.clsName); setEditConf(ann.confidence != null ? String(ann.confidence) : ""); }}
                    style={{ ...styles.annRow, background: isSel ? "#1a3056" : "transparent", borderLeft: `3px solid ${getClassColor(ann.clsName)}` }}>
                    <span style={{ color: getClassColor(ann.clsName), fontWeight: 600, fontSize: 10 }}>{ann.clsName}</span>
                    {ann.zoneTag && <span style={{ color: "#aaa", fontSize: 9 }}> :{ann.zoneTag}</span>}
                    <br />
                    <span style={{ color: "#667", fontSize: 9 }}>({x1},{y1})–({x2},{y2}) {ann.shapeType === "polygon" ? "[poly]" : ""}</span>
                    {showConfidence && ann.confidence != null && <span style={{ color: "#556", fontSize: 9 }}> {ann.confidence.toFixed(2)}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const styles = {
  app: { display: "flex", flexDirection: "column", height: "100vh", background: "#0b0f1a", color: "#c8d0e0", fontFamily: "'IBM Plex Mono', 'Fira Mono', monospace", fontSize: 12, overflow: "hidden" },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "6px 14px", background: "#0e1422", borderBottom: "3px solid #1c2540" },
  logo: { color: "#4af", fontWeight: 700, fontSize: 14, letterSpacing: 2, whiteSpace: "nowrap" },
  statusBar: { flex: 1, color: "#7a8faa", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  uploadBtn: { background: "#152240", border: "1px solid #2a4070", borderRadius: 4, padding: "4px 10px", cursor: "pointer", color: "#8ab", fontSize: 11, whiteSpace: "nowrap" },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  canvasPanel: { display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" },
  canvasToolbar: { display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", background: "#0e1422", borderBottom: "1px solid #1c2540" },
  toolBtn: { background: "#1a2035", border: "1px solid #2d3a52", borderRadius: 3, color: "#9ab", padding: "3px 8px", cursor: "pointer", fontSize: 11 },
  zoomLabel: { color: "#4a7a9b", fontSize: 11, minWidth: 40, textAlign: "right" },
  canvasContainer: { flex: 1, overflow: "auto", background: "#0d1120", display: "flex", alignItems: "flex-start", justifyContent: "flex-start", padding: 8 },
  dropZone: { width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", color: "#3a5070", border: "2px dashed #1c2f50", borderRadius: 8, minHeight: 300 },
  dropIcon: { fontSize: 48, color: "#1e3a58" },
  dropSub: { fontSize: 10, color: "#2a4060" },
  inferenceBar: { display: "flex", alignItems: "center", gap: 8, padding: "15px 10px", background: "#0e1422", borderTop: "3px solid #1c2540" },
  confLabel: { color: "#5a7a9a", fontSize: 11 },
  confInput: { width: 60, background: "#0d1625", border: "1px solid #1e3050", borderRadius: 3, color: "#8ab", padding: "2px 6px", fontSize: 11 },
  inferBtn: { background: "#0f3460", border: "1px solid #1e5a9a", borderRadius: 3, color: "#7af", padding: "3px 10px", cursor: "pointer", fontSize: 11 },
  zoneSummary: { color: "#5a8a6a", fontSize: 11, marginLeft: 8 },
  rightPanel: { width: 320, display: "flex", flexDirection: "column", background: "#0c1020", borderLeft: "1px solid #1a2540", overflow: "auto" },
  section: { padding: "8px 10px", borderBottom: "1px solid #141e30" },
  sectionTitle: { color: "#c8f0fa", fontSize: 13, letterSpacing: 2, marginBottom: 6, fontWeight: 700 },
  visRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 3, cursor: "pointer" },
  classChip: { border: "1px solid", borderRadius: 2, padding: "1px 5px", fontSize: 10 },
  select: { background: "#0d1625", border: "1px solid #1e3050", borderRadius: 3, color: "#8ab", padding: "3px 5px", fontSize: 11, width: "100%" },
  row: { display: "flex", alignItems: "center", gap: 4, marginBottom: 4 },
  label: { color: "#00ccff", fontSize: 12, whiteSpace: "nowrap", minWidth: 55 },
  smallBtn: { background: "#152240", border: "1px solid #2a4070", borderRadius: 3, color: "#8ab", padding: "3px 7px", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" },
  tinyBtn: { background: "#0d1625", border: "1px solid #1e3050", borderRadius: 2, color: "#5a7a9a", padding: "1px 5px", cursor: "pointer", fontSize: 10 },
  smallInput: { background: "#0d1625", border: "1px solid #1e3050", borderRadius: 3, color: "#8ab", padding: "2px 5px", fontSize: 11, width: 70 },
  ratioDisplay: { color: "#3a8a5a", fontSize: 10, marginTop: 3 },
  annList: { maxHeight: 300, overflowY: "auto" },
  annRow: { padding: "4px 6px", cursor: "pointer", borderRadius: 2, marginBottom: 1, paddingLeft: 6 },
  settingsOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 9000, display: "flex", alignItems: "flex-start", justifyContent: "flex-end" },
  settingsModal: { marginTop: 48, marginRight: 14, background: "#0e1728", border: "1px solid #2a4070", borderRadius: 8, padding: "16px 18px", minWidth: 300, boxShadow: "0 8px 32px rgba(0,0,0,0.7)", zIndex: 9001 },
};
