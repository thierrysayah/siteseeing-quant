# Agentic Takeoff — Product Spec (v1)

**Status:** Scope approved. Architecture drafted (Part II) — pending 3 decisions.
**Owner:** Thierry
**Last updated:** 2026-08-12

> This doc is in two parts. **Part I (§1–10)** is the product spec (the *what*).
> **Part II (§11+)** is the architecture (the *how*) for a fully
> **server-orchestrated** implementation.

---

## 1. One-line definition

Add an **Agentic layer** on top of the existing takeoff SaaS: instead of the
QS manually driving each tool, they delegate a goal — *"do the takeoff of this
drawing"* — and an agent runs the full pipeline across the platform's existing
tools, **pausing at every stage for the QS to approve, edit, or reject**.

The agent is an **orchestrator + a few intelligent stages**, not a monolithic
"AI". Most stages are the deterministic tools the platform already has; the
LLM/VLM is used only where perception, reasoning, or writing is required.

---

## 2. Who it's for

- **Primary user:** the platform's own **QS / estimators** (internal
  productivity), not their end clients. This sets a high accuracy/trust bar —
  the agent is a *fast junior that shows its work*, not an unattended oracle.
- **Availability:** usable on **all tiers** (Individual → Enterprise). Only the
  *pricing* stage is Enterprise-gated (see §4). Whether it's bundled from day
  one or sold as a separate upgrade is an open commercial question (§9) — the
  technical design must support either.

---

## 3. The pipeline (v1)

Nine stages. Each is either a **[tool]** (deterministic, already exists or is a
thin wrapper) or **[VLM]/[LLM]** (needs a model). Every stage ends in a
**checkpoint** (§5).

