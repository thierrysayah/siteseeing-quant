# Security Audit — SiteSeeing Quant

_Date: 2026-05-23. Audited against the codebase on branch `single-session-enforcement`._

## How to read this

- **Critical** — exploitable today by any signed-in user; causes financial loss, tier bypass, or cross-tenant data exposure. Fix this week.
- **High** — exploitable by a moderately motivated attacker; causes account compromise, IDOR, or business-model bypass. Fix this month.
- **Medium** — defense-in-depth; raises the bar but no clean exploit chain on its own. Fix before public launch.
- **Low** — hygiene / future-proofing.

Where I write *unverified*, it means the issue depends on something I can't see in the repo (your S3 imported-bucket IAM policy, your API Gateway throttle settings in the live deployment). You'll need to check those in the AWS console yourself.

A few findings the audit agents flagged as "Critical" (Cognito filter injection) are actually **Medium** — see the relevant entries for why. I'd rather call them honestly than have you panic-fix the wrong things first.

---

## CRITICAL

### C1. Free tier → Pro tier bypass at signup
- **STATUS: FIXED (2026-09-24).** `assignDefaultGroup` no longer reads `custom:plan`; every
  new account is placed in the `Trial` group and paid tiers are granted only by a
  payment-verified path. The sign-up page no longer sends the attribute at all.
- **File:** `amplify/backend/function/assignDefaultGroup/src/index.js:11–12`
- **Exploit:** The PostConfirmation Lambda reads `custom:plan` from the signup attributes and assigns the user to `Pro` if it equals `"pro"`, otherwise `Individual`. Cognito's SignUp API lets the client pass arbitrary user attributes; the Amplify React app sets `custom:plan` from `_planSel.current` (`src/App.js:127`), but a malicious client can send `custom:plan: "pro"` directly to Cognito and get the Pro group for free. No payment verification.
- **Impact:** Every gated Pro feature (DXF export, custom layers, 10-project quota) becomes free. Your entire pricing model is unenforced.
- **Fix:** Server-side: in `assignDefaultGroup`, ignore `custom:plan` entirely and always assign `Individual` on signup. Tier upgrades only happen through a payment-verified Lambda (Stripe webhook → assign to `Pro` group). Alternatively, write a "pending upgrade" record and reject `custom:plan` values that aren't `individual`.

### C2. `/infer` has no payload-size cap and no per-user quota
- **STATUS: FIXED (2026-09-26).** Two parts.
  1. *Size guard* at **9 MB** (not the suggested 5 MB): measured real payloads are ~350 KB per
     tile and ~1 MB for a whole A3 page, but the non-tiled path scales with sheet size, so a
     5 MB cap would have broken legitimate whole-page runs on A1/A0. API Gateway caps bodies
     at 10 MB regardless, so the guard sits just under it. Per-call cost is bounded by the
     `imgsz` clamp (M8).
  2. *Per-user quota* — **50 detection RUNS per user per UTC day, flat across all tiers.**
- **Quota design decisions (and why):**
  - **Runs, not calls.** A run is the unit users experience; the proxy only sees one tile, and
    an A3 run is ~18 calls (3 models x 6 tiles) while an A0 run is ~105. Metering calls would
    have made "50/day" mean two detections. The client therefore tags every call of one Detect
    press with the same `runId`.
  - **The run id comes from the client, so it is not trusted on its own.** Two backstops stop a
    single id being reused as an unbounded bucket: `INFER_PER_RUN_CALLS` (150 — above the
    largest legitimate run) and `INFER_DAILY_CALLS` (1500 — a whole-day ceiling; 50 A3 runs is
    ~900, so this has headroom, but a user working only on A0 sheets hits it before the run
    limit). Both are env vars. Ids are sanitised to `[A-Za-z0-9_-]{1,48}` before going near a
    document path; a call with no id is bucketed under `untagged`, which is forgiving for an
    older client mid-rollout and still bounded by the per-run cap.
  - **Daily, not monthly.** The date is part of the row key (`infer#<sub>#<YYYY-MM-DD>`), so
    the bucket resets itself — no cron, no reset job. A daily window also caps the blast
    radius of stolen credentials at one day's spend instead of one month's.
  - **One attribute, one write.** `runCalls` is a map of runId -> count, so `size(runCalls)` is
    the run count, `runCalls.<id>` the per-run count and `calls` the total. All three limits are
    therefore enforced by a SINGLE conditional write, which is what makes them atomic.
  - **Flat across tiers.** Tier resolution is 2 Cognito calls and a run is ~18 calls, so
    per-call tier lookups would add ~36 round-trips per analysis to the hot path. A flat limit
    needs no Cognito access in `inferProxy` at all.
  - **Refunds on upstream failure** (network error or 5xx), so users aren't billed for our
    outages. **Fails open** if DynamoDB is unavailable, logging `[inferQuota] counter
    unavailable` — an attacker can't induce that, so the outage is the bigger risk. That log
    line is worth a CloudWatch alarm.
  - Rows carry a 14-day `ttl`. **TTL is still DISABLED on `TakeoffRuns-dev`** — enabling it
    sweeps these automatically and touches nothing else, since only rows with the attribute
    are ever expired.
