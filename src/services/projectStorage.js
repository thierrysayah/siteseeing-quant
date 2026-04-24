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
// Individual/Pro:   private/users/{sub}/projects/{projectId}/
// Enterprise QS:    private/organisations/org-{orgId}/projects/{sub}/{projectId}/
// Enterprise Mgr:   private/organisations/org-{orgId}/projects/{ownerSub}/{projectId}/  (read only)
async function getBasePrefix() {
  const { userId } = await getCurrentUser();
  const orgId = await getOrgId();
  if (orgId) return `private/organisations/org-${orgId}/projects/${userId}/`;
  return `private/users/${userId}/projects/`;
}

// Build a path for a specific owner (used by managers accessing a QS's project)
async function ownerBasePath(ownerSub) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error('ownerBasePath called outside org context');
  return `private/organisations/org-${orgId}/projects/${ownerSub}/`;
}

async function userPath(projectId, filename, ownerSub) {
  const { userId } = await getCurrentUser();
  const isOtherOwner = ownerSub && ownerSub !== userId;
  const base = isOtherOwner ? await ownerBasePath(ownerSub) : await getBasePrefix();
  return `${base}${projectId}/${filename}`;
}

async function userPrefix(projectId, ownerSub) {
  const { userId } = await getCurrentUser();
  const isOtherOwner = ownerSub && ownerSub !== userId;
  const base = isOtherOwner ? await ownerBasePath(ownerSub) : await getBasePrefix();
  return projectId ? `${base}${projectId}/` : base;
}

