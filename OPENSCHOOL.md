# OpenSchool fork of LibreChat

## 2026-10-02 original-session logout and expiry recovery (unreleased)

Assigned sole Chat writer, base `4ecb2e6155580d3efc5f8a155f4e1ba327cbf72e`.
This section supersedes the older logout/browser-cookie behavior below. No Web change,
new Web API, runtime restart, browser operation, Docker, paid call, push or PR.
The gateway integration heading's accidental 2026-10-03 date is corrected to 2026-10-02.

The verified callback's original ID token travels in a private WeakMap grant into
`CentralLogout.saveLogoutBinding`, after a Mongo Chat session has been created.
The callback regenerates the Express session and awaits saving a server-only record
before issuing auth cookies/redirect. Store failure rolls back the new Mongo session.
The original token is never attached to the user, central binding, Chat JWT/refresh,
browser storage, API JSON, or a rendered recovery page. Only the final server-generated
303 to the fixed Keycloak end-session endpoint transmits it as `id_token_hint` through
the required OIDC front channel. There is no email/logout_hint or hintless fallback.

The Express logout record contains the original local-session ID, complete central
binding, browser-session ID, generation, and random form state. Its fixed 24-hour
recovery retention is independent of the original central expiry. **No change to
register/validate, central expiry, JWT/refresh authorization, or Mongo auth lifetime.**
Expired credentials are accepted only for the existing revocation-only logout or
as corroboration of the current recovery browser. The recovery record itself grants
no Chat access. Old runtime sessions without a stored hint and lost/expired recovery
records fail explicitly; they are not reconstructed from browser-supplied ID tokens.

`POST /api/auth/logout` retains the existing exact-route, same-origin, HS256 Bearer
verification (expiry allowed only for revocation). It always targets signed A.
It reloads the current Express record and, when present, verifies the signed refresh
cookie offline and compares the complete binding and local-session ID. A Bearer plus
B cookie (including the same owner with a different sid) revokes/deletes A only,
returns `CENTRAL_LOGOUT_BROWSER_MISMATCH`, and neither destroys B nor clears cookies
nor supplies an IdP redirect. The UI explains this result without automatic refresh
or IdP navigation. A matching browser is redirected only to the local recovery page.

Manual recovery is available on the login page and on the explicit central callback
failure page, including the existing-sid/expired-register case. Central mode disables
automatic OpenID redirects. Recovery never silently re-registers or extends the old
reference; a new login remains an explicit action after ending the original IdP session.

- `GET /api/auth/central-logout`: no side effects; shows the manual confirmation/retry
  form without an ID token. It works after access/refresh expiry and Mongo TTL cleanup,
  as long as the retained Express browser record is available.
- `POST /api/auth/central-logout/continue`: same-origin plus server-stored random form
  state; rechecks the current browser, saves a ten-minute pending callback state,
  idempotently revokes the original Web reference and deletes only its Mongo session,
  saves the issued state, then returns the original-hint Keycloak redirect.
- `GET /api/auth/central-logout/callback`: requires issued, unexpired state matching
  the current browser's server record. Only the original Express session is destroyed.
  Error/cancel retains retry. Completed state cannot be replayed. A callback arriving
  after login B cannot destroy B. Responses deliberately send no auth-cookie deletion
  or replacement: Express response-time saving/touching is disabled before sending,
  preventing a late A response from overwriting B's cookies. Stale A cookies grant no
  access after the server-side session/reference is revoked.

Web revoke failure and interrupted IdP navigation preserve the record and retry;
return to the recovery page and explicitly retry. No successful-IdP claim is made merely
because Web revoke returned 204 or Chat returned 200. Pages report incomplete state,
or a matching IdP return, and do not automatically log back in. Pages/redirects use
no-store, no-referrer and restrictive CSP. No token/full IdP URL is logged by these hooks.
Same-browser continuation/callback operations are serialized in this **single local
Chat process** and reload the server record; no distributed/multi-worker guarantee is
claimed. Recovery is bounded by the existing server-side store's availability and TTL.

