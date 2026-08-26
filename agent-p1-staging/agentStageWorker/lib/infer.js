/**
 * Server-side detection — a faithful port of the client's tiled inference
 * (src/DetectionTool.jsx: runTiledInference / parseModelResponse /
 * parseSegmentationResponse / iou / nms). Same tile size, overlap, models and
 * NMS threshold, so agent detections match manual "Run Analysis".
 *
 * Models are reached exactly like inferProxy: a Secrets-Manager token forwarded
 * to the Cloud Run endpoints. Tiles are JPEG (q90), matching the client.
 */
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const Jimp = require('jimp');

const sm = new SecretsManagerClient({ region: process.env.REGION || 'eu-west-3' });

// ── model access (mirrors inferProxy) ────────────────────────────────────────
const MODEL_URLS = {
  wall:    'https://predict-69b7f2f29e8ba20d1c3c-dproatj77a-lm.a.run.app/predict',
  zone:    'https://predict-69bbe87c3bb65e1f7377-dproatj77a-nw.a.run.app/predict',
  zoneseg: 'https://predict-69d4e9609d26fcda25f5-dproatj77a-od.a.run.app/predict',
};
const MODEL_DATA = {
  wall:    { conf: 0.5,  iou: 0.7, imgsz: 640 },
  zone:    { conf: 0.25, iou: 0.7, imgsz: 640 },
  zoneseg: { conf: 0.25, iou: 0.7, imgsz: 640 },
};

// Tiling constants — identical to the client.
const TILE_SIZE = 1280;
const TILE_OVERLAP = 128;
const NMS_IOU_THRESH = 0.4;

let cachedToken = null;
let cachedAt = 0;
const TTL_MS = 10 * 60 * 1000;
async function getToken() {
  const now = Date.now();
  if (cachedToken && now - cachedAt < TTL_MS) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: 'quant/inference/ultralytics' }));
  cachedToken = JSON.parse(res.SecretString).token;
  cachedAt = now;
  return cachedToken;
}

async function callModel(model, jpegBuffer) {
  const token = await getToken();
  const d = MODEL_DATA[model];
  const fd = new FormData();
  fd.append('file', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'image.jpg');
  fd.append('conf', String(d.conf));
  fd.append('iou', String(d.iou));
  fd.append('imgsz', String(d.imgsz));
  const r = await fetch(MODEL_URLS[model], {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`${model} model ${r.status}`);
  return r.json();
}

// ── response parsing (ported) ────────────────────────────────────────────────
function rid() { return Math.random().toString(36).slice(2); }

function parseBoxes(json, sourceModel) {
  const out = [];
  if (!json || !json.images) return out;
  for (const img of json.images) {
    for (const item of img.results || []) {
      const cls = item.name || item.class_name || String(item.class || 'unknown');
      const { x1, y1, x2, y2 } = item.box || {};
      if (x1 === undefined) continue;
      out.push({
        id: rid(), shapeType: 'box', clsName: cls,
        confidence: item.confidence ?? null, sourceModel, zoneTag: null,
        x1: Math.min(x1, x2), y1: Math.min(y1, y2),
        x2: Math.max(x1, x2), y2: Math.max(y1, y2), points: null,
      });
    }
  }
  return out;
}

function parsePolys(json, sourceModel) {
  const out = [];
  if (!json || !json.images) return out;
  for (const img of json.images) {
    for (const item of img.results || []) {
      const rawCls = item.name || item.class_name || String(item.class || 'unknown');
      const cls = rawCls === 'room' ? 'zone' : rawCls;
      let points = null;
      if (item.segments) {
        if (Array.isArray(item.segments.x) && Array.isArray(item.segments.y)) {
          points = item.segments.x.map((x, i) => [x, item.segments.y[i]]);
        } else if (Array.isArray(item.segments)) {
          points = item.segments;
        }
      }
      if (points && points.length >= 3) {
        out.push({
          id: rid(), shapeType: 'polygon', clsName: cls,
          confidence: item.confidence ?? null, sourceModel, zoneTag: null,
          x1: null, y1: null, x2: null, y2: null, points,
        });
      } else if (item.box && item.box.x1 !== undefined) {
        const { x1, y1, x2, y2 } = item.box;
        out.push({
          id: rid(), shapeType: 'box', clsName: cls,
          confidence: item.confidence ?? null, sourceModel, zoneTag: null,
          x1: Math.min(x1, x2), y1: Math.min(y1, y2),
          x2: Math.max(x1, x2), y2: Math.max(y1, y2), points: null,
        });
      }
    }
  }
  return out;
}

// ── geometry (ported) ────────────────────────────────────────────────────────
function bbox(a) {
  if (a.shapeType === 'box') return [a.x1, a.y1, a.x2, a.y2];
  const xs = a.points.map(p => p[0]), ys = a.points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function iou(a, b) {
  const [ax1, ay1, ax2, ay2] = bbox(a);
  const [bx1, by1, bx2, by2] = bbox(b);
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = iw * ih;
  const aA = (ax2 - ax1) * (ay2 - ay1), bA = (bx2 - bx1) * (by2 - by1);
  return inter / (aA + bA - inter + 1e-9);
}
function nms(anns, thresh) {
  const sorted = [...anns].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const keep = [], sup = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (sup.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!sup.has(j) && sorted[i].clsName === sorted[j].clsName && iou(sorted[i], sorted[j]) > thresh) sup.add(j);
    }
  }
  return keep;
}
function offset(a, tx, ty) {
  if (a.shapeType === 'polygon' && a.points) {
    return { ...a, points: a.points.map(([x, y]) => [x + tx, y + ty]) };
  }
  return { ...a, x1: a.x1 + tx, y1: a.y1 + ty, x2: a.x2 + tx, y2: a.y2 + ty };
}

// ── main: tile the page raster and detect ────────────────────────────────────
async function detectPage(pngBuffer) {
  const img = await Jimp.read(pngBuffer);
  const W = img.bitmap.width, H = img.bitmap.height;
  const stride = TILE_SIZE - TILE_OVERLAP;
  const all = [];
  let tiles = 0, failed = 0;

  for (let y = 0; y < H; y += stride) {
    for (let x = 0; x < W; x += stride) {
      const tw = Math.min(TILE_SIZE, W - x), th = Math.min(TILE_SIZE, H - y);
      tiles++;
      const jpeg = await img.clone().crop(x, y, tw, th).quality(90).getBufferAsync(Jimp.MIME_JPEG);
      let wallRes, zoneRes, segRes;
      try {
        [wallRes, zoneRes, segRes] = await Promise.all([
          callModel('wall', jpeg), callModel('zone', jpeg), callModel('zoneseg', jpeg),
        ]);
      } catch (e) {
        failed++; console.error('[infer] tile fail', x, y, e.message); continue;
      }
      const tileAnns = [
        ...parseBoxes(wallRes, 'wall_model'),
        ...parseBoxes(zoneRes, 'zone_door_window_model').filter(a => a.clsName === 'door' || a.clsName === 'window'),
        ...parsePolys(segRes, 'zone_seg_model'),
      ];
      for (const a of tileAnns) all.push(offset(a, x, y));
    }
  }

  const merged = nms(all, NMS_IOU_THRESH);
  return { annotations: merged, meta: { width: W, height: H, tiles, failed, raw: all.length } };
}

module.exports = { detectPage };
