import { useState, useRef, useEffect, useCallback } from "react";
import { loadProject, saveProject, getOriginalFileUrl, pageSlugify, listProjects, grantProjectAccess, getProjectGrants, revokeProjectAccess } from "./services/projectStorage";
import { getLimits, tierLabel, tierColor } from "./services/userService";
import Drawing from "dxf-writer";
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";

// ─── EXCEL COLUMNS ────────────────────────────────────────────────────────────
const EXCEL_COLUMNS = [
  { key: "page",             label: "Page" },
  { key: "num_id",           label: "ID" },
  { key: "shape_type",       label: "Shape Type" },
  { key: "class",            label: "Class" },
  { key: "x1",               label: "X1 (px)" },
  { key: "y1",               label: "Y1 (px)" },
  { key: "x2",               label: "X2 (px)" },
  { key: "y2",               label: "Y2 (px)" },
  { key: "polygon_points",   label: "Polygon Points" },
  { key: "confidence",       label: "Confidence" },
  { key: "source_model",     label: "Source Model" },
  { key: "zone_tag",         label: "Tag" },
  { key: "area_px2",         label: "Area (px²)" },
  { key: "area_m2",          label: "Area (m²)" },
  { key: "perimeter_px",     label: "Perimeter (px)" },
  { key: "length_m",         label: "Length / Perimeter (m)" },
];

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const WALL_MODEL_URL = "";
const WALL_MODEL_HEADERS = { Authorization: "" };
const WALL_MODEL_DATA = { conf: 0.5, iou: 0.7, imgsz: 640 };

const ZONE_MODEL_URL = "";
const ZONE_MODEL_HEADERS = { Authorization: "" };
const ZONE_MODEL_DATA = { conf: 0.25, iou: 0.7, imgsz: 640 };

// Instance segmentation model — zones only (returns polygons, not boxes)
const ZONE_SEG_MODEL_URL = "";
const ZONE_SEG_MODEL_HEADERS = { Authorization: "" };
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

// ─── AUTO DXF: PDF vector extraction helpers ─────────────────────────────────
function _bezierPts(p0, p1, p2, p3, n = 16) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    pts.push([
      mt**3*p0[0]+3*mt**2*t*p1[0]+3*mt*t**2*p2[0]+t**3*p3[0],
      mt**3*p0[1]+3*mt**2*t*p1[1]+3*mt*t**2*p2[1]+t**3*p3[1],
    ]);
  }
  return pts;
}

function _detectHatches(lines, angleTol=2, spacingTol=3, minLines=5, maxSpacing=20) {
  if (!lines || !lines.length) return { hatches: [], remaining: lines || [] };
  const ann = [];
  for (const ln of lines) {
    const dx = ln.end[0]-ln.start[0], dy = ln.end[1]-ln.start[1];
    const len = Math.sqrt(dx*dx+dy*dy);
    if (len < 0.5) continue;
    const angle = ((Math.atan2(dy, dx)*180/Math.PI)%180+180)%180;
    ann.push({ ...ln, _a: angle, _m: [(ln.start[0]+ln.end[0])/2, (ln.start[1]+ln.end[1])/2] });
  }
  const groups = {};
  for (const it of ann) { const b = Math.round(it._a/angleTol)*angleTol; (groups[b]||(groups[b]=[])).push(it); }
  const hatches = [], remaining = [];
  for (const [bucket, grp] of Object.entries(groups)) {
    if (grp.length < minLines) { remaining.push(...grp); continue; }
    const rad = parseFloat(bucket)*Math.PI/180, px = -Math.sin(rad), py = Math.cos(rad);
    const projs = grp.map(it => it._m[0]*px+it._m[1]*py).sort((a,b)=>a-b);
    const sp = []; for (let i=0;i<projs.length-1;i++) sp.push(projs[i+1]-projs[i]);
    if (!sp.length) { remaining.push(...grp); continue; }
    const med = [...sp].sort((a,b)=>a-b)[Math.floor(sp.length/2)];
    const reg = sp.filter(s => Math.abs(s-med)<spacingTol).length;
    if (reg > sp.length*0.6 && med < maxSpacing) hatches.push({ angle: Math.round(parseFloat(bucket)*10)/10, spacing: Math.round(med*100)/100, lines: grp });
    else remaining.push(...grp);
  }
  return { hatches, remaining: remaining.map(({_a,_m,...r})=>r) };
}