- **Verified against the live table:** each of the three limits denies with the correct reason
  and leaves the others untouched; refund restores exactly one call; and 8 concurrent *new*
  runs against a limit of 3 allowed exactly 3, confirming the conditional write is atomic. A
  run id of `x.y z/../evil` was stored as `xyzevil`.
- **Requires:** `amplify push` (new DynamoDB IAM in `custom-policies.json`, new
  `@aws-sdk/client-dynamodb` + `lib-dynamodb` deps, new `QUOTA_TABLE` / `INFER_DAILY_RUN_LIMIT`
  / `INFER_PER_RUN_CALLS` / `INFER_DAILY_CALLS` env vars) and a frontend redeploy — an
  un-redeployed client sends no `runId` and lands in the shared `untagged` bucket.

### C3. No API Gateway throttling on any route
- **STATUS: FIXED (2026-09-24).** Stage-wide backstop 25 rps / 50 burst, plus per-route
  limits (`/infer` 10/50, `/agent` 10/20, `/session/heartbeat` 20/50, `/session/claim` 5/20,
  `/user/profile` 10/20, `/org/grant-access` 5/10). NOTE: routes are declared `ANY`, and API
  Gateway method settings reject `ANY` and `*` as an http method — each route is therefore
  set per concrete verb (GET/POST/PUT/DELETE). **`amplify push` wipes stage method settings**,
  so re-run `./scripts/apply-api-throttling.sh` after every push.
- **File:** `amplify/backend/api/quantApi/**` (no `MethodSettings` configured)
- **Exploit:** Every route — `/infer`, `/session/heartbeat`, `/session/claim`, `/user/profile`, `/org/grant-access` — accepts unlimited RPS from any authenticated user. One user with a `while(true) fetch(...)` loop can drain your Lambda concurrency budget, hit DDB throttle limits, and rack up bills on every other route too.
- **Impact:** Service-wide DoS, plus AWS bill spikes. C2 covers the Ultralytics side; this covers the AWS side.
- **Fix:** Add `MethodSettings` per route via an Amplify CloudFormation override (see end of report for exact snippet). Targets:

  | Route | Rate (RPS) | Burst |
  |---|---|---|
  | `/infer` | 10 | 50 |
  | `/session/heartbeat` | 20 | 50 |
  | `/session/claim` | 5 | 20 |
  | `/user/profile` | 10 | 20 |
  | `/org/grant-access` | 5 | 10 |

  Sized assuming up to ~50 concurrent users. These are **per-stage totals**, not per-user — they prevent total catastrophe but don't enforce fairness. C2's per-user quota does the fairness layer.

### C4. Client-side tier checks are the only gate on Pro/Enterprise features
- **STATUS: IN PROGRESS (2026-09-28).** Code complete for steps 1-2; enforcement lands after a
  soak. See the rollout table below.
- **Scope correction - DXF cannot be enforced and the flag should be deleted.** `exportDXF()`
  (`src/DetectionTool.jsx:4183`) runs `dxf-writer` entirely in-browser with **zero network calls**
  (verified), over annotations the user may already read. No server can gate it; moving generation
  server-side would change nothing, since anyone who can read the annotations can re-implement a
  text serialisation. Per the tier table DXF is denied *only* to `individual` - the tier being
  removed - after which no tier is denied DXF at all. A flag that cannot be enforced is worse than
  no flag: it reads like a control.
- **Design: the control-file chokepoint.** `metadata.json` and `settings.json` go through a new
  `projectStore` Lambda; the browser's role gets an explicit `Deny` on those two filenames.
  A project exists iff its `metadata.json` exists (`listProjects` enumerates `*/metadata.json`),
  and custom classes live in **both** files - the editor reads them back from `settings.json`
  (`DetectionTool.jsx:1995`) - so a metadata-only gate would not have gated the feature.
  One chokepoint therefore enforces project cap + custom classes + read-only.
  Annotations and page PNGs stay on the direct-to-S3 path (they are large; gating them needs
  presigned URLs - deferred as Phase B).
- **Design: IAM resource split, not Cognito group roles.** Managers legitimately write
  `rate-card.json`/`manager-meta.json` under `org-{orgId}/{ownSub}/`, so splitting the org
  statement by resource closes manager-write **and** the any-member-can-overwrite-any-member hole
  at once - no new role, no identity-pool change, **no forced re-login**. Group roles were
  rejected: they change role resolution for every user (trial signups carry no group), need
  precedence + ambiguity config, duplicate the principal-tag setup, force a re-login, and still
  need the same carve-out written twice.
