# OpenSchool-Chat branding

Scope: browser title, favicon, forest semantic theme and four text links in the existing left panel. Chat history, authentication, controlled error-return links, provider capabilities and upstream credits remain in place. This is a fork feature branch; PM owns integration into `openschool/main`.

## Configuration

- **Runtime** `APP_TITLE=OpenSchool-Chat`. The OpenSchool Dockerfile supplies this default. Set it explicitly when running with another recipe or an existing Compose environment; an explicit runtime value takes precedence. Conversation tabs append ` · <APP_TITLE>`, including direct URLs, reload and browser Back. The existing “display chat title” opt-out still uses the application title only.
- **Runtime** `OPENSCHOOL_RETURN_URL=https://openschool.langracetech.com/simulation/ai-circles` for the controlled chat deployment. The sidebar reads the existing post-login startup config field `openschoolReturnUrl` and derives its origin. Set the server environment and restart the server, then reload chat to fetch the updated config. No new server field is needed. `VITE_OPENSCHOOL_BASE_URL` and its former Docker build argument are no longer used; stale build values cannot override runtime navigation.
- The sidebar accepts an absolute HTTPS return URL, or HTTP loopback (`localhost`, `127.0.0.1`, `[::1]`) for local development, with no credentials, query or fragment. Its path is discarded when deriving the origin. Missing, empty, invalid or not-yet-loaded config hides all four links; there is **no public-production fallback**. This is deployment-controlled configuration, never taken from browser queries or user profiles.
- Four sidebar links use normal same-tab navigation to `/me`, `/courses`, `/schedule`, `/simulation/ai-circles`. The existing refusal return flow still uses the full configured URL and its exact-match rules, opening a separate tab; the footer is unchanged. No implicit identity transfer or new membership is introduced.
- Existing `REACT_APP_THEME_*` overrides retain precedence. Otherwise the version-1 forest `ThemeDefinition` uses the canonical registry; saved light/dark/system and high-contrast preferences remain supported. No custom provider/status semantics are added.

## Visual provenance

OpenSchool source: `1411a61bb4f441bbcfb297b84aa5ce6a25110270`, `src/OpenSchool.Web/wwwroot/css/tokens.css` forest light/dark values, `_Layout.cshtml` Site.Mark and `site.css` `.brand-mark`. The actual source favicon is an academy symbol, not the 開 mark: the new `openschool-mark.svg` adapts the rendered 開 circle with forest green and gold, rather than claiming to copy that unrelated SVG. It uses local system font fallback, no remote font request. The unchanged upstream Apple/PWA icons and install metadata are outside this browser-favicon scope.

## Reproduce focused verification (PowerShell, Node 24)

With dependencies installed, the runtime-source change needs only these focused unit tests (no MongoDB, browser, Docker or Lighthouse):

```powershell
Push-Location client
npx jest --runInBand --coverage=false --runTestsByPath src/openschool/__tests__/branding.spec.tsx src/components/Messages/Content/__tests__/OpenSchoolReturn.spec.tsx src/components/Messages/Content/__tests__/Error.spec.tsx
Pop-Location
Push-Location api
npx jest --runInBand --coverage=false --runTestsByPath server/routes/__tests__/config.spec.js --testNamePattern=openschoolReturnUrl
Pop-Location
```

### Optional browser reproduction prerequisites

The existing local pair is OpenSchool at `http://127.0.0.1:15311` and chat at `http://127.0.0.1:15312`. Set chat's runtime `OPENSCHOOL_RETURN_URL=http://127.0.0.1:15311/simulation/ai-circles`. In the isolated branding harness this is already set by `playwright.branding.config.ts`; destination responses are intercepted, so no OpenSchool server is needed for those synthetic cases. For manual destination checks, both applications must be running independently. Leave port 15312 free for the harness; it starts its own chat server.

Use a checkout with its own writable dependencies for installation/builds; do not run `npm ci` or rebuild through a dependency junction shared with another agent. Install dependencies and build the frontend plus workspace packages (`npm run e2e:prepare`, equivalent to `npm run frontend`). Use installed Chrome with `E2E_CHROMIUM_CHANNEL=chrome`, or install Playwright Chromium separately. The harness requires `E2E_REPLICAS=1`, forces `E2E_USE_MEMORY_MONGO=true`, and needs an executable MongoDB binary for `mongodb-memory-server`: allow its initial download, use an existing cache, or set `MONGOMS_SYSTEM_BINARY` to a compatible local `mongod`. MongoDB binds an available loopback port; no Docker or pre-existing MongoDB service is required. A missing binary/download access prevents startup, not a product-test failure.

