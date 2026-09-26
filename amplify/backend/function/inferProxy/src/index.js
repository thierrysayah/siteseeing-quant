

/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const { SecretsManagerClient, GetSecretValueCommand } =
  require('@aws-sdk/client-secrets-manager');

const quota = require('./quota');

const sm = new SecretsManagerClient({ region: process.env.REGION || 'eu-west-3' });

// Cache the token across warm invocations — cold start ≈ 1 fetch only
let cachedToken = null;
let cachedAt = 0;
const TTL_MS = 10 * 60 * 1000; // 10 min — refresh well before rotation windows

async function getToken() {
  const now = Date.now();
  if (cachedToken && now - cachedAt < TTL_MS) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({
    SecretId: 'quant/inference/ultralytics',
  }));
  const { token } = JSON.parse(res.SecretString);
  cachedToken = token;
  cachedAt = now;
  return token;
}

// ── Request guard rails (security audit M8 / C2) ─────────────────────────────
// These parameters are the per-call COST levers. YOLO scales every input down to
// `imgsz` before inference, so payload size barely affects spend — but an absurd
// `imgsz` inflates GPU time and cost on a SINGLE call, which is far cheaper to
// abuse than spamming requests. Values are clamped rather than rejected so a
// slightly-off client still works; clamping is logged so abuse stays visible.
const MAX_IMGSZ = Number(process.env.MAX_IMGSZ || 2048);
// Generous: the client sends ~350 KB tiles, or ~1 MB for a whole A3 page. This
// only stops someone hand-rolling a huge request; API Gateway caps bodies at
// 10 MB regardless, so this sits just under that rather than guessing a limit
// that would break legitimate non-tiled runs on large sheets.
const MAX_B64_LEN = Number(process.env.MAX_B64_LEN || 9_000_000);

function clampNum(value, lo, hi, fallback, name, out) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) { out.push(`${name}=${value}->${fallback}`); return fallback; }
  const c = Math.min(hi, Math.max(lo, n));
  if (c !== n) out.push(`${name}=${n}->${c}`);
  return c;
}

const MODEL_URLS = {
  wall:    'https://predict-69b7f2f29e8ba20d1c3c-dproatj77a-lm.a.run.app/predict',
  zone:    'https://predict-69bbe87c3bb65e1f7377-dproatj77a-nw.a.run.app/predict',
  zoneseg: 'https://predict-69d4e9609d26fcda25f5-dproatj77a-od.a.run.app/predict',
};

// CORS headers returned on every response — the Amplify-generated API Gateway
// handles preflight OPTIONS separately, but Lambda proxy integration requires
// us to set Access-Control-Allow-Origin on the actual POST response too.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
  // Without this the browser hides the quota headers from our own fetch.
  'Access-Control-Expose-Headers': 'X-Infer-Runs-Limit,X-Infer-Runs-Remaining,X-Infer-Quota-Reset',
};

// Cognito User Pool `sub` from an IAM-authorized request. The identity pool has
// unauthenticated identities disabled, so every caller that reaches us is a
// signed-in user — no sub means something is wrong, not a guest.
function getCallerSub(event) {
  const claimsSub = event.requestContext?.authorizer?.claims?.sub;
  if (claimsSub) return claimsSub;
  const provider = event.requestContext?.identity?.cognitoAuthenticationProvider;
  const match = provider && provider.match(/CognitoSignIn:([a-f0-9-]+)$/);
  return match ? match[1] : null;
}

// The client shows a runs-remaining meter; the call ceiling is an internal
// backstop and is deliberately not advertised.
function quotaHeaders(q) {
  return {
    'X-Infer-Runs-Limit': String(q.runLimit),
    'X-Infer-Runs-Remaining': String(q.runsRemaining),
    'X-Infer-Quota-Reset': String(q.resetsAt),
  };
}

exports.handler = async (event) => {
  try {
    const { model, imageB64, conf, iou, imgsz, runId } = JSON.parse(event.body || '{}');
    const url = MODEL_URLS[model];
    if (!url) return resp(400, { error: 'unknown model' });
    if (!imageB64) return resp(400, { error: 'missing imageB64' });
    if (typeof imageB64 !== 'string' || imageB64.length > MAX_B64_LEN) {
      return resp(413, { error: 'image too large' });
    }

    const clamped = [];
    const safeConf  = clampNum(conf,  0, 1, 0.25, 'conf', clamped);
    const safeIou   = clampNum(iou,   0, 1, 0.7,  'iou',  clamped);
    const safeImgszRaw = clampNum(imgsz, 32, MAX_IMGSZ, 640, 'imgsz', clamped);
    const safeImgsz = safeImgszRaw == null ? null : Math.round(safeImgszRaw);
    if (clamped.length) console.warn('[inferProxy] clamped params:', clamped.join(', '));

    // Meter BEFORE spending anything upstream. A tiled sheet is ~18 calls, so
    // this is the loop that has to be bounded, not the size of any one image.
    const sub = getCallerSub(event);
    if (!sub) return resp(401, { error: 'unauthenticated', code: 'no_identity' });

    const q = await quota.consume(sub, runId);
    if (!q.ok) {
      console.warn('[inferProxy] quota denied:', q.reason, 'user', sub,
        `runs=${q.runs}/${q.runLimit} calls=${q.calls}/${q.callCeiling}`);
      return resp(429, {
        error: quota.MESSAGES[q.reason] || quota.MESSAGES.run_limit,
        code: 'infer_quota_exceeded',
        reason: q.reason,
        runLimit: q.runLimit,
        runsRemaining: q.runsRemaining,
        resetsAt: q.resetsAt,
      }, quotaHeaders(q));
    }

    const token = await getToken();

    // Node 22 native FormData + Blob
    const bytes = Buffer.from(imageB64, 'base64');
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'image.jpg');
    if (safeConf  != null) fd.append('conf',  String(safeConf));
    if (safeIou   != null) fd.append('iou',   String(safeIou));
    if (safeImgsz != null) fd.append('imgsz', String(safeImgsz));

    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
    } catch (netErr) {
      if (!q.degraded) await quota.refund(sub, runId);   // don't bill our own outage
      throw netErr;
    }
    // Same for an upstream error: the user got no detections, so give it back.
    if (r.status >= 500 && !q.degraded) await quota.refund(sub, runId);

    const text = await r.text();
    return {
      statusCode: r.status,
      headers: { ...CORS_HEADERS, ...quotaHeaders(q), 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (err) {
    console.error('[inferProxy]', err);
    return resp(500, { error: String(err?.message || err) });
  }
};

function resp(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...extraHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}