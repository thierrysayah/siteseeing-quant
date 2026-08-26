# Agentic Takeoff — P1a setup (async stage worker)

P1a introduces `agentStageWorker` and makes `agentOrchestrator` delegate each
stage to it **asynchronously** (so slow stages in P1b won't hit API Gateway's
29 s limit). Stages are still stubs — this slice only proves the async invoke +
poll loop end-to-end.

The orchestrator code is **already edited** in
`amplify/backend/function/agentOrchestrator/src/` (async invoke + client-lambda
dep installed). You only need to create the worker and grant the invoke
permission, then push.

---

## Step 1 — Create the worker function

```
amplify add function
```
- Function name: **agentStageWorker**
- Runtime: **NodeJS**
- Template: **Hello World**
- Advanced settings: **Yes**
  - Access other resources → **Yes** → **storage** → check **takeoffruns** →
    grant **create, read, update, delete**
  - No API, no scheduling, no layers, no secrets
- Edit now?: **No**

## Step 2 — Drop in the worker code

```
cp agent-p1-staging/agentStageWorker/index.js      amplify/backend/function/agentStageWorker/src/index.js
cp agent-p1-staging/agentStageWorker/package.json  amplify/backend/function/agentStageWorker/src/package.json
( cd amplify/backend/function/agentStageWorker/src && npm install )
```

## Step 3 — Let the orchestrator invoke the worker

```
amplify update function
```
- Select **agentOrchestrator**
- **Resource access permissions** (access other resources)
- Add the **function** category → check **agentStageWorker**
  - This grants `lambda:InvokeFunction` and injects the env var
    `FUNCTION_AGENTSTAGEWORKER_NAME` that the orchestrator reads.
- Finish (don't edit locally).

## Step 4 — Push

```
amplify push
```
Expect `Function agentStageWorker Create` + `Function agentOrchestrator Update`.
No API change this time (the worker is invoked Lambda→Lambda, not via API GW), so
none of the earlier `/agent` path drama applies.

## Step 5 — Test (same UX as P0, now async)

Open a project → **✦ Run Agent**. Behaviour is identical to P0 from the user's
side, but now each stage briefly shows **RUNNING** (the panel polls every 1.5 s)
before flipping to **AWAITING APPROVAL**. Approve through all 9 → **DONE**.

Because stages are instant stubs, "running" will flash by quickly — that's fine;
it proves the async path works. In P1b the detect stage will actually sit in
**running** for a few seconds while it tiles + infers.

---

## What changed vs P0

- `agentOrchestrator`: `createRun` / approve now set status **running** and
  **async-invoke** `agentStageWorker`, instead of computing the stub inline.
- `agentStageWorker` (new): runs one stage, guarded on `{status:'running',
  seq}` so duplicate/stale async invokes are no-ops, then flips to
  **awaiting_approval**.
- No frontend change — the panel already polls on `running`.

Next (P1b): replace the worker's `runStage` stub for the **detect** stage with
fetch-PNG-from-S3 → tile (jimp) → call model.
