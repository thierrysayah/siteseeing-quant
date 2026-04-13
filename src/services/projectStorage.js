import { uploadData, list, remove, getUrl } from 'aws-amplify/storage';
import { getCurrentUser } from 'aws-amplify/auth';
import { fetchAuthSession } from 'aws-amplify/auth';

// ─── PAGE SLUG ────────────────────────────────────────────────────────────────
// Turns a user page label into a stable, filesystem-safe S3 key segment.
// Falls back to "page-{pageIndex}" when no label is set.
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

// ─── PATH HELPER ──────────────────────────────────────────────────────────────
// For Individual/Pro: private/{cognito-sub}/projects/...
// For Enterprise:     private/org-{orgId}/projects/...  (shared across the org)
async function getBasePrefix() {
  const { userId } = await getCurrentUser();
  try {
    const session = await fetchAuthSession();
    const orgId = session?.tokens?.idToken?.payload?.['custom:orgId'];
    if (orgId) return `private/org-${orgId}/projects/`;
  } catch {
    // fall through to personal prefix
  }
  return `private/${userId}/projects/`;
}

async function userPath(projectId, filename) {
  const base = await getBasePrefix();
  return `${base}${projectId}/${filename}`;
}

async function userPrefix(projectId) {
  const base = await getBasePrefix();
  return projectId ? `${base}${projectId}/` : base;
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
// Accepts either a flat annotations array (v1) or a pages array (v2).
function deriveCountsFromPages(pages) {
  if (!pages || pages.length === 0) return null;
  const allAnns = pages.flatMap(p => p.annotations || []);
  if (allAnns.length === 0) return null;
  return {
    zones: allAnns.filter((a) => a.clsName === 'zone').length,
    doors: allAnns.filter((a) => a.clsName === 'door').length,
    windows: allAnns.filter((a) => a.clsName === 'window').length,
    walls: allAnns.filter(
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
    pageCount: 1,
  };
  await uploadData({
    path: key,
    data: JSON.stringify(metadata),
    options: { contentType: 'application/json', cacheControl: 'no-cache, no-store, must-revalidate' },
  }).result;
}

// ─── SAVE PROJECT ─────────────────────────────────────────────────────────────
// Each page gets its own annotation file named after the user's page label:
//   annotations-{slug}.json  and  page-{slug}.png
// Stale files left by renamed pages are deleted after each save.
export async function saveProject(
  projectId,
  { name, pages, scale, settings, file, pageImages, existingExt, existingFileName }
) {
  const counts = deriveCountsFromPages(pages);
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
    pageCount: pages ? pages.length : 1,
  };

  const NO_CACHE = 'no-cache, no-store, must-revalidate';

  // ── Shared settings file ──────────────────────────────────────────────────
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
    uploadData({
      path: metaKey,
      data: JSON.stringify(metadata),
      options: { contentType: 'application/json', cacheControl: NO_CACHE },
    }).result,
    uploadData({
      path: settingsKey,
      data: JSON.stringify(settingsPayload),
      options: { contentType: 'application/json', cacheControl: NO_CACHE },
    }).result,
  ];

  // ── Per-page annotation files — named after the page label slug ───────────
  const currentSlugs = new Set(); // track valid slugs for cleanup later
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
      uploads.push(
        uploadData({
          path: pageAnnotKey,
          data: JSON.stringify(pageAnnotPayload),
          options: { contentType: 'application/json', cacheControl: NO_CACHE },
        }).result
      );
    }
  }

  // Upload original file (PDF or image) on first save
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

  // Upload page images — named after the page label slug
  if (pageImages && pageImages.length > 0) {
    for (const pi of pageImages) {
      const slug = pi.slug || pageSlugify(pi.label, pi.pageIndex);
      const pageKey = await userPath(projectId, `page-${slug}.png`);
      uploads.push(
        uploadData({
          path: pageKey,
          data: pi.blob,
          options: { contentType: 'image/png' },
        }).result
      );
    }
  }

  await Promise.all(uploads);

  // ── Cleanup: delete stale annotation files and page images from renamed pages
  // Any annotations-*.json or page-*.png whose slug is not in currentSlugs is orphaned.
  if (currentSlugs.size > 0) {
    try {
      const prefix = await userPrefix(projectId);
      const existingFiles = await list({ path: prefix });
      const toDelete = [];
      for (const item of (existingFiles.items || [])) {
        const p = item.path;
        const annotMatch = p.match(/\/annotations-([^/]+)\.json$/);
        if (annotMatch && !currentSlugs.has(annotMatch[1])) {
          toDelete.push(p); // stale annotation file
        }
        const imageMatch = p.match(/\/page-([^/]+)\.png$/);
        if (imageMatch && !currentSlugs.has(imageMatch[1])) {
          toDelete.push(p); // stale page image
        }
      }
      if (toDelete.length > 0) {
        await Promise.all(toDelete.map(path => remove({ path })));
      }
    } catch (err) {
      console.warn('[saveProject] Cleanup of stale files failed:', err);
    }
  }

  return metadata;
}