For a separately authorized browser/performance run:

```powershell
npm ci --no-audit --no-fund
npm run e2e:prepare
Push-Location client
npx tsc --noEmit
npx jest --runInBand --coverage=false --runTestsByPath src/openschool/__tests__/branding.spec.tsx src/utils/__tests__/documentTitle.test.ts src/components/Nav/SettingsTabs/General/__tests__/ChatTitleInTab.spec.tsx src/routes/__tests__/ChatRoute.spec.tsx src/hooks/Config/__tests__/useAppStartup.spec.tsx
Pop-Location
$env:E2E_BASE_URL='http://127.0.0.1:15312'
$env:E2E_REPLICAS='1'
$env:E2E_CHROMIUM_CHANNEL='chrome'
npx playwright test --config openschool/playwright.branding.config.ts
$env:CHROME_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:OPENSCHOOL_QA_LIGHTHOUSE='1'
npx playwright test --config openschool/playwright.branding.config.ts
Remove-Item Env:OPENSCHOOL_QA_LIGHTHOUSE
```

The isolated harness refuses another chat destination, starts its own disposable MongoDB, and registers a synthetic user. It does not reuse an existing server, database, Google session or paid model. The setup explicitly selects English to avoid OS Chrome language affecting selectors. Browser cases cover 390/1440 × English/Traditional Chinese × light/dark, title reload/new chat/Back, favicon response, keyboard focus, no horizontal overflow, saved high contrast, persisted synthetic history, and same-tab links to the runtime-configured 15311 origin. Destination navigation is intercepted with synthetic responses, so it does **not** prove OpenSchool destination authorization or Google identity continuity. The runtime navigation unit tests also exercise other loopback origins and ignore stale build-time values.

Screenshots and traces: `e2e/specs/.test-results/branding/` (ignored). Lighthouse reports: `.lighthouse/` (the upstream auditor clears that directory). The performance case reuses upstream `load.spec.ts`, its 250-ms Mongo query delay, three runs, and original LCP/CLS/TBT budgets. A local test-user login is an E2E fixture, not a production identity feature.

## Verification record

### Runtime-source fix (2026-09-30)

Source: `7628b9e79b434fdc465a4f2156d721cafd92bb85` plus the scoped changes in this commit.

- Client branding, refusal-return and error unit suites: **187 passed**. Server `openschoolReturnUrl` cases: **8 passed**, 60 unrelated cases excluded by the test-name filter. The client tests cover all four runtime destinations, stale build values, loading/missing/invalid config, origin changes, HTTPS and HTTP loopback.
- Changed-file ESLint, Prettier, import-order and `git diff --check` passed. Node 24.18.0; existing dependency junctions were read only (client/api junctions added locally to resolve workspace-specific test dependencies). Initial test starts lacked those workspace dependencies; the results above are the successful reruns.
- No server field or validation change, footer/refusal-flow implementation change, or `socialLogin.js` change. No frontend build, typecheck, browser E2E, Lighthouse, Docker or full suite run in this focused-unit-only task. Browser assertions now match the harness's runtime 15311 origin but were not rerun. No push or deployment; this is engineering self-verification, not PM acceptance.

### Earlier branding verification

Base: LibreChat `fb3472c4d6bccc777837843759310de688912950`.

- Production frontend build passed. Existing dependency eval/chunk-size/Tailwind warnings remain; this is not a zero-warning claim.
- Client `tsc --noEmit` passed; 43 focused Jest tests passed.
- Nine browser cases passed with the built frontend and disposable database. Desktop dark and mobile layout inspected. Initial runs caught and fixed direct-load title restoration and legacy list-anchor styling; earlier failed runs are not acceptance evidence.
- Upstream Lighthouse setup initially failed because OS Chrome opened Chinese while setup searched English. The scoped setup above fixes test language without changing product authentication. Both the installed Chrome and portable Chromium attempts stopped with Windows `EPERM` while chrome-launcher removed its temporary profile. A first report was emitted, but the three-run median gate did not complete: **Lighthouse remains unverified**, not passed. No timing budget or dependency was changed to hide this limitation.
- Read-only Luna review of workflow triggers found no image publishing/deploy workflow for a push of `codex/openschool-chat-branding`; repo-external hooks were not verified. Sol reviewed the scoped diff; its test-target guard finding was fixed and a follow-up review found no new required fix. These reviews do not substitute for PM product acceptance.

No merge, deployment, tag, dependency/lockfile change, or paid model invocation is included. Google multi-account isolation, organization membership, allowances, live AI replies, destination authorization and full-product regression are not verified here.
