import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRun, getRun, getQuota, getDetections, putDetections, putScale,
  approveStage, rejectStage, cancelRun, TERMINAL,
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
 *   onAdjust(annotations)   — promote detections into editable annotations now
 *   getAgentDetections()    — current full annotation set (for save-back)
 */
const POLL_MS = 1500;

export default function AgentRunPanel({
  projectId, pageId, onClose, onPreview, onApply, onAdjust, getAgentDetections,
  scaleCal,   // the editor's real Scale-Calibration state + handlers (both options)
}) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);        // an action is in flight
  const [adjusting, setAdjusting] = useState(false); // editing this stage's output
  const [collapsed, setCollapsed] = useState(false); // minimized to free the screen
  // Draggable position — starts centered on screen.
  const [pos, setPos] = useState(() => {
    if (typeof window === 'undefined') return { x: 400, y: 120 };
    return {
      x: Math.max(12, (window.innerWidth - 380) / 2),
      y: Math.max(12, Math.min(window.innerHeight * 0.5 - 220, window.innerHeight - 260)),
    };
  });
  const [detCount, setDetCount] = useState(null); // # of proposed detections loaded
  const [quota, setQuota] = useState(null);       // { used, limit, remaining } free trial
  const [exhausted, setExhausted] = useState(false); // trial used up — can't start
  const pollRef = useRef(null);
  const detRef = useRef(null);       // latest fetched detections
  const detKeyRef = useRef(null);    // which detectionsKey we last fetched
  const appliedRef = useRef(false);  // detections now live in the editor (adjust or finish)
  // Callbacks come from the parent with fresh identity each render; hold them in
  // refs so our effects don't re-fire (and wipe the overlay) on every render.
  const onPreviewRef = useRef(onPreview); onPreviewRef.current = onPreview;
  const onAdjustRef = useRef(onAdjust); onAdjustRef.current = onAdjust;
  const getDetRef = useRef(getAgentDetections); getDetRef.current = getAgentDetections;
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
        if (cancelled) return;
        setRun(r);
        if (r.quota) setQuota(r.quota);
      } catch (e) {
        if (cancelled) return;
        // A start can fail because the free trial is used up (402). Check the
        // quota to tell that apart from a real error and show the right message.
        try {
          const q = await getQuota();
          if (!cancelled && q && q.remaining <= 0) { setQuota(q); setExhausted(true); return; }
        } catch { /* fall through to generic error */ }
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

  // Fetch detections whenever the run's detectionsKey changes (detect writes it,
  // then cleanup repoints it to the cleaned set) and refresh the canvas overlay.
  useEffect(() => {
    if (!run?.detectionsKey || run.detectionsKey === detKeyRef.current) return;
    const key = run.detectionsKey;
    let cancelled = false;
    (async () => {
      try {
        const { annotations } = await getDetections(run.runId);
        if (cancelled) return;
        detKeyRef.current = key;
        detRef.current = annotations || [];
        setDetCount(detRef.current.length);
        // If the user already adjusted (detections live in the editor), don't
        // re-show the overlay — that would double up with the real annotations.
        if (!appliedRef.current) onPreviewRef.current?.(detRef.current);
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

  // Adjust: enter edit mode. For Detect, promote detections into editable
  // annotations; for Calibrate scale, just open the scale editor.
  const startAdjust = useCallback(() => {
    if (!run || busy) return;
    if (run.stageKey === 'detect') {
      onAdjustRef.current?.(detRef.current || []);
      appliedRef.current = true;    // in the editor now; don't re-merge on finish
    }
    setAdjusting(true);
  }, [run, busy]);

  // Save & continue: persist this stage's edit, then approve → next stage.
  const saveAndContinue = useCallback(async () => {
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (run.stageKey === 'calibrate_scale') {
        const ratio = scaleCal?.ratio;
        if (!ratio || !(ratio > 0)) {
          setError('Set a scale first — enter a 1:XXX ratio, or measure a known length, then it appears below.');
          setBusy(false); return;
        }
        await putScale(run.runId, ratio);
      } else {
        const anns = getDetRef.current ? getDetRef.current() : [];
        const res = await putDetections(run.runId, anns);
        if (res?.detectionsKey) detKeyRef.current = res.detectionsKey; // don't re-fetch our own edit
      }
      const r = await approveStage(run.runId, run.seq);
      setRun(r);
      setAdjusting(false);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }, [run, busy, scaleCal]);

  // Drag the panel by its header. Clamped so it can't be lost off-screen.
  const startDrag = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const orig = { ...pos };
    const width = collapsed ? 260 : 380;
    const move = (ev) => {
      const nx = Math.max(-width + 80, Math.min(window.innerWidth - 80, orig.x + ev.clientX - startX));
      const ny = Math.max(0, Math.min(window.innerHeight - 44, orig.y + ev.clientY - startY));
      setPos({ x: nx, y: ny });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [pos, collapsed]);

  const isTerminal = run && TERMINAL.has(run.status);
  const canAct = run && run.status === 'awaiting_approval' && !busy;
  // Hard-gate: the run is parked until the user supplies a scale.
  const needsScale = run && run.status === 'needs_input' && run.stageKey === 'calibrate_scale';

  return (
    // Backdrop does NOT close on click — an accidental outside click must not
    // abandon a run mid-flow. Close only via the ✕ button.
    <div style={styles.overlay}>
      <div style={{ ...styles.modal, width: collapsed ? 260 : 380, left: pos.x, top: pos.y }}>
        {/* header — drag handle */}
        <div style={styles.header} onMouseDown={startDrag}>
          <span style={styles.eyebrow}>
            <span style={styles.tick} /> {collapsed && run ? `${run.stageLabel}` : 'AGENT · FULL TAKEOFF'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            {run && collapsed && <StatusPill status={run.status} />}
            <button onClick={() => setCollapsed(c => !c)} style={styles.close} title={collapsed ? 'Expand' : 'Collapse'}>
              {collapsed ? '▢' : '—'}
            </button>
            <button onClick={onClose} style={styles.close} title="Close">✕</button>
          </div>
        </div>

        {/* collapsed: one-line bar + the primary action, so editing has the whole
            screen but you can still advance without expanding */}
        {run && collapsed && canAct && (
          <div style={{ ...styles.actions, marginTop: 10 }}>
            {adjusting
              ? <button onClick={saveAndContinue} style={styles.approve} disabled={busy}>{busy ? 'Saving…' : 'Save & continue →'}</button>
              : <button onClick={() => act(approveStage)} style={styles.approve} disabled={busy}>
                  {run.stageIndex >= run.totalStages - 1 ? 'Approve & finish' : 'Approve →'}
                </button>}
          </div>
        )}

        {/* trial used up — no run to show */}
        {exhausted && !collapsed && (
          <div style={styles.trialBox}>
            <div style={styles.trialTitle}>✦ Free trial used up</div>
            <div style={styles.trialBody}>
              You've used all {quota?.limit ?? 3} free agent sheets. Upgrade to keep running
              full takeoffs.
            </div>
            <div style={styles.actions}>
              <button onClick={onClose} style={styles.approve}>Got it</button>
            </div>
          </div>
        )}

        {!run && !error && !exhausted && !collapsed && <div style={styles.dim}>Starting run…</div>}
        {error && !collapsed && <div style={styles.error}>⚠ {error}</div>}

        {/* free-trial meter — shown after a run starts */}
        {quota && !exhausted && !collapsed && (
          <div style={styles.quotaLine}>
            ✦ {quota.remaining} of {quota.limit} free sheet{quota.limit === 1 ? '' : 's'} left
          </div>
        )}

        {run && !collapsed && (
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
              </div>
              {detCount != null && !adjusting && run.stageKey === 'detect' && (
                <div style={styles.previewNote}>
                  ◈ {detCount} shown on the canvas — proposed. Approve to keep, or Adjust to edit.
                </div>
              )}
            </div>

            {/* actions — normal review */}
            {canAct && !adjusting && (
              <div style={styles.actions}>
                {(run.stageKey === 'detect' && detRef.current) || run.stageKey === 'calibrate_scale'
                  ? <button onClick={startAdjust} style={styles.reject} disabled={busy}>Adjust</button>
                  : <button onClick={() => act(rejectStage)} style={styles.reject} disabled={busy}>Reject</button>}
                <button onClick={() => act(cancelRun)} style={styles.cancel} disabled={busy}>Cancel run</button>
                <button onClick={() => act(approveStage)} style={styles.approve} disabled={busy}>
                  {run.stageIndex >= run.totalStages - 1 ? 'Approve & finish' : 'Approve →'}
                </button>
              </div>
            )}

            {/* actions — adjusting DETECT: detections are live in the editor */}
            {canAct && adjusting && run.stageKey === 'detect' && (
              <>
                <div style={styles.adjustNote}>
                  ✎ Editing on the canvas — add / move / delete / reclass with the normal
                  tools. Your whole page becomes the takeoff.
                </div>
                <div style={styles.actions}>
                  <button onClick={() => act(cancelRun)} style={styles.cancel} disabled={busy}>Cancel run</button>
                  <button onClick={saveAndContinue} style={styles.approve} disabled={busy}>
                    {busy ? 'Saving…' : 'Save & continue →'}
                  </button>
                </div>
              </>
            )}

            {/* actions — adjusting SCALE: same two options as the right panel */}
            {((canAct && adjusting && run.stageKey === 'calibrate_scale') || needsScale) && scaleCal && (
              <>
                {needsScale && (
                  <div style={{ ...styles.adjustNote, background: 'var(--err-bg)', borderColor: 'var(--err-bd)', color: 'var(--err-tx)' }}>
                    ⚠ Scale required — this drawing has no readable scale and none is set.
                    Set it to continue (the pipeline can't produce real quantities without it).
                  </div>
                )}
                {/* Option A — stated drawing scale */}
                <div style={styles.scaleHead}>Enter the drawing's stated scale (title block)</div>
                <div style={{ ...styles.row, marginBottom: 8 }}>
                  <span style={styles.scaleLbl}>1&nbsp;:</span>
                  <input
                    value={scaleCal.drawingScaleDenom}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) scaleCal.setDrawingScaleDenom(v); }}
                    placeholder="100"
                    style={{ ...styles.scaleInput, maxWidth: 90 }}
                  />
                  <button onClick={scaleCal.applyDrawingScale} style={styles.smallGhost}>Set from scale</button>
                </div>

                <div style={styles.scaleOr}>
                  <span style={styles.scaleRule} /> or measure <span style={styles.scaleRule} />
                </div>

                {/* Option B — measure a known length */}
                <div style={styles.scaleHead}>Draw a line with <b>Scale Cal.</b>, then enter its real length</div>
                <div style={{ ...styles.row, marginBottom: 8 }}>
                  <input
                    value={scaleCal.realLength}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) scaleCal.setRealLength(v); }}
                    style={{ ...styles.scaleInput, maxWidth: 56 }}
                  />
                  <span style={styles.scaleLbl}>m&nbsp;=</span>
                  <input
                    value={scaleCal.pixelLength}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) scaleCal.setPixelLength(v); }}
                    style={{ ...styles.scaleInput, maxWidth: 56 }}
                  />
                  <span style={styles.scaleLbl}>px</span>
                  <button onClick={scaleCal.calculateRatio} style={styles.smallGhost}>Set scale</button>
                </div>

                {scaleCal.ratio != null
                  ? <div style={styles.scaleCurrent}>✓ Scale 1 : {scaleCal.denom}</div>
                  : <div style={styles.scaleNone}>No scale set yet</div>}

                <div style={styles.actions}>
                  <button onClick={() => act(cancelRun)} style={styles.cancel} disabled={busy}>Cancel run</button>
                  <button onClick={saveAndContinue} style={styles.approve} disabled={busy || scaleCal.ratio == null}>
                    {busy ? 'Saving…' : 'Save scale & continue →'}
                  </button>
                </div>
              </>
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
    needs_input:       { t: 'SCALE REQUIRED',    c: 'var(--err-tx)' },
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
  // Light non-blocking scrim + panel pinned to the top-LEFT (over the canvas) so
  // the right inspector — CLASSES, EDIT SELECTED (reclass), layers, tags — stays
  // fully usable while adjusting. Backdrop never captures clicks; only ✕ closes.
  overlay: { position: 'fixed', inset: 0, background: 'transparent', zIndex: 9500, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', padding: '64px 0 0 18px', pointerEvents: 'none' },
  modal: { position: 'fixed', width: 380, maxWidth: '92vw', maxHeight: '82vh', overflowY: 'auto', background: 'var(--bg-modal)', border: '1px solid var(--bd-panel)', borderRadius: 10, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', fontFamily: 'var(--font-ui)', pointerEvents: 'auto' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, cursor: 'grab', userSelect: 'none' },
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
  adjustNote: { marginBottom: 10, padding: 10, background: 'var(--amber-soft)', border: '1px solid var(--amber-bd)', borderRadius: 6, fontSize: 12, color: 'var(--tx-body)', lineHeight: 1.5 },
  quotaLine: { marginTop: 8, fontSize: 11, color: 'var(--tx-dim)', letterSpacing: 0.2 },
  trialBox: { marginTop: 12, padding: 14, background: 'var(--bg-badge)', border: '1px solid var(--bd-panel)', borderRadius: 8 },
  trialTitle: { fontSize: 14, fontWeight: 700, color: 'var(--tx-body)', marginBottom: 6 },
  trialBody: { fontSize: 12, color: 'var(--tx-dim)', lineHeight: 1.5, marginBottom: 12 },
  scaleHead: { fontSize: 11, color: 'var(--tx-faint)', marginBottom: 5 },
  scaleLbl: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--tx-label)', whiteSpace: 'nowrap' },
  scaleInput: { flex: 1, minWidth: 44, background: 'var(--bg-input)', border: '1px solid var(--bd-input)', borderRadius: 5, color: 'var(--tx-body)', fontFamily: 'var(--font-mono)', fontSize: 12, padding: '6px 8px' },
  smallGhost: { background: 'var(--bg-btn)', border: '1px solid var(--bd-btn)', borderRadius: 5, color: 'var(--tx-btn)', fontSize: 11, padding: '6px 10px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 },
  scaleOr: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px', color: 'var(--tx-faint)', fontSize: 10 },
  scaleRule: { flex: 1, height: 1, background: 'var(--bd-divider)' },
  scaleCurrent: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ok-tx)', marginBottom: 10 },
  scaleNone: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--tx-faint)', marginBottom: 10 },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  approve: { marginLeft: 'auto', background: 'var(--amber)', color: 'var(--on-amber)', border: '1px solid var(--amber)', borderRadius: 6, padding: '8px 14px', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  reject: { background: 'transparent', color: 'var(--err-tx)', border: '1px solid var(--err-bd)', borderRadius: 6, padding: '8px 12px', cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  cancel: { background: 'transparent', color: 'var(--tx-faint)', border: '1px solid var(--bd-btn2)', borderRadius: 6, padding: '8px 12px', cursor: 'pointer', fontFamily: 'var(--font-ui)' },
  terminal: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, color: 'var(--tx-body)', fontSize: 13 },
  dim: { color: 'var(--tx-faint)', fontSize: 13, padding: '8px 0' },
  error: { color: 'var(--err-tx)', fontSize: 12, marginBottom: 10 },
};
