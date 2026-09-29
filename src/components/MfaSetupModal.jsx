import { useState, useRef, useEffect, useCallback } from "react";
import QRCode from "qrcode";
import { isTotpEnabled, beginTotpSetup, verifyAndEnableTotp, disableTotp } from "../services/mfaService";
import "../pages/ProjectsPage.css";

// Two-factor authentication settings. Follows NewProjectModal's conventions
// (.modal-* classes, autofocus, Escape to close) rather than inventing a dialog.
//
// `qrcode` is already in the tree as a dependency of @aws-amplify/ui-react, so
// rendering the QR adds nothing to the bundle.
export default function MfaSetupModal({ accountLabel, onClose }) {
  const [phase, setPhase] = useState("loading"); // loading | off | setup | on
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const codeRef = useRef(null);

  useEffect(() => {
    let alive = true;
    isTotpEnabled()
      .then((on) => { if (alive) setPhase(on ? "on" : "off"); })
      .catch(() => { if (alive) { setPhase("off"); setError("Couldn't read your current security settings."); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => { if (phase === "setup") codeRef.current?.focus(); }, [phase]);

  const startSetup = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const { sharedSecret, setupUri } = await beginTotpSetup(accountLabel);
      setSecret(sharedSecret);
      setQrDataUrl(await QRCode.toDataURL(setupUri, { margin: 1, width: 200 }));
      setPhase("setup");
    } catch (err) {
      setError(err?.message || "Couldn't start setup. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [accountLabel]);

  const confirm = useCallback(async () => {
    if (!/^\d{6}$/.test(code.trim())) { setError("Enter the 6-digit code from your app."); return; }
    setBusy(true); setError("");
    try {
      await verifyAndEnableTotp(code);
      setPhase("on"); setCode(""); setQrDataUrl(""); setSecret("");
    } catch (err) {
      // Cognito rejects a wrong code, so nothing was enabled — the user can retry.
      setError(err?.name === "EnableSoftwareTokenMFAException" || err?.name === "CodeMismatchException"
        ? "That code didn't match. Codes change every 30 seconds — try the current one."
        : (err?.message || "Couldn't verify that code."));
    } finally {
      setBusy(false);
    }
  }, [code]);

  const turnOff = useCallback(async () => {
    if (!window.confirm("Turn off two-factor authentication? Your account will be protected by your password alone.")) return;
    setBusy(true); setError("");
    try { await disableTotp(); setPhase("off"); }
    catch (err) { setError(err?.message || "Couldn't turn it off."); }
    finally { setBusy(false); }
  }, []);

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2 className="modal-title">Two-Factor Authentication</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          {phase === "loading" && <p className="modal-hint">Checking your settings…</p>}

          {phase === "off" && (
            <>
              <p className="modal-hint">
                Add a second step when signing in, using an authenticator app such as
                Google Authenticator, 1Password or Authy. Your password alone will no
                longer be enough for someone to reach your account.
              </p>
              {/* Stated BEFORE they commit, not after: Cognito has no backup codes
                  and no self-service reset, so a lost device means contacting us. */}
              <p className="mfa-warn">
                Use an app that backs up or syncs your codes, and keep the setup key we
                show you next. Without either, losing your phone means contacting us to
                reset it — and resetting your password will not get you back in.
              </p>
            </>
          )}

          {phase === "setup" && (
            <>
              <p className="modal-hint">1. Scan this with your authenticator app.</p>
              {qrDataUrl && <img className="mfa-qr" src={qrDataUrl} alt="Two-factor setup QR code" />}
              <p className="modal-hint">
                Can't scan? Enter this key manually:
                <code className="mfa-secret">{secret}</code>
              </p>
              {/* The cheapest recovery by far. Someone who saves this key can
                  restore access on any device without contacting support, which
                  is the difference between a self-service fix and an email
                  exchange plus an operator running an MFA reset. */}
              <p className="mfa-warn">
                Save this key somewhere safe, such as a password manager. If you lose your
                phone, it is the only way to restore access yourself — otherwise you'll
                need to contact us to reset it.
              </p>
              <label className="modal-label" htmlFor="mfa-code">2. Enter the 6-digit code it shows</label>
              <input
                id="mfa-code" ref={codeRef} className="modal-input" type="text"
                inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                placeholder="000000" value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
              />
            </>
          )}

          {phase === "on" && (
            <p className="mfa-ok">
              ✓ Two-factor authentication is on. You'll be asked for a code from your
              authenticator app each time you sign in.
            </p>
          )}

          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-footer">
          <button className="pp-btn-ghost" onClick={onClose}>Close</button>
          {phase === "off" && (
            <button className="pp-btn-primary" onClick={startSetup} disabled={busy}>
              {busy ? "Starting…" : "Set up"}
            </button>
          )}
          {phase === "setup" && (
            <button className="pp-btn-primary" onClick={confirm} disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Verify & enable"}
            </button>
          )}
          {phase === "on" && (
            <button className="pp-btn-ghost mfa-danger" onClick={turnOff} disabled={busy}>
              {busy ? "…" : "Turn off"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
