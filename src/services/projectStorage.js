import { uploadData, list, remove, getUrl } from 'aws-amplify/storage';
import { getCurrentUser, fetchAuthSession } from 'aws-amplify/auth';
import { post, get, del } from 'aws-amplify/api';

// ─── PAGE SLUG ────────────────────────────────────────────────────────────────
export function pageSlugify(label, pageIndex) {
  if (label && label.trim()) {
    const slug = label.trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (slug) return slug;
  }
  return `page-${pageIndex}`;
}

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
async function getOrgId() {
  try {
    const session = await fetchAuthSession();
    return session?.tokens?.idToken?.payload?.['custom:orgId'] || null;
  } catch {
    return null;
  }
}

// ─── PATH HELPERS ─────────────────────────────────────────────────────────────
// Individual/Pro:   private/{sub}/projects/{projectId}/
// Enterprise QS:    private/org-{orgId}/projects/{sub}/{projectId}/
// Enterprise Mgr:   private/org-{orgId}/projects/{ownerSub}/{projectId}/  (read only)
async function getBasePrefix() {
  const { userId } = await getCurrentUser();
  const orgId = await getOrgId();
  if (orgId) return `private/org-${orgId}/projects/${userId}/`;
  return `private/${userId}/projects/`;
}

// Build a path for a specific owner (used by managers accessing a QS's project)
async function ownerBasePath(ownerSub) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error('ownerBasePath called outside org context');
  return `private/org-${orgId}/projects/${ownerSub}/`;
}

async function userPath(projectId, filename, ownerSub) {
  const base = ownerSub ? await ownerBasePath(ownerSub) : await getBasePrefix();
  return `${base}${projectId}/${filename}`;
}

async function userPrefix(projectId, ownerSub) {
  const base = ownerSub ? await ownerBasePath(ownerSub) : await getBasePrefix();
  return projectId ? `${base}${projectId}/` : base;
}

