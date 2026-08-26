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
- **File:** `amplify/backend/function/assignDefaultGroup/src/index.js:11–12`
- **Exploit:** The PostConfirmation Lambda reads `custom:plan` from the signup attributes and assigns the user to `Pro` if it equals `"pro"`, otherwise `Individual`. Cognito's SignUp API lets the client pass arbitrary user attributes; the Amplify React app sets `custom:plan` from `_planSel.current` (`src/App.js:127`), but a malicious client can send `custom:plan: "pro"` directly to Cognito and get the Pro group for free. No payment verification.
- **Impact:** Every gated Pro feature (DXF export, custom layers, 10-project quota) becomes free. Your entire pricing model is unenforced.
- **Fix:** Server-side: in `assignDefaultGroup`, ignore `custom:plan` entirely and always assign `Individual` on signup. Tier upgrades only happen through a payment-verified Lambda (Stripe webhook → assign to `Pro` group). Alternatively, write a "pending upgrade" record and reject `custom:plan` values that aren't `individual`.

### C2. `/infer` has no payload-size cap and no per-user quota
- **File:** `amplify/backend/function/inferProxy/src/index.js:45–47`
- **Exploit:** Any signed-in user can POST a base64 image of arbitrary size (up to API Gateway's 10 MB default) to `/infer`, and can hit it in a tight loop. Each call forwards to the paid Ultralytics endpoint. With the current cache + no quota, a script can drain your model budget in minutes.
- **Impact:** Pure financial damage. There is no upper bound on what one bad actor can cost you.
- **Fix:**
  1. Add input validation at the top of the handler: `if (!imageB64 || imageB64.length > 5_000_000) return resp(400, { error: 'image too large' });` (5 MB pre-decode cap).
  2. Per-user monthly quota — small DDB table `InferenceQuota` keyed by `userId#YYYY-MM`, counter incremented on each call, with limits per tier (e.g. 100/mo Individual, 2,000/mo Pro, unlimited Enterprise).
  3. **Plus** API Gateway throttling (see C3) as broad-stroke protection.

### C3. No API Gateway throttling on any route
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
This is really C1's consequence, but the surface is wider than just the signup flow — listing each consumer because each needs a server-side fix.

| Feature | Frontend gate (bypassable) | Server-side gate |
|---|---|---|
| DXF export | `src/DetectionTool.jsx` — gated on `canExportDXF` | **None.** Anyone can call `exportDXF()` from the console. |
| Custom layers (classes) | `src/DetectionTool.jsx:4501` — gated on `canUseCustomClasses` | **None.** Custom classes are just JSON in the `metadata.json` written to S3; nothing rejects them at write time. |
| `maxProjects` quota | `src/pages/ProjectsPage.jsx:28` | **None.** `createProject` writes directly to S3 under the user's prefix; S3 doesn't count objects against a tier. |
| Manager read-only mode | `src/DetectionTool.jsx:1304` — `isReadOnly` disables UI | **None.** A manager can call `saveProject()` from the console and overwrite the project. |

- **Fix:** Each of these needs a server-side enforcement point. The cleanest path:
  - Introduce a `validateProjectWrite` Lambda invoked by an S3 `PUT` event (or as a pre-signed-URL minter Lambda the client must go through). It loads the metadata, checks the caller's tier from Cognito groups, and rejects DXF requests / custom-layer additions / over-quota creates / read-only saves.
  - Or: keep S3 direct writes for everything except the gated features, and route those through a Lambda (`/projects/export-dxf`, `/projects/create`) that verifies tier.

### C5. S3 bucket scope — UNVERIFIED, must check manually
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

## HIGH

### H1. IDOR — `GET /org/grant-access` leaks every project's manager list
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:78–87`
- **Exploit:** The GET handler queries `ProjectGrants` by `projectId` only — no ownership check on the caller. Any authenticated user who knows or guesses a `projectId` (UUIDs are unguessable, but they leak through screenshots, support tickets, and the URL bar) can dump the full grants list: manager emails, names, ownerSub, orgId, grantedAt.
- **Impact:** Org-structure leak, manager email enumeration, PII.
- **Fix:** Same ownership check the POST/DELETE handlers already have:
  ```js
  if (callerSub !== ownerSub) return fail("Only the project owner can list grants");
  ```
  But ownerSub isn't passed on GET — either accept it as a query param and require it match `callerSub`, or load the project metadata first and verify ownership.

### H2. Email enumeration via `/org/grant-access` POST
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:120`
- **Exploit:** When granting access fails because the user doesn't exist, the response is `"No user found with email: <email>"`. An attacker can probe email addresses ("does jane@bigcorp.com exist?") and distinguish from "not in your org" and "doesn't exist" by error message. Combined with no rate limiting, they can enumerate your entire user base by email.
- **Fix:** Return a generic error: `"This user can't be granted access"` for *all* lookup failure modes (not found, wrong org, not a manager). Add per-user rate limit on POSTs to this endpoint (e.g. 10/min).

### H3. Source maps shipped in `build/`
- **File:** `build/static/js/*.map` (verified — all chunks have `.map` files)
- **Exploit:** If you've ever deployed `build/` to production (`amplify publish` or any static host), the source maps are publicly downloadable. They reverse-compiled JS back to your original source: every helper function name, every comment, every internal API call pattern. An attacker uses them to find weaknesses fast.
- **Fix:** Set `GENERATE_SOURCEMAP=false` in `.env.production` (CRA convention) and rebuild. Verify by checking that `build/static/js/` has no `.map` files. Also: delete the existing `.map` files from any deployed host.
- **Severity caveat:** If you've never deployed (still localhost-only), this is currently Medium. Becomes High the moment you push to production.

### H4. Weak Cognito password policy
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
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:148`
- **Exploit:** CloudWatch logs are accessible to anyone with `logs:GetLogEvents` in your account. If you ever add a dev or contractor with broad IAM, they see manager emails, orgIds, project IDs.
- **Fix:** Don't log PII: replace with `console.log("[grantProjectAccess] granted projectId:", projectId);`.

### M7. Cognito filter "injection" in `getUserByEmail` / `getUserBySub`
- **File:** `amplify/backend/function/grantProjectAccess/src/index.js:35, 48`
- **Why not Critical (downgraded from agent claim):** Cognito's `ListUsersCommand` filter language is *not* SQL — it supports only `attr = "literal"` and `attr ^= "prefix"`. There is no OR, AND, UNION, or comment syntax. The worst an attacker can do by injecting a `"` is malform the filter and get a `ValidationException` back. No enumeration is possible *through filter injection itself*.
- **Real concern remaining:** unsanitized user input still has hygiene risks if you ever switch to a query engine that does support those operators, and the email-enumeration risk via the function's overall behavior is real (covered in H2).
- **Fix:** Validate email format strictly before the call (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, max 254 chars) and validate `sub` as a UUID (`/^[a-f0-9-]{36}$/`). Cheap, removes the foot-gun.

### M8. No validation on `model`, `conf`, `iou`, `imgsz` parameters in `/infer`
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
   - C2 — add payload-size cap on `/infer`. The per-user quota table can wait one more week.
   - H1, H2 — fix `grantProjectAccess` GET ownership check + generic error message.

3. **This month:**
   - C4 — server-side enforcement for DXF, custom layers, project quota, manager read-only. This is a real chunk of work; split it into separate PRs per feature.
   - H4, H5 — Cognito password policy + opt-in MFA.
   - C2 (part 2) — per-user inference quota table.
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