TL integration handoff: the `chat-local` Keycloak client's allowed post-logout return
must include exactly `http://localhost:15483/api/auth/central-logout/callback`.
This batch does not modify Keycloak/runtime configuration. Load the new Chat code and
frontend through the normal TL runtime workflow, then sign in once to create the new
server-only recovery record before testing expiry/recovery. Existing running binary
sessions cannot retroactively acquire the original hint. No new Web endpoint is needed.

Directed evidence on the base plus this commit's patch, using existing dependencies:

- Native Node suites: local-central-identity, local-central-sso, local-central-logout,
  local-central-access and local-central-continuation: **74 tests** across the checked
  suites pass (the first four 65; continuation 9). The continuation suite uses real
  Express, express-session cookies/MemoryStore, jsonwebtoken, production routes and
  origin middleware, with Web/Mongo boundaries substituted. It covers A/B cookies,
  expired recovery, TTL-missing auth sessions, revoke outage, IdP error/interruption,
  forged/cross-browser/expired/replayed states, concurrent callback, new B login,
  missing hints, and actual callback failure routing. Callback issuance also verifies
  hint non-disclosure and save-failure rollback before auth cookies.
- API Jest: LogoutController, auth/oauth, auth.cross-site, oauth.state and config:
  **129/129 pass**; AuthService and routes/oauth: **71/71 pass** (200 API tests total).
  Client Jest: AuthContext and Login: **38/38 pass**.
- `npm run build:data-provider` and client `tsc --noEmit` pass; changed-file ESLint,
  formatting, JS syntax and `git diff --check` pass. Two preexisting lint exceptions
  are documented inline (intentional control-character rejection and a test-only label).
  No dependency or lockfile change.
- No real Mongo/Keycloak/Google, full production client bundle or full upstream suite
  run in this batch. The user-reported Web `a8019d9` expiry/recovery receipt and a new
  Web sid entering the **old running Chat binary** are separate evidence, not acceptance
  of this new Chat logout flow. TL owns real dual-service verification and PM acceptance.

Changed paths for this package:

- `api/server/services/CentralLogout.js`, `LocalCentralSSO.js`, `AuthService.js`
- `api/server/controllers/auth/oauth.js`; `api/server/routes/auth.js`, `oauth.js`,
  `config.js`; `api/server/socialLogins.js`
- `client/src/components/Auth/Login.tsx`, `__tests__/Login.spec.tsx`;
  `client/src/hooks/AuthContext.tsx`, `__tests__/AuthContext.spec.tsx`
- `client/src/locales/en/translation.json`, `client/src/locales/zh-Hant/translation.json`
- `packages/data-provider/src/config.ts`, `packages/data-provider/src/types/mutations.ts`
- `openschool/local-central-continuation.test.cjs`, `local-central-sso.test.cjs`,
  `local-central-logout.test.cjs`, `local-central-access.test.cjs`; `OPENSCHOOL.md`

## Local central SSO wiring (2026-10-02)

Assigned Chat worker, original source `97a9169f52675395dbb650d3cf5ca6ed0eed9735`;
TC follow-up source `85feb0561c17562cd85a904ab9d9c4168c4f00bd`, branch
`codex/local-central-sso`. This package wires the existing Passport callback, Chat-owned
JWT/refresh tokens, Mongo sessions and logout. It is engineering evidence, not P0 or
product acceptance. No deployment, Docker, paid calls, push or gateway changes.

