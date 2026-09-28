/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */

// ── projectStore — server-side enforcement of tier limits (audit C4) ─────────
//
// Why this function exists: the browser writes project data STRAIGHT to S3, so
// until now there was nowhere for a limit check to live and every gate was a
// disabled button the user could re-enable in devtools.
//
// `metadata.json` and `settings.json` are the chokepoint. A project exists iff
// its metadata.json exists (listProjects enumerates `*/metadata.json`), and
// custom class definitions live in BOTH files — the editor reads them back from
// settings.json — so routing just these two small control files through here
// gates project count, custom classes and read-only in one place. Annotations
// and page PNGs stay on the direct-to-S3 path; they are large, and gating them
// needs presigned URLs (deliberately deferred).
//
// This function's IAM is what makes it work: the browser's role carries an
// explicit Deny on these two filenames, which does not apply here.

const {
  CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const {
  S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const { deriveTierAndRole, limitsFor } = require('./tier');

const REGION = process.env.REGION || process.env.AWS_REGION || 'eu-west-3';
const USER_POOL_ID = process.env.USER_POOL_ID || 'eu-west-3_jpxbGzhTX';
const BUCKET = process.env.PROJECT_BUCKET || 'estimation-platform-user-data';

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

// The client sends these headers on its own writes; the manager dashboard reads
// metadata.json through a presigned URL and will serve stale JSON if we differ.
const NO_CACHE = 'no-cache, no-store, must-revalidate';
// Control files are small. Anything near this is abuse, not a big project.
const MAX_BODY_BYTES = 256 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,PUT,DELETE,GET',
};

const resp = (statusCode, obj) => ({
  statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});
const deny = (code, error, extra = {}) => resp(403, { error, code, ...extra });

// Cognito User Pool `sub` from an IAM-authorized request. Same pattern as
// getUserProfile / agentOrchestrator / sessionGuard.
function getCallerSub(event) {
  const claimsSub = event.requestContext?.authorizer?.claims?.sub;
  if (claimsSub) return claimsSub;
  const provider = event.requestContext?.identity?.cognitoAuthenticationProvider;
  const m = provider && provider.match(/CognitoSignIn:([a-f0-9-]+)$/);
  return m ? m[1] : null;
}

// Autosave fires every few seconds and ListUsers is rate-limited, so resolving
// the tier on every call would both slow saves and risk throttling. Containers
// are per-concurrent-execution, so an autosave loop hits this almost every time.
// A tier change takes at most TTL to propagate, which is fine for entitlements.
const identityCache = new Map();
const IDENTITY_TTL_MS = 5 * 60 * 1000;

async function resolveIdentity(sub) {
  const hit = identityCache.get(sub);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value;
  try {
    const listed = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID, Filter: `sub = "${sub}"`, Limit: 1,
    }));
    const user = listed.Users && listed.Users[0];
    // A caller holding valid credentials for a sub that does not exist in the
    // pool is not a normal state — refuse rather than guess an entitlement.
    if (!user) return { notFound: true };

    const groupsResp = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID, Username: user.Username,
    }));
    const groups = (groupsResp.Groups || []).map((g) => g.GroupName);
    const orgId = user.Attributes?.find((a) => a.Name === 'custom:orgId')?.Value || null;
    const email = user.Attributes?.find((a) => a.Name === 'email')?.Value || null;
    const { tier, role } = deriveTierAndRole(groups, user.UserCreateDate || null);
    value = { tier, role, orgId, email };
  } catch (err) {
    // Degrade to `trial`, matching agentOrchestrator's resolveTier. Deliberately
    // NOT `expired`: that is read-only, so a Cognito blip would stop every user
    // saving. `trial` keeps people working while still capped, and an attacker
    // has no way to induce this.
    console.error('[projectStore] identity lookup failed — degrading to trial:', err);
    return { tier: 'trial', role: null, orgId: null, email: null, degraded: true };
  }
  identityCache.set(sub, { value, expiresAt: Date.now() + IDENTITY_TTL_MS });
  return value;
}

// Mirrors getBasePrefix() in src/services/projectStorage.js. Built from the
// SERVER's own sub/orgId — never from the request body, which is the entire
// cross-tenant attack and is free to get wrong.
const basePrefix = (sub, orgId) => (orgId
  ? `private/organisations/org-${orgId}/projects/${sub}/`
  : `private/users/${sub}/projects/`);

// Anything else could climb out of the caller's prefix via the S3 key.
const VALID_PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Count projects by listing FOLDERS, not metadata.json objects. One call
 * regardless of how many files a project holds, and it fails closed: someone
 * writing orphan files into a fresh folder to dodge the cap consumes a slot.
 */
async function countProjects(prefix) {
  let count = 0;
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, Delimiter: '/', ContinuationToken: token,
    }));
    count += (page.CommonPrefixes || []).length;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return count;
}

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

const putJson = (key, value) => s3.send(new PutObjectCommand({
  Bucket: BUCKET, Key: key, Body: JSON.stringify(value),
  ContentType: 'application/json', CacheControl: NO_CACHE,
}));

