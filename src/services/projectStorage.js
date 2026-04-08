import { uploadData, list, remove, getUrl } from 'aws-amplify/storage';
import { getCurrentUser } from 'aws-amplify/auth';

// ─── PATH HELPER ──────────────────────────────────────────────────────────────
// Uses the Cognito User Pool sub (userId) — stable, user-specific, human-traceable
// via Cognito User Pool console. Path: private/{sub}/projects/...
async function getUserSub() {
  const { userId } = await getCurrentUser();
  return userId;
}

async function userPath(projectId, filename) {
  const sub = await getUserSub();
  return `private/${sub}/projects/${projectId}/${filename}`;
}

async function userPrefix(projectId) {
  const sub = await getUserSub();
  return projectId
    ? `private/${sub}/projects/${projectId}/`
    : `private/${sub}/projects/`;
}

// ─── CACHE-SAFE DOWNLOAD ──────────────────────────────────────────────────────
// Uses a fresh presigned URL (unique query-string per call) + fetch cache:'no-store'
// so the browser NEVER serves a stale cached response for any S3 JSON file.
async function fetchJSON(path) {
  const { url } = await getUrl({ path, options: { expiresIn: 60 } });
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── COUNT HELPER ─────────────────────────────────────────────────────────────
function deriveCountsFromAnnotations(annotations) {
  if (!annotations || annotations.length === 0) return null;
  return {
    zones: annotations.filter((a) => a.clsName === 'zone').length,
    doors: annotations.filter((a) => a.clsName === 'door').length,
    windows: annotations.filter((a) => a.clsName === 'window').length,
    walls: annotations.filter(
      (a) => a.clsName === 'Internal_Wall' || a.clsName === 'External_Wall'
    ).length,
  };
}

// ─── LIST PROJECTS ────────────────────────────────────────────────────────────
export async function listProjects() {
  const prefix = await userPrefix(null);

  const result = await list({ path: prefix });
  const items = result.items || [];

  const metadataKeys = items
    .map((item) => item.path)
    .filter((key) => key.endsWith('metadata.json'));

  if (metadataKeys.length === 0) return [];

  const projects = await Promise.all(
    metadataKeys.map(async (key) => {
      try {
        return await fetchJSON(key);
      } catch {
        return null;
      }
    })
  );

  return projects
    .filter(Boolean)
    .sort((a, b) => new Date(b.lastEdited) - new Date(a.lastEdited));
}

// ─── CREATE PROJECT ───────────────────────────────────────────────────────────
export async function createProject(id, name, owner) {
  const key = await userPath(id, 'metadata.json');
  const metadata = {
    id,
    name,
    owner,
    status: 'Draft',
    lastEdited: new Date().toISOString(),
    counts: null,
    fileName: null,
    originalExt: null,
  };
  await uploadData({
    path: key,
    data: JSON.stringify(metadata),
    options: { contentType: 'application/json', cacheControl: 'no-cache, no-store, must-revalidate' },
  }).result;
}

// ─── SAVE PROJECT ─────────────────────────────────────────────────────────────
export async function saveProject(
  projectId,
  { name, annotations, scale, settings, customTags, customClasses, imageInfo, file, existingExt, existingFileName }
) {
  const counts = deriveCountsFromAnnotations(annotations);
  // Preserve existing ext/fileName if no new file is provided (e.g. re-saving after load)
  const originalExt = file
    ? file.name.split('.').pop().toLowerCase()
    : (existingExt || null);
  const fileName = file ? file.name : (existingFileName || null);

  const metadata = {
    id: projectId,
    name,
    status: counts ? 'In Progress' : 'Draft',
    lastEdited: new Date().toISOString(),
    counts,
    fileName,
    originalExt,
  };

  const annotationsPayload = {
    schemaVersion: '1.0',
    savedAt: new Date().toISOString(),
    imageInfo: imageInfo || { w: 0, h: 0 },
    scale: scale || { pixelToMeter: null, pixelLength: '', realLength: '' },
    settings: settings || { autoSimplifyDist: '0' },
    customTags: customTags || {},
    customClasses: customClasses || [],
    annotations: annotations || [],
  };

  const [metaKey, annotKey] = await Promise.all([
    userPath(projectId, 'metadata.json'),
    userPath(projectId, 'annotations.json'),
  ]);

  const NO_CACHE = 'no-cache, no-store, must-revalidate';
  const uploads = [
    uploadData({
      path: metaKey,
      data: JSON.stringify(metadata),
      options: { contentType: 'application/json', cacheControl: NO_CACHE },
    }).result,
    uploadData({
      path: annotKey,
      data: JSON.stringify(annotationsPayload),
      options: { contentType: 'application/json', cacheControl: NO_CACHE },
    }).result,
  ];

  if (file && originalExt) {
    const fileKey = await userPath(projectId, `original.${originalExt}`);
    uploads.push(
      uploadData({
        path: fileKey,
        data: file,
        options: { contentType: file.type || 'application/octet-stream' },
      }).result
    );
  }

  await Promise.all(uploads);
  return metadata;
}

// ─── LOAD PROJECT ─────────────────────────────────────────────────────────────
export async function loadProject(projectId) {
  const [metaKey, annotKey] = await Promise.all([
    userPath(projectId, 'metadata.json'),
    userPath(projectId, 'annotations.json'),
  ]);

  // Fetch annotations — returns null for new (unsaved) projects
  let annotData;
  try {
    annotData = await fetchJSON(annotKey);
  } catch {
    return null; // Project not yet saved
  }

  // Fetch metadata
  let metadata = null;
  try {
    metadata = await fetchJSON(metaKey);
  } catch {
    // metadata missing but annotations exist — continue
  }

  // Build presigned URL for original file
  let originalFileUrl = null;
  if (metadata?.originalExt) {
    try {
      const fileKey = await userPath(projectId, `original.${metadata.originalExt}`);
      const urlResult = await getUrl({ path: fileKey });
      originalFileUrl = urlResult.url.toString();
    } catch (err) {
      console.error('[loadProject] Failed to generate presigned URL:', err);
    }
  } else {
    console.warn('[loadProject] No originalExt in metadata — image will not be restored.', metadata);
  }

  return {
    metadata,
    annotations: annotData.annotations || [],
    scale: annotData.scale || {},
    settings: annotData.settings || {},
    customTags: annotData.customTags || {},
    customClasses: annotData.customClasses || [],
    imageInfo: annotData.imageInfo || { w: 0, h: 0 },
    originalFileUrl,
    originalExt: metadata?.originalExt || null,
  };
}

// ─── DELETE PROJECT ───────────────────────────────────────────────────────────
export async function deleteProject(projectId) {
  const prefix = await userPrefix(projectId);
  const result = await list({ path: prefix });
  const items = result.items || [];
  if (items.length === 0) return;
  await Promise.all(items.map((item) => remove({ path: item.path })));
}