| # | Stage | Type | What it does |
|---|-------|------|--------------|
| 1 | Understand sheet | **[VLM]** | Classify sheet type (electrical/plumbing/structural), read the title block (project, drawing no., revision). Routes which detection models to run. |
| 2 | Calibrate scale | **[VLM]** | Read the scale bar / "1:100" note → derive px→m. **Hard-stops for human input if unreadable** (§6). |
| 1 | Understand sheet | **[VLM]** | Classify sheet type (electrical/plumbing/structural), read the title block (project, drawing no., revision). Routes which detection models to run. |
| 2 | Calibrate scale | **[VLM]** | Read the scale bar / "1:100" note → derive px→m. **Hard-stops for human input if unreadable** (§6). |
| 3 | **Detect & clean** | **[tool]** | Run detection (`/infer`: wall / zone / zoneseg), then immediately **trim zone overhangs** (the app's algorithm): remove the part of a zone poking into a neighbour so areas aren't double-counted, delete duplicate zones, **leave ambiguous pairs alone** (offender chosen from vertex-containment + compactness; never guessed), and **flag** (keep) low-confidence items. The user reviews/edits this cleaned set (Adjust). One step — detect and cleanup were merged. |
| 4 | Classify & tag | **[VLM]** | Map detections to classes/zone tags using the drawing legend + schedules. |
| 5 | Quantify | **[tool]** | Compute counts, lengths, areas, perimeters — real units from the project scale, else pixel-based. |
| 6 | QA pass | **[VLM/LLM]** | Second-pass review: flag misses/hallucinations, overlapping/double-counted zones, obvious gaps. Advisory — surfaces issues, doesn't silently fix. **Must read the detections JSON as a required input** (the full annotation set from Detect & clean), so it can adjudicate the genuinely *ambiguous* overlap pairs the deterministic trim leaves alone, and cross-check against the drawing. |
| 7 | **Price** *(optional)* | **[tool]** | Multiply quantities × rate card → costed estimate. **Enterprise-only, and only if the rate library is populated AND the user opts in.** Otherwise ends at quantities only. |
| 8 | Report | **[LLM]** | Draft the takeoff/estimate narrative: summary, inclusions, exclusions, assumptions. Pulls Stage 7 pricing if present, else quantities only. |

**8 stages** (detect+clean merged). Intelligence is concentrated in stages
1, 2, 4, 6, 8; stages 3, 5, 7 are deterministic tools.

---

## 4. Output branches (tiering)

The pipeline has **two terminal outputs**, chosen by tier + configuration:

- **Quantity takeoff** (default, **all tiers**): stages 1–7 + 9. Output is a
  verified quantity takeoff + narrative report.
- **Priced estimate** (**Enterprise only**): adds Stage 8. Requires **both**:
  1. the org's **rate library is populated**, and
  2. the user **opts in** to pricing for this run.
  If either is missing, the run silently ends at quantities (no error, no
  half-priced output).

**Consequence — the rate library is NOT a v1 blocker.** v1 ships as
"drawing → verified quantities → report" for everyone. Pricing (Stage 8 + the
rate-library data model) is an **additive Enterprise track** built in parallel
or immediately after, not a prerequisite for launch.

---

## 5. Autonomy model — per-stage checkpoints

The defining product decision. v1 is **supervised / propose-and-approve**:

- After each stage the agent presents its result with **evidence + confidence**.
- The QS chooses: **Approve** → next stage · **Edit** → hand-correct, then
  continue · **Reject** → discard this stage's output.
- Each stage has an **auto / pause** toggle, so an experienced user can let
  trusted stages run through and only gate the risky ones. Same engine serves
  both "hand-hold me" and "mostly hands-off" users.

**Rejection behaviour (v1, deliberately small):** on reject/edit, the user
**hand-edits** using the normal editor tools, then resumes the pipeline from the
next stage. The agent does **not** yet retry a stage from natural-language
feedback ("no, those are windows") — that's a fast-follow (§8), not v1.

---

## 6. Guardrails (first-class requirements, not afterthoughts)

Because this is a **measurement product with professional liability**:

- **Never fabricate a quantity.** Every number traces to a detection or an
  explicit user input.
- **Cite evidence.** "This 42 m² is zones #7, #12, #33 on page 2."
- **Surface confidence and self-uncertainty.** The agent says when it's unsure.
- **Mandatory human gate on scale (Stage 2).** If the scale bar is unreadable,
  the agent **hard-stops and asks** — it never guesses px→m, since every
  downstream quantity depends on it.
- **Tenant isolation.** No cross-project / cross-org data leakage (builds on the
  existing tier/org model).
- **Untrusted input.** Uploaded drawings/specs are treated as untrusted
  (prompt-injection surface); their extracted text never triggers tool calls
  without validation.
- **Non-destructive by default.** The agent never mutates the user's existing
  annotations, and never silently deletes or merges. Cleanup (§3.4) works only on
  the run's fresh detections, does **not** auto-merge distinct zones, flags
  rather than deletes low-confidence items, and every change is a reviewable diff
  applied as a single undo step on approval.

---

## 7. Metering & quotas

- **Billable unit: per sheet/page processed** — *not* per project/run. A 20-page
  PDF costs ~20× a 1-page one in VLM + inference; metering per run would blow
  margins on large drawing sets.
- **Per-tier quotas** on pages/month; overage consumes credits.
- Quota is checked **before** a run starts and decremented per page as the
  pipeline advances. Ties into the outstanding rate-limiting / `/infer` quota
  work (Security Audit C2).

---

## 7a. Free trial

Because every sheet costs real compute (VLM + detection), the trial is a
**bounded bucket of work, not a window of time** — a time-based "free for N days"
would be unbounded cost.

- **Grant: 3 free sheets per account**, one-time (tunable).
- **Full-quality pipeline**, quantities-only (pricing is Enterprise-gated
  anyway). Users experience the real thing — that's what converts.
- **No hard expiry** to start (a soft 30-day clock is a later conversion lever).
- **On exhaustion:** upsell — "You've used your 3 free sheets; upgrade / buy
  pages to continue." UI shows remaining trial sheets.

**It's just a bucket in the quota table**, drawn down before the paid bucket —
not a separate system (see §19).

**Implementation (P1d, shipped).** Metered **per run started**, enforced
**server-side** in the orchestrator's `createRun`: one atomic conditional `ADD`
on a sentinel row `runId = "quota#<cognito-sub>"` in the existing `takeoffruns`
table (no new AWS resource). The condition
`attribute_not_exists(freeSheetsUsed) OR freeSheetsUsed < freeSheetsLimit` means
two near-simultaneous starts can't both claim the last sheet. On exhaustion the
start returns **402 `trial_exhausted`** and the panel shows the "used up" upsell;
otherwise the 201 carries `quota:{used,limit,remaining}` and the panel shows
**"N of M free sheets left"**. `GET /agent/quota` returns the same for a pre-run
display. Limit is `FREE_SHEETS_LIMIT` (env, default 3). No auto-refund on
failed/cancelled runs yet — a later refinement.

**Abuse gate.** Free + real per-sheet cost invites multi-account farming. A
*card-required* trial is the strongest defence, but there is **no payment
integration yet** (billing will be **Amazon Payment Services**, added later), so
we do **not** require a card now.

**Decision — no card for now.** The trial ships gated on **a verified email
(already required by Cognito at signup) + one grant per account + trial
concurrency cap (one run at a time) + per-upload page cap**. These bound cost and
most farming without any payment infra. A card-required option can be added later
alongside the Amazon Payment Services integration if abuse proves material.

---

## 8. Explicitly out of scope for v1 (fast-follows)

- **Chat agent** — conversational "do X" interface. Comes *after* the staged
  pipeline is shipped and trusted.
- **Agent-resume-from-feedback** — retrying a stage from NL correction instead
  of manual edit.
- **LLM-judged cleanup** (Stage 4 reasoning beyond thresholds).
- **Spec/RFI/completeness-vs-spec (RAG over uploaded specs).**
- **Revision-delta analysis** (compare Rev B vs Rev C).
- **Autonomous / unattended** end-to-end runs.

---

## 9. Open questions (commercial / product, not blocking the build)

1. **Packaging:** bundled into all tiers from launch, or a separate paid
   "Agent" upgrade? Design must support both; decision can come later.
2. **Rate-library data model** (Enterprise pricing) — its own mini-spec when we
   pick up Stage 8.
3. **Quota defaults** per tier (pages/month) — set with pricing.

---

## 10. Success criteria for v1

- A QS can take a single-sheet PDF from upload to a **verified quantity takeoff +
  report** via the staged agent, approving/editing at each checkpoint, in
  materially less time than doing it manually.
- Zero fabricated quantities; every figure is traceable.
- Scale is never silently guessed.
- Usage is metered per page and enforced per tier.

---

## Appendix A — Decision log

| Decision | Choice |
|---|---|
| Primary user | QS / estimators (internal productivity) |
| First capability | Full takeoff (not QA-only, not report-only) |
| Autonomy | Per-stage checkpoints; per-stage auto/pause; both hand-hold and hands-off from one engine |
| Pricing stage | Enterprise-only, optional, requires populated rate library + opt-in |
| Rate library | Not a v1 blocker; quantities is the universal output |
| Rejection loop (v1) | Hand-edit then resume; agent-resume-from-feedback deferred |
| Checkpoint = canvas review | Each stage's output renders on the canvas as a **proposed overlay** (non-destructive); merged into the project only on finish |
| "Adjust" replaces "Reject" | The action button is **Adjust**, opening a per-stage editable window for that stage's output before approving. **Detect ✅** (edit on canvas → push back) and **Calibrate scale ✅** (draw a known length with Scale Cal., or type m/px → push back) are done. **Quantities are NOT directly editable** — all quantities derive from the drawing (detections × scale), so you adjust the detections or the scale and they recompute; a manual quantities override would break traceability. |
| Scale failure | Mandatory human gate (hard-stop, never guess) |
| Billable unit | Per sheet/page processed |
| Quotas | Per-tier |
| Chat agent | Deferred to fast-follow |
| Orchestration | **Fully server-orchestrated** (client never calls models) |
| Free trial | **3 free sheets/account**, one-time, full quality, no expiry |
| Trial abuse gate | **No card.** Verified email (Cognito) + 1 grant/account + 1 concurrent run + per-upload cap |
| Billing provider | **Amazon Payment Services** (added later; not Stripe) |
| Metering timing | Gate moves to **P1** (first real cost), not P4 |
| Cleaning order | **Simplify (RDP) → NMS → trim overhangs, iterated to convergence.** Simplifying first disambiguates offender-detection. A single trim pass misses cascading overlaps (a pair's resolution can depend on a neighbour only clipped at pass end) — so trim runs **iteratively (≤6 passes) until no change**. This is why manual "Run trim" pressed twice fixed cases the agent's single pass missed (e.g. #5→#14). Deterministic, **no LLM**. |
| Ambiguous pairs | The deterministic trim leaves genuinely ambiguous overlap pairs alone (never guesses). Those are adjudicated by the **QA stage (LLM)**, which **must read the detections JSON** as a required input. |
| Cost model | **Pay-per-use, zero idle.** Bedrock **on-demand only** (no Provisioned Throughput), Lambda/DynamoDB on-demand (no provisioned concurrency/capacity), detection billed per call. Do **not** enable any hourly/provisioned option. Est. AI ~$0.05–0.20/sheet (mixed models). |

---

# PART II — Architecture (the How)

## 11. Guiding principle

**The server is authoritative.** The browser renders stages and sends
approvals; it never calls a model, never computes a billable quantity it can
forge, and never sees a model key. Every guardrail in §6 and every quota in §7
is enforced server-side because that's the only place the client can't bypass.

## 12. Topology

```
┌─────────┐   HTTPS/SigV4   ┌──────────────────┐
│ Browser │ ───────────────▶│  API Gateway     │  (quantApi, IAM auth)
│ (React) │ ◀───────────────│  /agent/*        │
└─────────┘   poll status   └────────┬─────────┘
     ▲  render stage output          │ invoke
     │  + evidence/confidence         ▼
     │                        ┌───────────────┐   async invoke   ┌────────────────┐
     │                        │ orchestrator  │ ───────────────▶ │  stageWorker   │
     │                        │   Lambda      │                  │   Lambda       │
     │                        │ (validate,    │                  │ runs ONE stage │
     │                        │  quota, state)│                  └───────┬────────┘
     │                        └───────┬───────┘                          │
     │                                │ read/write                       │ calls
     │                                ▼                                   ▼
     │                     ┌──────────────────┐        ┌──────────────────────────────┐
     │                     │ DynamoDB          │        │ Tools & models (server-side) │
     └──────── GET ────────│  TakeoffRuns      │        │  • detect  → existing /infer │
                           │  UsageQuotas      │        │  • quantify/cleanup (module) │
                           └──────────────────┘        │  • VLM/LLM → Bedrock          │
                                    ▲                    │  • price → rate library       │
                        S3: page rasters, detection      └──────────────────────────────┘
                        JSON, stage artifacts, overlays
```

## 13. Orchestration engine — Lambda + DynamoDB state (not Step Functions, for v1)

Because **every stage stops for a human**, the pipeline is driven by user
actions, not auto-chaining. So we don't need Step Functions' chaining — a
**run-state row in DynamoDB advanced by API calls** is simpler and stays fully
inside the current Amplify/Lambda/DynamoDB toolset.

- `orchestrator` Lambda: validates identity + quota, reads/writes run state,
  async-invokes the right `stageWorker`, enforces gating rules.
- `stageWorker` Lambda: runs exactly **one** stage, writes its output +
  evidence + confidence to DDB/S3, sets the next status. One stage per
  invocation keeps every stage well under the 15-min Lambda limit.

> **Upgrade path:** if stages later auto-chain (autonomous mode, complex
> retries, audit-trail needs), migrate to **Step Functions `waitForTaskToken`**
> — its callback pattern is built for human-approval flows. Not needed for v1.

## 14. Run-state model (DynamoDB `TakeoffRuns`)

One row per **sheet** (matches the per-page billing unit; multi-sheet PDFs =
several runs grouped by an optional `batchId`).

| Field | Notes |
|---|---|
| `runId` (PK) | uuid |
| `userId`, `orgId` | **derived from SigV4 identity**, never client-supplied |
| `projectId`, `pageId`, `batchId?` | source sheet |
| `tier` | snapshot at run start |
| `stage` | current stage index (1–9) |
| `status` | `running` \| `awaiting_approval` \| `needs_input` \| `done` \| `failed` \| `cancelled` |
| `seq` | monotonic counter — optimistic-concurrency guard against double-advance/double-charge |
| `pricingRequested` | bool (opt-in) |
| `stageOutputs` | small results inline; large blobs (detections, overlays) as **S3 keys** (DDB 400 KB item limit) |
| `evidence`, `confidence` | per stage, for the "show your work" guardrail |
| `pagesCharged` | metering |
| `createdAt`, `updatedAt` | |

Large artifacts (page raster, detection JSON, QA overlay) live in **S3** under
the run; DDB stores pointers.

## 15. Stage handler contract

Every stage — deterministic or model-backed — implements the same interface, so
the orchestrator treats them uniformly:

```
runStage(ctx, stageInput) -> {
  output,                 // the stage result (annotations, scale, report, …)
  evidence,               // what it's based on (detection ids, crop refs, …)
  confidence,             // 0–1
  gate: 'approve' | 'needs_input' | 'auto',   // 'needs_input' = hard human gate
  artifacts?: [{ s3Key }] // overlays, rasters
}
```

- `gate: 'needs_input'` is how **Stage 2 (scale)** hard-stops (§6): if the scale
  bar is unreadable it returns `needs_input`, the run parks in `needs_input`
  status, and the client must `POST /input` before it can proceed.
- Model-backed stages call **Bedrock/tools inside the worker** — there is no
  public `/vlm` route, so the client can't invoke models directly.

## 16. API surface (`/agent/*`, private/IAM auth)

| Route | Does |
|---|---|
| `POST /agent/runs` | Start a run. Checks quota, creates state, async-runs Stage 1. Returns `runId`. |
| `GET  /agent/runs/{id}` | Poll: current stage, status, output, evidence, confidence. |
| `POST /agent/runs/{id}/approve` | Approve current stage → advance (async-runs next). |
| `POST /agent/runs/{id}/edit` | Commit hand-edited stage output (from the normal editor) → advance. |
| `POST /agent/runs/{id}/reject` | Discard stage output; stop or await manual redo. |
| `POST /agent/runs/{id}/input` | Provide required input (e.g. the scale value) → clears `needs_input`. |
| `POST /agent/runs/{id}/cancel` | Abort. |

**Async + poll:** API Gateway caps at 29 s, and detection/VLM can exceed that.
So `approve`/`start` return immediately (`202`, status `running`) and the client
polls `GET` until `awaiting_approval` / `needs_input`. (Push via AppSync
subscription is a later optimization; poll is fine for v1.)

**Concurrency:** every advance is a DDB conditional write on the expected
`{stage, status, seq}` — a double-clicked Approve or duplicate request is a
no-op, so no stage runs (or bills) twice.

## 17. Stage 3 detection — server-side (the "big lift" that mostly evaporated)

**Key finding:** the app **already renders every page to a PNG and stores it in
S3** (`projectStorage.js` → `page-{slug}.png`), and detection on a *saved*
project already runs on that stored PNG. So **no server-side PDF rasterization is
needed** — no pdfium/MuPDF/canvas, no container Lambda. The stage worker:

1. **Fetches the existing `page-{slug}.png` from S3** — the exact image the user
   sees and that detection runs on today, so agent detections == manual
   detections.
2. **Tiles it** (reuse the existing tile size / overlap / NMS constants, ported
   to a shared module) using **`jimp`** — pure-JS image crop, **no native binary**,
   which avoids a whole class of Lambda-deploy pain (sharp's linux-binary gotcha).
   Sharp is a later optimization if tiling is too slow.
3. **Calls the detection model per tile** by reusing `inferProxy`'s forwarding
   logic (Secrets Manager token → Cloud Run model URLs) as a shared module.
4. Writes the merged detections to **S3**, pointer in DDB.

**Secure S3 access:** the worker derives `sub` (+ `orgId` from Cognito) from its
own IAM identity and lists the project's own prefix to find the page PNG — it
never trusts a client-supplied S3 key (tenant isolation).

Net: Stage 3 is **fetch + tile + infer**, all lightweight. The feared
rasterization lift is gone.

## 18. Models — Amazon Bedrock (CONFIRMED)

**Decision: Amazon Bedrock, in eu-west-3.** IAM auth (no API key to manage,
nothing to leak/rotate), data stays in-account and in-region.

**Region check — done.** eu-west-3 (Paris) offers vision-capable models across
vendors, so there is **no cross-region need and no API-key fallback required**:
- **Anthropic Claude** — Opus / Sonnet / Haiku (incl. current gens)
- **Amazon Nova** — Lite / Pro
- **Mistral Pixtral Large**

**Model choice is per-stage config, not hardcoded.** The stage handler contract
(§15) lets each stage name its own model id, so we tune cost vs. quality without
code changes. Rough strategy (final tuning during build):

| Stage need | Lean | Candidate |
|---|---|---|
| Cheap/bulk perception (understand sheet, tag) | cost | Nova Lite / Claude Haiku |
| Accuracy-critical (scale read, QA) | quality | Claude Sonnet / Nova Pro / Pixtral |
| Report writing (text only) | cost | any capable text model |

Because billing is per page (§7), defaulting the light stages to a cheap model
and reserving the strong model for the accuracy-critical stages directly
protects margin.

## 19. Metering & quota enforcement

- `UsageQuotas` DDB table, one row per account:
  `{ accountId (PK), period (SK=YYYY-MM), trialLimit, trialUsed, paidLimit, paidUsed }`.
- `POST /agent/runs` runs a **conditional decrement** before creating the run,
  drawing from the **trial bucket first, then the paid bucket** — over-quota is
  rejected atomically, server-side. The free trial (§7a) is exactly this trial
  bucket; no separate system.
- `paidLimit` derived from tier (defaults TBD, §9); `trialLimit = 3`, granted
  once per account. Ties into Security-Audit C2 and the API-Gateway throttling item.
- **Trial abuse controls:** one grant per verified account, **one concurrent
  trial run**, and a **per-upload page cap** so a single trial upload can't burn
  the whole grant on a huge set.

## 20. New backend resources (Amplify)

| Resource | Type |
|---|---|
| `TakeoffRuns` | DynamoDB (`amplify add storage`) |
| `UsageQuotas` | DynamoDB |
| `agentOrchestrator` | Lambda (`amplify add function`) + `/agent/*` on quantApi |
| `agentStageWorker` | Lambda (async-invoked; Bedrock + S3 + DDB + `/infer` access) |
| Bedrock IAM policy | custom policy on the worker's execution role |
| Shared module | rasterize/tile/NMS (ported from client), quantify, evidence helpers |

## 21. Build order (walking skeleton first)

- **P0 — skeleton:** `TakeoffRuns` + orchestrator + `/agent/*` + client checkpoint
  shell, with a single stub stage. Proves the state machine + approve loop end-to-end.
- **P1 — deterministic spine:** server-side **rasterize+tile+detect** (§17) →
  cleanup → quantify. Ships "one click → verified quantities" with checkpoints,
  **no model yet**. Genuinely useful on its own.
- **P2 — perception:** VLM stages — understand-sheet, **calibrate-scale (with the
  hard gate)**, classify/tag.
- **P3 — reason + write:** QA pass + report.
- **P4 — metering:** `UsageQuotas` + per-tier enforcement (before any wider rollout).
- **P5 — Enterprise pricing:** rate-library data model + Stage 8.

## 22. Decisions — RESOLVED

1. **Models:** ✅ **Amazon Bedrock** in eu-west-3 (vision models confirmed
   available; model-agnostic, per-stage config).
2. **Run granularity:** ✅ **One run per sheet**, grouped by `batchId`.
3. **Progress delivery:** ✅ **Poll first**; push (AppSync) is a later,
   no-redesign upgrade.

---

# PART III — Build Plan

Walking-skeleton first: prove the machine with no AI, then add capability in
thin vertical slices. Each phase is independently shippable/testable.

### P0 — Walking skeleton (no models, no real stages)
**Goal:** prove the server-orchestrated state machine + checkpoint approve loop.
- **DynamoDB `TakeoffRuns`** (`amplify add storage`), PK `runId`.
- **`agentOrchestrator` Lambda** (`amplify add function`) + routes on quantApi
  (private/IAM): `POST /agent/runs`, `GET /agent/runs/{id}`,
  `POST /agent/runs/{id}/approve|reject|cancel`.
  - Derives `userId`/`orgId` from SigV4 identity (reuse `getCallerSub`).
  - Runs a **stub stage** (`{output:"stub", confidence:1, gate:"approve"}`) and
    advances `stage` on approve; conditional writes on `{stage,status,seq}`.
- **Client:** a "Run agent" button + a checkpoint panel (current stage, status,
  output, Approve/Reject) that **polls** `GET` every ~1.5 s.
- **Done when:** click Run → stages advance one-by-one on approval → run reaches
  `done`. Pure orchestration, zero AI.

### P1 — Deterministic spine + metering gate
- **`agentStageWorker` Lambda** (async-invoked) so stages can exceed 29 s.
- **Detect (§17, no rasterization):** fetch the existing `page-{slug}.png` from
  S3, tile with **jimp** (pure-JS, no native binary), call the detection model
  via a shared module reusing `inferProxy`'s forwarding.
- Stages **detect(3) → cleanup(4) → quantify(6)**; artifacts to S3, pointers in DDB.
- Sub-slices to minimize amplify round-trips: **(P1a)** worker + async plumbing
  (orchestrator async-invokes it; stub stage) ✅ → **(P1b)** real detect ✅ →
  **(P1b.2)** ✅ show detections on the canvas (proposed dashed overlay) +
  merge-on-finish — `GET /agent/runs/{id}/detections` (orchestrator S3 read)
  feeds the panel, which renders them non-destructively; prerequisite for
  "Adjust" →
  **(P1c)** cleanup + quantify → **(P1d)** metering/trial gate.
- **Metering gate lands here, not P4.** The moment the agent does real,
  cost-incurring work it must sit behind the quota gate — a "free trial" is an
  *enforced* limit. Ship a lean `UsageQuotas` with the **trial bucket (3 sheets)**
  + abuse controls (one grant/account, one concurrent run, per-upload cap). Paid
  buckets/tiers fill in at P4; the gate exists from first cost.
- **Ships:** one click → verified quantities with checkpoints, **trial-gated**,
  all tiers, no AI.

### P2 — Perception (Bedrock vision)
- Bedrock IAM policy on the worker role; `InvokeModel` via `bedrock-runtime`.
- Stages **understand-sheet(1)**, **calibrate-scale(2)** with the hard
  `needs_input` gate + `POST /agent/runs/{id}/input`, **classify/tag(5)**.

### P3 — Reason + write
- **QA(7)** (advisory flags) + **report(9)** (narrative).

### P4 — Paid buckets + billing
- Extend the P1 quota table with **paid page-buckets per tier**; wire the upgrade
  / buy-pages flow via **Amazon Payment Services**. Optionally add a
  card-required trial (§7a) at this point. (Closes Security-Audit C2 for this path.)

### P5 — Enterprise pricing
- Rate-library data model + **price(8)** stage, gated to Enterprise + populated
  library + opt-in.
