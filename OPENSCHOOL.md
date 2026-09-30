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
| `OPENSCHOOL_RETURN_URL=<absolute http(s) URL>` | `api/server/routes/config.js`, `client/src/components/Messages/Content/Error/openschoolReturn.tsx` (+ one prop in `parts.tsx`, one call each in `ModelError.tsx` / `ProviderError.tsx`) | Published post-login as `openschoolReturnUrl` (only an http(s) URL without credentials, query or fragment). When a chat error's text contains exactly that URL, optionally with `?circle=<a-z0-9->`, the error shows a separate "返回開放學校共學圈" link (new tab, `noopener noreferrer`) rebuilt from the configured URL. The error text stays text; any other URL is ignored. Not offered outside the chat (search, shared links). |

Why: OpenSchool's AI gateway trusts the Google subject that LibreChat forwards
(`{{LIBRECHAT_USER_GOOGLEID}}`). Upstream falls back to email when the Google ID is not found, so a
different Google account with the same email would be logged in as — and forwarded as — the
existing user. See OpenSchool ADR-0000015 / SPEC-0000021 (in the OpenSchool repository).

## Checks

```bash
npm ci && npm run build:data-provider && npm run build:data-schemas && npm run build:api
cd api && npx jest strategies/socialLogin.test.js server/routes/__tests__/config.spec.js
cd client && npx jest src/components/Messages/Content/__tests__/OpenSchoolReturn.spec.tsx src/components/Messages/Content/__tests__/Error.spec.tsx
```

Both env-only switches deliberately skip upstream's "new levers go in `configSchema`" rule, like
`CUSTOM_FOOTER`: they are OpenSchool deployment settings, and keeping them out of shared schema
code keeps upstream merges conflict-free.

## Dependency audit

`npm audit --omit=dev` on the upstream lockfile reports advisories inherited from upstream
(assessment and gate are recorded in the OpenSchool repo's S1b-G handoff). We do not run
`npm audit fix` here: a fork-only lockfile would conflict with every upstream merge. Bump by merging
upstream releases; before any non-local exposure, re-audit and, if upstream has not caught up, add
targeted `overrides` in a separate commit.

## Building an image

- `docker build -f openschool/Dockerfile -t openschool-librechat:<commit> .`
  Same steps as the upstream `Dockerfile` but on a Debian node image and without the uv/ghcr stage,
  so it only needs Docker Hub and the npm registry (plus `cdn.sheetjs.com`, which the upstream
  lockfile uses for `xlsx`).
- The upstream `Dockerfile` is unchanged.