- **Rollout (order matters - step 4 breaks stale clients):**

  | # | Step | State |
  |---|---|---|
  | 0 | Allow-side org split (read/write separation) | **written + simulated, awaiting apply** |
  | 1 | `projectStore` Lambda + `/projects` route | code committed, needs `amplify push` |
  | 2 | Client calls the route | code committed, needs `amplify publish` |
  | 3 | Soak 24-72 h, watch `projectStore` 4xx/5xx | - |
  | 4 | Apply `DenyDirectControlFileWrites` - **the enforcing step** | `infra/authRole-s3-policy-step4-deny.json` |
  | 5 | Delete the `individual` tier and `canExportDXF` | - |

- **Verified so far:** handler logic 16/16 against stubbed AWS clients (read-only for expired and
  managers; cap at the boundary; cap *not* applied to updates; enterprise unlimited; path
  traversal; missing identity; sub absent from the pool; oversized body; bad method), plus
  assertions on what actually reaches S3 - a body claiming another `ownerSub` still writes under
  the caller's own prefix, classes stripped from both files with the rest of settings intact.
  IAM split simulated 11/11 (cross-member write/delete `implicitDeny`, manager rate-card still
  allowed, org reads preserved). Deny wildcard pre-verified to span `/`.
- **Deliberate behaviours worth knowing:** the cap applies to *creates* only, so a user over their
  limit can still save existing work; unentitled custom classes are **stripped, not rejected**,
  because rejecting would turn a feature gate into a total lockout for a lapsed user; and a
  Cognito outage degrades to `trial`, **not** `expired` - expired is read-only, so failing that
  way would stop every user saving.

The original finding follows. It is really C1's consequence, but the surface is wider than just the signup flow - listing each consumer because each needs a server-side fix.

| Feature | Frontend gate (bypassable) | Server-side gate |
|---|---|---|
| DXF export | `src/DetectionTool.jsx` — gated on `canExportDXF` | **None.** Anyone can call `exportDXF()` from the console. |
| Custom layers (classes) | `src/DetectionTool.jsx:4501` — gated on `canUseCustomClasses` | **None.** Custom classes are just JSON in the `metadata.json` written to S3; nothing rejects them at write time. |
| `maxProjects` quota | `src/pages/ProjectsPage.jsx:28` | **None.** `createProject` writes directly to S3 under the user's prefix; S3 doesn't count objects against a tier. |
| Manager read-only mode | `src/DetectionTool.jsx:1304` — `isReadOnly` disables UI | **None.** A manager can call `saveProject()` from the console and overwrite the project. |

- **Fix:** Each of these needs a server-side enforcement point. The cleanest path:
  - Introduce a `validateProjectWrite` Lambda invoked by an S3 `PUT` event (or as a pre-signed-URL minter Lambda the client must go through). It loads the metadata, checks the caller's tier from Cognito groups, and rejects DXF requests / custom-layer additions / over-quota creates / read-only saves.
  - Or: keep S3 direct writes for everything except the gated features, and route those through a Lambda (`/projects/export-dxf`, `/projects/create`) that verifies tier.

### C5. S3 bucket scope — VERIFIED, WAS WORSE THAN DESCRIBED
- **STATUS: FIXED (2026-09-24).** Verified with IAM policy simulation, and the real finding was
  worse than the worst case below: **`AmazonS3FullAccess` was ATTACHED to the auth role** —
  `s3:*` on `*`. Any signed-in user could read/overwrite/delete every object in all 16 buckets
  in the account (ML model weights, Amplify deployment buckets, unrelated projects), and had
  `s3:DeleteBucket` and `s3:PutBucketPolicy`. The inline policy separately granted the whole
  user-data bucket, so every tenant could read every other tenant's drawings.
- **Fix applied:** detached `AmazonS3FullAccess`; scoped the inline policy via Cognito principal
  tags (`sub`, `orgId` from `custom:orgId`) since the S3 paths use the user-pool sub, not the
  identity id that `${cognito-identity.amazonaws.com:sub}` provides; added `sts:TagSession` to
  the trust policy. Committed as `infra/authRole-s3-policy.json` + `infra/README-authRole.md`.
- **Remaining gap:** org access is org-wide, not per-`ProjectGrants`. Needs Lambda-mediated
  reads to close.
