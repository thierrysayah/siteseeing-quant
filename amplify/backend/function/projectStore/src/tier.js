// ── Canonical entitlements (security audit C4) ───────────────────────────────
//
// This file is the source of truth for what each tier may do. The copy in
// `src/services/userService.js` is a CLIENT-SIDE MIRROR used only to decide what
// to show; it ships to the user's machine and can be edited there, so it must
// never be the thing that decides. If the two ever disagree, this one wins.
//
// `deriveTierAndRole` is duplicated from
// `amplify/backend/function/getUserProfile/src/index.js`, and a string-returning
// variant lives in `agentOrchestrator/src/index.js` as `resolveTier`. Three
// copies is two too many, but a Lambda layer is heavier than this repo warrants;
// if you change the rules, change all three.

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);

// NB: `canExportDXF` is deliberately absent. DXF generation happens entirely in
// the browser (`src/DetectionTool.jsx` exportDXF) with no network call, over
// annotations the user is already entitled to read, so no server can gate it.
// A flag that cannot be enforced is worse than no flag: it reads like a control.
const LIMITS = {
  trial:      { maxProjects: 5,        canUseCustomClasses: true,  isReadOnly: false },
  pro:        { maxProjects: 10,       canUseCustomClasses: true,  isReadOnly: false },
  enterprise: { maxProjects: Infinity, canUseCustomClasses: true,  isReadOnly: false },
  individual: { maxProjects: 2,        canUseCustomClasses: false, isReadOnly: false }, // legacy
  expired:    { maxProjects: 0,        canUseCustomClasses: false, isReadOnly: true },
};

// Map Cognito groups (+ account age) to tier/role.
//
// The trial window is derived from Cognito's own UserCreateDate rather than any
// user-supplied attribute: Cognito owns that value, so a client cannot forge it
// (the mistake behind C1) and it needs no extra table or expiry job.
function deriveTierAndRole(groups, userCreateDate) {
  if (groups.includes('EnterpriseManager')) return { tier: 'enterprise', role: 'manager' };
  if (groups.includes('EnterpriseQS'))      return { tier: 'enterprise', role: 'qs' };
  if (groups.includes('Pro'))               return { tier: 'pro', role: null };
  if (groups.includes('Individual'))        return { tier: 'individual', role: null };

  const started = userCreateDate ? new Date(userCreateDate).getTime() : NaN;
  if (!Number.isFinite(started)) return { tier: 'expired', role: null };
  return { tier: Date.now() < started + TRIAL_DAYS * 86400000 ? 'trial' : 'expired', role: null };
}

/**
 * Effective limits for a caller. A manager may read the whole org but must never
 * write a QS's project — that is a data-integrity boundary, not a paywall.
 */
function limitsFor(tier, role) {
  const base = LIMITS[tier] || LIMITS.expired;
  if (role === 'manager') return { ...base, isReadOnly: true, maxProjects: 0 };
  return base;
}

module.exports = { LIMITS, TRIAL_DAYS, deriveTierAndRole, limitsFor };
