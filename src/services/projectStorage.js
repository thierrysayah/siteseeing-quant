import { uploadData, downloadData, list, remove, getUrl } from 'aws-amplify/storage';
import { getCurrentUser } from 'aws-amplify/auth';

// ─── PATH HELPER ──────────────────────────────────────────────────────────────
async function userPath(projectId, filename) {
  const { userId } = await getCurrentUser();
  return `private/${userId}/projects/${projectId}/${filename}`;
}

async function userPrefix(projectId) {
  const { userId } = await getCurrentUser();
  return projectId
    ? `private/${userId}/projects/${projectId}/`
    : `private/${userId}/projects/`;
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
        const { body } = await downloadData({ path: key }).result;
        const text = await body.text();
        return JSON.parse(text);
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
    options: { contentType: 'application/json' },
  }).result;
}

// ─── SAVE PROJECT ─────────────────────────────────────────────────────────────
export async function saveProject(
  projectId,
  { name, annotations, scale, customTags, imageInfo, file }
) {
  const counts = deriveCountsFromAnnotations(annotations);
  const originalExt = file
    ? file.name.split('.').pop().toLowerCase()
    : null;

  const metadata = {
    id: projectId,
    name,
    status: counts ? 'In Progress' : 'Draft',
    lastEdited: new Date().toISOString(),
    counts,
    fileName: file ? file.name : null,
    originalExt,
  };

  const annotationsPayload = {
    schemaVersion: '1.0',
    savedAt: new Date().toISOString(),
    imageInfo: imageInfo || { w: 0, h: 0 },
    scale: scale || { pixelToMeter: null, pixelLength: '', realLength: '' },
    customTags: customTags || {},
    annotations: annotations || [],
  };

  const [metaKey, annotKey] = await Promise.all([
    userPath(projectId, 'metadata.json'),
    userPath(projectId, 'annotations.json'),
  ]);

  const uploads = [
    uploadData({
      path: metaKey,
      data: JSON.stringify(metadata),
      options: { contentType: 'application/json' },
    }).result,
    uploadData({
      path: annotKey,
      data: JSON.stringify(annotationsPayload),
      options: { contentType: 'application/json' },
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

  // Try to download annotations; return null for new (unsaved) projects
  let annotData;
  try {
    const { body } = await downloadData({ path: annotKey }).result;
    const text = await body.text();
    annotData = JSON.parse(text);
  } catch {
    return null; // Project not yet saved
  }

  // Fetch metadata
  let metadata = null;
  try {
    const { body } = await downloadData({ path: metaKey }).result;
    const text = await body.text();
    metadata = JSON.parse(text);
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
    } catch {
      // file missing — silently ignore
    }
  }

  return {
    metadata,
    annotations: annotData.annotations || [],
    scale: annotData.scale || {},
    customTags: annotData.customTags || {},
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