- **File:** `amplify/backend/storage/estimationplatform54fe8981/parameters.json` (imported bucket — IAM lives outside the repo)
- **Why this is here:** The bucket is `"serviceType": "imported"`, meaning IAM is whatever you manually attached to the Cognito Identity Pool's *authenticated role* in the AWS console. I can't see it from the codebase.
- **What to verify (in AWS console, IAM → Roles → `<auth-role>`):** Every `s3:*` action's `Resource` ARN must include `${cognito-identity.amazonaws.com:sub}` (for `private/users/*` paths) and `${aws:PrincipalTag/orgId}` or similar (for `private/organisations/org-*/*` paths).
- **Worst case if misconfigured:** User A's IAM policy resolves to `arn:aws:s3:::<bucket>/private/users/*` (no `${...:sub}` substitution) → A can `ListObjectsV2` over every user's prefix → A can `GetObject` on every file. That's a full cross-tenant breach.
- **Fix:** Confirm the policy looks like this, with the placeholder variable, not a literal `*`:
  ```json
  {
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
    "Resource": [
      "arn:aws:s3:::<bucket>/private/users/${cognito-identity.amazonaws.com:sub}/*"
    ]
  }
  ```
  The organisations path is trickier because IAM doesn't natively know about `custom:orgId`; you may need a Lambda-mediated read for cross-user-same-org access rather than direct S3 IAM.

---

### C6. `custom:orgId` was client-writable — cross-tenant S3 access (NOT IN THE ORIGINAL AUDIT)
- **STATUS: FIXED (2026-09-28).** Found while verifying the ground for C4.
- **What was wrong:** the web app client `4b8jv4b0k9dijjt3j10lm8lhds` (the one `aws-exports.js`
  ships to the browser) listed `custom:orgId` in its **`WriteAttributes`**, and the pool schema
  marks the attribute `Mutable: True`. `WriteAttributes` is exactly the set a *user* may change on
  themselves via Cognito's public `UpdateUserAttributes` API, using nothing but their own access
  token.
- **Why that mattered:** `custom:orgId` is mapped to `aws:PrincipalTag/orgId` by the identity
  pool's principal-tag map, and `infra/authRole-s3-policy.json` grants `GetObject`, `PutObject`
  and `DeleteObject` on `…/private/organisations/org-${aws:PrincipalTag/orgId}/*`. So the chain was:

      custom:orgId (user-writable) -> aws:PrincipalTag/orgId -> S3 read+write on that org's projects

  Any signed-in user could set their own `orgId` to another organisation's, re-login to refresh the
  tag, and read, overwrite or delete that org's entire project tree. Same shape as C1 — trusting a
  client-supplied attribute — but landing on cross-tenant data rather than billing tier.
- **Not visible in the repo.** `cli-inputs.json` declared `userpoolClientWriteAttributes: ["email"]`
  while the live client had four attributes: **drift**, most likely from when `custom:plan` was
  added for the old signup flow (the C1 vector), with `custom:orgId` alongside it. Reading the repo
  would have told you this was safe. It was not — the same lesson as C5.
- **Exposure at the time of the fix:** 2 users had an orgId set, both `org-acme-123` (test
  accounts), so there was effectively nothing behind it to steal. Fixed while that was still true.
- **Fix:** `WriteAttributes` reduced to `["email", "name"]` via `update-user-pool-client`.
  `custom:orgId` remains **readable** — the client needs it to build S3 paths — but only an admin
  API (e.g. a Lambda using `AdminUpdateUserAttributes`) can now set it.
- **Why the CLI, not `amplify push`:** the generated CloudFormation omits `WriteAttributes` and
  `ReadAttributes` on both `UserPoolClient` resources (verified), so CFN does not manage the field
  and the change is not reverted by a push. `cli-inputs.json` was updated to match reality anyway.
- **Verified:** the signup form sends only `email` and `name` (`src/App.js:83-89`), both still
  writable, and no code anywhere calls `updateUserAttributes` — so nothing legitimate regressed.
  Re-check with:
  `aws cognito-idp describe-user-pool-client --user-pool-id eu-west-3_jpxbGzhTX --client-id 4b8jv4b0k9dijjt3j10lm8lhds --region eu-west-3 --query 'UserPoolClient.WriteAttributes'`

---

## HIGH

### H1. IDOR — `GET /org/grant-access` leaks every project's manager list
- **STATUS: FIXED (2026-09-26).** The GET result is filtered to rows whose `ownerSub` matches
  the caller. Filtering rather than erroring means a non-owner cannot distinguish "not my
  project" from "no grants yet", so it is not an existence oracle either.
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:78–87`
- **Exploit:** The GET handler queries `ProjectGrants` by `projectId` only — no ownership check on the caller. Any authenticated user who knows or guesses a `projectId` (UUIDs are unguessable, but they leak through screenshots, support tickets, and the URL bar) can dump the full grants list: manager emails, names, ownerSub, orgId, grantedAt.
- **Impact:** Org-structure leak, manager email enumeration, PII.
- **Fix:** Same ownership check the POST/DELETE handlers already have:
  ```js
  if (callerSub !== ownerSub) return fail("Only the project owner can list grants");
  ```
  But ownerSub isn't passed on GET — either accept it as a query param and require it match `callerSub`, or load the project metadata first and verify ownership.

### H2. Email enumeration via `/org/grant-access` POST
- **STATUS: FIXED (2026-09-26).** All five lookup failure modes (malformed email, no such user,
  no sub, different org, not an EnterpriseManager) now return one identical message; the real
  reason is logged server-side. Per-endpoint rate limiting is covered by C3's throttle (5 rps).
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:120`
- **Exploit:** When granting access fails because the user doesn't exist, the response is `"No user found with email: <email>"`. An attacker can probe email addresses ("does jane@bigcorp.com exist?") and distinguish from "not in your org" and "doesn't exist" by error message. Combined with no rate limiting, they can enumerate your entire user base by email.
- **Fix:** Return a generic error: `"This user can't be granted access"` for *all* lookup failure modes (not found, wrong org, not a manager). Add per-user rate limit on POSTs to this endpoint (e.g. 10/min).

