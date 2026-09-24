import { fetchAuthSession } from 'aws-amplify/auth';
import { get } from 'aws-amplify/api';

// ─── TIER DEFINITIONS ────────────────────────────────────────────────────────
// Maps Cognito group names → tier/role.
// Groups must exist in the Cognito User Pool:
//   Individual | Pro | EnterpriseQS | EnterpriseManager
const GROUP_MAP = {
  Trial:            { tier: 'trial',       role: null },
  Individual:       { tier: 'individual',  role: null },
  Pro:              { tier: 'pro',         role: null },
  EnterpriseQS:     { tier: 'enterprise',  role: 'qs' },
  EnterpriseManager:{ tier: 'enterprise',  role: 'manager' },
};

// ─── TIER LIMITS ─────────────────────────────────────────────────────────────
// Controls which features are enabled and how many projects each tier can have.
// Update these values here to change limits globally.
export const TIER_LIMITS = {
  // Free trial — full Pro features for a fixed window (server-resolved from the
  // Cognito account-creation date). AI takeoff sheets stay capped separately.
  trial: {
    maxProjects: 5,
    canExportDXF: true,
    canUseCustomClasses: true,
    isReadOnly: false,
  },
  // Trial over, no paid plan — data stays readable and exportable, but nothing
  // new can be created or edited. Reuses the manager role's read-only plumbing.
  expired: {
    maxProjects: 0,
    canExportDXF: true,
    canUseCustomClasses: false,
    isReadOnly: true,
  },
  individual: {
    maxProjects: 2,
    canExportDXF: false,
    canUseCustomClasses: false,
    isReadOnly: false,
  },
  pro: {
    maxProjects: 10,
    canExportDXF: true,
    canUseCustomClasses: true,
    isReadOnly: false,
  },
  enterprise: {
    maxProjects: Infinity,
    canExportDXF: true,
    canUseCustomClasses: true,
    isReadOnly: false, // overridden to true for 'manager' role
  },
};

// ─── GET USER TIER ────────────────────────────────────────────────────────────
// Reads the Cognito JWT (idToken) from the current auth session,
// extracts the `cognito:groups` claim, and returns tier + role.
// Falls back to 'individual' if no group is assigned.
export async function getUserTier() {
  // The server resolves the trial window (from the Cognito account-creation
  // date), so prefer /user/profile and fall back to JWT groups only if it fails.
  try {
    const p = await fetchUserProfile();
    if (p && p.tier) return { tier: p.tier, role: p.role ?? null, trial: p.trial ?? null };
  } catch { /* fall through to the JWT-only path */ }
  try {
    const session = await fetchAuthSession();
    const idToken = session?.tokens?.idToken;
    if (!idToken) return { tier: 'individual', role: null };

    // idToken is an object with a payload property in Amplify v6
    const groups = idToken.payload?.['cognito:groups'] || [];

    // Priority: if user is in multiple groups, pick the highest tier
    const priority = ['EnterpriseManager', 'EnterpriseQS', 'Pro', 'Individual', 'Trial'];
    for (const group of priority) {
      if (groups.includes(group)) return GROUP_MAP[group];
    }

    // No group assigned — default to individual (most restricted)
    return { tier: 'individual', role: null };
  } catch (err) {
    console.error('[getUserTier] Failed to read auth session:', err);
    return { tier: 'individual', role: null };
  }
}

// ─── GET LIMITS ───────────────────────────────────────────────────────────────
// Returns the limits object for a given tier, with manager read-only override.
export function getLimits(tier, role) {
  const base = TIER_LIMITS[tier] || TIER_LIMITS.expired;
  if (role === 'manager') {
    return { ...base, isReadOnly: true, maxProjects: Infinity };
  }
  return base;
}

// ─── TIER DISPLAY HELPERS ─────────────────────────────────────────────────────
export function tierLabel(tier, role, trial) {
  if (tier === 'enterprise' && role === 'manager') return 'Enterprise · Manager';
  if (tier === 'enterprise' && role === 'qs') return 'Enterprise · QS';
  if (tier === 'pro') return 'Pro';
  if (tier === 'trial') {
    const d = trial && trial.daysLeft;
    return d == null ? 'Pro trial' : `Pro trial · ${d} day${d === 1 ? '' : 's'} left`;
  }
  if (tier === 'expired') return 'Trial ended · read-only';
  return 'Individual';
}

export function tierColor(tier, role) {
  if (tier === 'enterprise' && role === 'manager') return '#c0a040';
  if (tier === 'enterprise') return '#40a0c0';
  if (tier === 'pro') return '#7060e0';
  if (tier === 'trial') return '#e0a030';
  if (tier === 'expired') return '#b04a4a';
  return '#4a7a9a';
}

// ─── FETCH USER PROFILE FROM LAMBDA ──────────────────────────────────────────
// Returns { tier, role, orgId, projectGrants } from DynamoDB via API Gateway.
// Falls back to JWT-only tier if the Lambda call fails.
export async function fetchUserProfile() {
  try {
    const { body } = await get({
      apiName: 'quantApi',
      path: '/user/profile',
    }).response;
    return await body.json();
  } catch {
    return null;
  }
}
