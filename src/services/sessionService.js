import { post } from 'aws-amplify/api';

// LocalStorage key for the per-device session id. Lives in this single file
// so nothing else has to know the key name.
const LS_KEY = 'quant.sessionId';

export function getLocalSessionId() {
  try { return localStorage.getItem(LS_KEY) || null; } catch { return null; }
}

export function setLocalSessionId(id) {
  try { localStorage.setItem(LS_KEY, id); } catch { /* private mode etc. */ }
}

export function clearLocalSession() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

function deviceLabel() {
  if (typeof navigator === 'undefined') return '';
  // First 120 chars of the UA — enough to identify a device without being noisy.
  return (navigator.userAgent || '').slice(0, 120);
}

function newSessionId() {
  // crypto.randomUUID is available in all modern browsers; fall back to a
  // best-effort random string for the rare ancient environment.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Claim this device as the user's active session. Always overwrites any
 * existing row server-side, so a fresh login on a new device kicks the
 * previous one out within the next heartbeat cycle.
 *
 * Returns the new sessionId (already persisted to localStorage).
 */
export async function claimSession() {
  const sessionId = newSessionId();
  setLocalSessionId(sessionId);
  await post({
    apiName: 'quantApi',
    path: '/session/claim',
    options: { body: { sessionId, deviceLabel: deviceLabel() } },
  }).response;
  return sessionId;
}

/**
 * Ask the server whether our local sessionId is still the active one for
 * this user. Returns { valid: boolean, reason?: string }.
 *
 * Throws on network/5xx errors — callers should treat that as "unknown" and
 * NOT sign the user out.
 */
export async function checkSession() {
  const sessionId = getLocalSessionId();
  if (!sessionId) return { valid: false, reason: 'no-local' };
  const { body } = await post({
    apiName: 'quantApi',
    path: '/session/heartbeat',
    options: { body: { sessionId } },
  }).response;
  return body.json();
}