### H3. Source maps shipped in `build/`
- **STATUS: FIXED (2026-09-24).** Was **confirmed live**, not theoretical:
  `https://dev.d28h0kazpkiv4s.amplifyapp.com/static/js/main.*.js.map` returned HTTP 200 with
  the real source map. Fixed by `GENERATE_SOURCEMAP=false` in `.env.production` **and** as an
  Amplify app environment variable (belt and braces — the console build may not read the env
  file). Local rebuild verified: 0 `.map` files and 0 `sourceMappingURL` references.
  **The already-deployed maps stay live until the `dev` branch is redeployed.**
- **File:** `build/static/js/*.map` (verified — all chunks have `.map` files)
- **Exploit:** If you've ever deployed `build/` to production (`amplify publish` or any static host), the source maps are publicly downloadable. They reverse-compiled JS back to your original source: every helper function name, every comment, every internal API call pattern. An attacker uses them to find weaknesses fast.
- **Fix:** Set `GENERATE_SOURCEMAP=false` in `.env.production` (CRA convention) and rebuild. Verify by checking that `build/static/js/` has no `.map` files. Also: delete the existing `.map` files from any deployed host.
- **Severity caveat:** If you've never deployed (still localhost-only), this is currently Medium. Becomes High the moment you push to production.

### H4. Weak Cognito password policy
- **STATUS: FIXED IN CONFIG (2026-09-27) — takes effect on the next `amplify push`.**
  Minimum length stays at **8**, but all **4 character classes are now required** (upper,
  lower, number, symbol). Chosen over the suggested 12 + 3-of-4: Cognito has no "N of 4"
  setting, so 4-of-4 is the native way to express a composition rule, and 8 was kept to avoid
  friction on trial signups. `password` is no longer a valid password.
- **Changed in three places, which use three different spellings of the same enum:**
  - `auth/.../cli-inputs.json` — `["Requires Lowercase","Requires Numbers","Requires Symbols","Requires Uppercase"]` (source of truth; `amplify push` regenerates `build/` from it)
  - `auth/.../build/` template + `parameters.json` — renders to `RequireLowercase: true` etc.
  - `src/aws-exports.js` — `["REQUIRES_LOWERCASE", ...]` (different casing!). This one drives
    the Amplify UI hint and client-side check; leaving it stale means users get a bare Cognito
    rejection with no upfront guidance.
  Strings verified against a working 4-of-4 config in the sibling `invoke-yolo-api` project
  rather than guessed — the Amplify CLI ships packed, so its enums can't be grepped.
- **Caveat: this applies to NEW passwords only.** Existing accounts keep their 8-char
  lowercase passwords until they next reset, so landing it before trial signups is worth far
  more than after.
- **Verify after `amplify push`:** `aws cognito-idp describe-user-pool --user-pool-id
  eu-west-3_jpxbGzhTX --region eu-west-3 --query 'UserPool.Policies.PasswordPolicy'` should
  show all four `Require*` flags true.
- **File:** `amplify/backend/auth/estimationplatformece78c7f/cli-inputs.json:20–21`
- **Exploit:** `passwordPolicyMinLength: 8` + `passwordPolicyCharacters: []` allows `password` as a literal password. Credential-stuffing attackers love this — rainbow tables exist for all 8-char lowercase-only strings.
- **Fix:** Bump to `passwordPolicyMinLength: 12` and require at least 3 of: uppercase, lowercase, number, symbol. Run `amplify update auth` → "Walkthrough security configuration" → set the policy.

### H5. No MFA option
- **File:** `amplify/backend/auth/estimationplatformece78c7f/cli-inputs.json:11` — `mfaConfiguration: "OFF"`
- **Exploit:** Any account password compromise (phishing, reuse, the H4 weakness above) is a full account takeover. For Enterprise/Manager accounts, this is especially bad because they can view the org's projects.
- **Fix:** Set `mfaConfiguration: "OPTIONAL"` initially (let security-conscious users opt in), then `"ON"` once you have a recovery path defined. TOTP is the right method (`mfaTypes: ["TOTP"]`). At minimum, enforce MFA for the `EnterpriseManager` group.