// ─── CACHE-SAFE DOWNLOAD ──────────────────────────────────────────────────────
async function fetchJSON(path) {
  const { url } = await getUrl({ path, options: { expiresIn: 60 } });
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── COUNT HELPER ─────────────────────────────────────────────────────────────
function deriveCountsFromPages(pages) {
  if (!pages || pages.length === 0) return null;
  const allAnns = pages.flatMap(p => p.annotations || []);
  if (allAnns.length === 0) return null;
  return {
    zones:   allAnns.filter(a => a.clsName === 'zone').length,
    doors:   allAnns.filter(a => a.clsName === 'door').length,
    windows: allAnns.filter(a => a.clsName === 'window').length,
    walls:   allAnns.filter(a => a.clsName === 'Internal_Wall' || a.clsName === 'External_Wall').length,
  };
}

// ─── LIST PROJECTS (QS / Individual / Pro) ────────────────────────────────────
export async function listProjects() {
  const prefix = await userPrefix(null);
  const result = await list({ path: prefix });
  const items = result.items || [];

  const metadataKeys = items.map(i => i.path).filter(k => k.endsWith('metadata.json'));
  if (metadataKeys.length === 0) return [];

  const projects = await Promise.all(
    metadataKeys.map(async key => {
      try { return await fetchJSON(key); } catch { return null; }
    })
  );
  return projects.filter(Boolean).sort((a, b) => new Date(b.lastEdited) - new Date(a.lastEdited));
}

// ─── LIST MANAGER PROJECTS ────────────────────────────────────────────────────
// grants = [{ projectId, ownerSub, orgId }] — comes from getUserProfile Lambda
export async function listManagerProjects(grants) {
  if (!grants || grants.length === 0) return [];
  const orgId = await getOrgId();
  if (!orgId) return [];

  const projects = await Promise.all(
    grants.map(async grant => {
      try {
        const key = `private/org-${orgId}/projects/${grant.ownerSub}/${grant.projectId}/metadata.json`;
        const data = await fetchJSON(key);
        return { ...data, ownerSub: grant.ownerSub }; // attach ownerSub so we can route loads
      } catch { return null; }
    })
  );
  return projects.filter(Boolean).sort((a, b) => new Date(b.lastEdited) - new Date(a.lastEdited));
}

// ─── CREATE PROJECT ───────────────────────────────────────────────────────────
export async function createProject(id, name, owner) {
  const { userId } = await getCurrentUser();
  const key = await userPath(id, 'metadata.json');
  const metadata = {
    id,
    name,
    owner,
    ownerSub: userId,          // ← used by managers to resolve the S3 path
    status: 'Draft',
    lastEdited: new Date().toISOString(),
    counts: null,
    fileName: null,
    originalExt: null,
    pageCount: 1,
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
  { name, pages, scale, settings, file, pageImages, existingExt, existingFileName }
) {
  const { userId } = await getCurrentUser();
  const counts = deriveCountsFromPages(pages);
  const originalExt = file ? file.name.split('.').pop().toLowerCase() : (existingExt || null);
  const fileName = file ? file.name : (existingFileName || null);

  const metadata = {
    id: projectId,
    name,
    ownerSub: userId,
    status: counts ? 'In Progress' : 'Draft',
    lastEdited: new Date().toISOString(),
    counts,
    fileName,
    originalExt,
    pageCount: pages ? pages.length : 1,
  };

  const NO_CACHE = 'no-cache, no-store, must-revalidate';

  const settingsPayload = {
    schemaVersion: '3.0',
    savedAt: new Date().toISOString(),
    scale: scale || { pixelToMeter: null, pixelLength: '', realLength: '' },
    settings: settings || { autoSimplifyDist: '0' },
  };

  const [metaKey, settingsKey] = await Promise.all([
    userPath(projectId, 'metadata.json'),
    userPath(projectId, 'settings.json'),
  ]);

  const uploads = [
    uploadData({ path: metaKey, data: JSON.stringify(metadata), options: { contentType: 'application/json', cacheControl: NO_CACHE } }).result,
    uploadData({ path: settingsKey, data: JSON.stringify(settingsPayload), options: { contentType: 'application/json', cacheControl: NO_CACHE } }).result,
  ];

  const currentSlugs = new Set();
  if (pages && pages.length > 0) {
    for (const p of pages) {
      const slug = pageSlugify(p.label, p.pageIndex);
      currentSlugs.add(slug);
      const pageAnnotPayload = {
        pageIndex: p.pageIndex,
        pageSlug: slug,
        pdfPageNumber: p.pdfPageNumber ?? null,
        label: p.label ?? null,
        imageInfo: p.imageInfo || { w: 0, h: 0 },
        annotations: p.annotations || [],
      };
      const pageAnnotKey = await userPath(projectId, `annotations-${slug}.json`);
      uploads.push(uploadData({ path: pageAnnotKey, data: JSON.stringify(pageAnnotPayload), options: { contentType: 'application/json', cacheControl: NO_CACHE } }).result);
    }
  }

  if (file && originalExt) {
    const fileKey = await userPath(projectId, `original.${originalExt}`);
    uploads.push(uploadData({ path: fileKey, data: file, options: { contentType: file.type || 'application/octet-stream' } }).result);
  }

  if (pageImages && pageImages.length > 0) {
    for (const pi of pageImages) {
      const slug = pi.slug || pageSlugify(pi.label, pi.pageIndex);
      const pageKey = await userPath(projectId, `page-${slug}.png`);
      uploads.push(uploadData({ path: pageKey, data: pi.blob, options: { contentType: 'image/png' } }).result);
    }
  }

  await Promise.all(uploads);

  // Cleanup stale annotation/image files from renamed pages
  if (currentSlugs.size > 0) {
    try {
      const prefix = await userPrefix(projectId);
      const existingFiles = await list({ path: prefix });
      const toDelete = [];
      for (const item of (existingFiles.items || [])) {
        const p = item.path;
        const annotMatch = p.match(/\/annotations-([^/]+)\.json$/);
        if (annotMatch && !currentSlugs.has(annotMatch[1])) toDelete.push(p);
        const imageMatch = p.match(/\/page-([^/]+)\.png$/);
        if (imageMatch && !currentSlugs.has(imageMatch[1])) toDelete.push(p);
      }
      if (toDelete.length > 0) await Promise.all(toDelete.map(path => remove({ path })));
    } catch (err) {
      console.warn('[saveProject] Cleanup failed:', err);
    }
  }

  return metadata;
}

// ─── LOAD PROJECT ─────────────────────────────────────────────────────────────
// ownerSub is required when a manager is loading a QS's project
export async function loadProject(projectId, ownerSub) {
  const prefix = await userPrefix(projectId, ownerSub || null);
  const allFiles = await list({ path: prefix });
  const allPaths = (allFiles.items || []).map(item => item.path);

  let metadata = null;
  try {
    const metaKey = await userPath(projectId, 'metadata.json', ownerSub || null);
    metadata = await fetchJSON(metaKey);
  } catch { /* missing */ }

  const hasSettingsJson = allPaths.some(p => p.endsWith('/settings.json'));
  const perPageFiles = allPaths.filter(p => /\/annotations-[^/]+\.json$/.test(p));
  const hasOldAnnotations = allPaths.some(p => p.endsWith('/annotations.json'));

  let pages = [], scale = {}, settings = {};

  if (hasSettingsJson && perPageFiles.length > 0) {
    try {
      const settingsKey = await userPath(projectId, 'settings.json', ownerSub || null);
      const settingsData = await fetchJSON(settingsKey);
      scale = settingsData.scale || {};
      settings = settingsData.settings || {};
    } catch { /* defaults */ }

    const pageResults = await Promise.all(
      perPageFiles.map(async filePath => {
        try { return await fetchJSON(filePath); } catch { return null; }
      })
    );
    pages = pageResults.filter(Boolean).sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));

  } else if (hasOldAnnotations) {
    let annotData;
    try {
      const annotKey = await userPath(projectId, 'annotations.json', ownerSub || null);
      annotData = await fetchJSON(annotKey);
    } catch { return null; }

    if (annotData.pages) {
      pages = annotData.pages;
      scale = annotData.scale || {};
      settings = annotData.settings || {};
    } else {
      pages = [{ pageIndex: 0, imageInfo: annotData.imageInfo || { w: 0, h: 0 }, annotations: annotData.annotations || [] }];
      scale = annotData.scale || {};
      settings = annotData.settings || {};
      if (annotData.customTags) settings.customTags = annotData.customTags;
      if (annotData.customClasses) settings.customClasses = annotData.customClasses;
    }
  } else {
    return null;
  }

  // Build presigned URLs for page images
  const pageImageUrls = {};
  const pageFiles = allPaths.filter(p => /\/page-[^/]+\.png$/.test(p));
  await Promise.all(pageFiles.map(async filePath => {
    const match = filePath.match(/\/page-([^/]+)\.png$/);
    if (match) {
      const slug = match[1];
      const urlResult = await getUrl({ path: filePath, options: { expiresIn: 120 } });
      pageImageUrls[slug] = urlResult.url.toString();
    }
  }));

  let originalFileUrl = null;
  if (metadata?.originalExt) {
    const originalKey = allPaths.find(p => p.endsWith(`/original.${metadata.originalExt}`));
    if (originalKey) {
      try {
        const urlResult = await getUrl({ path: originalKey, options: { expiresIn: 120 } });
        originalFileUrl = urlResult.url.toString();
      } catch (err) { console.error('[loadProject] presigned URL failed:', err); }
    }
  }

  return { metadata, pages, scale, settings, pageImageUrls, originalFileUrl, originalExt: metadata?.originalExt || null };
}