// ─── LOAD PROJECT ─────────────────────────────────────────────────────────────
export async function loadProject(projectId) {
  const prefix = await userPrefix(projectId);

  // List all files in this project's folder
  const allFiles = await list({ path: prefix });
  const allPaths = (allFiles.items || []).map(item => item.path);

  // ── Fetch metadata ──────────────────────────────────────────────────────
  let metadata = null;
  try {
    const metaKey = await userPath(projectId, 'metadata.json');
    metadata = await fetchJSON(metaKey);
  } catch {
    // metadata missing — continue
  }

  // ── Detect schema version ──────────────────────────────────────────────
  // v3: has settings.json + per-page annotation files (annotations-{slug}.json)
  // v2: has single annotations.json with pages array
  // v1: has single annotations.json with flat annotations array
  const hasSettingsJson = allPaths.some(p => p.endsWith('/settings.json'));
  // Match any annotations-{anything}.json — covers both old (page-0) and new (label slug) naming
  const perPageFiles = allPaths.filter(p => /\/annotations-[^/]+\.json$/.test(p));
  const hasOldAnnotations = allPaths.some(p => p.endsWith('/annotations.json'));

  let pages = [];
  let scale = {};
  let settings = {};

  if (hasSettingsJson && perPageFiles.length > 0) {
    // ── Schema v3 — per-page annotation files + shared settings ──────────
    try {
      const settingsKey = await userPath(projectId, 'settings.json');
      const settingsData = await fetchJSON(settingsKey);
      scale = settingsData.scale || {};
      settings = settingsData.settings || {};
    } catch {
      // settings missing — continue with defaults
    }

    // Load all per-page annotation files in parallel
    const pageResults = await Promise.all(
      perPageFiles.map(async (filePath) => {
        try {
          return await fetchJSON(filePath);
        } catch {
          return null;
        }
      })
    );

    pages = pageResults
      .filter(Boolean)
      .sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));

  } else if (hasOldAnnotations) {
    // ── Schema v2 or v1 — single annotations.json ────────────────────────
    let annotData;
    try {
      const annotKey = await userPath(projectId, 'annotations.json');
      annotData = await fetchJSON(annotKey);
    } catch {
      return null; // Project not yet saved
    }

    if (annotData.pages) {
      // Schema v2 — multi-page in single file
      pages = annotData.pages;
      scale = annotData.scale || {};
      settings = annotData.settings || {};
    } else {
      // Schema v1 — single page, wrap into pages array
      pages = [{
        pageIndex: 0,
        imageInfo: annotData.imageInfo || { w: 0, h: 0 },
        annotations: annotData.annotations || [],
      }];
      scale = annotData.scale || {};
      settings = annotData.settings || {};
      if (annotData.customTags) settings.customTags = annotData.customTags;
      if (annotData.customClasses) settings.customClasses = annotData.customClasses;
    }
  } else {
    // No annotations found
    return null;
  }

  // ── Build presigned URLs for page images — keyed by slug ─────────────
  // Supports both new naming (page-{slug}.png) and legacy (page-0.png)
  const pageImageUrls = {}; // { slug: url }
  const pageFiles = allPaths.filter(p => /\/page-[^/]+\.png$/.test(p));

  await Promise.all(pageFiles.map(async (filePath) => {
    const match = filePath.match(/\/page-([^/]+)\.png$/);
    if (match) {
      const slug = match[1]; // may be a number string for legacy projects
      const urlResult = await getUrl({ path: filePath, options: { expiresIn: 120 } });
      pageImageUrls[slug] = urlResult.url.toString();
    }
  }));

  // Generate presigned URL for original file if it exists in S3
  // (always needed — used both as image fallback and to fetch the PDF for auto DXF)
  let originalFileUrl = null;
  if (metadata?.originalExt) {
    const originalKey = allPaths.find(p => p.endsWith(`/original.${metadata.originalExt}`));
    if (originalKey) {
      try {
        const urlResult = await getUrl({ path: originalKey, options: { expiresIn: 120 } });
        originalFileUrl = urlResult.url.toString();
      } catch (err) {
        console.error('[loadProject] Failed to generate presigned URL:', err);
      }
    }
  }

  return {
    metadata,
    pages,
    scale,
    settings,
    pageImageUrls,
    originalFileUrl,
    originalExt: metadata?.originalExt || null,
  };
}

// ─── GET ORIGINAL FILE URL ────────────────────────────────────────────────────
// Returns a fresh presigned URL for the project's original file (PDF/image).
// Useful for on-demand fetching (e.g. DXF auto export after session refresh).
export async function getOriginalFileUrl(projectId, originalExt) {
  if (!originalExt) return null;
  const prefix = await userPrefix(projectId);
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
  await Promise.all(items.map((item) => remove({ path: item.path })));
}