### H6. 5 high/critical CVEs in npm dependencies
- **File:** Frontend `package.json` (transitive deps)
- **Exploit:** Most are dev-only or build-time, but `lodash` <=4.17.20 (CVE-2021-23337, code injection via `_.template`) is a runtime transitive of `@aws-amplify/ui-react`. Some Amplify packages also pull in vulnerable `node-forge` and `path-to-regexp` versions.
- **Fix:**
  ```
  npm audit fix
  npm audit fix --force   # only if needed; review breaking changes first
  ```
  For transitive deps that can't be auto-fixed, use `"overrides"` in `package.json` to pin a patched version.

### H7. Cognito tokens stored in localStorage
- **File:** Amplify default (`src/index.js:13` `Amplify.configure(awsExports)` — uses default storage)
- **Exploit:** Amplify defaults to localStorage for the idToken / accessToken / refreshToken. Any XSS vulnerability anywhere in the app (today or in the future) hands the attacker your auth tokens. They can be exfiltrated and used until expiry (and the 30-day refresh token means a long compromise window). I didn't find a live XSS vector in the current code, but the surface is large (project names, custom layer names, zone tags — anywhere user-supplied text reaches the DOM).
- **Fix:**
  - Short-term: keep localStorage but lock down the XSS surface (see H8). React's default JSX escaping protects most paths; audit any `dangerouslySetInnerHTML` usage and any PDF/DXF export that interpolates user strings.
  - Long-term: configure Amplify with `cookieStorage` (httpOnly + Secure + SameSite=Strict). This requires server-side cookie handling (CloudFront / Amplify Hosting cookie config).

### H8. User-supplied strings (project name, custom layer name, zone tag) flow into PDF/DXF exports
- **File:** Multiple sites in `src/DetectionTool.jsx` — anywhere `project.name`, `customClass.name`, `ann.zoneTag` is rendered or written to file.
- **Exploit:** React's JSX escaping is fine for screen rendering. But PDF/DXF/Excel exports don't go through JSX — they build strings directly. If a user names a project `<script>alert(1)</script>` or `=cmd|'/C calc'!A1`, the result depends on the export format:
  - HTML export → reflected XSS (if any).
  - Excel CSV → formula injection (Office runs `=...` cells, can exfiltrate via webhook).
  - DXF/PDF → mostly safe, but inspect.