// ─── GET ORIGINAL FILE URL ────────────────────────────────────────────────────
export async function getOriginalFileUrl(projectId, originalExt, ownerSub) {
  if (!originalExt) return null;
  const prefix = await userPrefix(projectId, ownerSub || null);
  const allFiles = await list({ path: prefix });
  const allPaths = (allFiles.items || []).map(item => item.path);
  const originalKey = allPaths.find(p => p.endsWith(`/original.${originalExt}`));
  if (!originalKey) return null;
  try {
    const urlResult = await getUrl({ path: originalKey, options: { expiresIn: 120 } });
    return urlResult.url.toString();
  } catch (err) {
    console.error('[getOriginalFileUrl] Failed:', err);
    return null;
  }
}

// ─── DELETE PROJECT ───────────────────────────────────────────────────────────
export async function deleteProject(projectId) {
  const prefix = await userPrefix(projectId);
  const result = await list({ path: prefix });
  const items = result.items || [];
  if (items.length === 0) return;
  await Promise.all(items.map(item => remove({ path: item.path })));
}

// ─── GRANT PROJECT ACCESS ─────────────────────────────────────────────────────
// Called by a QS to share their project with a manager (by email)
export async function grantProjectAccess(projectId, managerEmail) {
  const { userId: ownerSub } = await getCurrentUser();
  const orgId = await getOrgId();

  const { body } = await post({
    apiName: 'quantApi',
    path: '/org/grant-access',
    options: { body: { projectId, managerEmail, ownerSub, orgId } },
  }).response;
  const data = await body.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ─── GET PROJECT GRANTS (list of managers for a project) ──────────────────────
export async function getProjectGrants(projectId) {
  const { body } = await get({
    apiName: 'quantApi',
    path: `/org/grant-access?projectId=${encodeURIComponent(projectId)}`,
  }).response;
  const data = await body.json();
  if (data.error) throw new Error(data.error);
  return data.grants || [];
}

// ─── REVOKE PROJECT ACCESS ────────────────────────────────────────────────────
export async function revokeProjectAccess(projectId, managerId) {
  const { userId: ownerSub } = await getCurrentUser();

  const { body } = await del({
    apiName: 'quantApi',
    path: '/org/grant-access',
    options: { body: { projectId, managerId, ownerSub } },
  }).response;
  const data = await body.json();
  if (data.error) throw new Error(data.error);
  return data;
}
