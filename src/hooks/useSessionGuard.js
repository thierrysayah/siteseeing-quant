import { useEffect, useRef, useState } from 'react';
import {
  claimSession,
  checkSession,
  clearLocalSession,
  getLocalSessionId,
} from '../services/sessionService';

// 30s is the worst-case kick-out latency. Tab refocus triggers an extra check
// for instant feedback when the user comes back to the tab.
const HEARTBEAT_MS = 30_000;

// localStorage key used by sessionService — duplicated here only so the
// cross-tab `storage` event listener can match on it without importing a
// constant (keeping sessionService's surface minimal).
const LS_KEY = 'quant.sessionId';

/**
 * useSessionGuard
 *
 * Lifecycle hook that enforces single-session: when this user signs in
 * elsewhere, the local app signs out automatically within ~30s.
 *
 * Pass the Cognito user + signOut callback from useAuthenticator(). Returns
 * { forcedOut, dismiss } so the host component can render a modal explaining
 * the forced sign-out.
 */
export function useSessionGuard(user, signOut) {
  const [forcedOut, setForcedOut] = useState(false);
  // Tracks which user we've already claimed for so React StrictMode's
  // double-mount in dev doesn't trigger two POST /session/claim calls.
  const claimedFor = useRef(null);

  useEffect(() => {
    if (!user) {
      claimedFor.current = null;
      clearLocalSession();
      return undefined;
    }
    const uid = user.userId || user.username;

    let cancelled = false;
    let interval = null;
    let onVis = null;

    const tick = async () => {
      if (cancelled || !getLocalSessionId()) return;
      try {
        const res = await checkSession();
        if (cancelled) return;
        if (res && res.valid === false) {
          setForcedOut(true);
          clearLocalSession();
          try { await signOut(); } catch { /* may throw if already signed out */ }
        }
      } catch {
        // Network/5xx — do NOT sign out. Try again next tick.
      }
    };

    // Cross-tab propagation: if another tab clears `quant.sessionId` (because
    // it was forced out by a remote device, or the user clicked Sign Out
    // there), every other open tab of the same browser should follow. The
    // `storage` event only fires in tabs OTHER than the one that wrote, which
    // is exactly the semantics we want.
    const onStorage = (e) => {
      if (e.key !== LS_KEY) return;
      if (e.newValue == null) {
        // Sibling tab cleared the session. Sign out here too. Don't surface
        // the "another device" modal — this is a same-browser sign-out, not
        // a remote kick.
        try { signOut(); } catch { /* ignore */ }
      }
    };
    window.addEventListener('storage', onStorage);

    const startPolling = () => {
      if (cancelled) return;
      interval = setInterval(tick, HEARTBEAT_MS);
      onVis = () => {
        if (document.visibilityState === 'visible') tick();
      };
      document.addEventListener('visibilitychange', onVis);
    };

    const init = async () => {
      if (claimedFor.current === uid) {
        // Already claimed for this user during a previous effect run (e.g.
        // React StrictMode double-mount) — heartbeat alone is enough.
        startPolling();
        return;
      }
      claimedFor.current = uid;
      // Wait for claim to land server-side BEFORE starting the heartbeat. If
      // we polled too early (a tab-blur within the first ~200ms could
      // trigger onVis instantly), the row wouldn't exist yet and the server
      // would report `valid:false reason:missing`, falsely signing the user
      // out the moment they logged in.
      try {
        await claimSession();
      } catch {
        // Claim failed (server down, transient network). Don't start the
        // heartbeat — that would force-signout the user on the first tick
        // because no row exists yet. Session enforcement is effectively off
        // for this load; the next page reload retries claim.
        return;
      }
      startPolling();
    };

    init();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (onVis) document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('storage', onStorage);
    };
  }, [user, signOut]);

  return { forcedOut, dismiss: () => setForcedOut(false) };
}
