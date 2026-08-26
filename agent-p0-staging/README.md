# Agentic Takeoff — P0 backend setup

This folder stages the `agentOrchestrator` Lambda so it doesn't collide with
`amplify add function`'s scaffolding. Run the steps below, then copy the two
files into the generated function.

Frontend (service, panel, "✦ Run Agent" button) is already wired and builds —
it just needs these backend resources to exist.

---

## Step 1 — DynamoDB table `TakeoffRuns`

```
amplify add storage
```
Answer:
- Service: **NoSQL Database**
- Friendly name: **takeoffruns**
- Table name: **TakeoffRuns**
- Partition key: **runId** — type **string**
- No sort key
- No global secondary indexes (add "no")
- No Lambda trigger

> The friendly name **takeoffruns** matters: it produces the env var
> `STORAGE_TAKEOFFRUNS_NAME` the Lambda reads.

## Step 2 — Lambda `agentOrchestrator`

```
amplify add function
```
Answer:
- Function name: **agentOrchestrator**
- Runtime: **NodeJS**
- Template: **Hello World**
- Advanced settings: **Yes**
  - "Do you want to access other resources…": **Yes**
  - Select **storage** → check **takeoffruns** → grant **create, read, update, delete**
  - No scheduling, no layers, no secrets
- Edit the local function now?: **No**

## Step 3 — Drop in the real code

Replace the generated stub files with the two here:

```
cp agent-p0-staging/agentOrchestrator/index.js       amplify/backend/function/agentOrchestrator/src/index.js
cp agent-p0-staging/agentOrchestrator/package.json   amplify/backend/function/agentOrchestrator/src/package.json
( cd amplify/backend/function/agentOrchestrator/src && npm install )
```

## Step 4 — API route

The route is **already added** to `amplify/backend/api/quantApi/cli-inputs.json`
as the plain path `/agent` — Amplify auto-generates a greedy `/agent/{proxy+}`
child that catches every subpath (`/agent/runs`, `/agent/runs/{id}/approve`, …).
The API→function dependency is also registered in `backend-config.json`.

> Do **not** write `{proxy+}` yourself in the path — Amplify appends its own,
> and a manual one causes a double-greedy `/agent/{proxy+}/{proxy+}` error.

Nothing to do — `amplify push` picks it up.

## Step 5 — Push

```
amplify push
```

## Step 6 — Test

1. Open a project in the app → click **✦ Run Agent** (top-right).
2. You should see **Stage 1 / 9 · Understand sheet · AWAITING APPROVAL** with a
   stub output line and a confidence of 1.00.
3. Click **Approve →** eight times, watching the stage advance and the progress
   bar fill. The last click says **Approve & finish** → status **DONE**.
4. Try **Reject** / **Cancel run** on a fresh run → status **REJECTED** /
   **CANCELLED**.
5. In the DynamoDB console, the `TakeoffRuns` table shows the row advancing
   `stageIndex` / `seq` and ending in a terminal `status`.

That's the whole walking skeleton proven: server-authoritative run state +
checkpoint approve/reject loop, identity-scoped, with no models yet.

---

## What this proves (and what's next)

P0 has **no AI and no detection** — every stage is a stub. Next:

- **P1** — the big lift: server-side rasterize + tile + detect → cleanup →
  quantify, plus the lean metering/trial gate (3 free sheets).
- **P2** — Bedrock vision stages (understand sheet, calibrate scale w/ hard gate,
  classify/tag).

Once P0 is verified you can delete this `agent-p0-staging/` folder — the code
lives in `amplify/backend/function/agentOrchestrator/` from then on.
