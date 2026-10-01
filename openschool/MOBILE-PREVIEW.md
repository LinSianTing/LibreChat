# Mobile handoff notice — 2026-10-01

Scope: stack the handoff notice above the composer at every breakpoint; allow dismissing only the success notice, keep edited text and return focus to the composer. The hook remains active to retain account-switch and private-draft protections. Errors and recovery links remain visible. Success is hidden after leaving the new-conversation context. English and Traditional Chinese success copy is shorter.

Base: `b9469ef86` on `openschool/main` (contains deployed `0777f3b46`). Eric approved the local preview and this bounded display release in PM human message `01a0f60f-6939-74a0-b285-e1db38d1abaf`. This is not approval for unrelated product changes or extra paid calls.

## Evidence

- Six targeted Jest suites: 162 passed, including handoff, draft autosave, query parameters, redirect, auth redirect and the notice component. Full client TypeScript check passed. Vite production build passed; existing large-chunk warnings remain.
- Touched TSX files: ESLint zero warnings and import-order check. The final import sort was rebuilt; it does not alter component behavior.
- Actual built frontend with the synthetic API below: 320/390/430/1440px, no horizontal overflow, notice above full-width composer. Keyboard Enter dismiss preserves edited draft and focuses textarea. Long draft and 390x420 reduced viewport checked; focus scrolling brings send control into view. This is not a real virtual keyboard/safe-area device test.
- Expired (404), forbidden (403), unavailable (503) retain recovery links. No model call, database, OAuth or real account used in this preview. Earlier fixture-shape failures were corrected before acceptance; no production authorization rules were changed.
- Screenshots live in the OpenSchool TL ignored artifacts directory `mobile-preview/`, not production files. A separate read-only reviewer checked the privacy/account-state behavior; this is not PM full product acceptance.

## Reproduce the local preview

Build the real client first. Then:

```text
python openschool/mobile-preview.py --dist client/dist --port 15412
```

Open `http://127.0.0.1:15412/preview`. The server binds loopback only, uses synthetic user/prompt fixtures, and rejects model submissions. It is a layout harness, not an authentication service. The intentional service-worker 404 avoids caching the fixture; it can appear in the browser console. Use only synthetic draft text. The production runtime Dockerfile uses explicit COPY paths and excludes the entire `openschool/` development tooling directory.

Do not deploy this Python server, substitute its authentication for Google, or mistake its mock responses for model/authorization evidence. Deployment and data-preservation evidence belongs to the OpenSchool release manifest and milestone, recorded only after execution.