Enable only with `OPENSCHOOL_CENTRAL_SSO=true`, `NODE_ENV=development`,
`OPENID_ISSUER=http://localhost:15480/realms/langrace-local`, `OPENID_CLIENT_ID=chat-local`,
`OPENSCHOOL_CENTRAL_API_URL=http://localhost:15481` and a server-only
`OPENSCHOOL_CENTRAL_API_KEY`. `OPENID_REUSE_TOKENS=true` is explicitly rejected.
Normal Chat JWT/refresh/session secrets, `DOMAIN_SERVER`/`DOMAIN_CLIENT` and
`OPENID_CALLBACK_URL=/oauth/openid/callback` must still be configured for local Chat.
The local issuer is explicitly allowed HTTP. State and nonce are generated on every
authorization request; the pinned [openid-client 6.5.0 Passport strategy](https://github.com/panva/openid-client/blob/v6.5.0/src/passport.ts)
owns S256 PKCE, stored state/nonce and authorization-code validation before our callback.

`api/server/services/LocalCentralSSO.js` implements the fixed Web contract:

- Server-only JSON POSTs to `/internal/central-sso/register` with `{idToken}`,
  `/validate` with `{reference}`, and `/revoke` with `{reference}`, authenticated by
  `X-OpenSchool-Central-Key`. A 2500 ms total deadline includes body parsing; no retry,
  redirect, decision cache or credential/body logging. Field/path/header differences
  from the assigned Web contract: **none**.
- Web selects the preapproved mapping. Chat accepts only the exact existing, ordinary
  `USER` Mongo owner, with no tenant scope, temporary expiry or deletion in progress.
  No email lookup, account creation, first-admin assignment, Google legacy condition,
  provider rewrite or role synchronization. The old `localCentralIdentity.js` remains
  an unused historical helper; it is not the runtime identity policy.
- Callback-only grants survive the user reload in `setAuthTokens` by becoming an
  explicit Mongo `Session.centralSession` binding. Both signed Chat access and refresh
  tokens contain the binding; access tokens additionally identify the local session.
  Every accepted JWT checks the local session and live Web reference. Refresh checks
  signed versus stored binding and validates the same reference, never registers or
  extends the original expiry. Missing bindings, owner/member/subject/sid changes,
  expired/revoked sessions and Web errors deny.
- Trusted request fields are `req.user.memberId` and
  `req.user.centralSessionReference` (`reference` is an alias); `centralSession` contains
  the full validated binding. No browser header/body supplies these fields. Gateway
  headers and Web consumers remain the main TL's package.
- Local/password registration, other OAuth providers, admin auth and token-reuse
  middleware paths are blocked only in central mode. Feature off retains prior behavior.
- Only exact central POST /api/auth/logout accepts a revocation-only Authorization
  Bearer credential. Real jsonwebtoken verifies the Chat signature with JWT_SECRET,
  HS256 only, allowing expiry only here. Signed owner, local-session ID and central
  binding must be structurally valid. It does not invoke live authorization or require
  the Mongo TTL record to remain, and never puts this credential into req.user.
  Same-origin middleware still applies; body/query/provider/cookie tokens are ignored.
- Logout revokes the original reference first. Any Web revoke failure returns 503
  without deleting the local session or clearing browser cookies. Success deletes only
  the signed local session (idempotently), clears the current browser's cookies/session
  and returns Keycloak end-session with client_id=chat-local and exact
  post_logout_redirect_uri=http://localhost:15483/. IdP logout remains pending; this
  response is not evidence of Google/federated logout. Another browser is retained.
- A central logout attempt retains its access token only as a revocation retry
  credential in tab sessionStorage (memory fallback), clears the general token header,
  and replaces authenticated/login content with an incomplete-logout/retry screen.
  Silent refresh, token-update recovery and automatic OIDC are suppressed until an
  explicit retry succeeds. Retry uses only the logout endpoint, outside Axios recovery.
- Central images and all three shared-file routes validate signed refresh binding,
  Mongo session/owner and live Web reference before access, even with insecure image
  links configured. A denied Authorization credential cannot fall back to a cookie.
  Public-client startup advertises forced-PKCE OIDC and hides blocked login providers.
  Feature-off regression behavior is preserved.

Verification on the TC follow-up source plus this working patch:

- Existing-lock npm ci succeeded (Node 24.18.0/npm 11.16.0, HUSKY=0,
  SCARF_ANALYTICS=false); package-lock.json is unchanged. Root node_modules and built
  workspace dist outputs are available for TL runtime integration.
- Builds: build:data-provider, build:data-schemas, build:api, build:client-package pass.
  Full tsc --noEmit for client, packages/data-schemas and packages/api is checked
  separately from the dependency-free tests; data-provider build includes declaration
  typechecking.
- node --test openschool/local-central-identity.test.cjs
  openschool/local-central-sso.test.cjs openschool/local-central-logout.test.cjs
  openschool/local-central-access.test.cjs: 65/65 pass. The original 52 use explicit
  dependency substitutes. The additional 13 use installed real jsonwebtoken, Express,
  CORS and transpiled production middleware/router bodies with HTTP/model boundaries
  substituted. They cover expired/TTL-missing/outage logout, real forged signatures,
  Origin and exact-route boundaries, revoke failure retry, browser isolation, image
  access, all share-file routes, and public-client config. No real Mongo is claimed.
- API Jest: LogoutController.spec.js, auth.cross-site.test.js and
  optionalShareFileAuth.spec.js: 48/48; routes/__tests__/config.spec.js: 70/70.
  packages/api images/authorization.spec.ts: 25/25. Data-provider
  request-interceptor.spec.ts and logout.spec.ts: 24/24. Client
  hooks/__tests__/AuthContext.spec.tsx: 27/27 (including incomplete logout/reload,
  no silent refresh, ignored in-flight success, and explicit retry).
- Changed JS syntax, Prettier and git diff --check are separate static checks.
  npm ci reported 16 audit findings (7 low, 2 moderate, 7 high); no dependency upgrades
  or audit fixes were applied. npm's allow-scripts policy blocked seven package scripts,
  including mongodb-memory-server binary postinstall; this batch did not run real Mongo.
- Live Web/Keycloak/Google, actual browser redirects, chat/attachments end-to-end,
  frontend production bundle and full repository tests remain unverified here.
  User-reported Web real-KC success is not a Chat joint-runtime result. Main TL owns
  integration/review; no P0 or product acceptance is claimed.

Read-only discovery handoff (no gateway/header changes in this batch):

- /api/models uses requireJwtAuth, ModelController.loadModels, then loadConfigModels
  (packages/api/src/endpoints/config/models.ts) and fetchModels
  (packages/api/src/endpoints/models.ts). req.user reaches userObject, including the
  trusted memberId and centralSessionReference in central mode.
- fetchModels accepts headers and userObject. Its MODEL_QUERIES cache is keyed by
  baseURL+API key for two minutes; it skips that cache when both nonempty headers and
  userObject are supplied (or skipCache/userIdQuery applies). Config discovery can fall
  back to configured model defaults after empty/failed discovery. Main integration must
  account for that fallback and token-config caching when introducing per-user filtering.
- The current resolveHeaders/createSafeUser allowlist in packages/api/src/utils/env.ts
  does not expose memberId or centralSessionReference as template fields. Their presence
  on req.user alone does not send them to Web. Main TL must wire the trusted values to
  X-OpenSchool-Member-Id and X-OpenSchool-Central-Session with the existing service key;
  this package deliberately leaves that integration unchanged. No register/validate/
  revoke field, URL or secret-header differences from the assigned Web contract.
- Main reports central Web /models now requires the same live dual headers and returns
  private,no-store per-user results; headerless discovery receives 401. Its planned Chat
  fetch:false/default-personal startup and per-user/no-global-cache adaptation are not
  implemented or runtime-verified in this batch.

This fork carries the small changes that the OpenSchool platform (開放學校平台) needs on top of
LibreChat. LibreChat is MIT licensed; upstream is <https://github.com/danny-avila/LibreChat>.

## Branches（分支規則）

| Branch | Purpose |
|---|---|
| `main` | 社群版本的同步與調整。**不放 OpenSchool 專屬修改。** |
| `openschool/main` | OpenSchool 的整合分支。所有 OpenSchool 修改都進這裡；OpenSchool 的本機開發與安裝驗證都以它為準。 |
| `openschool/version/<major>_<minor>_<patch>` | 需要固定版本線時才從 `openschool/main` 切出，例如 `openschool/version/1_0_0`、`openschool/version/1_1_0`。 |

- 修改由 OpenSchool 的雲端 TL 提交到 `openschool/main`（Eric 授權），每個 commit 附驗證；不改寫歷史、不 force push。
  fork 的 GitHub Actions 目前沒有在跑，所以不以 fork PR 當關卡，也避免上游 workflow 花掉 Actions 預算。
- 跟進上游：把上游的 release tag（或本 fork 的 `main`）**merge** 進 `openschool/main`，不 rebase。merge 後重跑下方檢查。
- 每個修改保持小、以環境變數開啟、預設與上游行為相同，讓 merge 衝突維持在最少。
  因此修補直接寫在原本的 CJS 檔（例如 `api/strategies/socialLogin.js`），而不是依上游 CLAUDE.md 搬進 `/packages/api`：
  這是刻意的取捨，換取跟進上游時衝突最小。

## Patches（目前的修改）

| Env var | File | What it does |
|---|---|---|
| `OPENSCHOOL_STRICT_SOCIAL_ID=true` | `api/strategies/socialLogin.js` | Social login continues an existing account only when the provider ID matches. An account found only by email is refused (`AUTH_FAILED`) instead of being taken over, and no provider ID is written. The admin path (`existingUsersOnly`) keeps the upstream handling. Off unless the value is exactly `true` (case-insensitive). |
| `OPENSCHOOL_CHAT_ACCESS_URL=http://school:8080/ai-gateway/v1/chat-access` and `OPENSCHOOL_GATEWAY_KEY` | `api/strategies/socialLogin.js` | Opt-in Google eligibility check for both existing and new regular users, after strict subject collision checks and before user updates/creation. Sends one POST with `Authorization: Bearer <gateway key>`, `X-OpenSchool-Google-Sub` from the Passport-verified Google profile ID (never browser input), and `X-Forwarded-Proto: https`. Only HTTP 200 with a JSON object containing boolean `allowed: true` permits continuing. Missing key/subject, unverified email, redirects, non-200, malformed responses, network failures and a five-second deadline (including body parsing) deny with `AUTH_FAILED`. No retries or decision caching; new gate logs contain no subject, email, key or token. |
| `OPENSCHOOL_RETURN_URL=<absolute http(s) URL>` | `api/server/routes/config.js`, `client/src/components/Messages/Content/Error/openschoolReturn.tsx` (+ one prop in `parts.tsx`, one call each in `ModelError.tsx` / `ProviderError.tsx`) | Published post-login as `openschoolReturnUrl` (only an http(s) URL without credentials, query or fragment). When a chat error's text contains exactly that URL, optionally with `?circle=<a-z0-9->`, the error shows a separate "返回開放學校共學圈" link (new tab, `noopener noreferrer`) rebuilt from the configured URL. The error text stays text; any other URL is ignored. Not offered outside the chat (search, shared links). |

Why: OpenSchool's AI gateway trusts the Google subject that LibreChat forwards
(`{{LIBRECHAT_USER_GOOGLEID}}`). Upstream falls back to email when the Google ID is not found, so a
different Google account with the same email would be logged in as — and forwarded as — the
existing user. See OpenSchool ADR-0000015 / SPEC-0000021 (in the OpenSchool repository).

### Invitation-only adult mock demo

Deploy the eligibility endpoint and key together with `OPENSCHOOL_STRICT_SOCIAL_ID=true`.
`ALLOW_SOCIAL_REGISTRATION=true` may be enabled for this demo only when that gate is deployed and
configured; the gate never enables registration itself. New accounts retain the ordinary `USER`
schema default; eligibility response fields cannot grant roles. The OpenSchool endpoint owns the
adult invitation decision. Keep the admin route blocked at the proxy: `existingUsersOnly` retains
upstream behavior and does not consult this gate or acquire admin access from an eligibility result.
An absent/empty gate URL preserves upstream login behavior. This check runs on each Google social
login, not on existing sessions, refreshes, or individual chat requests; it is not session revocation.
No proxy/deployment configuration is changed by this patch.

## Checks

```bash
npm ci && npm run build:data-provider && npm run build:data-schemas && npm run build:api
cd api && npx jest strategies/socialLogin.test.js server/routes/__tests__/config.spec.js
cd client && npx jest src/components/Messages/Content/__tests__/OpenSchoolReturn.spec.tsx src/components/Messages/Content/__tests__/Error.spec.tsx
```

These env-only switches deliberately skip upstream's "new levers go in `configSchema`" rule, like
`CUSTOM_FOOTER`: they are OpenSchool deployment settings, and keeping them out of shared schema
code keeps upstream merges conflict-free.

## Dependency audit

`npm audit --omit=dev` on the upstream lockfile reports advisories inherited from upstream
(assessment and gate are recorded in the OpenSchool repo's S1b-G handoff). We do not run
`npm audit fix` here: a fork-only lockfile would conflict with every upstream merge. Bump by merging
upstream releases; before any non-local exposure, re-audit and, if upstream has not caught up, add
targeted `overrides` in a separate commit.

2026-09-30 (branch `openschool/deps-audit`): minimal bump to meet the pre-real-model gate. `undici`
`^7.29.0` -> `^7.29.1` (`api/package.json`, `packages/api/package.json`; resolves to 7.30.0) and
`multer` `^2.3.0` -> `^2.4.0` (`api/package.json`; 2.4.0 no longer depends on `concat-stream`).
No `npm audit fix`, no `overrides`, no other package touched. `npm audit --omit=dev` goes from 7 to 5
findings; undici and multer are gone. Still open, with the original assessment unchanged: `nodemailer`
(only relevant once email sending is enabled), `fast-uri`, `brace-expansion`, `ip-address`, `moment`
(not reachable from the OpenSchool path or low risk). Re-audit before any non-local exposure.

## Private prompt handoff (H3, default off)

H3 implementation branch: `openschool/prompt-handoff`, base
`984626afd3683b291d4b7b3746fd0580604ed86c`. The actual deployed Chat source reported by Eric is
`7628b9e79b434fdc465a4f2156d721cafd92bb85` (image `000d9a9b`). That commit is the direct child of
984626afd and adds the invitation guard in `socialLogin.js`, its tests and this document.
H3 carries those two source/test files **exactly from 7628b9e**, preserving the existing
`OPENSCHOOL_CHAT_ACCESS_URL` / `OPENSCHOOL_GATEWAY_KEY` gate. Eric subsequently authorized a normal
merge of fixed 7628b9e after the H3 implementation commit so the final integration head retains
the deployed source as an actual Git ancestor (required by `check-release`). No rebase, push,
image build, source-pin change or service change is part of H3. TL must review the final head,
verify that ancestry and gate checks pass, and formally update the source pin before release.

Server configuration (not browser or `librechat.yaml` input):

- `OPENSCHOOL_PROMPT_HANDOFF_ENABLED=true` enables the BFF; default off. Authenticated startup
  config publishes only boolean `openschoolPromptHandoffEnabled`, never the gateway URL/key.
- `OPENSCHOOL_HANDOFF_GATEWAY_URL` is the **complete** Web consume URL, e.g.
  `http://school:8080/ai-gateway/v1/prompt-handoff/consume`.
- `OPENSCHOOL_HANDOFF_GATEWAY_KEY` supplies its Bearer credential. **No fallback** to
  `OPENSCHOOL_GATEWAY_KEY`: the deployment helper must provide the explicit handoff key. The
  invitation guard retains its existing key name independently.
- With server `DOMAIN_CLIENT=https://...`, BFF sets fixed `X-Forwarded-Proto: https` for Web's
  HTTPS middleware. Browser headers cannot override it. The BFF never follows redirects.
- Configure `OPENSCHOOL_RETURN_URL` to offer the existing trusted OpenSchool return link in error UX.

Contract: `/c/new?endpoint=OpenSchool&model=personal` (or `circle-<code>`)
`&os_handoff=<64 lowercase hex>`. The ID is bound/authorized and atomically consumed by **Web**;
the Chat BFF cannot grant access, extend Web TTL or authorize a Send. Authenticated
`POST /api/openschool/handoff` accepts only `{id}`, derives Google subject from `req.user.googleId`,
and forwards a single JSON POST with a five-second deadline, bounded response body, no retry or
redirect. JWT, existing origin guard, explicit origin/JSON checks and strict body shape all apply.
No prompt, ID, subject, credential or full error response is logged by this implementation.

Only `{id, expiresAt}` survives OAuth in sessionStorage (ten-minute local upper bound; Web's expiry
is authoritative). Prompt text stays in memory. URL prompt/q/submit/autosubmit are blocked, the ID
is removed from the URL on dispatch, and success/failure clears storage except a 401 that permits
same-account login recovery. StrictMode reuses one promise. Model discovery precedes consume;
prefill waits for an initialized new OpenSchool conversation and the returned model. Existing text
requires explicit append/cancel; text arriving during model initialization requires confirmation
again. The hook never calls submitMessage. Handoff composers disable local draft saving and long
text-to-file paste conversion; received prompt is discarded from hook memory after prefill,
cancellation, expiry or failure. Review/edit and ordinary explicit Send remain user actions.

Fork exceptions follow the deployment-only patches above: an isolated CJS route and env-only
switch minimize upstream integration changes; English and Traditional Chinese strings are both
required by the H3 assignment, rather than relying on upstream's translation automation.

Reproducible offline directed checks use existing image `openschool-chat:984626a-local`, two CPUs,
6 GiB memory, a read-only checkout mount, no network/ports, and existing dependencies. Run as root
**only inside the disposable container** to copy source into its ephemeral `/app`:

```powershell
git archive --format=tar --output=.git/h3-baseline-client.tar 984626afd3683b291d4b7b3746fd0580604ed86c client
docker run --rm --user 0:0 --network none --cpus 2 --memory 6g --mount "type=bind,source=<H3 checkout>,target=/h3,readonly" --entrypoint sh openschool-chat:984626a-local /h3/openschool/test-handoff.sh
```

The harness copies client source (the image omits it), rebuilds data-provider/types, runs directed
BFF/config/socialLogin and client handoff/query/autosave/auth-redirect tests, then client tsc. Its
Jest adapter substitutes the image's existing Babel presets/import.meta transform because the
upstream client test plugins are absent from that image; no dependency was added or installed.
Full client typecheck additionally requires the image-omitted existing Sandpack package; the harness
compares its diagnostics with the fixed 984 client archive under the same dependencies and reports
existing baseline failures explicitly, rather than claiming a green full typecheck. Browser
Google OAuth, actual Web atomic/TTL/eligibility behavior, deployment HTTP/secret wiring, lighthouse
and full production frontend build remain TL H4 verification. No paid model call was made.

2026-10-01 H3 directed evidence (base 984626afd plus fixed deployed gate 7628b9e): data-provider
build/type emission passed; API **180/180** and client **114/114** tests passed. Candidate full
client tsc reported eight TS2307 diagnostics for missing existing Sandpack modules, **identical**
to the fixed 984 client source under the same image dependencies; no H3 diagnostics remain. This
is a baseline comparison, not a green full client typecheck. `git diff --check` passed; the normal
merge retains 7628b9e as an actual ancestor and its socialLogin source/test blobs are unchanged.

## Building an image

- `docker build -f openschool/Dockerfile -t openschool-librechat:<commit> .`
  Same steps as the upstream `Dockerfile` but on a Debian node image and without the uv/ghcr stage,
  so it only needs Docker Hub and the npm registry (plus `cdn.sheetjs.com`, which the upstream
  lockfile uses for `xlsx`).
- The upstream `Dockerfile` is unchanged.

## 2026-10-02 local P0 central gateway integration (unreleased)

On base 93e6d0f, authenticated model discovery now uses the current central
member/session pair without a global model cache or default-model fallback.
Prompt handoff and custom endpoint headers use the same server-validated pair;
legacy Google headers apply only outside local central mode. Local runtime
configuration is ignored, and no paid provider credentials were added.

Directed evidence: 43 API tests passed for CentralGateway, ModelController and
OpenSchool handoff; 142 env utility tests passed. Data schemas/API builds and
frontend production build passed (existing Tailwind/eval/chunk warnings remain).
These are directed checks, not full P0 acceptance. Actual synthetic Keycloak
login reached the Chat UI; expired-session access returned to login. Re-entry
under the same expired central sid currently fails closed and remains unresolved.
Original-session IdP logout, cross-tab A-token/B-cookie handling, real Google,
full dual-service runtime, and deployment are not complete. No paid call made.

### 2026-10-02 TL browser follow-up: fixed IdP form redirect

Against 88ca0ef47, real local browser submission remained on the recovery form. The form CSP allowed only self, which prevented its 303 continuation to the fixed local Keycloak logout endpoint. Add exactly that endpoint to form-action; default-src, frame-ancestors and base-uri remain none. No configurable/open redirect or hintless logout was introduced.

After restarting this isolated Chat, the in-memory recovery record was lost; TL reset only the synthetic teacher-a IdP fixture to start a new test. That administrative reset is NOT product logout evidence. A fresh Chat login followed by Web login then Chat menu logout → explicit recovery POST → Keycloak → matching callback succeeded. Web /me subsequently required login, and the next Chat OIDC challenge displayed the Keycloak credential form. Screenshot is ignored local evidence chat-logout-callback.png in the Web worktree.

Nine continuation HTTP tests passed with an exact CSP assertion. Earlier child test/build receipts remain their fixed-source evidence. This does not establish other-browser survival, expired Chat recovery, restart durability, real Google, or full A4 completion. In-memory recovery across a Chat restart remains a limitation to address before deployment.

### 2026-10-02 persistent logout recovery follow-up

Central OpenID startup now requires USE_REDIS=true and REDIS_URI; it refuses a memory-store fallback. Uses the existing connect-redis store dependency, not a new session implementation. Local Web tools provision a dedicated authenticated Redis 7.4 AOF/appendfsync-always volume on loopback 15485, with noeviction. USE_REDIS_STREAMS stays false; no scheduler was enabled. Deploying multiple Chat processes is not covered by the current process-local continuation serialization.

Actual evidence: established a new synthetic Chat login, recorded a digest of its server-side centralLogout record plus original expiry without printing token/key values, restarted both Chat and its dedicated Redis, and verified identical record/expiry and healthy AOF status. Waited for natural authentication expiry: protected Chat reloaded to login; recovery link still produced the original form. Stopped only the isolated Web, submitted and observed an incomplete/retry page; restarted Web and the same retry completed the matching Keycloak callback. Next OpenID challenge showed the credential form. No administrative session reset was used in this persistence/expiry/outage run; no expired session was extended. Screenshot chat-expired-restart-outage-recovered.png is ignored local evidence in the Web tree.

12 targeted Node tests passed (9 continuation +3 startup store policy). Redis inspection command: node openschool/probe-local-session-store.cjs --record before restart, then without --record and with --expired after natural expiry. It is limited to the named synthetic subject and dedicated DB/port, outputs aggregates only. This test is not real Google, other-browser survival, Redis outage recovery, or complete A4 acceptance.
