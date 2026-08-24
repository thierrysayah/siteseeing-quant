/**
 * Locate + fetch a project's page raster from S3, and persist artifacts back.
 *
 * The worker is invoked async (no request identity), so it derives everything
 * from the run row: `userId` (Cognito sub, server-trusted) + `projectId`. It
 * resolves the user's `orgId` from Cognito, then *lists* the project prefix and
 * picks the `page-*.png` — listing (not exact-key reconstruction) tolerates the
 * `page-{slug}.png` naming and legacy path variants seen in the bucket.
 */
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CognitoIdentityProviderClient, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');

const REGION = process.env.REGION || 'eu-west-3';
const BUCKET = process.env.PROJECT_BUCKET || 'estimation-platform-user-data';
const USER_POOL_ID = process.env.USER_POOL_ID || 'eu-west-3_jpxbGzhTX';

const s3 = new S3Client({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

async function resolveOrgId(sub) {
  try {
    const resp = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID, Filter: `sub = "${sub}"`, Limit: 1,
    }));
    const u = resp.Users?.[0];
    return u?.Attributes?.find(a => a.Name === 'custom:orgId')?.Value || null;
  } catch (e) {
    console.warn('[pageimage] orgId lookup failed', e.message);
    return null;
  }
}

// Candidate project prefixes, current scheme first, then legacy variants.
function candidatePrefixes(sub, orgId, projectId) {
  const p = [];
  if (orgId) {
    p.push(`private/organisations/org-${orgId}/projects/${sub}/${projectId}/`);
    p.push(`private/org-${orgId}/projects/${sub}/${projectId}/`); // legacy
  }
  p.push(`private/users/${sub}/projects/${projectId}/`);
  return p;
}

const PAGE_RE = /\/page-[^/]+\.png$/;

/** Fetch the page PNG for a run → { buffer, key }. Throws if not found. */
async function fetchPagePng(run) {
  const sub = run.userId;
  const projectId = run.projectId;
  const pageId = run.pageId;
  const orgId = await resolveOrgId(sub);

  for (const prefix of candidatePrefixes(sub, orgId, projectId)) {
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    const pngs = (Contents || []).filter(o => PAGE_RE.test(o.Key));
    if (!pngs.length) continue;

    let chosen;
    if (pngs.length === 1) {
      chosen = pngs[0];
    } else if (pageId != null) {
      chosen = pngs.find(o => o.Key.endsWith(`page-${pageId}.png`))
            || pngs.find(o => o.Key.includes(String(pageId)))
            || pngs[0];
    } else {
      chosen = pngs[0];
    }

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: chosen.Key }));
    const buffer = Buffer.from(await obj.Body.transformToByteArray());
    return { buffer, key: chosen.Key };
  }
  throw new Error(`page image not found for project ${projectId}`);
}

/** Read the project's px→m scale from settings.json, or null if unset. */
async function readProjectScale(run) {
  const sub = run.userId;
  const projectId = run.projectId;
  const orgId = await resolveOrgId(sub);
  for (const prefix of candidatePrefixes(sub, orgId, projectId)) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}settings.json` }));
      const data = JSON.parse(await obj.Body.transformToString());
      const r = data?.scale?.pixelToMeter;
      return (typeof r === 'number' && r > 0) ? r : null;
    } catch { /* try next prefix */ }
  }
  return null;
}

/** Read the project's auto-simplify distance (px) from settings.json.
 *  Matches the client's default of 20 when unset. */
async function readAutoSimplifyDist(run) {
  const orgId = await resolveOrgId(run.userId);
  for (const prefix of candidatePrefixes(run.userId, orgId, run.projectId)) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}settings.json` }));
      const data = JSON.parse(await obj.Body.transformToString());
      const v = parseInt(data?.settings?.autoSimplifyDist, 10);
      return isNaN(v) ? 20 : v;   // unset → client default; '0' → disabled
    } catch { /* try next prefix */ }
  }
  return 20;
}

/** Load a JSON artifact previously written under agent-runs/{runId}/…. */
async function getJsonArtifact(key) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return JSON.parse(await obj.Body.transformToString());
}

/** Persist a JSON artifact under agent-runs/{runId}/… and return its key. */
async function putJsonArtifact(runId, name, data) {
  const key = `agent-runs/${runId}/${name}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key,
    Body: JSON.stringify(data), ContentType: 'application/json',
  }));
  return key;
}

module.exports = { fetchPagePng, putJsonArtifact, getJsonArtifact, readProjectScale, readAutoSimplifyDist };
