# OpenSchool-Chat branding

Scope: browser title, favicon, forest semantic theme and four text links in the existing left panel. Chat history, authentication, controlled error-return links, provider capabilities and upstream credits remain in place. This is a fork feature branch; PM owns integration into `openschool/main`.

## Configuration

- **Runtime** `APP_TITLE=OpenSchool-Chat`. The OpenSchool Dockerfile supplies this default. Set it explicitly when running with another recipe or an existing Compose environment; an explicit runtime value takes precedence. Conversation tabs append ` · <APP_TITLE>`, including direct URLs, reload and browser Back. The existing “display chat title” opt-out still uses the application title only.
- **Build time** `VITE_OPENSCHOOL_BASE_URL=https://openschool.langracetech.com`. The OpenSchool Dockerfile accepts `--build-arg VITE_OPENSCHOOL_BASE_URL=...`. For a local paired frontend, set this variable **before** the frontend build (for example `http://127.0.0.1:5199`). Changing the runtime environment alone cannot change already compiled links.
- The base value must be an absolute HTTPS origin, or HTTP loopback for local development, with no credentials, non-root path, query or fragment. Invalid/empty values hide the four links; unset uses the public OpenSchool origin. This is deployment-controlled configuration, never taken from browser queries or user profiles. It is intentionally Vite configuration rather than a new server policy/config-schema field: navigation has no backend behavior and does not modify the shared identity/config route.
- This is separate from existing `OPENSCHOOL_RETURN_URL`, which controls the error page's existing return link. Preserve that setting. Four sidebar links use normal same-tab navigation to `/me`, `/courses`, `/schedule`, `/simulation/ai-circles`. No implicit identity transfer or new membership is introduced.
- Existing `REACT_APP_THEME_*` overrides retain precedence. Otherwise the version-1 forest `ThemeDefinition` uses the canonical registry; saved light/dark/system and high-contrast preferences remain supported. No custom provider/status semantics are added.

## Visual provenance

OpenSchool source: `1411a61bb4f441bbcfb297b84aa5ce6a25110270`, `src/OpenSchool.Web/wwwroot/css/tokens.css` forest light/dark values, `_Layout.cshtml` Site.Mark and `site.css` `.brand-mark`. The actual source favicon is an academy symbol, not the 開 mark: the new `openschool-mark.svg` adapts the rendered 開 circle with forest green and gold, rather than claiming to copy that unrelated SVG. It uses local system font fallback, no remote font request. The unchanged upstream Apple/PWA icons and install metadata are outside this browser-favicon scope.

## Reproduce focused verification (PowerShell, Node 24)

```powershell
npm ci --no-audit --no-fund
npm run frontend
Push-Location client
npx tsc --noEmit
npx jest --runInBand --coverage=false --runTestsByPath src/openschool/__tests__/branding.spec.tsx src/utils/__tests__/documentTitle.test.ts src/components/Nav/SettingsTabs/General/__tests__/ChatTitleInTab.spec.tsx src/routes/__tests__/ChatRoute.spec.tsx src/hooks/Config/__tests__/useAppStartup.spec.tsx
Pop-Location
$env:E2E_BASE_URL='http://127.0.0.1:15312'
$env:E2E_CHROMIUM_CHANNEL='chrome'
npx playwright test --config openschool/playwright.branding.config.ts
$env:CHROME_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:OPENSCHOOL_QA_LIGHTHOUSE='1'
npx playwright test --config openschool/playwright.branding.config.ts
Remove-Item Env:OPENSCHOOL_QA_LIGHTHOUSE
```

The isolated harness refuses another destination, starts its own disposable MongoDB, and registers a synthetic user. It does not reuse an existing server, database, Google session or paid model. The setup explicitly selects English to avoid OS Chrome language affecting selectors. Browser cases cover 390/1440 × English/Traditional Chinese × light/dark, title reload/new chat/Back, favicon response, keyboard focus, no horizontal overflow, saved high contrast, persisted synthetic history, and same-tab links. Destination navigation is intercepted with synthetic responses, so it does **not** prove OpenSchool destination authorization or Google identity continuity. The base-URL unit tests also exercise a non-default loopback origin.

Screenshots and traces: `e2e/specs/.test-results/branding/` (ignored). Lighthouse reports: `.lighthouse/` (the upstream auditor clears that directory). The performance case reuses upstream `load.spec.ts`, its 250-ms Mongo query delay, three runs, and original LCP/CLS/TBT budgets. A local test-user login is an E2E fixture, not a production identity feature.

## Verification record

Base: LibreChat `fb3472c4d6bccc777837843759310de688912950`.

- Production frontend build passed. Existing dependency eval/chunk-size/Tailwind warnings remain; this is not a zero-warning claim.
- Client `tsc --noEmit` passed; 43 focused Jest tests passed.
- Nine browser cases passed with the built frontend and disposable database. Desktop dark and mobile layout inspected. Initial runs caught and fixed direct-load title restoration and legacy list-anchor styling; earlier failed runs are not acceptance evidence.
- Upstream Lighthouse setup initially failed because OS Chrome opened Chinese while setup searched English. The scoped setup above fixes test language without changing product authentication. Both the installed Chrome and portable Chromium attempts stopped with Windows `EPERM` while chrome-launcher removed its temporary profile. A first report was emitted, but the three-run median gate did not complete: **Lighthouse remains unverified**, not passed. No timing budget or dependency was changed to hide this limitation.
- Read-only Luna review of workflow triggers found no image publishing/deploy workflow for a push of `codex/openschool-chat-branding`; repo-external hooks were not verified. Sol reviewed the scoped diff; its test-target guard finding was fixed and a follow-up review found no new required fix. These reviews do not substitute for PM product acceptance.

No merge, deployment, tag, dependency/lockfile change, or paid model invocation is included. Google multi-account isolation, organization membership, allowances, live AI replies, destination authorization and full-product regression are not verified here.
