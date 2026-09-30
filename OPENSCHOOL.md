# OpenSchool fork of LibreChat

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
