import { get, post, put } from 'aws-amplify/api';

/**
 * Client for the Agentic Takeoff orchestrator (see AGENTIC-TAKEOFF-SPEC.md).
 *
 * The server owns all pipeline state; these are thin signed calls to the
 * `/agent/*` routes on quantApi. Every response is the run's public view:
 *   { runId, stageIndex, stageLabel, totalStages, status, seq, output,
 *     evidence, confidence, gate, ... }
 */

async function readJson(op) {
  const { body } = await op.response;
  return body.json();
}

/** Start a run for one sheet. Returns the run at stage 1, awaiting approval. */
export function startRun({ projectId, pageId, pricingRequested = false }) {
  return readJson(post({
    apiName: 'quantApi',
    path: '/agent/runs',
    options: { body: { projectId, pageId, pricingRequested } },
  }));
}

/** Fetch the current state of a run (used for polling). */
export function getRun(runId) {
  return readJson(get({ apiName: 'quantApi', path: `/agent/runs/${runId}` }));
}

/** Fetch the detections a run produced → { annotations, meta }. */
export function getDetections(runId) {
  return readJson(get({ apiName: 'quantApi', path: `/agent/runs/${runId}/detections` }));
}

/** Save the user's edited detections (Adjust) → { ok, count }. */
export function putDetections(runId, annotations) {
  return readJson(put({
    apiName: 'quantApi',
    path: `/agent/runs/${runId}/detections`,
    options: { body: { annotations } },
  }));
}

/** Approve the current stage → advance. `seq` is the last seq the client saw. */
export function approveStage(runId, seq) {
  return readJson(post({
    apiName: 'quantApi',
    path: `/agent/runs/${runId}/approve`,
    options: { body: { seq } },
  }));
}

/** Reject the current stage → terminate the run (P0). */
export function rejectStage(runId, seq) {
  return readJson(post({
    apiName: 'quantApi',
    path: `/agent/runs/${runId}/reject`,
    options: { body: { seq } },
  }));
}

/** Cancel the whole run. */
export function cancelRun(runId, seq) {
  return readJson(post({
    apiName: 'quantApi',
    path: `/agent/runs/${runId}/cancel`,
    options: { body: { seq } },
  }));
}

// Terminal statuses — the pipeline is over, no more actions.
export const TERMINAL = new Set(['done', 'rejected', 'cancelled', 'failed']);