exports.handler = async (event) => {
  try {
    const method = (event.httpMethod || '').toUpperCase();
    if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    const sub = getCallerSub(event);
    if (!sub) return deny('unauthenticated', 'Not signed in.');

    const identity = await resolveIdentity(sub);
    if (identity.notFound) return deny('unauthenticated', 'Not signed in.');

    const { tier, role, orgId, email } = identity;
    const limits = limitsFor(tier, role);

    // `/projects/{projectId}` — the path may or may not carry the stage prefix.
    const after = (event.path || '').split('/projects')[1] || '';
    const projectId = decodeURIComponent(after.split('/').filter(Boolean)[0] || '');

    if (method !== 'PUT' && method !== 'DELETE') {
      return resp(405, { error: 'method not allowed', code: 'bad_method' });
    }
    if (!VALID_PROJECT_ID.test(projectId)) {
      return deny('bad_project_id', 'Invalid project id.');
    }

    // Read-only covers both an ended trial and an Enterprise Manager. A manager
    // may read the whole org but must never overwrite a QS's work.
    if (limits.isReadOnly) {
      return deny('read_only',
        role === 'manager'
          ? 'Managers have read-only access to projects.'
          : 'Your trial has ended. Your projects are read-only — upgrade to continue editing.',
        { tier, role });
    }

    const prefix = basePrefix(sub, orgId);
    const projectPrefix = `${prefix}${projectId}/`;
    const metaKey = `${projectPrefix}metadata.json`;

    if (method === 'DELETE') {
      let token;
      let removed = 0;
      do {
        const page = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET, Prefix: projectPrefix, ContinuationToken: token,
        }));
        const objects = (page.Contents || []).map((o) => ({ Key: o.Key }));
        if (objects.length) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: BUCKET, Delete: { Objects: objects, Quiet: true },
          }));
          removed += objects.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      console.log('[projectStore] deleted', projectId, removed, 'objects');
      return resp(200, { ok: true, deleted: removed });
    }

    // ── PUT: create or update ────────────────────────────────────────────────
    const raw = event.body || '{}';
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return resp(413, { error: 'Project data too large.', code: 'payload_too_large' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return resp(400, { error: 'bad json', code: 'bad_json' }); }

    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : null;
    if (!metadata) return resp(400, { error: 'metadata required', code: 'bad_body' });
    const settings = body.settings && typeof body.settings === 'object' ? body.settings : null;

    // The cap applies to CREATES only — an existing project must stay saveable
    // even if the user is somehow over their limit (e.g. after a downgrade).
    const isCreate = !(await exists(metaKey));
    // No tier is currently unlimited (enterprise is 50), so this counts on every
    // create. The Infinity guard stays as a cheap escape hatch if an unlimited
    // tier is ever reintroduced.
    if (isCreate && limits.maxProjects !== Infinity) {
      const count = await countProjects(prefix);
      if (count >= limits.maxProjects) {
        console.warn('[projectStore] project cap hit:', sub, count, '/', limits.maxProjects);
        return deny('project_limit',
          `You've reached your plan's limit of ${limits.maxProjects} projects.`,
          { count, maxProjects: limits.maxProjects, tier });
      }
    }

    const warnings = [];
    if (!limits.canUseCustomClasses) {
      // Strip rather than reject: rejecting would leave a user who lapsed from a
      // custom-class tier unable to save AT ALL, turning a feature gate into a
      // lockout. Their classes stop persisting; their work still saves.
      if (metadata.customClasses?.length) { delete metadata.customClasses; warnings.push('custom_classes_stripped'); }
      if (settings?.settings?.customClasses?.length) {
        delete settings.settings.customClasses;
        if (!warnings.includes('custom_classes_stripped')) warnings.push('custom_classes_stripped');
      }
    }

    // Identity fields are the server's to state, not the client's.
    metadata.id = projectId;
    metadata.ownerSub = sub;
    if (email) metadata.owner = email;
    metadata.lastEdited = new Date().toISOString();

    await Promise.all([
      putJson(metaKey, metadata),
      settings ? putJson(`${projectPrefix}settings.json`, settings) : Promise.resolve(),
    ]);

    console.log('[projectStore]', isCreate ? 'created' : 'updated', projectId, 'tier', tier);
    return resp(200, { ok: true, created: isCreate, metadata, limits: publicLimits(limits), warnings });
  } catch (err) {
    console.error('[projectStore]', err);
    return resp(500, { error: String(err?.message || err), code: 'server_error' });
  }
};

// Infinity is not representable in JSON (it serialises to null), so it would
// reach the client as a silent `null`. No tier uses it today; the sentinel
// remains so reintroducing an unlimited tier cannot break the client quietly.
function publicLimits(limits) {
  return {
    maxProjects: limits.maxProjects === Infinity ? -1 : limits.maxProjects,
    canUseCustomClasses: limits.canUseCustomClasses,
    isReadOnly: limits.isReadOnly,
  };
}
