# OpenSchool fork of LibreChat

This fork carries the small changes that the OpenSchool platform (開放學校平台) needs on top of
LibreChat. LibreChat is MIT licensed; upstream is <https://github.com/danny-avila/LibreChat>.

## Branches（分支規則）

| Branch | Purpose |
|---|---|
| `main` | 社群版本的同步與調整。**不放 OpenSchool 專屬修改。** |
| `openschool/main` | OpenSchool 的整合分支。所有 OpenSchool 修改都進這裡；OpenSchool 的本機開發與安裝驗證都以它為準。 |
| `openschool/version/<major>_<minor>_<patch>` | 需要固定版本線時才從 `openschool/main` 切出，例如 `openschool/version/1_0_0`、`openschool/version/1_1_0`。 |

- 修改一律經 PR 進 `openschool/main`；不改寫歷史、不 force push。
- 跟進上游：把上游的 release tag（或本 fork 的 `main`）**merge** 進 `openschool/main`，不 rebase。merge 後重跑下方檢查。
- 每個修改保持小、以環境變數開啟、預設與上游行為相同，讓 merge 衝突維持在最少。
  因此修補直接寫在原本的 CJS 檔（例如 `api/strategies/socialLogin.js`），而不是依上游 CLAUDE.md 搬進 `/packages/api`：
  這是刻意的取捨，換取跟進上游時衝突最小。

## Patches（目前的修改）

| Env var | File | What it does |
|---|---|---|
| `OPENSCHOOL_STRICT_SOCIAL_ID=true` | `api/strategies/socialLogin.js` | Social login continues an existing account only when the provider ID matches. An account found only by email is refused (`AUTH_FAILED`) instead of being taken over, and no provider ID is written. The admin path (`existingUsersOnly`) keeps the upstream handling. Off unless the value is exactly `true` (case-insensitive). |

Why: OpenSchool's AI gateway trusts the Google subject that LibreChat forwards
(`{{LIBRECHAT_USER_GOOGLEID}}`). Upstream falls back to email when the Google ID is not found, so a
different Google account with the same email would be logged in as — and forwarded as — the
existing user. See OpenSchool ADR-0000015 / SPEC-0000021 (in the OpenSchool repository).

## Checks

```bash
npm ci && npm run build:data-provider && npm run build:data-schemas && npm run build:api
cd api && npx jest strategies/socialLogin.test.js
```

## Building an image

- `docker build -f openschool/Dockerfile -t openschool-librechat:<commit> .`
  Same steps as the upstream `Dockerfile` but on a Debian node image and without the uv/ghcr stage,
  so it only needs Docker Hub and the npm registry (plus `cdn.sheetjs.com`, which the upstream
  lockfile uses for `xlsx`).
- The upstream `Dockerfile` is unchanged.
