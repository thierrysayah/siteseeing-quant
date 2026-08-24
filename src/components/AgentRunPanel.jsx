import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRun, getRun, getDetections, approveStage, rejectStage, cancelRun, TERMINAL,
} from '../services/agentService';

/**
 * AgentRunPanel — the checkpoint UI for the Agentic Takeoff pipeline.
 *
 * P0: drives the server-orchestrated state machine through its stub stages.
 * The user watches each stage complete and Approves / Rejects / Cancels. When
 * a stage is `running` (real async stages arrive in P1) the panel polls until
 * it's back to awaiting_approval. All styling uses theme tokens so it follows
 * dark/blueprint automatically.
 *
 * Props:
 *   projectId, pageId
 *   onClose()               — close the panel (also clears any preview)
 *   onPreview(annotations)  — show/replace the proposed overlay on the canvas
 *   onApply(annotations)    — merge detections into the editor (on finish)
 */
const POLL_MS = 1500;

export default function AgentRunPanel({ projectId, pageId, onClose, onPreview, onApply }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);       // an action is in flight
  const [detCount, setDetCount] = useState(null); // # of proposed detections loaded
  const pollRef = useRef(null);
  const detRef = useRef(null);       // cached detections (fetched once)
  const appliedRef = useRef(false);  // guard so we merge only once
  // Callbacks come from the parent with fresh identity each render; hold them in
  // refs so our effects don't re-fire (and wipe the overlay) on every render.
  const onPreviewRef = useRef(onPreview); onPreviewRef.current = onPreview;
  const onApplyRef = useRef(onApply); onApplyRef.current = onApply;

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // Kick off the run once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await startRun({ projectId, pageId });
        if (!cancelled) setRun(r);
      } catch (e) {
        if (!cancelled) setError(friendly(e));
      }
    })();
    return () => { cancelled = true; stopPolling(); };
  }, [projectId, pageId]);

  // Poll only while a stage is actively running (P1+ async stages).
  useEffect(() => {
    if (run?.status === 'running' && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const r = await getRun(run.runId);
          setRun(r);
        } catch { /* transient — keep polling */ }
      }, POLL_MS);
    }
    if (run?.status !== 'running') stopPolling();
    return undefined;
  }, [run?.status, run?.runId]);

  // Once the run has detections, fetch them once and show as a canvas overlay.
  useEffect(() => {
    if (!run?.detectionsKey || detRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const { annotations } = await getDetections(run.runId);
        if (cancelled) return;
        detRef.current = annotations || [];
        setDetCount(detRef.current.length);
        onPreviewRef.current?.(detRef.current);
      } catch { /* leave it; user still sees the summary text */ }
    })();
    return () => { cancelled = true; };
  }, [run?.detectionsKey, run?.runId]);

  // On finish, merge the detections into the editor (once).
  useEffect(() => {
    if (run?.status === 'done' && detRef.current && !appliedRef.current) {
      appliedRef.current = true;
      onApplyRef.current?.(detRef.current);
    }
  }, [run?.status]);

  // Clear the preview overlay only on true unmount, unless we already merged the
  // detections into the editor (then they're real annotations).
  useEffect(() => () => {
    if (!appliedRef.current) onPreviewRef.current?.(null);
  }, []);

  const act = useCallback(async (fn) => {
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn(run.runId, run.seq);
      setRun(r);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }, [run, busy]);

  const isTerminal = run && TERMINAL.has(run.status);
  const canAct = run && run.status === 'awaiting_approval' && !busy;

  return (
    // Backdrop does NOT close on click — an accidental outside click must not
    // abandon a run mid-flow. Close only via the ✕ button.
    <div style={styles.overlay}>
      <div style={styles.modal}>
        {/* header */}
        <div style={styles.header}>
          <span style={styles.eyebrow}><span style={styles.tick} /> AGENT · FULL TAKEOFF</span>
          <button onClick={onClose} style={styles.close} title="Close">✕</button>
        </div>

        {!run && !error && <div style={styles.dim}>Starting run…</div>}
        {error && <div style={styles.error}>⚠ {error}</div>}

        {run && (
          <>
            {/* progress */}
            <div style={styles.progressRow}>
              <span style={styles.stageNum}>
                STAGE {Math.min(run.stageIndex + 1, run.totalStages)} / {run.totalStages}
              </span>
              <StatusPill status={run.status} />
            </div>
            <div style={styles.stageLabel}>{run.stageLabel}</div>

            {/* progress bar */}
            <div style={styles.barTrack}>
              <div style={{
                ...styles.barFill,
                width: `${((run.stageIndex + (isTerminal && run.status === 'done' ? 1 : 0)) / run.totalStages) * 100}%`,
              }} />
            </div>

            {/* stage output + evidence + confidence */}
            <div style={styles.card}>
              <div style={styles.output}>{run.output}</div>
              <div style={styles.metaRow}>
                <span style={styles.meta}>evidence: {run.evidence}</span>
                <span style={styles.conf}>conf {Number(run.confidence).toFixed(2)}</span>
              </div>
              {detCount != null && (
                <div style={styles.previewNote}>
                  ◈ {detCount} detections shown on the canvas
                  {run.status === 'done' ? ' — added to your project' : ' (proposed — approve to keep)'}
                </div>
              )}
            </div>

            {/* actions */}
            {canAct && (
              <div style={styles.actions}>
                <button onClick={() => act(rejectStage)} style={styles.reject} disabled={busy}>Reject</button>
                <button onClick={() => act(cancelRun)} style={styles.cancel} disabled={busy}>Cancel run</button>
                <button onClick={() => act(approveStage)} style={styles.approve} disabled={busy}>
                  {run.stageIndex >= run.totalStages - 1 ? 'Approve & finish' : 'Approve →'}
                </button>
              </div>
            )}

            {run.status === 'running' && <div style={styles.dim}>Working…</div>}

            {isTerminal && (
              <div style={styles.terminal}>
                <span>{terminalMessage(run.status)}</span>
                <button onClick={onClose} style={styles.approve}>Close</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    awaiting_approval: { t: 'AWAITING APPROVAL', c: 'var(--amber)' },
    running:           { t: 'RUNNING',           c: 'var(--accent2)' },
    done:              { t: 'DONE',               c: 'var(--ok-tx)' },
    rejected:          { t: 'REJECTED',           c: 'var(--err-tx)' },
    cancelled:         { t: 'CANCELLED',          c: 'var(--tx-faint)' },
    failed:            { t: 'FAILED',             c: 'var(--err-tx)' },
  };
  const s = map[status] || { t: status, c: 'var(--tx-faint)' };
  return <span style={{ ...styles.pill, color: s.c, borderColor: s.c }}>{s.t}</span>;
}

function terminalMessage(status) {
  if (status === 'done') return 'Takeoff complete.';
  if (status === 'rejected') return 'Stage rejected — run stopped.';
  if (status === 'cancelled') return 'Run cancelled.';
  return 'Run ended.';
}

function friendly(e) {
  const msg = e?.response?.body || e?.message || String(e);
  return typeof msg === 'string' ? msg : 'Something went wrong.';
}

const styles = {
  // Light scrim + panel pinned to the top-right so the drawing (and the proposed
  // overlay) stays visible while reviewing. Backdrop doesn't capture clicks
  // meant for closing — only the ✕ closes.
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.12)', zIndex: 9500, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: '64px 18px 0 0', pointerEvents: 'none' },
  modal: { width: 380, maxWidth: '92vw', background: 'var(--bg-modal)', border: '1px solid var(--bd-panel)', borderRadius: 10, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', fontFamily: 'var(--font-ui)', pointerEvents: 'auto' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  eyebrow: { fontFamily: 'var(--font-disp)', fontWeight: 600, fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--tx-status)', display: 'flex', alignItems: 'center', gap: 8 },
  tick: { width: 12, height: 2, background: 'var(--amber)', display: 'inline-block' },
  close: { background: 'transparent', border: 'none', color: 'var(--tx-faint)', cursor: 'pointer', fontSize: 14 },
  progressRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  stageNum: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--tx-label)', letterSpacing: '0.08em' },
  stageLabel: { fontSize: 18, fontWeight: 600, color: 'var(--tx-body)', marginBottom: 10 },
  pill: { fontFamily: 'var(--font-disp)', fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', border: '1px solid', borderRadius: 4, padding: '2px 7px' },
  barTrack: { height: 4, background: 'var(--bg-btn2)', borderRadius: 3, overflow: 'hidden', marginBottom: 14 },
  barFill: { height: '100%', background: 'var(--amber)', transition: 'width .2s' },
  card: { background: 'var(--bg-row)', border: '1px solid var(--bd-section)', borderRadius: 6, padding: 12, marginBottom: 14 },
  output: { fontSize: 13, color: 'var(--tx-body)', lineHeight: 1.5 },
  metaRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 10 },
  meta: { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--tx-faint)', lineHeight: 1.4 },
  conf: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent2)', whiteSpace: 'nowrap' },
  previewNote: { marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--bd-section)', fontSize: 12, color: 'var(--accent2)' },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  approve: { marginLeft: 'auto', background: 'var(--amber)', color: 'var(--on-amber)', border: '1px solid var(--amber)', borderRadius: 6, padding: '8px 14px', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  reject: { background: 'transparent', color: 'var(--err-tx)', border: '1px solid var(--err-bd)', borderRadius: 6, padding: '8px 12px', cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  cancel: { background: 'transparent', color: 'var(--tx-faint)', border: '1px solid var(--bd-btn2)', borderRadius: 6, padding: '8px 12px', cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  terminal: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, color: 'var(--tx-body)', fontSize: 13 },
  dim: { color: 'var(--tx-faint)', fontSize: 13, padding: '8px 0' },
  error: { color: 'var(--err-tx)', fontSize: 12, marginBottom: 10 },
};