- **Fix:** Sanitize user strings at the export boundary. For CSV/Excel: prefix `=`, `+`, `-`, `@`, `\t`, `\r` with a single quote (`'`). For HTML reports: ensure all values use textContent equivalent (React's escaping is automatic only for JSX, not for `dangerouslySetInnerHTML`). For project/class names at input time, restrict to `/^[\w\s\-.,()]{1,80}$/` (reject angle brackets, ampersands, equals signs as first char).

---

## MEDIUM

### M1. CORS `Access-Control-Allow-Origin: *` on every Lambda
- **File:** `inferProxy/src/index.js:38`, `sessionGuard/src/index.js:37`, `grantProjectAccess/src/index.js:14`, `getUserProfile/src/index.js` (similar)
- **Exploit:** Mitigated by SigV4 IAM auth (a malicious origin can't forge the user's signature without already having the IAM credentials), but it's a defense-in-depth concern. Browsers will let any site initiate cross-origin requests; only the IAM signing requirement stops them from succeeding.
- **Fix:** Replace `*` with the actual frontend origin(s):
  ```js
  const ALLOWED_ORIGINS = ['https://app.siteseeing.com', 'http://localhost:3000'];
  const origin = event.headers?.origin || event.headers?.Origin;
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  ```

### M2. `assignDefaultGroup` accepts `custom:plan` values it doesn't expect
- **File:** `amplify/backend/function/assignDefaultGroup/src/index.js:11–12`
- **Note:** Specifically the `plan === 'pro' ? 'Pro' : 'Individual'` fallback is *good* (rejects unknown values to Individual) — but this is brittle. If you later add a `Manager` tier and don't update this Lambda, attackers can self-promote. C1 is the real bug; this is its hardening companion.
- **Fix:** When fixing C1, use an explicit allowlist with a hard reject on anything unexpected:
  ```js
  const ALLOWED = { individual: 'Individual', pro: 'Pro' };
  const group = ALLOWED[event.request.userAttributes['custom:plan']];
  if (!group) return event;  // don't assign any group; force manual approval
  ```

### M3. `/session/claim` race condition / hostile takeover
- **File:** `amplify/backend/function/sessionGuard/src/index.js:60–70` (PutCommand without `ConditionExpression`)
- **Exploit:** Lower impact than the C-tier findings because it requires the attacker to already have the user's credentials. But if user A and user B share an account (against your single-session policy), they can each ping-pong each other's session indefinitely. That's denial-of-use to each other.
- **Fix:** Not really necessary — the single-session policy is *meant* to allow new logins to evict old ones. This is the feature, not a bug. Leave as-is.

### M4. No TTL on `UserSessions` DynamoDB rows
- **File:** `amplify/backend/storage/usersessions/cli-inputs.json` (no `TimeToLiveSpecification`)
- **Exploit:** Stale rows accumulate forever. Not directly exploitable, but: storage cost creep, slightly noisier scans, and if you ever do "show me all your active sessions" UI you'll display ghost entries.
- **Fix:** Enable DDB TTL on a new attribute `expiresAt` set to `claimedAt + 90 days`. Add it in the Lambda on `PutCommand`.

### M5. Secrets-Manager token cached for 10 minutes
- **File:** `amplify/backend/function/inferProxy/src/index.js:14`
- **Exploit:** If you rotate the Ultralytics token (which you should, automated or not), warm Lambda containers keep using the old token for up to 10 min and inference fails. Not a security hole; an availability one.
- **Fix:** Drop TTL to 5 min, or use Secrets Manager's rotation-event subscription to invalidate the cache.

### M6. `grantProjectAccess` logs sensitive grant data to CloudWatch
- **STATUS: FIXED (2026-09-26).** Logs `managerId` + `projectId` instead of manager email and orgId.
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:148`
- **Exploit:** CloudWatch logs are accessible to anyone with `logs:GetLogEvents` in your account. If you ever add a dev or contractor with broad IAM, they see manager emails, orgIds, project IDs.
- **Fix:** Don't log PII: replace with `console.log("[grantProjectAccess] granted projectId:", projectId);`.

### M7. Cognito filter "injection" in `getUserByEmail` / `getUserBySub`
- **STATUS: PARTIALLY FIXED (2026-09-26).** Email is validated before the ListUsers filter with a
  conservative pattern that excludes quotes, backslashes and whitespace. `sub` UUID validation
  still outstanding.
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:35, 48`
- **Why not Critical (downgraded from agent claim):** Cognito's `ListUsersCommand` filter language is *not* SQL — it supports only `attr = "literal"` and `attr ^= "prefix"`. There is no OR, AND, UNION, or comment syntax. The worst an attacker can do by injecting a `"` is malform the filter and get a `ValidationException` back. No enumeration is possible *through filter injection itself*.
- **Real concern remaining:** unsanitized user input still has hygiene risks if you ever switch to a query engine that does support those operators, and the email-enumeration risk via the function's overall behavior is real (covered in H2).
- **Fix:** Validate email format strictly before the call (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, max 254 chars) and validate `sub` as a UUID (`/^[a-f0-9-]{36}$/`). Cheap, removes the foot-gun.

### M8. No validation on `model`, `conf`, `iou`, `imgsz` parameters in `/infer`
- **STATUS: FIXED (2026-09-26).** `conf`/`iou` clamped to 0..1, `imgsz` to 32..2048 (env
  `MAX_IMGSZ`), non-numeric values fall back to defaults; every clamp is logged. Verified that
  legitimate values (0.25/0.7/640, and the Detection Lab's 1280) pass through untouched.
  **Re-prioritised above C2's size cap:** YOLO scales every input to `imgsz` before inference,
  so `imgsz` is the real per-call cost lever while payload size barely moves spend.
- **File:** `amplify/backend/function/inferProxy/src/index.js:45, 56–58`
- **Exploit:** `model` is checked against the URL map, so that's OK. But `conf`/`iou`/`imgsz` are forwarded unvalidated. An attacker can send `imgsz: 99999` to inflate Ultralytics call latency/cost.
- **Fix:** Validate ranges before forwarding:
  ```js
  const conf  = clamp(Number(body.conf  ?? 0.25), 0, 1);
  const iou   = clamp(Number(body.iou   ?? 0.5),  0, 1);
  const imgsz = clamp(Math.round(Number(body.imgsz ?? 640)), 32, 1024);
  ```

### M9. Presigned URL expiration is short but irrevocable
- **File:** `src/services/projectStorage.js:445` (and similar)
- **Exploit:** 120s expiry is fine for legitimate clicks but means a manager whose access you revoked can still hit the URL for up to 2 minutes. Combined with browser caching, an attacker who captures one URL has up to that window.
- **Fix:** Drop to 60s. For real revocation, route image access through a Lambda that checks the `ProjectGrants` table on every fetch.

### M10. Missing CSP header
- **File:** `public/index.html` (no `<meta http-equiv="Content-Security-Policy">`)
- **Exploit:** Defense-in-depth against XSS — if an attacker finds an injection point, CSP can prevent the payload from executing.
- **Fix:** Add a strict CSP meta tag:
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.amazonaws.com https://*.execute-api.eu-west-3.amazonaws.com;">
  ```
  Test in report-only mode first to avoid breaking inline styles from Amplify UI.

---

## LOW

### L1. Inference model URLs still in source map / comments
- `src/DetectionTool.jsx:33–36` has comments referencing the Cloud Run hostnames. The hostnames themselves don't grant access (they're behind bearer auth), but they're recon info. Strip the comments.

### L2. Manager email lookup leaks via timing
- `grantProjectAccess` returns slightly faster when the email isn't found (skips the org check). Probably not exploitable without precise measurement, but worth flagging.

### L3. Heartbeat polling has no backoff on failure
- `src/hooks/useSessionGuard.js:51` — silent retry every 30 s forever if the heartbeat 5xxs. Cosmetic concern; users don't get a "your session is stale" indicator.

### L4. `sessionGuard` regex for parsing `cognitoAuthenticationProvider`
- `amplify/backend/function/sessionGuard/src/index.js` — fallback regex `CognitoSignIn:([a-f0-9-]+)$` doesn't enforce UUID format. Cosmetic; the primary auth path is the cognitoIdentityId.

### L5. Audit logging absent for grant/revoke
- No persistent audit trail for `ProjectGrants` writes. If a manager accidentally or maliciously revokes a QS, there's no history. Consider a small `AuditLog` DDB table.

---

## What's already protected (calling out what NOT to worry about)

- ✅ Ultralytics bearer token is in Secrets Manager, not in the client bundle (you fixed this).
- ✅ The single-session enforcement (`UserSessions` + `sessionGuard`) does protect against credential-sharing.
- ✅ `getUserProfile` re-derives tier from Cognito groups server-side (verified — not blindly trusting client claims).
- ✅ `grantProjectAccess` POST and DELETE correctly check `callerSub === ownerSub` (just the GET is missing it).
- ✅ S3 path layout (`private/users/...`, `private/organisations/...`) is sound *in principle* — but only as good as the IAM policy on the imported bucket (see C5).
- ✅ React's default JSX escaping covers screen rendering.

---

## Suggested fix order

1. **Today:**
   - C5 — verify the S3 IAM policy in the AWS console. This is a 5-min sanity check that, if wrong, makes every other finding irrelevant.
   - C3 — add API Gateway throttling (CFN snippet below). 15 min, zero code change.
   - H3 — disable source maps + delete from any deployed host. 2 min.

2. **This week:**
   - C1 — fix `assignDefaultGroup` to ignore `custom:plan` and default to Individual.
   - C2 — add payload-size cap on `/infer`. The per-user quota table can wait one more week. ✅ both parts done 2026-09-26
   - H1, H2 — fix `grantProjectAccess` GET ownership check + generic error message.

3. **This month:**
   - C4 — server-side enforcement for DXF, custom layers, project quota, manager read-only. This is a real chunk of work; split it into separate PRs per feature.
   - H4 ✅ (2026-09-27, config landed — needs `amplify push`), H5 — opt-in MFA still to do.
   - H6 — `npm audit fix`.

4. **Before public launch:**
   - All Mediums.

---

## Appendix: API Gateway throttling override

Amplify lets you customize the generated CFN via `amplify/backend/api/quantApi/build/cloudformation-template.json` overrides — but that file is regenerated on every `amplify push`. The durable path is the `override.ts` file Amplify supports for REST APIs.

For now, the quickest practical fix is to set throttles in the AWS console (API Gateway → `quantApi` → Stages → `dev` → Method-level throttling) and document them in this repo. They'll persist until the next `amplify push` rewrites the stage. After the next push, re-apply.

**To make it durable**, add `amplify/backend/api/quantApi/override.ts`:

```ts
import { AmplifyApiRestResourceStackTemplate } from '@aws-amplify/cli-extensibility-helper';

export function override(resources: AmplifyApiRestResourceStackTemplate) {
  // Per-method throttles. Path format must match API Gateway resource paths
  // (note the `/` prefix; HttpMethod is `POST`, `GET`, `*`, etc.).
  resources.restApi.body.paths['/infer']['x-amazon-apigateway-throttling'] = {
    rateLimit: 10,
    burstLimit: 50,
  };
  resources.restApi.body.paths['/session/heartbeat']['x-amazon-apigateway-throttling'] = {
    rateLimit: 20,
    burstLimit: 50,
  };
  resources.restApi.body.paths['/session/claim']['x-amazon-apigateway-throttling'] = {
    rateLimit: 5,
    burstLimit: 20,
  };
  resources.restApi.body.paths['/user/profile']['x-amazon-apigateway-throttling'] = {
    rateLimit: 10,
    burstLimit: 20,
  };
  resources.restApi.body.paths['/org/grant-access']['x-amazon-apigateway-throttling'] = {
    rateLimit: 5,
    burstLimit: 10,
  };
}
```

Run `amplify push` and the throttles deploy as part of the API stack. The `x-amazon-apigateway-throttling` extension is exactly what API Gateway uses internally for per-method throttles, so this is the proper path. Verify after push in API Gateway console → Stages → `dev` → method → throttling.

Account-wide default backstop (set once in AWS console → API Gateway → Settings → Throttle): 100 RPS / 200 burst. Belt-and-suspenders.

---

_End of audit._
