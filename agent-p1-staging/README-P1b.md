# Agentic Takeoff — P1b setup (real detect stage)

P1b implements the **detect** stage for real: the worker fetches the page PNG
from S3, tiles it with jimp, calls your 3 detection models (reusing inferProxy's
Secrets-Manager token + Cloud Run URLs), runs NMS, and writes the detections to
S3 with a summary at the checkpoint. Other stages stay stubs.

The `agentStageWorker` function already exists (from P1a). This slice **updates
its code + adds IAM permissions + bumps timeout/memory**. No new function, no API
change.

Timeout/memory are already raised in
`amplify/backend/function/agentStageWorker/agentStageWorker-cloudformation-template.json`
(Timeout 300s, Memory 1024MB) — detection across many tiles needs it.

---

## Step 1 — Copy the updated worker in

```
# from repo root
cp    agent-p1-staging/agentStageWorker/index.js          amplify/backend/function/agentStageWorker/src/index.js
cp    agent-p1-staging/agentStageWorker/package.json      amplify/backend/function/agentStageWorker/src/package.json
mkdir -p amplify/backend/function/agentStageWorker/src/lib
cp    agent-p1-staging/agentStageWorker/lib/infer.js      amplify/backend/function/agentStageWorker/src/lib/infer.js
cp    agent-p1-staging/agentStageWorker/lib/pageimage.js  amplify/backend/function/agentStageWorker/src/lib/pageimage.js

# IAM custom policy goes at the FUNCTION ROOT (sibling of src/), not inside src/
cp    agent-p1-staging/agentStageWorker/custom-policies.json  amplify/backend/function/agentStageWorker/custom-policies.json

( cd amplify/backend/function/agentStageWorker/src && npm install )
```

`custom-policies.json` grants the worker: S3 get/put/list on
`estimation-platform-user-data`, Secrets Manager read on the model token, and
`cognito-idp:ListUsers` (to resolve the user's orgId for the S3 path).

## Step 2 — Push

```
amplify push
```
Expect `Function agentStageWorker Update`. (No API, no new resources.)

## Step 3 — Test from the app

Open a **single-page** project with a floor plan already loaded →
**✦ Run Agent** → approve stages 1–2 (still stubs) → at **stage 3 "Detect"** the
panel sits in **RUNNING** for a few seconds while it tiles + infers, then shows
e.g. *"Detected 328 objects — 179 zone, 76 Internal_Wall, 73 door, …"* with tile
counts in the evidence line. Approve onward through the remaining stubs.

> Multi-page: P1b picks the page PNG by matching the run's `pageId`; single-page
> projects always use the one page. Multi-page slug-matching is refined later.

## What it does / doesn't

- **Does:** produce detections server-side, identical pipeline to manual "Run
  Analysis" (same tile size/overlap/models/NMS), stored at
  `s3://estimation-platform-user-data/agent-runs/{runId}/detections.json`, key
  saved on the run (`detectionsKey`).
- **Doesn't yet:** apply detections to the project canvas (that's a later
  finish/apply step), cleanup (P1c), quantify (P1c), or any VLM (P2).

Next: **P1c** — cleanup (conservative, non-destructive dedupe) + quantify,
operating on `detectionsKey`.