// ─── CACHE-SAFE DOWNLOAD ──────────────────────────────────────────────────────
async function fetchJSON(path) {
  const { url } = await getUrl({ path, options: { expiresIn: 60 } });
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── GEOMETRY HELPERS (exact mirror of DetectionTool.jsx) ────────────────────
function _areaPx(ann) {
  if (ann.shapeType === 'box') {
    return Math.max(0, ann.x2 - ann.x1) * Math.max(0, ann.y2 - ann.y1);
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
function _perimPx(ann) {
  if (ann.shapeType === 'box') {
    return 2 * (Math.max(0, ann.x2 - ann.x1) + Math.max(0, ann.y2 - ann.y1));
  }
  if (ann.shapeType === 'line') {
    return Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
  }
  const pts = ann.points || [];
  if (pts.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}
function _wallLength(areaPx, perimPx) {
  const halfP = perimPx / 2;
  const disc = halfP * halfP - 4 * areaPx;
  if (disc < 0) return halfP / 2;
  const sqrtDisc = Math.sqrt(disc);
  return (halfP + sqrtDisc) / 2;
}

// ─── COUNT & MEASUREMENT HELPERS ─────────────────────────────────────────────
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

// Compute the length contribution of an annotation (in px) given its expected measure type.
// - 'line' shape: direct endpoint distance (no quadratic formula — that would halve it)
// - 'box' or 'polygon': apply wall-length quadratic formula to recover the longer dimension
function _lengthPx(ann) {
  if (ann.shapeType === 'line') return Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1);
  const perim = _perimPx(ann);
  if (perim <= 0) return 0;
  return _wallLength(_areaPx(ann), perim);
}

// Derive per-class measurements from all annotations across all pages.
// Returns a unified `measurements` map keyed by className, where each entry has ONE of:
//   { length: <metres> }  — for walls and custom measureType='length'
//   { area:   <m²>     }  — for zones and custom measureType='area'
//   { count:  <n>      }  — for doors, windows and custom measureType='unit'
// Also returns legacy totals for backward compatibility with older dashboard code paths.
function deriveMeasurementsFromPages(pages, ratio, customClasses) {
  if (!pages || pages.length === 0) {
    return { measurements: {}, totalWallLengthM: null, totalZoneAreaM2: null, customMeasurements: {} };
  }
  const allAnns = pages.flatMap(p => p.annotations || []);

  // Build measureType lookup for custom classes: { name -> 'length'|'area'|'unit' }
  const customMeasureType = {};
  for (const cc of (customClasses || [])) {
    if (cc.measureType) customMeasureType[cc.name] = cc.measureType;
  }

  // Accumulators in PX / count — keyed by class name
  const lenPxByClass = {};    // { clsName: total length in px }
  const areaPxByClass = {};   // { clsName: total area   in px² }
  const perimPxByClass = {};  // { clsName: total perimeter in px } — only for area-type custom classes
  const countByClass = {};    // { clsName: count }

  for (const ann of allAnns) {
    const cls = ann.clsName;
    if (!cls) continue;

    if (cls === 'Internal_Wall' || cls === 'External_Wall') {
      lenPxByClass[cls] = (lenPxByClass[cls] || 0) + _lengthPx(ann);
    } else if (cls === 'zone') {
      areaPxByClass[cls] = (areaPxByClass[cls] || 0) + _areaPx(ann);
    } else if (cls === 'door' || cls === 'window') {
      countByClass[cls] = (countByClass[cls] || 0) + 1;
    } else if (customMeasureType[cls]) {
      const mt = customMeasureType[cls];
      if (mt === 'length') {
        lenPxByClass[cls] = (lenPxByClass[cls] || 0) + _lengthPx(ann);
      } else if (mt === 'area') {
        areaPxByClass[cls] = (areaPxByClass[cls] || 0) + _areaPx(ann);
        // Also accumulate perimeter for area-type custom classes
        perimPxByClass[cls] = (perimPxByClass[cls] || 0) + _perimPx(ann);
      } else if (mt === 'unit') {
        countByClass[cls] = (countByClass[cls] || 0) + 1;
      }
    }
    // Unknown / Unassigned classes are ignored for cost/measurement purposes.
  }

  // Build the unified `measurements` map (converting px → real units via ratio)
  const measurements = {};
  for (const [cls, px] of Object.entries(lenPxByClass)) {
    if (ratio) measurements[cls] = { length: px * ratio };
  }
  for (const [cls, px2] of Object.entries(areaPxByClass)) {
    if (ratio) {
      measurements[cls] = {
        area: px2 * ratio * ratio,
        // Include perimeter if it was tracked (area-type custom classes)
        ...(perimPxByClass[cls] != null ? { perimeter: perimPxByClass[cls] * ratio } : {}),
      };
    }
  }
  for (const [cls, n] of Object.entries(countByClass)) {
    measurements[cls] = { count: n };
  }

  // ── Legacy totals (kept for dashboard backward compat) ─────────────────────
  const wallLenPx =
    (lenPxByClass['Internal_Wall'] || 0) + (lenPxByClass['External_Wall'] || 0);
  const zoneAreaPx = areaPxByClass['zone'] || 0;

  const customMeasurements = {};
  for (const cls of Object.keys(customMeasureType)) {
    const m = measurements[cls];
    if (!m) continue;
    if (m.length != null) customMeasurements[cls] = m.length;
    else if (m.area != null) customMeasurements[cls] = m.area;
    else if (m.count != null) customMeasurements[cls] = m.count;
  }

  return {
    measurements,
    totalWallLengthM: ratio ? wallLenPx * ratio : null,
    totalZoneAreaM2:  ratio ? zoneAreaPx * ratio * ratio : null,
    customMeasurements,
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
        const key = `private/organisations/org-${orgId}/projects/${grant.ownerSub}/${grant.projectId}/metadata.json`;
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
  const { userId, signInDetails } = await getCurrentUser();
  const ownerEmail = signInDetails?.loginId || null;
  const counts = deriveCountsFromPages(pages);
  const measurements = deriveMeasurementsFromPages(pages, scale?.pixelToMeter, settings?.customClasses);
  const originalExt = file ? file.name.split('.').pop().toLowerCase() : (existingExt || null);
  const fileName = file ? file.name : (existingFileName || null);

  const metadata = {
    id: projectId,
    name,
    owner: ownerEmail,
    ownerSub: userId,
    status: counts ? 'In Progress' : 'Draft',
    lastEdited: new Date().toISOString(),
    counts,
    measurements:        measurements.measurements,        // unified per-class: { cls: { length|area|count } }
    totalWallLengthM:    measurements.totalWallLengthM,    // legacy
    totalZoneAreaM2:     measurements.totalZoneAreaM2,     // legacy
    customMeasurements:  measurements.customMeasurements,  // legacy
    fileName,
    originalExt,
    pageCount: pages ? pages.length : 1,
    customClasses: settings?.customClasses || [],
  };

  console.log('[saveProject] measurements being saved:', measurements.measurements, '(ratio=', scale?.pixelToMeter, ')');

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

  // Cleanup stale annotation JSON files from renamed/deleted pages
  // NOTE: PNG files are intentionally NOT deleted here to prevent data loss from slug mismatches.
  // Stale PNGs are harmless (small storage cost) vs accidentally deleting valid floor plan images.
  if (currentSlugs.size > 0) {
    try {
      const prefix = await userPrefix(projectId);
      const existingFiles = await list({ path: prefix });
      const toDelete = [];
      for (const item of (existingFiles.items || [])) {
        const p = item.path;
        const annotMatch = p.match(/\/annotations-([^/]+)\.json$/);
        if (annotMatch && !currentSlugs.has(annotMatch[1])) toDelete.push(p);
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

// ─── RATE CARD ────────────────────────────────────────────────────────────────
// Stored at private/organisations/org-{orgId}/{userId}/rate-card.json
// Each manager in the org has their own rate card.
export async function loadRateCard() {
  try {
    const { userId } = await getCurrentUser();
    const orgId = await getOrgId();
    if (!orgId) return null;
    const key = `private/organisations/org-${orgId}/${userId}/rate-card.json`;
    const { url } = await getUrl({ path: key, options: { expiresIn: 60 } });
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function saveRateCard(rates) {
  const { userId } = await getCurrentUser();
  const orgId = await getOrgId();
  if (!orgId) throw new Error('No org context');
  const key = `private/organisations/org-${orgId}/${userId}/rate-card.json`;
  const payload = { updatedAt: new Date().toISOString(), rates };
  await uploadData({
    path: key,
    data: JSON.stringify(payload),
    options: { contentType: 'application/json', cacheControl: 'no-cache, no-store, must-revalidate' },
  }).result;
}

// ─── MANAGER META ─────────────────────────────────────────────────────────────
// Stores per-project rate overrides and status overrides for this manager.
// Path: private/organisations/org-{orgId}/{userId}/manager-meta.json
// Shape: { projectStatuses: { [id]: string }, projectOverrides: { [id]: { [cls]: { costType, rate } } } }
export async function loadManagerMeta() {
  try {
    const { userId } = await getCurrentUser();
    const orgId = await getOrgId();
    if (!orgId) return null;
    const key = `private/organisations/org-${orgId}/${userId}/manager-meta.json`;
    const { url } = await getUrl({ path: key, options: { expiresIn: 60 } });
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function saveManagerMeta(meta) {
  const { userId } = await getCurrentUser();
  const orgId = await getOrgId();
  if (!orgId) throw new Error('No org context');
  const key = `private/organisations/org-${orgId}/${userId}/manager-meta.json`;
  const payload = { ...meta, updatedAt: new Date().toISOString() };
  await uploadData({
    path: key,
    data: JSON.stringify(payload),
    options: { contentType: 'application/json', cacheControl: 'no-cache, no-store, must-revalidate' },
  }).result;
}