async function _extractPdfVectors(pdfDoc, pageNum, region) {
  const page = await pdfDoc.getPage(pageNum); // 1-based
  const vp = page.getViewport({ scale: 1.0 });
  const opList = await page.getOperatorList();
  const OPS = window.pdfjsLib.OPS;
  const stStack = [];
  let ctm=[1,0,0,1,0,0], lw=1, sC=[0,0,0], fC=null;
  let pts=[], pStart=null, closed=false, cx=0, cy=0;
  const lines=[], curves=[], rects=[], polys=[];
  const mm=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const tp=(x,y)=>[ctm[0]*x+ctm[2]*y+ctm[4],ctm[1]*x+ctm[3]*y+ctm[5]];
  const r3=v=>Math.round(v*1000)/1000;
  const inR=(x,y)=>!region||(x>=region[0]&&x<=region[2]&&y>=region[1]&&y<=region[3]);
  function emit(){
    if(pts.length<2){pts=[];pStart=null;closed=false;return;}
    if(closed&&pts.length>=4){
      const pp=pts.map(([x,y])=>[r3(x),r3(y)]);
      if(!region||pp.some(([x,y])=>inR(x,y))) polys.push({points:pp,color:[...sC],fill:fC?[...fC]:null,width:lw});
    } else {
      for(let j=0;j<pts.length-1;j++){
        const s=[r3(pts[j][0]),r3(pts[j][1])],e=[r3(pts[j+1][0]),r3(pts[j+1][1])];
        if(!region||inR(s[0],s[1])||inR(e[0],e[1])) lines.push({start:s,end:e,color:[...sC],width:lw});
      }
    }
    pts=[];pStart=null;closed=false;
  }
  for(let i=0;i<opList.fnArray.length;i++){
    const fn=opList.fnArray[i],args=opList.argsArray[i];
    if(fn===OPS.save) stStack.push({ctm:[...ctm],lw,sC:[...sC],fC:fC?[...fC]:null});
    else if(fn===OPS.restore&&stStack.length){const s=stStack.pop();ctm=s.ctm;lw=s.lw;sC=s.sC;fC=s.fC;}
    else if(fn===OPS.transform) ctm=mm(ctm,[args[0],args[1],args[2],args[3],args[4],args[5]]);
    else if(fn===OPS.setLineWidth) lw=args[0];
    else if(fn===OPS.setStrokeRGBColor) sC=[Math.round(args[0]*255),Math.round(args[1]*255),Math.round(args[2]*255)];
    else if(fn===OPS.setFillRGBColor) fC=[Math.round(args[0]*255),Math.round(args[1]*255),Math.round(args[2]*255)];
    else if(fn===OPS.setStrokeGray){const v=Math.round(args[0]*255);sC=[v,v,v];}
    else if(fn===OPS.setFillGray){const v=Math.round(args[0]*255);fC=[v,v,v];}
    else if(fn===OPS.constructPath){
      const sOps=args[0],sArgs=args[1];let j=0;
      for(let k=0;k<sOps.length;k++){
        const op=sOps[k];
        if(op===OPS.moveTo){if(pts.length>=2)emit();const[px,py]=tp(sArgs[j],sArgs[j+1]);j+=2;pStart=[px,py];pts=[[px,py]];cx=px;cy=py;closed=false;}
        else if(op===OPS.lineTo){const[px,py]=tp(sArgs[j],sArgs[j+1]);j+=2;pts.push([px,py]);cx=px;cy=py;}
        else if(op===OPS.curveTo){const[c1x,c1y]=tp(sArgs[j],sArgs[j+1]),[c2x,c2y]=tp(sArgs[j+2],sArgs[j+3]),[ex,ey]=tp(sArgs[j+4],sArgs[j+5]);j+=6;const sp=pts.length?pts[pts.length-1]:[cx,cy];curves.push({p0:[r3(sp[0]),r3(sp[1])],p1:[r3(c1x),r3(c1y)],p2:[r3(c2x),r3(c2y)],p3:[r3(ex),r3(ey)],color:[...sC],width:lw});pts.push([ex,ey]);cx=ex;cy=ey;}
        else if(op===OPS.curveTo2){const[c2x,c2y]=tp(sArgs[j],sArgs[j+1]),[ex,ey]=tp(sArgs[j+2],sArgs[j+3]);j+=4;const sp=pts.length?pts[pts.length-1]:[cx,cy];curves.push({p0:[r3(sp[0]),r3(sp[1])],p1:[r3(sp[0]),r3(sp[1])],p2:[r3(c2x),r3(c2y)],p3:[r3(ex),r3(ey)],color:[...sC],width:lw});pts.push([ex,ey]);cx=ex;cy=ey;}
        else if(op===OPS.curveTo3){const[c1x,c1y]=tp(sArgs[j],sArgs[j+1]),[ex,ey]=tp(sArgs[j+2],sArgs[j+3]);j+=4;const sp=pts.length?pts[pts.length-1]:[cx,cy];curves.push({p0:[r3(sp[0]),r3(sp[1])],p1:[r3(c1x),r3(c1y)],p2:[r3(ex),r3(ey)],p3:[r3(ex),r3(ey)],color:[...sC],width:lw});pts.push([ex,ey]);cx=ex;cy=ey;}
        else if(op===OPS.rectangle){const x=sArgs[j],y=sArgs[j+1],w=sArgs[j+2],h=sArgs[j+3];j+=4;const[rx0,ry0]=tp(x,y),[rx1,ry1]=tp(x+w,y+h);const mn=[Math.min(rx0,rx1),Math.min(ry0,ry1)],mx=[Math.max(rx0,rx1),Math.max(ry0,ry1)];if(inR((mn[0]+mx[0])/2,(mn[1]+mx[1])/2))rects.push({x0:r3(mn[0]),y0:r3(mn[1]),x1:r3(mx[0]),y1:r3(mx[1]),color:[...sC],fill:fC?[...fC]:null,width:lw});}
        else if(op===OPS.closePath){closed=true;if(pStart)pts.push([...pStart]);}
      }
    }
    else if(fn===OPS.stroke||fn===OPS.closeStroke){if(fn===OPS.closeStroke&&pStart&&!closed){closed=true;pts.push([...pStart]);}emit();}
    else if(fn===OPS.fill||fn===OPS.eoFill||fn===OPS.fillStroke||fn===OPS.eoFillStroke||fn===OPS.closeFillStroke){if(pStart&&!closed){closed=true;pts.push([...pStart]);}emit();}
    else if(fn===OPS.endPath){pts=[];pStart=null;closed=false;}
  }
  return {pageWidth:vp.width,pageHeight:vp.height,lines,curves,rects,closedPolys:polys};
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

// Solve for wall length from area and perimeter of a rectangle:
// area = a*b, perimeter = 2a+2b → quadratic: a² - (P/2)*a + area = 0
// Returns the longer side (a >= b)
function wallLengthFromAreaPerim(areaPx, perimPx) {
  const halfP = perimPx / 2;
  const disc = halfP * halfP - 4 * areaPx;
  if (disc < 0) return halfP / 2; // fallback: square
  const sqrtDisc = Math.sqrt(disc);
  const a = (halfP + sqrtDisc) / 2;
  return a;
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

// Returns the next sequential numId (max existing + 1, or 1 if none)
function nextNumId(anns) {
  let max = 0;
  for (const a of anns) if (typeof a.numId === "number" && a.numId > max) max = a.numId;
  return max + 1;
}

// Assigns sequential numIds to annotations missing one (stable order)
function fillMissingNumIds(anns) {
  let next = nextNumId(anns);
  return anns.map(a => (typeof a.numId === "number" ? a : { ...a, numId: next++ }));
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
      // Length label (with numId prefix)
      const lineLen = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
      const lmx = ((ann.x1 + ann.x2) / 2) * scale + 4;
      const lmy = Math.max(12, ((ann.y1 + ann.y2) / 2) * scale - 8);
      ctx.font = "bold 11px monospace";
      ctx.fillStyle = color;
      const idPrefix = ann.numId != null ? `#${ann.numId} ` : "";
      if (ratio) {
        ctx.fillText(`${idPrefix}${(lineLen * ratio).toFixed(3)} m`, lmx, lmy);
      } else {
        ctx.fillText(`${idPrefix}${lineLen.toFixed(1)} px`, lmx, lmy);
      }
    } else if (ann.points && ann.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(ann.points[0][0] * scale, ann.points[0][1] * scale);
      for (let j = 1; j < ann.points.length; j++) ctx.lineTo(ann.points[j][0] * scale, ann.points[j][1] * scale);
      ctx.closePath();
      ctx.stroke();
    }

    // Label (skip for line — length already shown inline with ID)
    if (ann.shapeType !== "line") {
      let label = ann.numId != null ? `#${ann.numId} ${ann.clsName}` : ann.clsName;
      if (ann.zoneTag) label += `: ${ann.zoneTag}`;
      if (showConfidence && ann.confidence != null) label += ` ${ann.confidence.toFixed(2)}`;
      if (ann.shapeType === "polygon") label += " [poly]";
      ctx.fillStyle = color;
      ctx.font = "bold 11px monospace";
      ctx.fillText(label, x1 * scale + 3, Math.max(12, y1 * scale - 4));
    }

    // Area/perimeter overlay — only zones
    if (ann.clsName === "zone" && ratio) {
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
function PdfPageImportModal({ pdfData, onConfirmSingle, onConfirmMulti, onCancel }) {
  const previewCanvasRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [totalPages, setTotalPages] = useState(0);
  const [thumbnails, setThumbnails] = useState([]); // [{pageIndex, dataUrl}]
  const [selectedPages, setSelectedPages] = useState(new Set());
  const [pageLabels, setPageLabels] = useState({}); // { pdfPageIndex0based: string }
  const [loadError, setLoadError] = useState(null);

  // Step 2 — crop state
  const [step, setStep] = useState(1); // 1 = select pages, 2 = crop
  const [fullResPages, setFullResPages] = useState([]); // [{origPageIndex, pageCanvas}] rendered at full DPI
  const [cropIdx, setCropIdx] = useState(0); // which page in fullResPages we're cropping
  const [cropRects, setCropRects] = useState({}); // { idx: {x1,y1,x2,y2} in PREVIEW coords } — null = full page
  const [prevScale, setPrevScale] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState('');
  const [cropStatus, setCropStatus] = useState('');
  const dragStart = useRef(null);
  const isDragging = useRef(false);

  // ── Load pdf.js + parse document ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    loadPdfJs().then(async (pdfjsLib) => {
      const typedArray = new Uint8Array(pdfData.slice(0));
      const doc = await pdfjsLib.getDocument({ data: typedArray }).promise;
      if (cancelled) return;
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      const allIdx = new Set();
      for (let i = 0; i < doc.numPages; i++) allIdx.add(i);
      setSelectedPages(allIdx);

      const thumbs = [];
      for (let i = 0; i < doc.numPages; i++) {
        try {
          const page = await doc.getPage(i + 1);
          const thumbScale = 0.3;
          const viewport = page.getViewport({ scale: thumbScale });
          const offscreen = document.createElement("canvas");
          offscreen.width = Math.round(viewport.width);
          offscreen.height = Math.round(viewport.height);
          await page.render({ canvasContext: offscreen.getContext("2d"), viewport }).promise;
          if (cancelled) return;
          thumbs.push({ pageIndex: i, dataUrl: offscreen.toDataURL("image/jpeg", 0.7) });
        } catch {
          thumbs.push({ pageIndex: i, dataUrl: null });
        }
      }
      if (!cancelled) {
        setThumbnails(thumbs);
        // Default label: "Page N" using 1-based PDF page number
        const defaults = {};
        thumbs.forEach(t => { defaults[t.pageIndex] = `Page ${t.pageIndex + 1}`; });
        setPageLabels(defaults);
      }
    }).catch((err) => {
      console.error('[PdfPageImportModal] Failed to load PDF:', err);
      if (!cancelled) setLoadError(err?.message || 'Failed to parse PDF.');
    });
    return () => { cancelled = true; };
  }, [pdfData]);

  const togglePage = (idx) => {
    setSelectedPages(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAll = () => { const s = new Set(); for (let i = 0; i < totalPages; i++) s.add(i); setSelectedPages(s); };
  const selectNone = () => setSelectedPages(new Set());

  // ── Step 1 → Step 2: render selected pages at full DPI ───────────────────
  const goToCropStep = async () => {
    if (!pdfDoc || selectedPages.size === 0) return;
    setRendering(true);
    const sorted = [...selectedPages].sort((a, b) => a - b);
    const rendered = [];
    for (let i = 0; i < sorted.length; i++) {
      const pgIdx = sorted[i];
      setRenderProgress(`Rendering page ${i + 1} of ${sorted.length}…`);
      try {
        const page = await pdfDoc.getPage(pgIdx + 1);
        const viewport = page.getViewport({ scale: PDF_SCALE });
        const offscreen = document.createElement("canvas");
        offscreen.width = Math.round(viewport.width);
        offscreen.height = Math.round(viewport.height);
        await page.render({ canvasContext: offscreen.getContext("2d"), viewport }).promise;
        rendered.push({ origPageIndex: pgIdx, pageCanvas: offscreen });
      } catch (err) {
        console.error(`[PdfPageImportModal] Failed to render page ${pgIdx + 1}:`, err);
      }
    }
    setRendering(false);
    if (rendered.length === 0) return;
    setFullResPages(rendered);
    setCropIdx(0);
    setCropRects({});
    setCropStatus("Drag a rectangle to crop, or use 'Full Page'. Navigate pages with ◀ ▶.");
    setStep(2);
  };

  // ── Step 2: draw preview canvas for current crop page ─────────────────────
  const currentCropPage = fullResPages[cropIdx] || null;

  useEffect(() => {
    if (step !== 2 || !currentCropPage || !previewCanvasRef.current) return;
    const container = previewCanvasRef.current.parentElement;
    const maxW = container.clientWidth - 4;
    const maxH = container.clientHeight - 4;
    const pc = currentCropPage.pageCanvas;
    const ps = Math.min(maxW / pc.width, maxH / pc.height, 1.0);
    setPrevScale(ps);
    const pw = Math.round(pc.width * ps);
    const ph = Math.round(pc.height * ps);
    const cv = previewCanvasRef.current;
    cv.width = pw;
    cv.height = ph;
    const ctx = cv.getContext("2d");
    ctx.drawImage(pc, 0, 0, pw, ph);
    const r = cropRects[cropIdx] || null;
    if (r) drawCropRect(ctx, r);
  }, [step, cropIdx, currentCropPage, cropRects]); // eslint-disable-line react-hooks/exhaustive-deps

  function drawCropRect(ctx, r) {
    if (!r) return;
    ctx.strokeStyle = "#FF3300";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
    ctx.fillStyle = "rgba(255,51,0,0.18)";
    ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
  }

  function repaintCrop(r) {
    const cv = previewCanvasRef.current;
    if (!cv || !currentCropPage) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(currentCropPage.pageCanvas, 0, 0, cv.width, cv.height);
    if (r) drawCropRect(ctx, r);
  }

  function getCropXY(e) {
    const rect_ = previewCanvasRef.current.getBoundingClientRect();
    return {
      px: clamp(e.clientX - rect_.left, 0, previewCanvasRef.current.width - 1),
      py: clamp(e.clientY - rect_.top, 0, previewCanvasRef.current.height - 1),
    };
  }

  function onCropMouseDown(e) {
    if (e.button !== 0) return;
    isDragging.current = true;
    const { px, py } = getCropXY(e);
    dragStart.current = [px, py];
    setCropRects(prev => ({ ...prev, [cropIdx]: null }));
    repaintCrop(null);
  }

  function onCropMouseMove(e) {
    if (!isDragging.current || !dragStart.current) return;
    const { px, py } = getCropXY(e);
    const [sx, sy] = dragStart.current;
    const r = { x1: Math.min(sx, px), y1: Math.min(sy, py), x2: Math.max(sx, px), y2: Math.max(sy, py) };
    setCropRects(prev => ({ ...prev, [cropIdx]: r }));
    repaintCrop(r);
    if (currentCropPage && prevScale > 0) {
      const fw = Math.round((r.x2 - r.x1) / prevScale), fh = Math.round((r.y2 - r.y1) / prevScale);
      setCropStatus(`Crop: ${fw} × ${fh} px at ${PDF_RENDER_DPI} DPI  —  Page ${cropIdx + 1} of ${fullResPages.length}`);
    }
  }

  function onCropMouseUp() { isDragging.current = false; }

  function clearCurrentCrop() {
    setCropRects(prev => { const next = { ...prev }; delete next[cropIdx]; return next; });
    repaintCrop(null);
    setCropStatus(`Crop cleared — will use full page. Page ${cropIdx + 1} of ${fullResPages.length}`);
  }

  function markFullPageAll() {
    setCropRects({});
    setCropStatus("All pages set to full page.");
  }

  // ── Final confirm: apply crops and return canvases ────────────────────────
  function handleFinalConfirm() {
    const results = fullResPages.map((fp, idx) => {
      const pc = fp.pageCanvas;
      const r = cropRects[idx];
      let outCanvas;
      if (r && prevScale > 0) {
        const fx1 = clamp(Math.round(r.x1 / prevScale), 0, pc.width);
        const fy1 = clamp(Math.round(r.y1 / prevScale), 0, pc.height);
        const fx2 = clamp(Math.round(r.x2 / prevScale), 0, pc.width);
        const fy2 = clamp(Math.round(r.y2 / prevScale), 0, pc.height);
        const cw = fx2 - fx1, ch = fy2 - fy1;
        if (cw >= 4 && ch >= 4) {
          outCanvas = document.createElement("canvas");
          outCanvas.width = cw;
          outCanvas.height = ch;
          outCanvas.getContext("2d").drawImage(pc, fx1, fy1, cw, ch, 0, 0, cw, ch);
        } else {
          outCanvas = pc; // crop too small, use full
        }
      } else {
        outCanvas = pc;
      }
      return {
        pageIndex: idx,
        pdfPageNumber: fp.origPageIndex + 1, // 1-based PDF page number
        label: pageLabels[fp.origPageIndex] || `Page ${fp.origPageIndex + 1}`,
        canvas: outCanvas,
      };
    });

    if (results.length === 1) {
      onConfirmSingle(results[0].canvas);
    } else {
      onConfirmMulti(results);
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <div style={pdfStyles.overlay}>
      <div style={pdfStyles.modal}>
        <div style={pdfStyles.header}>
          <span style={pdfStyles.title}>📄 PDF IMPORT</span>
          <span style={pdfStyles.subtitle}>
            {step === 1
              ? (totalPages > 0 ? `Step 1 — Select pages (${totalPages} found)` : 'Loading PDF…')
              : `Step 2 — Crop regions  (${fullResPages.length} page${fullResPages.length !== 1 ? 's' : ''})`}
          </span>
        </div>

        {/* ── Error ── */}
        {loadError && (
          <div style={{ padding: 24, color: "#e05555", fontFamily: "monospace", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
            Could not render this PDF.<br />
            <span style={{ fontSize: 10, color: "#7a4a4a" }}>{loadError}</span><br /><br />
            <span style={{ fontSize: 11, color: "#5a7a9a" }}>
              Try exporting the drawing as a PNG or TIFF from your CAD software and use Load Image instead.
            </span>
          </div>
        )}

        {/* ════════════════  STEP 1 — page selection  ════════════════ */}
        {step === 1 && !loadError && (
          <>
            {thumbnails.length === 0 && (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#3a5c7a", fontFamily: "monospace", fontSize: 13 }}>
                ⟳ Loading pages…
              </div>
            )}

            {thumbnails.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 14px", borderBottom: "1px solid #141e30" }}>
                  <span style={{ color: "#5a7a9a", fontSize: 11, fontFamily: "monospace" }}>
                    {selectedPages.size} of {totalPages} selected
                  </span>
                  <button onClick={selectAll} style={pdfStyles.pageBtn}>Select All</button>
                  <button onClick={selectNone} style={pdfStyles.pageBtn}>Select None</button>
                </div>
                <div style={pdfStyles.thumbGrid}>
                  {thumbnails.map(({ pageIndex, dataUrl }) => {
                    const isSelected = selectedPages.has(pageIndex);
                    return (
                      <div
                        key={pageIndex}
                        onClick={() => togglePage(pageIndex)}
                        style={{
                          cursor: "pointer",
                          border: isSelected ? "2px solid #4af" : "2px solid #1a2a40",
                          borderRadius: 4,
                          padding: 4,
                          background: isSelected ? "#0c1e3a" : "#080e18",
                          textAlign: "center",
                          minWidth: 100,
                          maxWidth: 160,
                          transition: "border-color 0.15s, background 0.15s",
                        }}
                      >
                        {dataUrl ? (
                          <img src={dataUrl} alt={`Page ${pageIndex + 1}`} style={{ width: "100%", height: "auto", borderRadius: 2, opacity: isSelected ? 1 : 0.5 }} />
                        ) : (
                          <div style={{ width: 100, height: 130, background: "#0a1020", display: "flex", alignItems: "center", justifyContent: "center", color: "#3a5a7a", fontSize: 10 }}>Error</div>
                        )}
                        <input
                          value={pageLabels[pageIndex] || `Page ${pageIndex + 1}`}
                          onChange={e => { e.stopPropagation(); setPageLabels(prev => ({ ...prev, [pageIndex]: e.target.value })); }}
                          onClick={e => e.stopPropagation()}
                          style={{ marginTop: 4, width: "90%", fontSize: 10, fontFamily: "monospace", background: "#0a1828", border: "1px solid #1a3050", borderRadius: 3, color: isSelected ? "#8cf" : "#4a6a7a", padding: "2px 4px", textAlign: "center", outline: "none" }}
                        />
                        <div style={{
                          marginTop: 2, width: 14, height: 14, borderRadius: 3,
                          border: isSelected ? "1px solid #4af" : "1px solid #2a3a50",
                          background: isSelected ? "#1e5a9a" : "transparent",
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          fontSize: 10, color: "#fff",
                        }}>
                          {isSelected ? "✓" : ""}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {rendering && (
              <div style={{ padding: "10px 14px", color: "#4af", fontFamily: "monospace", fontSize: 11, borderTop: "1px solid #141e30" }}>
                ⟳ {renderProgress}
              </div>
            )}

            <div style={pdfStyles.btnRow}>
              <button
                onClick={goToCropStep}
                disabled={selectedPages.size === 0 || rendering || thumbnails.length === 0}
                style={{
                  ...pdfStyles.confirmBtn,
                  opacity: (selectedPages.size === 0 || rendering) ? 0.5 : 1,
                  cursor: (selectedPages.size === 0 || rendering) ? 'not-allowed' : 'pointer',
                }}
              >
                {rendering ? `⟳ ${renderProgress}` : `Next → Crop (${selectedPages.size} page${selectedPages.size !== 1 ? 's' : ''})`}
              </button>
              <button onClick={onCancel} disabled={rendering} style={pdfStyles.cancelBtn}>✕ Cancel</button>
            </div>
          </>
        )}

        {/* ════════════════  STEP 2 — per-page crop  ════════════════ */}
        {step === 2 && (
          <>
            {/* Page navigation row */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderBottom: "1px solid #141e30" }}>
              <button
                onClick={() => setCropIdx(i => Math.max(0, i - 1))}
                disabled={cropIdx === 0}
                style={{ ...pdfStyles.pageBtn, opacity: cropIdx === 0 ? 0.35 : 1 }}
              >◀ Prev</button>
              <span style={{ color: "#8ab", fontSize: 12, fontFamily: "monospace", minWidth: 80, textAlign: "center" }}>
                {pageLabels[fullResPages[cropIdx]?.origPageIndex] || `Page ${(fullResPages[cropIdx]?.origPageIndex ?? cropIdx) + 1}`} ({cropIdx + 1}/{fullResPages.length})
              </span>
              <button
                onClick={() => setCropIdx(i => Math.min(fullResPages.length - 1, i + 1))}
                disabled={cropIdx === fullResPages.length - 1}
                style={{ ...pdfStyles.pageBtn, opacity: cropIdx === fullResPages.length - 1 ? 0.35 : 1 }}
              >Next ▶</button>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 10, fontFamily: "monospace", color: cropRects[cropIdx] ? "#f93" : "#3a8a5a" }}>
                {cropRects[cropIdx] ? "⬜ Cropped" : "⬜ Full page"}
              </span>
            </div>

            {/* Canvas */}
            <div style={pdfStyles.canvasWrap}>
              <canvas
                ref={previewCanvasRef}
                style={{ display: currentCropPage ? "block" : "none", cursor: "crosshair", maxWidth: "100%", maxHeight: "100%" }}
                onMouseDown={onCropMouseDown}
                onMouseMove={onCropMouseMove}
                onMouseUp={onCropMouseUp}
                onMouseLeave={onCropMouseUp}
              />
              {!currentCropPage && (
                <div style={{ color: "#3a5c7a", fontFamily: "monospace", fontSize: 13, padding: 24 }}>No page to display.</div>
              )}
            </div>

            {/* Status */}
            <div style={{ padding: "5px 14px", color: "#5a9a7a", fontSize: 10, fontFamily: "monospace", borderTop: "1px solid #141e30", minHeight: 22 }}>
              {cropStatus}
            </div>

            {/* Action buttons */}
            <div style={pdfStyles.btnRow}>
              <button onClick={clearCurrentCrop} style={pdfStyles.clearBtn}>Clear Crop</button>
              <button onClick={markFullPageAll} style={pdfStyles.fullBtn}>Full Page (All)</button>
              <button onClick={() => setStep(1)} style={pdfStyles.pageBtn}>◀ Back</button>
              <div style={{ flex: 1 }} />
              <button onClick={handleFinalConfirm} style={pdfStyles.confirmBtn}>
                ✓ Import {fullResPages.length} Page{fullResPages.length !== 1 ? 's' : ''}
              </button>
              <button onClick={onCancel} style={pdfStyles.cancelBtn}>✕ Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── AUTO DXF MODAL ──────────────────────────────────────────────────────────
function AutoDxfModal({ pdfData, initialPage, scaleRatio, onClose }) {
  const cvRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [totalPages, setTotalPages] = useState(0);
  const [pageIdx, setPageIdx] = useState(initialPage || 0); // 0-based
  const [pageCanvas, setPageCanvas] = useState(null);
  const [ps, setPs] = useState(1); // preview scale
  const [rect, setRect] = useState(null);
  const [statusMsg, setStatusMsg] = useState("Drag a rectangle to select a region, or export the full page.");
  const [extracting, setExtracting] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const dragRef = useRef(null);
  const dragging = useRef(false);

  // Load PDF
  useEffect(() => {
    let c = false;
    loadPdfJs().then(async (lib) => {
      const doc = await lib.getDocument({ data: new Uint8Array(pdfData.slice(0)) }).promise;
      if (c) return;
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
    }).catch(e => { if (!c) setLoadError(e?.message || 'Failed to parse PDF.'); });
    return () => { c = true; };
  }, [pdfData]);

  // Render page
  useEffect(() => {
    if (!pdfDoc) return;
    let c = false;
    (async () => {
      const page = await pdfDoc.getPage(pageIdx + 1);
      const viewport = page.getViewport({ scale: PDF_SCALE });
      const off = document.createElement("canvas");
      off.width = Math.round(viewport.width);
      off.height = Math.round(viewport.height);
      await page.render({ canvasContext: off.getContext("2d"), viewport }).promise;
      if (c) return;
      setPageCanvas(off);
      setRect(null);
    })().catch(e => { if (!c) setLoadError(e?.message); });
    return () => { c = true; };
  }, [pdfDoc, pageIdx]);

  // Draw preview
  useEffect(() => {
    if (!pageCanvas || !cvRef.current) return;
    const container = cvRef.current.parentElement;
    const mw = container.clientWidth - 4, mh = container.clientHeight - 4;
    const s = Math.min(mw / pageCanvas.width, mh / pageCanvas.height, 1.0);
    setPs(s);
    const pw = Math.round(pageCanvas.width * s), ph = Math.round(pageCanvas.height * s);
    const cv = cvRef.current;
    cv.width = pw; cv.height = ph;
    const ctx = cv.getContext("2d");
    ctx.drawImage(pageCanvas, 0, 0, pw, ph);
    if (rect) { ctx.strokeStyle = "#FF3300"; ctx.lineWidth = 2; ctx.strokeRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1); ctx.fillStyle = "rgba(255,51,0,0.18)"; ctx.fillRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1); }
  }, [pageCanvas, rect]);

  function getXY(e) { const r = cvRef.current.getBoundingClientRect(); return { px: clamp(e.clientX - r.left, 0, cvRef.current.width - 1), py: clamp(e.clientY - r.top, 0, cvRef.current.height - 1) }; }
  function onDown(e) { if (e.button !== 0) return; dragging.current = true; const { px, py } = getXY(e); dragRef.current = [px, py]; setRect(null); }
  function onMove(e) { if (!dragging.current || !dragRef.current) return; const { px, py } = getXY(e); const [sx, sy] = dragRef.current; setRect({ x1: Math.min(sx, px), y1: Math.min(sy, py), x2: Math.max(sx, px), y2: Math.max(sy, py) }); }
  function onUp() { dragging.current = false; }

  // Extract & generate DXF
  const doExport = async () => {
    if (!pdfDoc || !pageCanvas) return;
    setExtracting(true);
    setStatusMsg("Extracting vector geometry…");
    try {
      // Convert region from preview coords → PDF user-space coords (bottom-left, Y up)
      const pageVp = (await pdfDoc.getPage(pageIdx + 1)).getViewport({ scale: 1.0 });
      const pgW = pageVp.width, pgH = pageVp.height;
      let pdfRegion = null;
      if (rect && ps > 0) {
        const cx1 = rect.x1 / (PDF_SCALE * ps), cy1 = rect.y1 / (PDF_SCALE * ps);
        const cx2 = rect.x2 / (PDF_SCALE * ps), cy2 = rect.y2 / (PDF_SCALE * ps);
        // Preview Y goes down, PDF Y goes up
        pdfRegion = [cx1, pgH - cy2, cx2, pgH - cy1];
      }

      const geo = await _extractPdfVectors(pdfDoc, pageIdx + 1, pdfRegion);
      const total = geo.lines.length + geo.curves.length + geo.rects.length + geo.closedPolys.length;
      if (total === 0) { setStatusMsg("No vector geometry found in this region."); setExtracting(false); return; }

      // Scale factor: PDF points → meters (if scale calibrated)
      const sf = scaleRatio ? (PDF_RENDER_DPI / 72) * scaleRatio : 1;

      // Generate DXF
      const d = new Drawing();
      d.setUnits(scaleRatio ? "Meters" : "Unitless");
      d.addLayer("LINES", 7, "CONTINUOUS");
      d.addLayer("CURVES", 3, "CONTINUOUS");
      d.addLayer("RECTS", 5, "CONTINUOUS");
      d.addLayer("POLYGONS", 1, "CONTINUOUS");
      d.addLayer("HATCHES", 8, "CONTINUOUS");

      const tx = x => x * sf, ty = y => y * sf; // PDF Y-up matches DXF Y-up

      const hatch = _detectHatches(geo.lines);
      d.setActiveLayer("LINES");
      for (const ln of hatch.remaining) d.drawLine(tx(ln.start[0]), ty(ln.start[1]), tx(ln.end[0]), ty(ln.end[1]));
      d.setActiveLayer("CURVES");
      for (const crv of geo.curves) { const pts = _bezierPts(crv.p0, crv.p1, crv.p2, crv.p3, 16).map(([x,y])=>[tx(x),ty(y)]); if (pts.length >= 2) d.drawPolyline(pts); }
      d.setActiveLayer("RECTS");
      for (const r of geo.rects) d.drawRect(tx(r.x0), ty(r.y0), tx(r.x1), ty(r.y1));
      d.setActiveLayer("POLYGONS");
      for (const p of geo.closedPolys) { if (p.points.length >= 3) d.drawPolyline(p.points.map(([x,y])=>[tx(x),ty(y)]), true); }
      d.setActiveLayer("HATCHES");
      for (const hg of hatch.hatches) for (const ln of hg.lines) d.drawLine(tx(ln.start[0]), ty(ln.start[1]), tx(ln.end[0]), ty(ln.end[1]));

      const blob = new Blob([d.toDxfString()], { type: "application/dxf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `auto_page${pageIdx + 1}.dxf`; a.click();

      const hatchInfo = _detectHatches(geo.lines);
      setStatusMsg(`Exported ${total} entities (${hatch.remaining.length} lines, ${geo.curves.length} curves, ${geo.rects.length} rects, ${geo.closedPolys.length} polys, ${hatchInfo.hatches.reduce((s,h)=>s+h.lines.length,0)} hatch lines)`);
    } catch (err) {
      console.error("[AutoDxf]", err);
      setStatusMsg(`Export failed: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div style={pdfStyles.overlay}>
      <div style={pdfStyles.modal}>
        <div style={pdfStyles.header}>
          <span style={pdfStyles.title}>📐 AUTO DXF EXPORT</span>
          <span style={pdfStyles.subtitle}>Extracts vector geometry directly from the PDF. Select a region or use the full page.</span>
        </div>

        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderBottom: "1px solid #141e30" }}>
            <button onClick={() => { setPageIdx(i => Math.max(0, i - 1)); }} disabled={pageIdx === 0} style={{ ...pdfStyles.pageBtn, opacity: pageIdx === 0 ? 0.35 : 1 }}>◀ Prev</button>
            <span style={{ color: "#8ab", fontSize: 12, fontFamily: "monospace", minWidth: 80, textAlign: "center" }}>Page {pageIdx + 1} / {totalPages}</span>
            <button onClick={() => { setPageIdx(i => Math.min(totalPages - 1, i + 1)); }} disabled={pageIdx === totalPages - 1} style={{ ...pdfStyles.pageBtn, opacity: pageIdx === totalPages - 1 ? 0.35 : 1 }}>Next ▶</button>
          </div>
        )}

        {loadError && <div style={{ padding: 24, color: "#e05555", fontFamily: "monospace", fontSize: 12 }}>Error: {loadError}</div>}

        <div style={pdfStyles.canvasWrap}>
          {!pageCanvas && !loadError && <div style={{ color: "#3a5c7a", fontFamily: "monospace", fontSize: 13, padding: 24 }}>⟳ Rendering page…</div>}
          <canvas ref={cvRef} style={{ display: pageCanvas ? "block" : "none", cursor: "crosshair", maxWidth: "100%", maxHeight: "100%" }}
            onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} />
        </div>

        <div style={{ padding: "5px 14px", color: "#5a9a7a", fontSize: 10, fontFamily: "monospace", borderTop: "1px solid #141e30", minHeight: 22 }}>{statusMsg}</div>

        <div style={pdfStyles.btnRow}>
          <button onClick={() => { setRect(null); setStatusMsg("Region cleared — will export full page."); }} style={pdfStyles.clearBtn}>Clear Region</button>
          <div style={{ flex: 1 }} />
          <button onClick={doExport} disabled={extracting || !pageCanvas} style={{ ...pdfStyles.confirmBtn, background: "#2a1a4a", borderColor: "#4a2a7a", color: "#b88adf", opacity: (extracting || !pageCanvas) ? 0.5 : 1 }}>
            {extracting ? "⟳ Extracting…" : "📐 Extract & Export DXF"}
          </button>
          <button onClick={onClose} disabled={extracting} style={pdfStyles.cancelBtn}>✕ Close</button>
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
  thumbGrid: { flex: 1, overflow: "auto", display: "flex", flexWrap: "wrap", gap: 10, padding: 14, alignContent: "flex-start" },
  canvasWrap: { flex: 1, overflow: "auto", background: "#08101a", display: "flex", alignItems: "flex-start", justifyContent: "flex-start", padding: 8, position: "relative" },
  pageBtn: { background: "#152240", border: "1px solid #2a4070", borderRadius: 3, color: "#8ab", padding: "2px 8px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" },
  btnRow: { display: "flex", gap: 8, padding: "8px 14px", borderTop: "1px solid #1a2a40", alignItems: "center" },
  confirmBtn: { background: "#0f3460", border: "1px solid #1e5a9a", borderRadius: 3, color: "#7af", padding: "5px 14px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" },
  fullBtn: { background: "#0d3d2a", border: "1px solid #1a6644", borderRadius: 3, color: "#6da", padding: "5px 14px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" },
  clearBtn: { background: "#1a1a2a", border: "1px solid #2a2a44", borderRadius: 3, color: "#7a8a9a", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" },
  cancelBtn: { background: "#2a1010", border: "1px solid #5a2020", borderRadius: 3, color: "#c66", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", marginLeft: "auto" },
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function DetectionTool({ project, user, onBack, userTierInfo = { tier: 'individual', role: null } }) {
  // ─── Tier / permissions ─────────────────────────────────────────────────────
  const tierLimits = getLimits(userTierInfo.tier, userTierInfo.role);
  const isReadOnly = tierLimits.isReadOnly; // Enterprise Manager
  const canExportDXF = tierLimits.canExportDXF;
  const canUseCustomClasses = tierLimits.canUseCustomClasses;

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
  const [autoSimplifyDist,  setAutoSimplifyDist]  = useState("20"); // px, applied after inference
  const [areaTextColor,     setAreaTextColor]     = useState("#c0c0c0");
  const [perimTextColor,    setPerimTextColor]    = useState("#c0c0c0");
  const [measureTextColor,  setMeasureTextColor]  = useState("#00FFFF");
  const [autoSave,          setAutoSave]          = useState(true);
  const [autoSaveInterval,  setAutoSaveInterval]  = useState("60"); // seconds
  const handleSaveRef = useRef(null); // always points to latest handleSave (avoids stale closure)
  const isDirty = useRef(false);      // true when annotations have changed since last save

  // Circle drawing temp state (image coords)
  const [tempCircle, setTempCircle] = useState(null); // {cx, cy, r}

  // Measure tool result
  const [lastLineIsMeasure, setLastLineIsMeasure] = useState(false); // true = measure tool, false = scale cal

  // Right panel resize
  const [rightPanelWidth, setRightPanelWidth] = useState(320);
  const panelDragRef = useRef(null); // {startX, startWidth}

  // Share panel (Enterprise QS only)
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [shareEmail, setShareEmail] = useState('');
  const [shareGrants, setShareGrants] = useState([]); // [{managerId, managerEmail, managerName}]
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState(null);
  const [shareSuccess, setShareSuccess] = useState(null);

  // Custom classes
  const [customClasses, setCustomClasses] = useState([]);
  const [showClassManager, setShowClassManager] = useState(false);
  const [newCustomClassName, setNewCustomClassName] = useState("");
  const [newCustomClassColor, setNewCustomClassColor] = useState("#FF6B6B");
  const [newCustomClassMeasureType, setNewCustomClassMeasureType] = useState("unit");

  // ─── Multi-page support ─────────────────────────────────────────────────────
  // allPagesRef stores data for ALL pages. The currently active page's annotations/img
  // live in the flat state above; allPagesRef keeps them synced on page switch & save.
  const allPagesRef = useRef([]); // [{pageIndex, img, imgNaturalSize, annotations}]
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const currentPageIndexRef = useRef(0); // always-fresh mirror for async callbacks
  // Keep ref in sync with state
  useEffect(() => { currentPageIndexRef.current = currentPageIndex; }, [currentPageIndex]);
  const [pageCount, setPageCount] = useState(0);
  // Track which page images have already been uploaded to S3 (avoid re-uploading)
  const uploadedPageImages = useRef(new Set());
  const pdfFileRef = useRef(null); // raw PDF File object for multi-page upload
  const pdfBytesRef = useRef(null); // PDF ArrayBuffer — kept for auto DXF export
  const [showAutoDxf, setShowAutoDxf] = useState(false);
  const [fetchingPdf, setFetchingPdf] = useState(false); // loading indicator for on-demand PDF fetch

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

  const computeBaseScale = useCallback((imgW, imgH) => {
    const cont = containerRef.current;
    if (!cont) return 1;
    const maxW = cont.clientWidth - 4;
    const maxH = cont.clientHeight - 4;
    return Math.min(maxW / imgW, maxH / imgH, 1.0);
  }, []);

  // ─── Page switching ────────────────────────────────────────────────────────
  // Syncs current page state into allPagesRef (call before switching or saving)
  const syncCurrentPageToRef = useCallback(() => {
    if (allPagesRef.current.length === 0) return;
    const idx = allPagesRef.current.findIndex(p => p.pageIndex === currentPageIndex);
    if (idx >= 0) {
      allPagesRef.current[idx] = {
        ...allPagesRef.current[idx],
        annotations,
        imgNaturalSize,
      };
    }
  }, [currentPageIndex, annotations, imgNaturalSize]);

  const switchPage = useCallback((newIdx) => {
    if (newIdx === currentPageIndex) return;
    // Save current page data to ref
    syncCurrentPageToRef();
    // Load new page from ref
    const newPage = allPagesRef.current.find(p => p.pageIndex === newIdx);
    if (!newPage) return;
    setOriginalImg(newPage.img || null);
    setImgNaturalSize(newPage.imgNaturalSize || { w: 0, h: 0 });
    setAnnotations(newPage.annotations || []);
    setLastMeasureLine(null);
    setLastLineIsMeasure(false);
    setCurrentPageIndex(newIdx);
    // Reset transient state
    setSelectedIdx(null);
    setSelectedIndices(new Set());
    setHoverIdx(null);
    setTempBox(null);
    setTempPolyPts([]);
    setTempPolyMouse(null);
    setTempLine(null);
    setTempLineShape(null);
    setTempCircle(null);
    setDrawMode("select");
    setHistory([]);
    setFuture([]);
    // Recompute base scale for new page dimensions
    const nSize = newPage.imgNaturalSize || { w: 0, h: 0 };
    if (nSize.w > 0 && nSize.h > 0) {
      const bs = computeBaseScale(nSize.w, nSize.h);
      setBaseScale(bs);
    }
    setZoom(1.0);
    setStatus(`Page ${newIdx + 1} of ${pageCount}`);
  }, [currentPageIndex, pageCount, syncCurrentPageToRef, computeBaseScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── PDF upload ──────────────────────────────────────────────────────────────
  const handlePdfChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pdfFileRef.current = file;
    setStatus(`Opening PDF: ${file.name} …`);
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result;
      pdfBytesRef.current = buf.slice(0); // persist for auto DXF
      setPdfModalData(buf);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  // Called when user confirms crop in the OLD single-page PDF modal (PdfRegionSelector)
  const handlePdfConfirmSingle = (croppedCanvas) => {
    setPdfModalData(null);
    croppedCanvas.toBlob((blob) => {
      if (blob) {
        const pngName = `${project?.name || 'pdf-page'}.png`;
        const pngFile = new File([blob], pngName, { type: 'image/png' });
        setCurrentFile(pngFile);
        existingFileInfoRef.current = { ext: 'png', fileName: pngFile.name };
      }
    }, 'image/png');
    // Load as single page in allPagesRef
    const img = new Image();
    img.onload = () => {
      const imgSize = { w: croppedCanvas.width, h: croppedCanvas.height };
      setOriginalImg(img);
      setImgNaturalSize(imgSize);
      const bs = computeBaseScale(croppedCanvas.width, croppedCanvas.height);
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
      allPagesRef.current = [{ pageIndex: 0, img, imgNaturalSize: imgSize, annotations: [] }];
      setCurrentPageIndex(0);
      setPageCount(1);
      uploadedPageImages.current = new Set();
      setStatus(`Loaded PDF page: ${croppedCanvas.width}×${croppedCanvas.height} px`);
    };
    img.src = croppedCanvas.toDataURL("image/png");
  };

  // Called when user confirms multi-page PDF import
  const handlePdfConfirmMulti = (pagesData) => {
    // pagesData = [{ pageIndex, canvas, blob }]
    setPdfModalData(null);
    if (!pagesData || pagesData.length === 0) return;

    // Store original PDF as the file to upload
    if (pdfFileRef.current) {
      setCurrentFile(pdfFileRef.current);
      existingFileInfoRef.current = { ext: 'pdf', fileName: pdfFileRef.current.name };
    }

    const loadedPages = [];
    let loadedCount = 0;

    pagesData.forEach(({ pageIndex, pdfPageNumber, label, canvas }) => {
      const img = new Image();
      img.onload = () => {
        const imgSize = { w: canvas.width, h: canvas.height };
        loadedPages.push({ pageIndex, pdfPageNumber, label, img, imgNaturalSize: imgSize, annotations: [] });
        loadedCount++;
        if (loadedCount === pagesData.length) {
          // All pages loaded — sort by pageIndex and set state
          loadedPages.sort((a, b) => a.pageIndex - b.pageIndex);
          allPagesRef.current = loadedPages;
          setPageCount(loadedPages.length);
          uploadedPageImages.current = new Set(); // all need uploading

          // Show first page
          const first = loadedPages[0];
          setOriginalImg(first.img);
          setImgNaturalSize(first.imgNaturalSize);
          setAnnotations([]);
          setCurrentPageIndex(first.pageIndex);
          setSelectedIdx(null);
          setSelectedIndices(new Set());
          setHoverIdx(null);
          setTempBox(null);
          setTempPolyPts([]);
          setTempPolyMouse(null);
          setTempLine(null);
          setLastMeasureLine(null);
          const bs = computeBaseScale(first.imgNaturalSize.w, first.imgNaturalSize.h);
          setBaseScale(bs);
          setZoom(1.0);
          setStatus(`Imported ${loadedPages.length} page(s) from PDF`);
        }
      };
      img.src = canvas.toDataURL("image/png");
    });
  };

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
    allPagesRef.current = [];
    setCurrentPageIndex(0);
    setPageCount(0);
    uploadedPageImages.current = new Set();

    loadProject(project.id, project.ownerSub || null)
      .then(async (data) => {
        if (cancelled || !data) return;

        // ── Shared settings ──────────────────────────────────────────────
        const s = data.settings || {};
        if (s.customTags && Object.keys(s.customTags).length) setZoneTags(s.customTags);
        if (s.customClasses?.length) {
          setCustomClasses(s.customClasses);
          setVisibleClasses(prev => new Set([...prev, ...s.customClasses.map(c => c.name)]));
        }
        if (s.autoSimplifyDist != null) setAutoSimplifyDist(String(s.autoSimplifyDist));
        if (s.areaTextColor)    setAreaTextColor(s.areaTextColor);
        if (s.perimTextColor)   setPerimTextColor(s.perimTextColor);
        if (s.measureTextColor) setMeasureTextColor(s.measureTextColor);
        if (s.autoSave != null)          setAutoSave(Boolean(s.autoSave));
        if (s.autoSaveInterval != null)  setAutoSaveInterval(String(s.autoSaveInterval));

        // ── Scale (shared across pages) ──────────────────────────────────
        if (data.scale?.pixelToMeter != null) {
          setRatio(data.scale.pixelToMeter);
          setPixelLength(data.scale.pixelLength || "");
          setRealLength(data.scale.realLength || "");
        }

        if (data.originalExt) {
          existingFileInfoRef.current = {
            ext: data.originalExt,
            fileName: data.metadata?.fileName || null,
          };
        }

        // ── Fetch original PDF for auto DXF (background, non-blocking) ──
        if (data.originalExt === 'pdf' && data.originalFileUrl) {
          fetch(data.originalFileUrl)
            .then(r => r.arrayBuffer())
            .then(buf => { if (!cancelled) pdfBytesRef.current = buf.slice(0); })
            .catch(() => {}); // silent — auto DXF just won't be available
        }

        // ── Load page images ─────────────────────────────────────────────
        const pages = data.pages || [];
        const pageImageUrls = data.pageImageUrls || {};

        // Load pages if we have annotation data (images may be missing but annotations are the source of truth)
        if (pages.length > 0) {
          const loadedPages = await Promise.all(pages.map(async (page) => {
            // Try slug key first (new naming), fallback to legacy numeric key
            const slug = page.pageSlug || pageSlugify(page.label, page.pageIndex);
            const url = pageImageUrls[slug] || pageImageUrls[String(page.pageIndex)];
            if (!url) return { ...page, img: null };
            return new Promise((resolve) => {
              const img = new Image();
              img.crossOrigin = "anonymous";
              img.onload = () => resolve({ ...page, img, imgNaturalSize: { w: img.naturalWidth, h: img.naturalHeight } });
              img.onerror = () => resolve({ ...page, img: null });
              img.src = url;
            });
          }));

          if (cancelled) return;
          // Fill missing numIds
          const normalizedPages = loadedPages.map(p => ({
            ...p,
            annotations: fillMissingNumIds(p.annotations || []),
          }));

          allPagesRef.current = normalizedPages;
          setPageCount(normalizedPages.length);
          // Track uploaded slugs so we don't re-upload unchanged images
          // Only mark slugs as uploaded if the image actually loaded
          uploadedPageImages.current = new Set(
            normalizedPages.filter(p => p.img).map(p => p.pageSlug || pageSlugify(p.label, p.pageIndex))
          );

          // Set first page as active
          const first = normalizedPages[0];
          if (first) {
            setOriginalImg(first.img);
            setImgNaturalSize(first.imgNaturalSize || { w: 0, h: 0 });
            setAnnotations(first.annotations || []);
            setCurrentPageIndex(0);
            if (first.img) {
              const bs = computeBaseScale(first.imgNaturalSize.w, first.imgNaturalSize.h);
              setBaseScale(bs);
              setZoom(1.0);
            }
            const missingImages = normalizedPages.filter(p => !p.img).length;
            if (missingImages > 0) {
              setStatus(`Loaded project: ${normalizedPages.length} page(s) — ${missingImages} background image(s) missing (re-import PDF to restore)`);
            } else {
              setStatus(`Loaded project: ${normalizedPages.length} page(s)`);
            }
          }
        } else if (data.originalFileUrl) {
          // Fallback: old v1 project with original.{ext}
          const page0 = pages[0] || { pageIndex: 0, imageInfo: { w: 0, h: 0 }, annotations: [] };
          if (data.originalExt === 'pdf') {
            // Re-open PDF selector for old PDF projects
            fetch(data.originalFileUrl)
              .then((r) => r.arrayBuffer())
              .then((buf) => { if (!cancelled) setPdfModalData(buf.slice(0)); })
              .catch(() => setStatus("Failed to restore PDF from saved project."));
          } else {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              if (cancelled) return;
              const imgSize = { w: img.naturalWidth, h: img.naturalHeight };
              allPagesRef.current = [{ pageIndex: 0, img, imgNaturalSize: imgSize, annotations: fillMissingNumIds(page0.annotations || []) }];
              setPageCount(1);
              setOriginalImg(img);
              setImgNaturalSize(imgSize);
              setAnnotations(fillMissingNumIds(page0.annotations || []));
              setCurrentPageIndex(0);
              const bs = computeBaseScale(imgSize.w, imgSize.h);
              setBaseScale(bs);
              setZoom(1.0);
              setStatus(`Restored saved image: ${imgSize.w}×${imgSize.h} px`);
            };
            img.onerror = () => setStatus("Failed to restore image from saved project.");
            img.src = data.originalFileUrl;
          }
        }
      })
      .catch((err) => console.error('[DetectionTool] loadProject failed:', err));

    return () => { cancelled = true; };
  }, [project?.id, computeBaseScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Save project to S3 ───────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!project?.id) return;
    setSaveStatus('saving');
    try {
      // Sync current page annotations/size into allPagesRef before saving
      syncCurrentPageToRef();

      // Build v2 pages array from allPagesRef
      const pagesToSave = allPagesRef.current.map(p => ({
        pageIndex: p.pageIndex,
        pdfPageNumber: p.pdfPageNumber ?? null,
        label: p.label ?? null,
        imageInfo: p.imgNaturalSize || { w: 0, h: 0 },
        annotations: p.annotations || [],
      }));

      // Build pageImages for pages not yet uploaded (or renamed) — tracked by slug
      const pageImages = [];
      for (const p of allPagesRef.current) {
        const slug = pageSlugify(p.label, p.pageIndex);
        if (!uploadedPageImages.current.has(slug) && p.img) {
          // Convert img to PNG blob
          const canvas = document.createElement('canvas');
          canvas.width = p.imgNaturalSize?.w || p.img.naturalWidth;
          canvas.height = p.imgNaturalSize?.h || p.img.naturalHeight;
          canvas.getContext('2d').drawImage(p.img, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (blob) pageImages.push({ pageIndex: p.pageIndex, label: p.label, slug, blob });
        }
      }

      await saveProject(project.id, {
        name: project.name,
        pages: pagesToSave,
        scale: { pixelToMeter: ratio, pixelLength, realLength },
        settings: {
          autoSimplifyDist, areaTextColor, perimTextColor, measureTextColor,
          autoSave, autoSaveInterval,
          customTags: zoneTags,
          customClasses,
        },
        file: currentFile,
        pageImages: pageImages.length > 0 ? pageImages : null,
        existingExt: existingFileInfoRef.current.ext,
        existingFileName: existingFileInfoRef.current.fileName,
      });

      // Mark newly uploaded slugs so we don't re-upload unchanged images
      for (const pi of pageImages) uploadedPageImages.current.add(pi.slug);

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

  // Auto-save interval — only saves if something changed since last save (disabled for read-only)
  useEffect(() => {
    if (!autoSave || !project?.id || isReadOnly) return;
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
      const imgSize = { w: img.naturalWidth, h: img.naturalHeight };
      setOriginalImg(img);
      setImgNaturalSize(imgSize);
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
      // Populate allPagesRef with single page
      allPagesRef.current = [{ pageIndex: 0, img, imgNaturalSize: imgSize, annotations: [] }];
      setCurrentPageIndex(0);
      setPageCount(1);
      uploadedPageImages.current = new Set(); // new image, needs uploading
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

  // Distance from point to a line segment [ax,ay]→[bx,by]
  const distToSegment = (x, y, ax, ay, bx, by) => {
    const edx = bx - ax, edy = by - ay;
    const lenSq = edx * edx + edy * edy;
    if (lenSq < 1) return Math.hypot(x - ax, y - ay);
    const t = Math.max(0, Math.min(1, ((x - ax) * edx + (y - ay) * edy) / lenSq));
    return Math.hypot(x - (ax + t * edx), y - (ay + t * edy));
  };

  // Returns the minimum distance from point (x,y) to the shape boundary (works for both interior & exterior)
  const distToBoundary = (ann, x, y) => {
    if (ann.shapeType === "box") {
      const [bx1, by1, bx2, by2] = [ann.x1, ann.y1, ann.x2, ann.y2];
      // 4 edge segments of the box
      return Math.min(
        distToSegment(x, y, bx1, by1, bx2, by1), // top
        distToSegment(x, y, bx1, by2, bx2, by2), // bottom
        distToSegment(x, y, bx1, by1, bx1, by2), // left
        distToSegment(x, y, bx2, by1, bx2, by2), // right
      );
    }
    if (ann.shapeType === "line") {
      return distToSegment(x, y, ann.x1, ann.y1, ann.x2, ann.y2);
    }
    if (ann.points && ann.points.length >= 2) {
      let minD = Infinity;
      const pts = ann.points;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const d = distToSegment(x, y, ax, ay, bx, by);
        if (d < minD) minD = d;
      }
      return minD;
    }
    return Infinity;
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
      const SELECT_NEAR = 8; // image-px — shapes this close to cursor are selectable even if cursor is outside
      const visIdxs = annotations.map((a, i) => visibleClasses.has(a.clsName) ? i : -1).filter(i => i >= 0);

      // Phase 1: shapes that contain the cursor — sorted by area (smallest = tightest fit first)
      const insideCandidates = visIdxs
        .filter(i => annotationContains(annotations[i], ox, oy))
        .map(i => [annotationAreaPx(annotations[i]), i]);
      insideCandidates.sort((a, b) => a[0] - b[0]);

      // Phase 2: shapes whose boundary is close to cursor (but don't contain it)
      let proximityCandidates = [];
      if (insideCandidates.length === 0) {
        proximityCandidates = visIdxs
          .filter(i => !annotationContains(annotations[i], ox, oy))
          .map(i => [distToBoundary(annotations[i], ox, oy), i])
          .filter(([d]) => d <= SELECT_NEAR);
        proximityCandidates.sort((a, b) => a[0] - b[0]);
      }

      const candidates = insideCandidates.length > 0 ? insideCandidates : proximityCandidates;

      if (candidates.length > 0) {
        const idx = candidates[0][1];
        if (e.ctrlKey || e.metaKey) {
          setSelectedIndices(prev => {
            const s = new Set(prev);
            if (s.has(idx)) {
              s.delete(idx);
              setSelectedIdx(s.size > 0 ? [...s][s.size - 1] : null);
            } else {
              s.add(idx);
              setSelectedIdx(idx);
            }
            return s;
          });
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
      const HOVER_NEAR = 8;
      const visIdxs = annotations.map((a, i) => visibleClasses.has(a.clsName) ? i : -1).filter(i => i >= 0);
      const inside = visIdxs
        .filter(i => annotationContains(annotations[i], ox, oy))
        .map(i => [annotationAreaPx(annotations[i]), i]);
      inside.sort((a, b) => a[0] - b[0]);
      if (inside.length > 0) {
        setHoverIdx(inside[0][1]);
      } else {
        const near = visIdxs
          .map(i => [distToBoundary(annotations[i], ox, oy), i])
          .filter(([d]) => d <= HOVER_NEAR);
        near.sort((a, b) => a[0] - b[0]);
        setHoverIdx(near.length > 0 ? near[0][1] : null);
      }
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
          const next = [...prev, { ...ann, numId: nextNumId(prev) }];
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
          const next = [...prev, { ...ann, numId: nextNumId(prev) }];
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
          const next = [...prev, { ...ann, numId: nextNumId(prev) }];
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
    setAnnotations(prev => { const next = [...prev, { ...ann, numId: nextNumId(prev) }]; setSelectedIdx(next.length - 1); setSelectedIndices(new Set([next.length - 1])); return next; });
    setTempPolyPts([]);
    setTempPolyMouse(null);
    setStatus("Polygon completed.");
  };

  // ─── Inference ───────────────────────────────────────────────────────────────
  // Helper: apply inference results to the correct page.
  // Uses currentPageIndexRef (not state) so the check is never stale
  // even when called from an async function that started on a different render.
  const applyInferenceResults = (targetPageIndex, newAnns) => {
    const mergeAnns = (prev) => {
      const kept = prev.filter(a => a.sourceModel === 'manual');
      let next = nextNumId(kept);
      const withIds = newAnns.map(a => ({ ...a, numId: next++ }));
      return [...kept, ...withIds];
    };

    const livePageIdx = currentPageIndexRef.current;
    if (livePageIdx === targetPageIndex) {
      // Still on the same page — update live state
      setAnnotations(prev => {
        pushHistory(prev);
        return mergeAnns(prev);
      });
    } else {
      // User switched pages — write into the ref for that page
      const refIdx = allPagesRef.current.findIndex(p => p.pageIndex === targetPageIndex);
      if (refIdx >= 0) {
        const oldAnns = allPagesRef.current[refIdx].annotations || [];
        allPagesRef.current[refIdx] = {
          ...allPagesRef.current[refIdx],
          annotations: mergeAnns(oldAnns),
        };
      }
      setStatus(`Inference results applied to page ${targetPageIndex + 1} (background).`);
    }
  };

  const runInference = async (tiled = false) => {
    if (!originalImg) { setStatus("Load an image first."); return; }
    // Capture which page we're running inference on
    const targetPageIndex = currentPageIndexRef.current;

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
    setStatus(tiled ? `Running tiled inference on page ${targetPageIndex + 1}…` : `Running inference on page ${targetPageIndex + 1}…`);

    try {
      const blob = await new Promise((res) => tempCanvas.toBlob(res, "image/jpeg", 0.95));

      const autoEps = (() => { const v = parseInt(autoSimplifyDist, 10); return !isNaN(v) && v > 0 ? v : 0; })();
      if (tiled && (imgNaturalSize.w > TILE_SIZE || imgNaturalSize.h > TILE_SIZE)) {
        const allAnns = await runTiledInference(tempCanvas, blob, wallModelData, zoneModelData, zoneSegModelData, autoEps);
        applyInferenceResults(targetPageIndex, allAnns);
        setStatus(`Tiled inference complete (page ${targetPageIndex + 1}) — ${allAnns.length} detections.`);
      } else {
        const [wallRes, doorWinRes, zoneSegRes] = await Promise.all([
          postInference(blob, WALL_MODEL_URL, WALL_MODEL_HEADERS, wallModelData),
          postInference(blob, ZONE_MODEL_URL, ZONE_MODEL_HEADERS, zoneModelData),
          postInference(blob, ZONE_SEG_MODEL_URL, ZONE_SEG_MODEL_HEADERS, zoneSegModelData),
        ]);
        const autoEps2 = (() => { const v = parseInt(autoSimplifyDist, 10); return !isNaN(v) && v > 0 ? v : 0; })();
        const wallAnns    = parseModelResponse(wallRes, "wall_model");
        const doorWinAnns = parseModelResponse(doorWinRes, "zone_door_window_model")
          .filter(a => a.clsName === "door" || a.clsName === "window");
        const zoneSegAnns = parseSegmentationResponse(zoneSegRes, "zone_seg_model", autoEps2);
        const allAnns = [...wallAnns, ...doorWinAnns, ...zoneSegAnns];
        applyInferenceResults(targetPageIndex, allAnns);
        setStatus(`Inference complete (page ${targetPageIndex + 1}) — ${allAnns.length} detections.`);
      }
      // Only clear selection if still on the target page
      if (currentPageIndexRef.current === targetPageIndex) {
        setSelectedIdx(null);
        setSelectedIndices(new Set());
      }
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
        setAnnotations((prev) => {
          let next = nextNumId(prev);
          const withIds = newAnns.map(a => ({ ...a, numId: next++ }));
          return [...prev, ...withIds];
        });
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

  const duplicateSelected = () => {
    if (selectedIdx == null) return;
    const ann = annotations[selectedIdx];
    if (!ann) return;
    pushHistory(annotations);
    const OFFSET = 20; // px offset so the copy is visible
    const clone = {
      ...ann,
      id: Math.random().toString(36).slice(2),
      x1: ann.x1 != null ? ann.x1 + OFFSET : null,
      y1: ann.y1 != null ? ann.y1 + OFFSET : null,
      x2: ann.x2 != null ? ann.x2 + OFFSET : null,
      y2: ann.y2 != null ? ann.y2 + OFFSET : null,
      points: ann.points ? ann.points.map(([x, y]) => [x + OFFSET, y + OFFSET]) : null,
    };
    setAnnotations(prev => {
      const newIdx = prev.length;
      const cloneWithId = { ...clone, numId: nextNumId(prev) };
      setTimeout(() => { setSelectedIdx(newIdx); setSelectedIndices(new Set([newIdx])); setEditClass(cloneWithId.clsName); }, 0);
      return [...prev, cloneWithId];
    });
  };

  const [rotateAngle, setRotateAngle] = useState("0");

  // Excel export column picker modal
  const [showExcelPicker, setShowExcelPicker] = useState(false);
  const [excelEnabledCols, setExcelEnabledCols] = useState(() => new Set(EXCEL_COLUMNS.map(c => c.key)));
  const [excelRows, setExcelRows] = useState([]);

  // PDF export column picker modal
  const [showPdfPicker, setShowPdfPicker] = useState(false);
  const [pdfEnabledCols, setPdfEnabledCols] = useState(() => new Set(EXCEL_COLUMNS.map(c => c.key)));
  const [pdfPickerRows, setPdfPickerRows] = useState([]);

  // Import annotations modal
  const [showImportAnns, setShowImportAnns] = useState(false);
  const [importProjects, setImportProjects] = useState([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importSelectedProject, setImportSelectedProject] = useState(null);
  const [importProjectData, setImportProjectData] = useState(null);
  const [importSelectedPage, setImportSelectedPage] = useState(null);
  const [importCurrentProjectPages, setImportCurrentProjectPages] = useState([]);
  const [importCurrentSelectedPage, setImportCurrentSelectedPage] = useState(null);

  const rotateSelected = () => {
    if (selectedIdx == null) return;
    const ann = annotations[selectedIdx];
    if (!ann) return;
    const deg = parseFloat(rotateAngle);
    if (isNaN(deg)) return;
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    pushHistory(annotations);

    // Find center of the annotation
    let cx, cy;
    if (ann.points && ann.points.length > 0) {
      cx = ann.points.reduce((s, p) => s + p[0], 0) / ann.points.length;
      cy = ann.points.reduce((s, p) => s + p[1], 0) / ann.points.length;
    } else {
      const [x1, y1, x2, y2] = annotationBbox(ann);
      cx = (x1 + x2) / 2;
      cy = (y1 + y2) / 2;
    }

    let rotated;
    if (ann.points && ann.points.length > 0) {
      const newPts = ann.points.map(([x, y]) => {
        const dx = x - cx, dy = y - cy;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
      });
      // Recompute bounding box from rotated points
      const xs = newPts.map(p => p[0]), ys = newPts.map(p => p[1]);
      rotated = { ...ann, points: newPts, x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    } else {
      // Box: convert to polygon so the actual rotation is visible
      const [x1, y1, x2, y2] = annotationBbox(ann);
      const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
      const newPts = corners.map(([x, y]) => {
        const dx = x - cx, dy = y - cy;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
      });
      const xs = newPts.map(p => p[0]), ys = newPts.map(p => p[1]);
      rotated = { ...ann, shapeType: "polygon", points: newPts, x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }

    setAnnotations(prev => prev.map((a, i) => i === selectedIdx ? rotated : a));
  };

  const flipSelected = (axis) => {
    if (selectedIdx == null) return;
    const ann = annotations[selectedIdx];
    if (!ann || !ann.points || ann.points.length === 0) return;
    pushHistory(annotations);
    const cx = ann.points.reduce((s, p) => s + p[0], 0) / ann.points.length;
    const cy = ann.points.reduce((s, p) => s + p[1], 0) / ann.points.length;
    const newPts = ann.points.map(([x, y]) =>
      axis === "h" ? [2 * cx - x, y] : [x, 2 * cy - y]
    );
    const xs = newPts.map(p => p[0]), ys = newPts.map(p => p[1]);
    const flipped = { ...ann, points: newPts, x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    setAnnotations(prev => prev.map((a, i) => i === selectedIdx ? flipped : a));
  };

  const openImportAnnotations = async () => {
    setShowImportAnns(true);
    setImportSelectedProject(null);
    setImportProjectData(null);
    setImportSelectedPage(null);
    setImportCurrentSelectedPage(null);
    setImportCurrentProjectPages([]);
    setImportLoading(true);
    try {
      const [projects, currentData] = await Promise.all([
        listProjects(),
        project?.id ? loadProject(project.id, project.ownerSub || null) : null,
      ]);
      setImportProjects(projects.filter(p => p.id !== project?.id));
      // Show saved pages from current project, excluding the active page
      if (currentData?.pages) {
        setImportCurrentProjectPages(
          currentData.pages.filter(p => p.pageIndex !== currentPageIndex)
        );
      }
    } catch { setImportProjects([]); }
    setImportLoading(false);
  };

  const selectImportProject = async (proj) => {
    setImportSelectedProject(proj);
    setImportProjectData(null);
    setImportSelectedPage(null);
    setImportLoading(true);
    try {
      const data = await loadProject(proj.id, proj.ownerSub || null);
      setImportProjectData(data);
    } catch { setImportProjectData(null); }
    setImportLoading(false);
  };

  const doImport = (annsToImport, sourceName) => {
    if (!annsToImport || annsToImport.length === 0) return;
    pushHistory(annotations);
    const imported = annsToImport.map(a => ({
      ...a,
      id: Math.random().toString(36).slice(2),
    }));
    setAnnotations(prev => {
      let nextId = nextNumId(prev);
      const withIds = imported.map(a => ({ ...a, numId: nextId++ }));
      return [...prev, ...withIds];
    });
    setShowImportAnns(false);
    setStatus(`Imported ${imported.length} annotations from "${sourceName}".`);
  };

  const confirmImportAnnotations = () => {
    if (!importProjectData || importSelectedPage == null) return;
    const page = importProjectData.pages[importSelectedPage];
    if (!page || !page.annotations || page.annotations.length === 0) return;
    doImport(page.annotations, importSelectedProject.name);
  };

  const confirmImportCurrentPage = () => {
    if (importCurrentSelectedPage == null) return;
    const page = importCurrentProjectPages[importCurrentSelectedPage];
    if (!page || !page.annotations || page.annotations.length === 0) return;
    const label = page.label || (page.pdfPageNumber != null ? `Page ${page.pdfPageNumber}` : `Page ${page.pageIndex + 1}`);
    doImport(page.annotations, label);
  };

  const calculateRatio = () => {
    const px = parseFloat(pixelLength), rl = parseFloat(realLength);
    if (!px || !rl || px <= 0 || rl <= 0) { setStatus("Enter valid pixel and real lengths."); return; }
    const r = rl / px;
    setRatio(r);
    setStatus(`Ratio: ${r.toFixed(8)} m/px`);
  };

  // ─── Export ──────────────────────────────────────────────────────────────────
  // Returns the label for the current page, or a fallback string
  const currentPageLabel = () => {
    const p = allPagesRef.current.find(pg => pg.pageIndex === currentPageIndex);
    return p?.label || (p?.pdfPageNumber != null ? `Page ${p.pdfPageNumber}` : `Page ${currentPageIndex + 1}`);
  };
  // Sanitize label for use in filenames
  const labelToSlug = (lbl) => lbl.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

  const exportJSON = () => {
    // JSON export: current page only
    const data = annotations.map(ann => {
      const [x1, y1, x2, y2] = annotationBbox(ann);
      const areaPx = annotationAreaPx(ann);
      const areaM2 = ratio ? areaPx * ratio * ratio : null;
      // Compute perimeter for every shape type (box, line, polygon, circle-as-polygon).
      // annotationPerimeterPx handles each case; no need to filter by shapeType.
      const perimPx = annotationPerimeterPx(ann);
      let perimM = ratio ? perimPx * ratio : null;
      if (ratio && (ann.clsName === "External_Wall" || ann.clsName === "Internal_Wall")) {
        const wAreaPx = annotationAreaPx(ann);
        if (perimPx > 0) perimM = wallLengthFromAreaPerim(wAreaPx, perimPx) * ratio;
      }
      return { page: currentPageLabel(), num_id: ann.numId ?? null, shape_type: ann.shapeType, class: ann.clsName, x1, y1, x2, y2, polygon_points: ann.points, confidence: ann.confidence, source_model: ann.sourceModel, zone_tag: ann.zoneTag, area_pixels2: areaPx, area_m2: areaM2, perimeter_pixels: perimPx, perimeter_m: perimM };
    });
    const pageSuffix = pageCount > 1 ? `_${labelToSlug(currentPageLabel())}` : '';
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `annotations${pageSuffix}.json`; a.click();
  };

  const buildExcelRows = () => {
    syncCurrentPageToRef();
    const allPages = allPagesRef.current.length > 0 ? allPagesRef.current : [{ pageIndex: currentPageIndex, annotations }];
    const rows = [];
    for (const page of allPages) {
      for (const ann of (page.annotations || [])) {
        const [x1, y1, x2, y2] = annotationBbox(ann);
        const areaPx = annotationAreaPx(ann);
        const areaM2 = ratio ? areaPx * ratio * ratio : "";
        // Perimeter for every shape (box, line, polygon, circle-as-polygon)
        const perimPx = annotationPerimeterPx(ann);
        let lengthM = ratio ? perimPx * ratio : "";
        if (ratio && (ann.clsName === "External_Wall" || ann.clsName === "Internal_Wall")) {
          if (perimPx > 0) lengthM = wallLengthFromAreaPerim(areaPx, perimPx) * ratio;
        }
        const pageLabel = page.label || (page.pdfPageNumber != null ? `Page ${page.pdfPageNumber}` : `Page ${page.pageIndex + 1}`);
        rows.push({
          page: pageLabel,
          num_id: ann.numId ?? "",
          shape_type: ann.shapeType,
          class: ann.clsName,
          x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2),
          polygon_points: ann.points ? JSON.stringify(ann.points) : "",
          confidence: ann.confidence ?? "",
          source_model: ann.sourceModel ?? "",
          zone_tag: ann.zoneTag ?? "",
          area_px2: areaPx !== "" ? Math.round(areaPx) : "",
          area_m2: areaM2 !== "" ? +areaM2.toFixed(4) : "",
          perimeter_px: perimPx !== "" ? Math.round(perimPx) : "",
          length_m: lengthM !== "" ? +lengthM.toFixed(4) : "",
        });
      }
    }
    return rows;
  };

  const openExcelPicker = () => {
    setExcelRows(buildExcelRows());
    setShowExcelPicker(true);
  };

  const openPdfPicker = () => {
    setPdfPickerRows(buildExcelRows());
    setShowPdfPicker(true);
  };

  const exportXLSX = (enabledCols) => {
    const cols = EXCEL_COLUMNS.filter(c => enabledCols.has(c.key));
    const header = cols.map(c => c.label);
    const data = excelRows.map(row => cols.map(c => row[c.key] ?? ""));
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    // Auto column widths
    const colWidths = cols.map((c, ci) => ({
      wch: Math.max(c.label.length + 2, ...data.map(r => String(r[ci] ?? "").length))
    }));
    ws["!cols"] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Annotations");
    const slug = (project?.name || "annotations").replace(/[^a-z0-9]/gi, "_");
    XLSX.writeFile(wb, `QT_${slug}.xlsx`);
    setShowExcelPicker(false);
  };

  const exportCSV = () => {
    syncCurrentPageToRef();
    const allPages = allPagesRef.current.length > 0 ? allPagesRef.current : [{ pageIndex: currentPageIndex, annotations }];
    const headers = ["page","num_id","shape_type","class","x1","y1","x2","y2","polygon_points","confidence","source_model","zone_tag","area_pixels2","area_m2","perimeter_pixels","perimeter_m"];
    const rows = [];
    for (const page of allPages) {
      const pageAnns = page.annotations || [];
      for (const ann of pageAnns) {
        const [x1, y1, x2, y2] = annotationBbox(ann);
        const areaPx = annotationAreaPx(ann);
        const areaM2 = ratio ? areaPx * ratio * ratio : "";
        // Perimeter for every shape (box, line, polygon, circle-as-polygon)
        const perimPx = annotationPerimeterPx(ann);
        let perimM = ratio ? perimPx * ratio : "";
        // Wall length from area & perimeter (rotation-invariant)
        if (ratio && (ann.clsName === "External_Wall" || ann.clsName === "Internal_Wall")) {
          const wAreaPx = annotationAreaPx(ann);
          if (perimPx > 0) perimM = wallLengthFromAreaPerim(wAreaPx, perimPx) * ratio;
        }
        const pageLabel = page.label || (page.pdfPageNumber != null ? `Page ${page.pdfPageNumber}` : `Page ${page.pageIndex + 1}`);
        rows.push([pageLabel, ann.numId ?? "", ann.shapeType, ann.clsName, x1, y1, x2, y2, ann.points ? JSON.stringify(ann.points) : "", ann.confidence ?? "", ann.sourceModel ?? "", ann.zoneTag ?? "", areaPx, areaM2, perimPx, perimM]);
      }
    }
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "annotations.csv"; a.click();
  };

  const exportReport = async (enabledCols) => {
    syncCurrentPageToRef();
    const allPages = allPagesRef.current.length > 0 ? allPagesRef.current : [];
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = 210, H = 297;
    const MARGIN = 14;
    const COL = W - MARGIN * 2;
    const ACCENT = [30, 80, 160];
    const DARK   = [15, 23, 40];
    const LIGHT  = [200, 208, 224];
    const MUTED  = [100, 120, 150];

    const scaleLabel = ratio
      ? `1 px = ${ratio.toFixed(6)} m  (${realLength}m : ${pixelLength}px)`
      : "No scale calibrated";

    // ── Helper: draw a horizontal rule ────────────────────────────────────────
    const hRule = (y, r=ACCENT[0], g=ACCENT[1], b=ACCENT[2]) => {
      doc.setDrawColor(r, g, b); doc.setLineWidth(0.4); doc.line(MARGIN, y, W - MARGIN, y);
    };

    // ── Helper: render one annotation table for a page ────────────────────────
    const drawTable = (anns, startY) => {
      const classes = {};
      for (const ann of anns) {
        if (!classes[ann.clsName]) classes[ann.clsName] = { count: 0, totalLength: 0, totalArea: 0 };
        const entry = classes[ann.clsName];
        entry.count++;
        const areaPx = annotationAreaPx(ann);
        const perimPx = annotationPerimeterPx(ann);
        if (ann.clsName === "External_Wall" || ann.clsName === "Internal_Wall") {
          if (perimPx > 0) entry.totalLength += wallLengthFromAreaPerim(areaPx, perimPx) * (ratio || 0);
        } else if (ann.clsName === "zone") {
          entry.totalArea += ratio ? areaPx * ratio * ratio : 0;
        }
      }

      let y = startY;
      const ROW_H = 7;
      const cols = [MARGIN, MARGIN + 60, MARGIN + 95, MARGIN + 135];

      // Table header
      doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
      doc.rect(MARGIN, y, COL, ROW_H, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(8); doc.setFont("helvetica", "bold");
      doc.text("Class", cols[0] + 2, y + 5);
      doc.text("Count", cols[1], y + 5);
      doc.text("Total Length (m)", cols[2], y + 5);
      doc.text("Total Area (m²)", cols[3], y + 5);
      y += ROW_H;

      const entries = Object.entries(classes);
      entries.forEach(([cls, data], i) => {
        doc.setFillColor(i % 2 === 0 ? 240 : 250, i % 2 === 0 ? 244 : 250, i % 2 === 0 ? 252 : 255);
        doc.rect(MARGIN, y, COL, ROW_H, "F");
        doc.setTextColor(DARK[0], DARK[1], DARK[2]);
        doc.setFont("helvetica", "normal"); doc.setFontSize(8);
        doc.text(cls, cols[0] + 2, y + 5);
        doc.text(String(data.count), cols[1], y + 5);
        doc.text(data.totalLength > 0 ? data.totalLength.toFixed(2) : "—", cols[2], y + 5);
        doc.text(data.totalArea > 0 ? data.totalArea.toFixed(2) : "—", cols[3], y + 5);
        y += ROW_H;
      });

      // Border around table
      doc.setDrawColor(180, 200, 220); doc.setLineWidth(0.3);
      doc.rect(MARGIN, startY, COL, y - startY);

      return y;
    };

    // ── Helper: draw per-annotation detail table with selected columns ────────
    const drawDetailTable = (anns, startY, pageLabel) => {
      const selCols = EXCEL_COLUMNS.filter(c => enabledCols.has(c.key));
      if (selCols.length === 0 || anns.length === 0) return startY;

      const numCols = selCols.length;
      const fontSize = numCols <= 4 ? 8 : numCols <= 8 ? 7 : numCols <= 12 ? 6 : 5.5;
      const ROW_H = numCols <= 4 ? 7 : numCols <= 8 ? 6.5 : 6;

      // Proportional column widths — text-heavy columns get more space
      const COL_WEIGHTS = {
        page: 1.4, num_id: 0.6, shape_type: 0.7, class: 2.0,
        x1: 0.7, y1: 0.7, x2: 0.7, y2: 0.7,
        polygon_points: 1.0, confidence: 0.8, source_model: 1.2,
        zone_tag: 1.5, area_px2: 0.9, area_m2: 1.2,
        perimeter_px: 0.9, length_m: 1.4,
      };
      const totalWeight = selCols.reduce((s, c) => s + (COL_WEIGHTS[c.key] || 1), 0);
      const colWidths = selCols.map(c => (COL_WEIGHTS[c.key] || 1) / totalWeight * COL);
      const colOffsets = colWidths.map((_, i) => colWidths.slice(0, i).reduce((s, w) => s + w, 0));

      const trunc = (v, ci) => {
        const maxChars = Math.max(3, Math.floor(colWidths[ci] / (fontSize * 0.42)));
        const s = String(v ?? "");
        return s.length > maxChars ? s.slice(0, maxChars - 1) + "…" : s;
      };

      let y = startY;
      let tableTop = y;

      const drawHeader = () => {
        doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
        doc.rect(MARGIN, y, COL, ROW_H, "F");
        doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(fontSize);
        selCols.forEach((col, ci) => doc.text(trunc(col.label, ci), MARGIN + 1 + colOffsets[ci], y + ROW_H - 2));
        y += ROW_H;
      };

      // Build row data from annotations
      const rowDataList = anns.map(ann => {
        const [x1, bY1, x2, bY2] = annotationBbox(ann);
        const areaPx = annotationAreaPx(ann);
        const areaM2 = ratio ? areaPx * ratio * ratio : "";
        // Perimeter for every shape (box, line, polygon, circle-as-polygon)
        const perimPx = annotationPerimeterPx(ann);
        let lengthM = ratio ? perimPx * ratio : "";
        if (ratio && (ann.clsName === "External_Wall" || ann.clsName === "Internal_Wall")) {
          if (perimPx > 0) lengthM = wallLengthFromAreaPerim(areaPx, perimPx) * ratio;
        }
        return {
          page: pageLabel,
          num_id: String(ann.numId ?? ""),
          shape_type: ann.shapeType || "",
          class: ann.clsName || "",
          x1: String(Math.round(x1)), y1: String(Math.round(bY1)),
          x2: String(Math.round(x2)), y2: String(Math.round(bY2)),
          polygon_points: ann.points ? `[${ann.points.length}pts]` : "",
          confidence: ann.confidence != null ? String(ann.confidence) : "",
          source_model: ann.sourceModel || "",
          zone_tag: ann.zoneTag || "",
          area_px2: areaPx !== "" ? String(Math.round(areaPx)) : "",
          area_m2: areaM2 !== "" ? (+areaM2).toFixed(3) : "",
          perimeter_px: perimPx !== "" ? String(Math.round(perimPx)) : "",
          length_m: lengthM !== "" ? (+lengthM).toFixed(3) : "",
        };
      });

      drawHeader();
      rowDataList.forEach((rowData, ri) => {
        // Page break
        if (y + ROW_H > H - 12) {
          doc.setDrawColor(180, 200, 220); doc.setLineWidth(0.3);
          doc.rect(MARGIN, tableTop, COL, y - tableTop);
          doc.addPage();
          doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
          doc.rect(0, 0, W, 12, "F");
          doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(9);
          doc.text(project?.name || "Untitled", MARGIN, 8);
          y = 20; tableTop = y;
          drawHeader();
        }
        doc.setFillColor(ri%2===0?240:250, ri%2===0?244:250, ri%2===0?252:255);
        doc.rect(MARGIN, y, COL, ROW_H, "F");
        doc.setTextColor(DARK[0], DARK[1], DARK[2]); doc.setFont("helvetica","normal"); doc.setFontSize(fontSize);
        selCols.forEach((col, ci) => doc.text(trunc(rowData[col.key] ?? "", ci), MARGIN + 1 + colOffsets[ci], y + ROW_H - 2));
        y += ROW_H;
      });

      doc.setDrawColor(180, 200, 220); doc.setLineWidth(0.3);
      doc.rect(MARGIN, tableTop, COL, y - tableTop);
      return y;
    };

    // ── Helper: render page image onto PDF ────────────────────────────────────
    const addPageImage = (page, y) => {
      if (!page.img) return y;
      const maxW = COL, maxH = 140;
      const imgW = page.imgNaturalSize?.w || page.img.naturalWidth;
      const imgH = page.imgNaturalSize?.h || page.img.naturalHeight;
      const scale = Math.min(maxW / imgW, maxH / imgH);
      const dw = imgW * scale, dh = imgH * scale;
      // Draw on temp canvas at natural size
      const c = document.createElement("canvas");
      c.width = imgW; c.height = imgH;
      const ctx = c.getContext("2d");
      ctx.drawImage(page.img, 0, 0);
      // Overlay annotations
      const annScale = 1;
      const drawAnnOnCanvas = (ann) => {
        const color = allClassColors[ann.clsName] || DEFAULT_COLOR;
        const hex = color.replace("#", "");
        const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.lineWidth = Math.max(2, imgW / 400);
        if (ann.shapeType === "box") {
          const [x1,y1,x2,y2] = annotationBbox(ann);
          ctx.strokeRect(x1*annScale, y1*annScale, (x2-x1)*annScale, (y2-y1)*annScale);
          ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
          ctx.fillRect(x1*annScale, y1*annScale, (x2-x1)*annScale, (y2-y1)*annScale);
        } else if (ann.points && ann.points.length > 1) {
          ctx.beginPath();
          ctx.moveTo(ann.points[0][0]*annScale, ann.points[0][1]*annScale);
          ann.points.slice(1).forEach(([px,py]) => ctx.lineTo(px*annScale, py*annScale));
          ctx.closePath(); ctx.stroke();
          ctx.fillStyle = `rgba(${r},${g},${b},0.12)`; ctx.fill();
        }
      };
      (page.annotations || []).forEach(drawAnnOnCanvas);
      const dataUrl = c.toDataURL("image/jpeg", 0.85);
      doc.addImage(dataUrl, "JPEG", MARGIN, y, dw, dh);
      return y + dh + 4;
    };

    // ══ COVER PAGE ═══════════════════════════════════════════════════════════
    doc.setFillColor(DARK[0], DARK[1], DARK[2]);
    doc.rect(0, 0, W, H, "F");
    // Accent bars
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(0, 70, W, 2, "F");
    doc.rect(0, 145, W, 2, "F");

    // Logo + "Quant" branding — top-left corner
    const LOGO_SIZE = 14;
    const LOGO_X = MARGIN, LOGO_Y = MARGIN;
    try {
      const logoResp = await fetch("/logo.png");
      const logoBlob = await logoResp.blob();
      const logoB64 = await new Promise(res => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result);
        reader.readAsDataURL(logoBlob);
      });
      doc.addImage(logoB64, "PNG", LOGO_X, LOGO_Y, LOGO_SIZE, LOGO_SIZE);
    } catch { /* skip if logo missing */ }
    doc.setTextColor(100, 210, 255);
    doc.setFont("helvetica", "bold"); doc.setFontSize(14);
    doc.text("QUANT", LOGO_X + LOGO_SIZE + 3, LOGO_Y + 10);

    // Title
    doc.setTextColor(200, 240, 255);
    doc.setFont("helvetica", "bold"); doc.setFontSize(26);
    doc.text("Quantity Takeoff Report", W / 2, 95, { align: "center" });
    // Project name
    doc.setTextColor(LIGHT[0], LIGHT[1], LIGHT[2]);
    doc.setFontSize(16); doc.setFont("helvetica", "normal");
    doc.text(project?.name || "Untitled Project", W / 2, 112, { align: "center" });
    // Meta info
    doc.setFontSize(10); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    const userName = user?.signInDetails?.loginId || user?.username || "Unknown";
    doc.text(`Prepared by: ${userName}`, W / 2, 157, { align: "center" });
    doc.text(`Generated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, W / 2, 167, { align: "center" });
    doc.text(`Scale: ${scaleLabel}`, W / 2, 177, { align: "center" });
    doc.text(`Pages analysed: ${allPages.length}`, W / 2, 187, { align: "center" });

    // ══ GRAND SUMMARY PAGE ═══════════════════════════════════════════════════
    doc.addPage();
    let y = MARGIN;

    // Header bar
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(0, 0, W, 12, "F");
    doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(9);
    doc.text(project?.name || "Untitled", MARGIN, 8);
    y = 20;

    doc.setTextColor(DARK[0], DARK[1], DARK[2]);
    doc.setFont("helvetica", "bold"); doc.setFontSize(14);
    doc.text("Summary — All Pages", MARGIN, y); y += 3;
    hRule(y); y += 6;

    // Aggregate totals across all pages
    const totals = {};
    for (const page of allPages) {
      for (const ann of (page.annotations || [])) {
        if (!totals[ann.clsName]) totals[ann.clsName] = { count: 0, totalLength: 0, totalArea: 0 };
        const entry = totals[ann.clsName];
        entry.count++;
        const areaPx = annotationAreaPx(ann);
        const perimPx = annotationPerimeterPx(ann);
        if (ann.clsName === "External_Wall" || ann.clsName === "Internal_Wall") {
          if (perimPx > 0) entry.totalLength += wallLengthFromAreaPerim(areaPx, perimPx) * (ratio || 0);
        } else if (ann.clsName === "zone") {
          entry.totalArea += ratio ? areaPx * ratio * ratio : 0;
        }
      }
    }

    if (Object.keys(totals).length === 0) {
      doc.setFont("helvetica","italic"); doc.setFontSize(10); doc.setTextColor(MUTED[0],MUTED[1],MUTED[2]);
      doc.text("No annotations found.", MARGIN, y); y += 10;
    } else {
      const ROW_H = 8;
      const cols = [MARGIN, MARGIN+60, MARGIN+95, MARGIN+135];
      // header
      doc.setFillColor(ACCENT[0],ACCENT[1],ACCENT[2]);
      doc.rect(MARGIN, y, COL, ROW_H, "F");
      doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(9);
      doc.text("Class", cols[0]+2, y+5.5);
      doc.text("Count", cols[1], y+5.5);
      doc.text("Total Length (m)", cols[2], y+5.5);
      doc.text("Total Area (m²)", cols[3], y+5.5);
      y += ROW_H;
      Object.entries(totals).forEach(([cls, data], i) => {
        doc.setFillColor(i%2===0?235:245, i%2===0?242:247, i%2===0?252:255);
        doc.rect(MARGIN, y, COL, ROW_H, "F");
        doc.setTextColor(DARK[0],DARK[1],DARK[2]); doc.setFont("helvetica","normal"); doc.setFontSize(9);
        doc.text(cls, cols[0]+2, y+5.5);
        doc.text(String(data.count), cols[1], y+5.5);
        doc.text(data.totalLength>0 ? data.totalLength.toFixed(2) : "—", cols[2], y+5.5);
        doc.text(data.totalArea>0 ? data.totalArea.toFixed(2) : "—", cols[3], y+5.5);
        y += ROW_H;
      });
      doc.setDrawColor(180,200,220); doc.setLineWidth(0.3);
      doc.rect(MARGIN, 29, COL, y-29);
    }

    // ══ PER-PAGE SECTIONS ════════════════════════════════════════════════════
    for (const page of allPages) {
      doc.addPage();
      y = 0;

      // Header bar
      doc.setFillColor(ACCENT[0],ACCENT[1],ACCENT[2]);
      doc.rect(0, 0, W, 12, "F");
      doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(9);
      doc.text(project?.name || "Untitled", MARGIN, 8);
      y = 20;

      const pageLabel = page.label || (page.pdfPageNumber != null ? `Page ${page.pdfPageNumber}` : `Page ${page.pageIndex + 1}`);
      doc.setTextColor(DARK[0],DARK[1],DARK[2]); doc.setFont("helvetica","bold"); doc.setFontSize(13);
      doc.text(pageLabel, MARGIN, y); y += 3;
      hRule(y); y += 6;

      // Annotated thumbnail
      y = addPageImage(page, y) + 2;

      // Scale note
      doc.setFontSize(7); doc.setTextColor(MUTED[0],MUTED[1],MUTED[2]); doc.setFont("helvetica","italic");
      doc.text(`Scale: ${scaleLabel}`, MARGIN, y); y += 6;

      // Annotation count
      const annCount = (page.annotations || []).length;
      doc.setFontSize(9); doc.setFont("helvetica","bold"); doc.setTextColor(DARK[0],DARK[1],DARK[2]);
      doc.text(`Annotations: ${annCount}`, MARGIN, y); y += 5;
      hRule(y, 180, 200, 220); y += 4;

      if (annCount === 0) {
        doc.setFont("helvetica","italic"); doc.setFontSize(9); doc.setTextColor(MUTED[0],MUTED[1],MUTED[2]);
        doc.text("No annotations on this page.", MARGIN, y);
      } else {
        // Group annotations by class and draw one table per class
        const byClass = {};
        for (const ann of (page.annotations || [])) {
          if (!byClass[ann.clsName]) byClass[ann.clsName] = [];
          byClass[ann.clsName].push(ann);
        }
        for (const [cls, clsAnns] of Object.entries(byClass)) {
          // Class title with colour swatch
          const hex = (allClassColors[cls] || DEFAULT_COLOR).replace("#", "");
          const cr = parseInt(hex.slice(0,2),16), cg = parseInt(hex.slice(2,4),16), cb = parseInt(hex.slice(4,6),16);
          if (y + 14 > H - 12) {
            doc.addPage();
            doc.setFillColor(ACCENT[0],ACCENT[1],ACCENT[2]); doc.rect(0,0,W,12,"F");
            doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(9);
            doc.text(project?.name || "Untitled", MARGIN, 8);
            y = 20;
          }
          doc.setFillColor(cr, cg, cb); doc.rect(MARGIN, y, 4, 4, "F");
          doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(DARK[0],DARK[1],DARK[2]);
          doc.text(`${cls}  (${clsAnns.length})`, MARGIN + 6, y + 3.5);
          y += 7;
          y = drawDetailTable(clsAnns, y, pageLabel);
          y += 5;
        }
      }

      // ── Class & tag colour legend ─────────────────────────────────────────
      y += 6;
      doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(DARK[0],DARK[1],DARK[2]);
      doc.text("Legend", MARGIN, y); y += 4;
      hRule(y, 180, 200, 220); y += 4;

      // Classes present on this page
      const pageClasses = [...new Set((page.annotations || []).map(a => a.clsName))];
      const SWATCH = 4, GAP = 3, ITEM_W = 45;
      let lx = MARGIN, ly = y;
      doc.setFont("helvetica","normal"); doc.setFontSize(7.5);
      for (const cls of pageClasses) {
        const hex = (allClassColors[cls] || DEFAULT_COLOR).replace("#","");
        const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
        doc.setFillColor(r,g,b); doc.rect(lx, ly - SWATCH + 1, SWATCH, SWATCH, "F");
        doc.setTextColor(DARK[0],DARK[1],DARK[2]); doc.text(cls, lx + SWATCH + 2, ly);
        lx += ITEM_W;
        if (lx + ITEM_W > W - MARGIN) { lx = MARGIN; ly += SWATCH + GAP + 1; }
      }

      // Zone tags used on this page
      const pageTags = [...new Set((page.annotations || []).filter(a => a.zoneTag).map(a => a.zoneTag))];
      if (pageTags.length > 0) {
        lx = MARGIN; ly += SWATCH + GAP + 4;
        doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(DARK[0],DARK[1],DARK[2]);
        doc.text("Zone Tags", MARGIN, ly); ly += 4;
        hRule(ly, 180, 200, 220); ly += 4;
        doc.setFont("helvetica","normal"); doc.setFontSize(7.5);
        for (const tag of pageTags) {
          const tagColor = (zoneTags[tag] || "#888888").replace("#","");
          const r = parseInt(tagColor.slice(0,2),16), g = parseInt(tagColor.slice(2,4),16), b = parseInt(tagColor.slice(4,6),16);
          doc.setFillColor(r,g,b); doc.rect(lx, ly - SWATCH + 1, SWATCH, SWATCH, "F");
          doc.setTextColor(DARK[0],DARK[1],DARK[2]); doc.text(tag, lx + SWATCH + 2, ly);
          lx += ITEM_W;
          if (lx + ITEM_W > W - MARGIN) { lx = MARGIN; ly += SWATCH + GAP + 1; }
        }
      }

      // Page footer
      doc.setFontSize(7); doc.setTextColor(MUTED[0],MUTED[1],MUTED[2]); doc.setFont("helvetica","normal");
      doc.text(`${new Date().toLocaleDateString("en-GB")}`, W - MARGIN, H - 6, { align: "right" });
      hRule(H - 9, 50, 70, 100);
    }

    const slug = (project?.name || "report").replace(/[^a-z0-9]/gi, "_");
    doc.save(`QT_${slug}.pdf`);
    setShowPdfPicker(false);
  };

  const exportDXF = () => {
    // DXF export: current page only, one layer per class
    const d = new Drawing();
    d.setUnits(ratio ? "Meters" : "Unitless");

    // Map hex color → closest AutoCAD Color Index (ACI)
    const ACI_MAP = {
      "#00B050": 3,   // Internal_Wall → green
      "#0070C0": 5,   // External_Wall → blue
      "#C00000": 1,   // zone → red
      "#7030A0": 6,   // door → magenta
      "#ED7D31": 30,  // window → orange
      "#667799": 8,   // Unassigned → grey
    };
    const hexToAci = (hex) => ACI_MAP[hex] || 7; // default white

    // Collect unique class names from annotations and create a layer for each
    const classSet = new Set(annotations.map(a => a.clsName));
    for (const cls of classSet) {
      const hex = allClassColors[cls] || DEFAULT_COLOR;
      d.addLayer(cls, hexToAci(hex), "CONTINUOUS");
    }

    const imgH = imgNaturalSize.h;
    // Coordinate transform: flip Y, optionally convert px → meters
    const tx = (x) => ratio ? x * ratio : x;
    const ty = (y) => ratio ? (imgH - y) * ratio : (imgH - y);

    for (const ann of annotations) {
      d.setActiveLayer(ann.clsName);

      if (ann.shapeType === "box") {
        d.drawRect(tx(ann.x1), ty(ann.y2), tx(ann.x2), ty(ann.y1));
      } else if (ann.shapeType === "line") {
        d.drawLine(tx(ann.x1), ty(ann.y1), tx(ann.x2), ty(ann.y2));
      } else if (ann.shapeType === "polygon" && ann.points && ann.points.length >= 3) {
        const pts = ann.points.map(([px, py]) => [tx(px), ty(py)]);
        d.drawPolyline(pts, true);
      } else if (ann.shapeType === "circle" && ann.points && ann.points.length >= 3) {
        // Circle stored as polygon points — compute center and radius
        const xs = ann.points.map(p => p[0]), ys = ann.points.map(p => p[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const r = Math.max(...xs) - cx;
        d.drawCircle(tx(cx), ty(cy), ratio ? r * ratio : r);
      }
    }

    const dxfString = d.toDxfString();
    const pageSuffix = pageCount > 1 ? `_${labelToSlug(currentPageLabel())}` : '';
    const blob = new Blob([dxfString], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `annotations${pageSuffix}.dxf`; a.click();
  };

  // ─── On-demand PDF fetch for Auto DXF ──────────────────────────────────────
  const handleAutoDxfClick = async () => {
    // Already have the PDF bytes cached — open modal immediately
    if (pdfBytesRef.current) {
      setShowAutoDxf(true);
      return;
    }

    // Need to fetch from S3
    setFetchingPdf(true);
    try {
      const ext = existingFileInfoRef.current.ext;
      const url = await getOriginalFileUrl(project.id, ext, project.ownerSub || null);
      if (!url) throw new Error('Original PDF not found in storage');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      pdfBytesRef.current = buf.slice(0); // cache for future use
      setShowAutoDxf(true);
    } catch (err) {
      console.error('[handleAutoDxfClick] Failed to fetch PDF:', err);
      alert('Could not fetch the original PDF from storage. Please try again.');
    } finally {
      setFetchingPdf(false);
    }
  };

  // ─── Right panel drag-to-resize ──────────────────────────────────────────────
  const onPanelDragStart = useCallback((e) => {
    e.preventDefault();
    panelDragRef.current = { startX: e.clientX, startWidth: rightPanelWidth };
    const onMove = (ev) => {
      const dx = panelDragRef.current.startX - ev.clientX; // dragging left = wider
      setRightPanelWidth(Math.max(200, Math.min(600, panelDragRef.current.startWidth + dx)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panelDragRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [rightPanelWidth]);

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
      // Page navigation: PageUp / PageDown
      if (e.key === "PageUp" && pageCount > 1) {
        e.preventDefault();
        switchPage(Math.max(0, currentPageIndex - 1));
      }
      if (e.key === "PageDown" && pageCount > 1) {
        e.preventDefault();
        switchPage(Math.min(pageCount - 1, currentPageIndex + 1));
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
      {/* PDF Page Import Modal */}
      {pdfModalData && (
        <PdfPageImportModal
          pdfData={pdfModalData}
          onConfirmSingle={handlePdfConfirmSingle}
          onConfirmMulti={handlePdfConfirmMulti}
          onCancel={() => { setPdfModalData(null); setStatus("PDF import cancelled."); }}
        />
      )}

      {/* Auto DXF Modal */}
      {showAutoDxf && (
        <AutoDxfModal
          pdfData={pdfBytesRef.current}
          initialPage={currentPageIndex}
          scaleRatio={ratio}
          onClose={() => setShowAutoDxf(false)}
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

      {/* Excel Column Picker Modal */}
      {showExcelPicker && (
        <div style={styles.settingsOverlay} onClick={() => setShowExcelPicker(false)}>
          <div style={{ ...styles.settingsModal, minWidth: 620, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ color: "#cfaa6c", fontWeight: 700, fontSize: 13, letterSpacing: 2 }}>EXCEL EXPORT</span>
              <button onClick={() => setShowExcelPicker(false)} style={styles.tinyBtn}>✕</button>
            </div>

            {/* Column toggles */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: "#7a9aaa", fontSize: 11, marginBottom: 8, letterSpacing: 1 }}>SELECT COLUMNS</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
                {EXCEL_COLUMNS.map(col => (
                  <label key={col.key} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: excelEnabledCols.has(col.key) ? "#c8f0fa" : "#4a6a7a", fontSize: 11, userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={excelEnabledCols.has(col.key)}
                      onChange={() => setExcelEnabledCols(prev => {
                        const next = new Set(prev);
                        next.has(col.key) ? next.delete(col.key) : next.add(col.key);
                        return next;
                      })}
                      style={{ accentColor: "#1e50a0" }}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button onClick={() => setExcelEnabledCols(new Set(EXCEL_COLUMNS.map(c => c.key)))} style={{ ...styles.tinyBtn, fontSize: 10 }}>All</button>
                <button onClick={() => setExcelEnabledCols(new Set())} style={{ ...styles.tinyBtn, fontSize: 10 }}>None</button>
              </div>
            </div>

            <div style={{ borderTop: "1px solid #1a2e50", marginBottom: 10 }} />

            {/* Data preview */}
            <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", marginBottom: 12 }}>
              {excelRows.length === 0 ? (
                <div style={{ color: "#4a6a7a", fontSize: 12, padding: 10 }}>No annotations to export.</div>
              ) : (
                <table style={{ borderCollapse: "collapse", fontSize: 10, whiteSpace: "nowrap", width: "100%" }}>
                  <thead>
                    <tr>
                      {EXCEL_COLUMNS.filter(c => excelEnabledCols.has(c.key)).map(col => (
                        <th key={col.key} style={{ background: "#1e3050", color: "#c8f0fa", padding: "4px 8px", textAlign: "left", fontWeight: 700, borderBottom: "1px solid #2a4070", position: "sticky", top: 0 }}>
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {excelRows.map((row, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? "#0d1e38" : "#0a1628" }}>
                        {EXCEL_COLUMNS.filter(c => excelEnabledCols.has(c.key)).map(col => (
                          <td key={col.key} style={{ padding: "3px 8px", color: "#a0c0d0", borderBottom: "1px solid #12243c", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {String(row[col.key] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowExcelPicker(false)} style={styles.tinyBtn}>Cancel</button>
              <button
                onClick={() => exportXLSX(excelEnabledCols)}
                disabled={excelEnabledCols.size === 0 || excelRows.length === 0}
                style={{ ...styles.tinyBtn, background: "#1e50a0", color: "#fff", fontWeight: 700, opacity: (excelEnabledCols.size === 0 || excelRows.length === 0) ? 0.4 : 1 }}
              >
                Export XLSX
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF Column Picker Modal */}
      {showPdfPicker && (
        <div style={styles.settingsOverlay} onClick={() => setShowPdfPicker(false)}>
          <div style={{ ...styles.settingsModal, minWidth: 620, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ color: "#cfaa6c", fontWeight: 700, fontSize: 13, letterSpacing: 2 }}>PDF REPORT EXPORT</span>
              <button onClick={() => setShowPdfPicker(false)} style={styles.tinyBtn}>✕</button>
            </div>

            {/* Column toggles */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: "#7a9aaa", fontSize: 11, marginBottom: 8, letterSpacing: 1 }}>SELECT COLUMNS TO INCLUDE IN REPORT</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
                {EXCEL_COLUMNS.map(col => (
                  <label key={col.key} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: pdfEnabledCols.has(col.key) ? "#c8f0fa" : "#4a6a7a", fontSize: 11, userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={pdfEnabledCols.has(col.key)}
                      onChange={() => setPdfEnabledCols(prev => {
                        const next = new Set(prev);
                        next.has(col.key) ? next.delete(col.key) : next.add(col.key);
                        return next;
                      })}
                      style={{ accentColor: "#1e50a0" }}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button onClick={() => setPdfEnabledCols(new Set(EXCEL_COLUMNS.map(c => c.key)))} style={{ ...styles.tinyBtn, fontSize: 10 }}>All</button>
                <button onClick={() => setPdfEnabledCols(new Set())} style={{ ...styles.tinyBtn, fontSize: 10 }}>None</button>
              </div>
            </div>

            <div style={{ borderTop: "1px solid #1a2e50", marginBottom: 10 }} />

            {/* Data preview */}
            <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", marginBottom: 12 }}>
              {pdfPickerRows.length === 0 ? (
                <div style={{ color: "#4a6a7a", fontSize: 12, padding: 10 }}>No annotations to export.</div>
              ) : (
                <table style={{ borderCollapse: "collapse", fontSize: 10, whiteSpace: "nowrap", width: "100%" }}>
                  <thead>
                    <tr>
                      {EXCEL_COLUMNS.filter(c => pdfEnabledCols.has(c.key)).map(col => (
                        <th key={col.key} style={{ background: "#1e3050", color: "#c8f0fa", padding: "4px 8px", textAlign: "left", fontWeight: 700, borderBottom: "1px solid #2a4070", position: "sticky", top: 0 }}>
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pdfPickerRows.map((row, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? "#0d1e38" : "#0a1628" }}>
                        {EXCEL_COLUMNS.filter(c => pdfEnabledCols.has(c.key)).map(col => (
                          <td key={col.key} style={{ padding: "3px 8px", color: "#a0c0d0", borderBottom: "1px solid #12243c", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {String(row[col.key] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowPdfPicker(false)} style={styles.tinyBtn}>Cancel</button>
              <button
                onClick={() => exportReport(pdfEnabledCols)}
                disabled={pdfEnabledCols.size === 0 || pdfPickerRows.length === 0}
                style={{ ...styles.tinyBtn, background: "#1e50a0", color: "#fff", fontWeight: 700, opacity: (pdfEnabledCols.size === 0 || pdfPickerRows.length === 0) ? 0.4 : 1 }}
              >
                Export PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Annotations Modal */}
      {showImportAnns && (
        <div style={styles.settingsOverlay} onClick={() => setShowImportAnns(false)}>
          <div style={{ ...styles.settingsModal, minWidth: 400, maxWidth: 500, maxHeight: "70vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ color: "#cfaa6c", fontWeight: 700, fontSize: 13, letterSpacing: 2 }}>IMPORT ANNOTATIONS</span>
              <button onClick={() => setShowImportAnns(false)} style={styles.tinyBtn}>✕</button>
            </div>

            {importLoading && <div style={{ color: "#7a9aaa", fontSize: 11 }}>Loading...</div>}

            {/* Step 1: Project list */}
            {!importSelectedProject && !importLoading && (
              <div style={{ overflowY: "auto", flex: 1 }}>
                {/* Current project pages */}
                {importCurrentProjectPages.length > 0 && (
                  <>
                    <div style={{ color: "#cfaa6c", fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>THIS PROJECT</div>
                    {importCurrentProjectPages.map((page, idx) => {
                      const annCount = (page.annotations || []).length;
                      const label = page.label || (page.pdfPageNumber != null ? `Page ${page.pdfPageNumber}` : `Page ${page.pageIndex + 1}`);
                      const isSelected = importCurrentSelectedPage === idx;
                      return (
                        <div
                          key={idx}
                          onClick={() => annCount > 0 && setImportCurrentSelectedPage(isSelected ? null : idx)}
                          style={{ padding: "8px 10px", marginBottom: 4, background: isSelected ? "#1a3056" : "#111e30", border: `1px solid ${isSelected ? "#3a6ab0" : "#1e3050"}`, borderRadius: 4, cursor: annCount > 0 ? "pointer" : "not-allowed", opacity: annCount > 0 ? 1 : 0.45 }}
                          onMouseEnter={e => { if (annCount > 0) e.currentTarget.style.borderColor = "#3a6ab0"; }}
                          onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = "#1e3050"; }}
                        >
                          <div style={{ color: "#c8d0e0", fontSize: 12 }}>{label}</div>
                          <div style={{ color: "#5a7a9a", fontSize: 10 }}>
                            {annCount} annotation{annCount !== 1 ? "s" : ""}
                            {annCount > 0 && (() => {
                              const classes = {};
                              page.annotations.forEach(a => { classes[a.clsName] = (classes[a.clsName] || 0) + 1; });
                              return " — " + Object.entries(classes).map(([c, n]) => `${n} ${c}`).join(", ");
                            })()}
                          </div>
                        </div>
                      );
                    })}
                    {importCurrentSelectedPage != null && (
                      <button
                        onClick={confirmImportCurrentPage}
                        style={{ ...styles.smallBtn, width: "100%", marginBottom: 10, background: "#1a3a1a", borderColor: "#2a6a2a", color: "#6caa6c", fontWeight: 700 }}
                      >Import {importCurrentProjectPages[importCurrentSelectedPage].annotations.length} annotations</button>
                    )}
                    <div style={{ borderTop: "1px solid #1a2e50", margin: "10px 0 10px" }} />
                    <div style={{ color: "#7a9aaa", fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>OTHER PROJECTS</div>
                  </>
                )}
                {importProjects.length === 0 && importCurrentProjectPages.length === 0 && <div style={{ color: "#4a6a7a", fontSize: 11 }}>No other pages or projects found.</div>}
                {importProjects.map(p => (
                  <div
                    key={p.id}
                    onClick={() => selectImportProject(p)}
                    style={{ padding: "8px 10px", marginBottom: 4, background: "#111e30", border: "1px solid #1e3050", borderRadius: 4, cursor: "pointer" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "#3a6ab0"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "#1e3050"}
                  >
                    <div style={{ color: "#c8d0e0", fontSize: 12, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ color: "#5a7a9a", fontSize: 10 }}>
                      {p.pageCount || 1} page{(p.pageCount || 1) > 1 ? "s" : ""} — {new Date(p.lastEdited).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Step 2: Page list with annotation counts */}
            {importSelectedProject && importProjectData && !importLoading && (
              <div style={{ overflowY: "auto", flex: 1 }}>
                <button onClick={() => { setImportSelectedProject(null); setImportProjectData(null); setImportSelectedPage(null); }} style={{ ...styles.tinyBtn, marginBottom: 10 }}>← Back to projects</button>
                <div style={{ color: "#8aabbb", fontSize: 11, marginBottom: 8 }}>{importSelectedProject.name}</div>
                {(importProjectData.pages || []).map((page, idx) => {
                  const annCount = (page.annotations || []).length;
                  const label = page.label || (page.pdfPageNumber != null ? `Page ${page.pdfPageNumber}` : `Page ${page.pageIndex + 1}`);
                  const isSelected = importSelectedPage === idx;
                  return (
                    <div
                      key={idx}
                      onClick={() => annCount > 0 && setImportSelectedPage(idx)}
                      style={{ padding: "8px 10px", marginBottom: 4, background: isSelected ? "#1a3056" : "#111e30", border: `1px solid ${isSelected ? "#3a6ab0" : "#1e3050"}`, borderRadius: 4, cursor: annCount > 0 ? "pointer" : "not-allowed", opacity: annCount > 0 ? 1 : 0.5 }}
                    >
                      <div style={{ color: "#c8d0e0", fontSize: 12 }}>{label}</div>
                      <div style={{ color: "#5a7a9a", fontSize: 10 }}>
                        {annCount} annotation{annCount !== 1 ? "s" : ""}
                        {annCount > 0 && (() => {
                          const classes = {};
                          page.annotations.forEach(a => { classes[a.clsName] = (classes[a.clsName] || 0) + 1; });
                          return " — " + Object.entries(classes).map(([c, n]) => `${n} ${c}`).join(", ");
                        })()}
                      </div>
                    </div>
                  );
                })}
                {importSelectedPage != null && (
                  <button
                    onClick={confirmImportAnnotations}
                    style={{ ...styles.smallBtn, width: "100%", marginTop: 10, background: "#1a3a1a", borderColor: "#2a6a2a", color: "#6caa6c", fontWeight: 700 }}
                  >Import {importProjectData.pages[importSelectedPage].annotations.length} annotations</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Share panel — Enterprise QS only */}
      {showSharePanel && project?.id && (
        <div style={{ background: "#0d1f0d", borderBottom: "1px solid #2a5a2a", padding: "12px 20px", fontFamily: "monospace", fontSize: 12 }}>
          <div style={{ color: "#6caa6c", fontWeight: 700, marginBottom: 10 }}>🔗 Share project with a Manager</div>

          {/* Current grants */}
          {shareGrants.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: "#4a7a4a", fontSize: 10, marginBottom: 6 }}>Currently shared with:</div>
              {shareGrants.map(g => (
                <div key={g.managerId} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ color: "#8abb8a" }}>{g.managerName || g.managerEmail}</span>
                  <span style={{ color: "#4a7a4a", fontSize: 10 }}>{g.managerEmail}</span>
                  <button
                    onClick={async () => {
                      try {
                        await revokeProjectAccess(project.id, g.managerId);
                        setShareGrants(prev => prev.filter(x => x.managerId !== g.managerId));
                      } catch (e) { setShareError(e.message); }
                    }}
                    style={{ marginLeft: "auto", background: "none", border: "1px solid #5a2a2a", color: "#c06060", borderRadius: 4, padding: "1px 8px", cursor: "pointer", fontSize: 10 }}
                  >Revoke</button>
                </div>
              ))}
            </div>
          )}

          {/* Add manager */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="email"
              placeholder="Manager's email address"
              value={shareEmail}
              onChange={e => { setShareEmail(e.target.value); setShareError(null); setShareSuccess(null); }}
              style={{ flex: 1, background: "#0a1a0a", border: "1px solid #2a5a2a", borderRadius: 4, padding: "5px 10px", color: "#b0d0b0", fontSize: 12, fontFamily: "monospace" }}
            />
            <button
              disabled={shareLoading || !shareEmail.trim()}
              onClick={async () => {
                setShareLoading(true);
                setShareError(null);
                setShareSuccess(null);
                try {
                  const result = await grantProjectAccess(project.id, shareEmail.trim());
                  setShareSuccess(`Access granted to ${result.managerName || shareEmail}`);
                  setShareEmail('');
                  const grants = await getProjectGrants(project.id);
                  setShareGrants(grants);
                } catch (e) {
                  setShareError(e.message || 'Failed to grant access');
                } finally {
                  setShareLoading(false);
                }
              }}
              style={{ background: "#1a4a1a", border: "1px solid #3a7a3a", color: "#6caa6c", borderRadius: 4, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontFamily: "monospace" }}
            >{shareLoading ? "…" : "Grant Access"}</button>
          </div>

          {shareError && <div style={{ color: "#c06060", fontSize: 11, marginTop: 6 }}>✕ {shareError}</div>}
          {shareSuccess && <div style={{ color: "#6caa6c", fontSize: 11, marginTop: 6 }}>✓ {shareSuccess}</div>}
        </div>
      )}

      {/* View Only banner for Enterprise Managers */}
      {isReadOnly && (
        <div style={{ background: "#1a1000", borderBottom: "1px solid #5a4010", padding: "6px 16px", display: "flex", alignItems: "center", gap: 10, fontFamily: "monospace", fontSize: 11 }}>
          <span style={{ color: "#c0a040", fontWeight: 700, letterSpacing: 1 }}>👁 VIEW ONLY</span>
          <span style={{ color: "#7a6030" }}>You have read-only access to this project. Editing and saving are disabled.</span>
          <span style={{ marginLeft: "auto", color: tierColor(userTierInfo.tier, userTierInfo.role), fontWeight: 600 }}>{tierLabel(userTierInfo.tier, userTierInfo.role)}</span>
        </div>
      )}

      {/* Header */}
      <div style={styles.header}>
        <span style={styles.logo}>⬡ QUANT 1.0 </span>
        <span style={styles.statusBar}>{status}</span>
        {!isReadOnly && <label style={styles.uploadBtn}>
          📂 Load Image
          <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: "none" }} />
        </label>}
        {!isReadOnly && <label style={{ ...styles.uploadBtn, background: "#0d2e4a", borderColor: "#1a5070", color: "#6cf" }}>
          📄 Import PDF
          <input type="file" accept="application/pdf,.pdf" onChange={handlePdfChange} style={{ display: "none" }} />
        </label>}
        {!isReadOnly && (
          <button onClick={openImportAnnotations} style={{ ...styles.uploadBtn, background: "#2a1a0d", borderColor: "#705a1a", color: "#cfaa6c" }}>
            Import Annotations
          </button>
        )}
        {project?.id && !isReadOnly && (
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
        {/* Share button — Enterprise QS only */}
        {project?.id && userTierInfo.tier === 'enterprise' && userTierInfo.role === 'qs' && (
          <button
            onClick={async () => {
              setShowSharePanel(v => !v);
              if (!showSharePanel) {
                setShareError(null);
                setShareSuccess(null);
                try {
                  const grants = await getProjectGrants(project.id);
                  setShareGrants(grants);
                } catch { setShareGrants([]); }
              }
            }}
            title="Share with Manager"
            style={{ ...styles.uploadBtn, background: showSharePanel ? '#1a2f1a' : '#0f2010', borderColor: showSharePanel ? '#3a7a3a' : '#1a4a1a', color: '#6caa6c' }}
          >🔗 Share</button>
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
              onClick={duplicateSelected}
              disabled={selectedIdx == null}
              title="Duplicate selected annotation"
              style={{ ...styles.toolBtn, opacity: selectedIdx == null ? 0.35 : 1 }}
            >Duplicate</button>
            <button
              onClick={rotateSelected}
              disabled={selectedIdx == null}
              title="Rotate selected annotation"
              style={{ ...styles.toolBtn, opacity: selectedIdx == null ? 0.35 : 1 }}
            >Rotate</button>
            <input
              type="number"
              min="-180"
              max="180"
              value={rotateAngle}
              onKeyDown={e => e.stopPropagation()}
              onChange={e => {
                const v = e.target.value;
                if (v === "" || v === "-") { setRotateAngle(v); return; }
                const n = parseFloat(v);
                if (!isNaN(n) && n >= -180 && n <= 180) setRotateAngle(v);
              }}
              title="Rotation angle (-180 to 180)"
              style={{ ...styles.smallInput, width: 56, fontSize: 11, textAlign: "center" }}
            />
            <button
              onClick={() => flipSelected("h")}
              disabled={selectedIdx == null || !annotations[selectedIdx]?.points}
              title="Flip horizontal"
              style={{ ...styles.toolBtn, opacity: (selectedIdx == null || !annotations[selectedIdx]?.points) ? 0.35 : 1 }}
            >⇔</button>
            <button
              onClick={() => flipSelected("v")}
              disabled={selectedIdx == null || !annotations[selectedIdx]?.points}
              title="Flip vertical"
              style={{ ...styles.toolBtn, opacity: (selectedIdx == null || !annotations[selectedIdx]?.points) ? 0.35 : 1 }}
            >⇕</button>
            <div style={{ width: 12 }} />
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

          {/* ── Page switcher bar (multi-page only) ── */}
          {pageCount > 1 && (
            <div style={styles.pageSwitcher}>
              <button
                onClick={() => switchPage(Math.max(0, currentPageIndex - 1))}
                disabled={currentPageIndex === 0}
                style={{ ...styles.pageNavBtn, opacity: currentPageIndex === 0 ? 0.35 : 1 }}
              >◀</button>
              {allPagesRef.current.map((p) => {
                const annCount = p.pageIndex === currentPageIndex ? annotations.length : (p.annotations || []).length;
                const isActive = p.pageIndex === currentPageIndex;
                return (
                  <button
                    key={p.pageIndex}
                    onClick={() => switchPage(p.pageIndex)}
                    style={{
                      ...styles.pageTabBtn,
                      background: isActive ? "#1e3a6a" : "#0c1428",
                      borderColor: isActive ? "#3a6ab0" : "#1a2a40",
                      color: isActive ? "#8cf" : "#5a7a9a",
                    }}
                  >
                    {p.label || (p.pdfPageNumber != null ? `Page ${p.pdfPageNumber}` : `Page ${p.pageIndex + 1}`)}
                    {annCount > 0 && (
                      <span style={styles.pageBadge}>{annCount}</span>
                    )}
                  </button>
                );
              })}
              <button
                onClick={() => switchPage(Math.min(pageCount - 1, currentPageIndex + 1))}
                disabled={currentPageIndex === pageCount - 1}
                style={{ ...styles.pageNavBtn, opacity: currentPageIndex === pageCount - 1 ? 0.35 : 1 }}
              >▶</button>
            </div>
          )}

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
              style={{ display: originalImg ? "block" : "none", cursor: isReadOnly ? "default" : drawMode === "select" ? "default" : "crosshair", pointerEvents: isReadOnly ? "none" : "auto" }}
              onMouseDown={isReadOnly ? undefined : onMouseDown}
              onMouseMove={isReadOnly ? undefined : onMouseMove}
              onMouseUp={isReadOnly ? undefined : onMouseUp}
              onDoubleClick={isReadOnly ? undefined : onDoubleClick}
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
            <button onClick={() => runInference(true)} disabled={inferring || !originalImg || isReadOnly} style={{ ...styles.inferBtn, background: "#0e4d6e", opacity: isReadOnly ? 0.4 : 1, cursor: isReadOnly ? "not-allowed" : "pointer" }}>
              ▶ Run Analysis
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: "#5a7a9a", fontSize: 11, userSelect: "none" }}>
              <input type="checkbox" checked={showConfidence} onChange={e => setShowConfidence(e.target.checked)} style={{ cursor: "pointer" }} />
              Show confidence
            </label>
            {zoneSummary && <span style={styles.zoneSummary}>{zoneSummary}</span>}
          </div>
        </div>

        {/* ── Right panel resize handle ── */}
        <div
          onMouseDown={onPanelDragStart}
          style={{ width: 5, cursor: "col-resize", background: "transparent", flexShrink: 0, zIndex: 10 }}
          onMouseEnter={e => e.currentTarget.style.background = "#2a4a7a"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        />
        {/* ── Right panel ── */}
        <div style={{ ...styles.rightPanel, width: rightPanelWidth }}>
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
                  <span style={{ ...styles.classChip, borderColor: color, color }}>{cls} ({annotations.filter(a => a.clsName === cls).length})</span>
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
            <button onClick={deleteSelected} style={{ ...styles.smallBtn, background: "#5c1010", width: "100%", marginTop: 4 }}>Delete</button>
            <div style={{ ...styles.row, marginTop: 6 }}>
              <span style={styles.label} title="RDP tolerance in image pixels">Shape Simplification (px):</span>
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
              CUSTOM CLASSES{!canUseCustomClasses && <span style={{ fontSize: 9, color: "#c0a040", letterSpacing: 0 }}>🔒 Pro</span>}
              {canUseCustomClasses && <button onClick={() => setShowClassManager(v => !v)} style={styles.tinyBtn}>{showClassManager ? "▲" : "▼"}</button>}
            </div>
            {!canUseCustomClasses && (
              <div style={{ fontSize: 10, color: "#4a6a7a", fontStyle: "italic" }}>Upgrade to Pro to add custom classes.</div>
            )}
            {canUseCustomClasses && showClassManager && (
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
                      setCustomClasses(prev => [...prev, { name, color: newCustomClassColor, measureType: newCustomClassMeasureType }]);
                      setVisibleClasses(prev => new Set([...prev, name]));
                      setNewCustomClassName("");
                    }}
                    placeholder="class name"
                    style={{ ...styles.smallInput, flex: 1, width: "auto" }}
                  />
                  <input type="color" value={newCustomClassColor} onChange={e => setNewCustomClassColor(e.target.value)} style={{ width: 28, height: 24, padding: 1, background: "none", border: "none", cursor: "pointer" }} />
                  <select value={newCustomClassMeasureType} onChange={e => setNewCustomClassMeasureType(e.target.value)} title="How is this class measured?" style={{ ...styles.select, width: 68, fontSize: 10, padding: "2px 4px" }}>
                    <option value="unit">unit</option>
                    <option value="length">length</option>
                    <option value="area">area</option>
                  </select>
                  <button onClick={() => {
                    const name = newCustomClassName.trim();
                    if (!name || allClasses.includes(name)) return;
                    setCustomClasses(prev => [...prev, { name, color: newCustomClassColor, measureType: newCustomClassMeasureType }]);
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
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setRealLength(v); }}
                style={{ ...styles.smallInput, width: 48 }}
                placeholder=""
                title="Real-world length"
              />
              <span style={{ color: "#5a7a9a", fontSize: 12 }}>:</span>
              <input
                value={pixelLength}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setPixelLength(v); }}
                style={{ ...styles.smallInput, width: 48 }}
                placeholder=""
                title="Pixel length (auto-filled when you draw a line)"
              />
            </div>
            <button onClick={calculateRatio} style={{ ...styles.smallBtn, width: "100%" }}>Set Scale</button>
            {ratio != null && <div style={styles.ratioDisplay}>px = {ratio.toFixed(6)} m</div>}
          </div>

          {/* Export */}
          <div style={styles.section}>
            <select
              defaultValue=""
              onChange={e => {
                const val = e.target.value;
                e.target.value = "";
                if (val === "json") exportJSON();
                else if (val === "excel") openExcelPicker();
                else if (val === "dxf-manual" && canExportDXF) exportDXF();
                else if (val === "dxf-auto" && canExportDXF) handleAutoDxfClick();
                else if (val === "report") openPdfPicker();
              }}
              style={{ ...styles.select, cursor: "pointer", fontWeight: 700, color: "#c8f0fa", letterSpacing: 1 }}
            >
              <option value="" disabled>EXPORT</option>
              <option value="json">JSON</option>
              <option value="excel">Excel (.xlsx)</option>
              <option value="dxf-manual" disabled={!canExportDXF}>{canExportDXF ? "DXF (Manual)" : "DXF (Manual) - Pro"}</option>
              <option value="dxf-auto" disabled={!canExportDXF || !(existingFileInfoRef.current.ext === 'pdf' || pdfBytesRef.current)}>{canExportDXF ? "DXF (Auto)" : "DXF (Auto) - Pro"}</option>
              <option value="report">PDF Report</option>
            </select>
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
                    {ann.numId != null && <span style={{ color: "#8ab", fontWeight: 700, fontSize: 12, marginRight: 5 }}>#{ann.numId}</span>}
                    <span style={{ color: getClassColor(ann.clsName), fontWeight: 600, fontSize: 12 }}>{ann.clsName}</span>
                    {ann.zoneTag && <span style={{ color: "#aaa", fontSize: 11 }}> :{ann.zoneTag}</span>}
                    {(ann.clsName === "External_Wall" || ann.clsName === "Internal_Wall") && ratio != null && (
                      <><br /><span style={{ color: "#ffffff", fontSize: 11 }}>L: {(wallLengthFromAreaPerim(annotationAreaPx(ann), annotationPerimeterPx(ann)) * ratio).toFixed(2)} m</span></>
                    )}
                    {ann.clsName === "zone" && (
                      <><br /><span style={{ color: "#ffffff", fontSize: 11 }}>
                        {ratio != null ? `A: ${(annotationAreaPx(ann) * ratio * ratio).toFixed(2)} m²` : `A: ${annotationAreaPx(ann).toFixed(0)} px²`}
                        {" | "}
                        {ratio != null ? `P: ${(annotationPerimeterPx(ann) * ratio).toFixed(2)} m` : `P: ${annotationPerimeterPx(ann).toFixed(0)} px`}
                      </span></>
                    )}
                    {(() => {
                      const cc = customClasses.find(c => c.name === ann.clsName);
                      if (!cc || !cc.measureType) return null;
                      if (cc.measureType === "area" && ratio != null) {
                        const a = annotationAreaPx(ann) * ratio * ratio;
                        const p = annotationPerimeterPx(ann) * ratio;
                        return <><br /><span style={{ color: "#ffffff", fontSize: 11 }}>A: {a.toFixed(2)} m² | P: {p.toFixed(2)} m</span></>;
                      }
                      if (cc.measureType === "length" && ratio != null) {
                        let lenPx;
                        if (ann.shapeType === "line") lenPx = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
                        else lenPx = wallLengthFromAreaPerim(annotationAreaPx(ann), annotationPerimeterPx(ann));
                        return <><br /><span style={{ color: "#ffffff", fontSize: 11 }}>L: {(lenPx * ratio).toFixed(2)} m</span></>;
                      }
                      return null;
                    })()}
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
  pageSwitcher: { display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", background: "#0a1018", borderBottom: "1px solid #141e30", overflowX: "auto" },
  pageNavBtn: { background: "#152240", border: "1px solid #2a4070", borderRadius: 3, color: "#8ab", padding: "2px 8px", cursor: "pointer", fontSize: 12, flexShrink: 0 },
  pageTabBtn: { background: "#0c1428", border: "1px solid #1a2a40", borderRadius: 3, color: "#5a7a9a", padding: "3px 10px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", flexShrink: 0, display: "flex", alignItems: "center", gap: 5 },
  pageBadge: { background: "#1a3060", color: "#6af", borderRadius: 8, padding: "0 5px", fontSize: 9, fontWeight: 700, lineHeight: "16px" },
};
