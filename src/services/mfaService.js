// ─── MFA (TOTP) ───────────────────────────────────────────────────────────────
// Thin wrapper over Amplify's auth APIs. Errors propagate to the caller — the UI
// needs to tell "wrong code" from "network down", so nothing is swallowed here
// (same posture as agentService.js, unlike userService.js which degrades).
//
// The pool is configured MFA OPTIONAL with TOTP only. Nothing forces enrolment:
// a user who never opts in is unaffected anywhere in the app.
import {
  setUpTOTP, verifyTOTPSetup, updateMFAPreference, fetchMFAPreference,
} from 'aws-amplify/auth';

// What an authenticator app shows as the account label.
const ISSUER = 'SiteSeeing Quant';

/** True if this account currently has an authenticator app registered. */
export async function isTotpEnabled() {
  const { enabled } = await fetchMFAPreference();
  // `enabled` is undefined when the user has never set up any factor.
  return Array.isArray(enabled) ? enabled.includes('TOTP') : false;
}

/**
 * Begin enrolment. Returns the secret plus the otpauth:// URI to render as a QR.
 * Nothing is active until verifyAndEnable() succeeds, so an abandoned setup
 * leaves the account exactly as it was.
 */
export async function beginTotpSetup(accountLabel) {
  const details = await setUpTOTP();
  return {
    sharedSecret: details.sharedSecret,               // for manual entry
    setupUri: details.getSetupUri(ISSUER, accountLabel).toString(),
  };
}

/**
 * Confirm the 6-digit code and make TOTP the preferred factor.
 * Throws if the code is wrong — Cognito rejects it, nothing is enabled.
 */
export async function verifyAndEnableTotp(code) {
  await verifyTOTPSetup({ code: String(code).trim() });
  await updateMFAPreference({ totp: 'PREFERRED' });
}

/**
 * Turn TOTP off. The user keeps access with their password alone, so this is a
 * deliberate downgrade and the UI should say so.
 */
export function disableTotp() {
  return updateMFAPreference({ totp: 'DISABLED' });
}
