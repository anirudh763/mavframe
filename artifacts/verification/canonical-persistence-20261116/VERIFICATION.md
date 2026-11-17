# Mavframe canonical workspaces and persistence — 2026-11-16

Implemented and deployed locally at port 3003. No commit, push or publication.
Existing dirty changes were preserved. The native C source, public header, Wasm glue
and committed Wasm binary retain their original SHA-256 values (six files).

## Behavior

- `/` and `/overview` show actual parser/capture and server workspace status.
- `/workbench` hosts the existing C/Wasm capture, scenario, frame, anomaly, byte,
  live-radio and finite fuzz workflows. Packet tools remain contextual.
- `/reports` provides actual capture exports and owned server saved runs/artifacts.
- `/settings` contains real server accounts/snapshots, service diagnostics and the
  separately identified existing browser profile/offline tools.
- The four-link 232px desktop rail uses the existing modal Menu drawer below 1000px.
  Legacy hashes and `/anomalies`, `/stream`, `/system` remain supported. Legacy root
  scenario queries normalize to `/workbench` with their scenario query intact.
- Save is explicit. Parsing remains local. A user save uploads a bounded real
  C/Wasm summary, capture bytes and the actual custom XML entry/includes. The
  shared SDK never uploads merely because network connectivity returns.
- The XML artifact uses shared intake/restore limits: 1 MiB per XML file, 4 MiB
  decoded source total, 32 MiB serialized artifact. It has no arbitrary 64-file cap.
  The normal 256 MiB local parser limit and 32 MiB server capture limit remain separate.
- Logout/account changes abort analysis, clear private state and source/counter/
  message/decoded/byte/chart/share/print DOM, and prevent late hashes or downloads
  from restoring private work. The detail DOM skeleton remains reusable.
- SW version: `mavframe-workbench-2026-11-16-29`; API responses stay network-only.

## Reproduction and results

Use the existing Python 3.13 venv at
`/Users/anirudhyadav/Downloads/active/audit-workstation-2026-11-15/mavframe/venv/bin`
in PATH for fixture generation. Default Homebrew Python 3.15 initially lacked
pytest/pymavlink; that environment failure is not a product test result.

| Check | Command | Result |
|---|---|---|
| Native C | `cmake -S . -B build -DMAVFRAME_WERROR=ON && cmake --build build && ctest --test-dir build` | PASS 3/3 |
| Native sanitizers | `cmake -S . -B /tmp/mavframe-canonical-asan -DMAVFRAME_WERROR=ON -DMAVFRAME_SANITIZE=ON && cmake --build /tmp/mavframe-canonical-asan && ctest --test-dir /tmp/mavframe-canonical-asan --output-on-failure` | PASS 3/3 ASan/UBSan |
| Python | Python 3.13 venv `python -m pytest tests -v` | PASS 21/21 |
| Wasm/report/live/fields/scenarios | `node --test tests/web/test_wasm.mjs tests/web/test_capture_report.mjs tests/web/test_live.mjs tests/web/test_display_fields.mjs tests/web/test_scenarios.mjs` | PASS 38/38 |
| Required finding/browser/PWA suite | `SCREENSHOT=1 CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test --test-concurrency=1 tests/web/test_finding.mjs tests/web/test_routes.mjs tests/web/test_ui.mjs tests/web/test_upgrade.mjs` | PASS 63/63, no skips |
| Product/legacy/scenario/custom XML | `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test --test-concurrency=1 tests/web/test_product_routes.mjs tests/web/test_scenario_ui.mjs tests/web/test_custom_dialect.mjs` | PASS 34/34 |
| Live canonical/persistence/privacy | `MAVFRAME_BASE_URL=http://127.0.0.1:3003 CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/web/test_workspace.mjs` | PASS 4/4 |

The canonical test covers each required route at 320/375/768/1024/1440 widths:
20 axe/reflow states, HTTP refresh, title/heading, keyboard drawer containment and
Escape restoration, route focus/history and 200% text sizing. ARIA text artifacts
are Playwright ARIA snapshots, not native speech. Existing suites additionally
cover loaded route states and both-theme scenario states, target sabotage,
finite real parser mutation/fuzz runs, offline parsing and a waiting worker update.
The final 52,436,272-byte responsiveness check observed a 171ms maximum main-thread
gap with 46 intermediate progress values.

The live saved-input check uses a real custom MAVLink packet, verifies the actual
capture and XML artifact bytes after upload, reloads and reopens through C/Wasm,
and verifies the custom decoded message. Separate tests cover 65 include files,
quote-heavy source that would exceed a 5 MiB JSON bundle, logout during a held
hash, and logout during a pending 5.86 MB public sample download.

Generated README screenshots were copied as `readme-*.png` in this directory;
the three pre-existing dirty `docs/screenshots` images were restored byte-for-byte.
Canonical desktop and mobile screenshots were visually inspected. Final container
health is healthy; served app, SDK, XML helper, stylesheet and SW match source.
The copied SDK matches `../runtime/workspace-ui.js` exactly.

## Remaining acceptance owned by the coordinating chat

Root's shared persistence runner will separately cover account/session rotation,
browser profile restart, container restart/recreation, snapshots and cross-owner
access on this final build. Native Safari/VoiceOver speech is not tested by this
agent; no transcript or human screen-reader claim is made. Automated axe and
keyboard results do not establish WCAG certification or production capacity.


## Final race review and deployment 28

The broad native/helper/browser results above were recorded for the initial
integration (worker26). The final bounded review changed only UI concurrency
guards, central label clearing, and the shared SDK late-adapter render fix.
No native/parser code changed.

- Each parse now captures its own AbortController. Progress, result/summary
  commits, error messages, completion and deferred publication check controller
  identity together with the workspace epoch and browser-session nonce.
- Cancel immediately restores the previous result/summary and releases controls.
  A successor file/sample/scenario read invalidates the old canceled controller;
  the old unabortable digest cannot unlock or replace the newer operation.
- File and sample catch/finally paths and caller provenance updates check their
  captured epoch/session. A rejected old file read cannot redisplay its name.
- A canceled custom-dialect recheck restores its previous XML definitions and
  parser extras immediately, with its guarded abort listener removed on settlement.
  Stale summary/dialect combinations cannot be saved.
- Central logout clearing resets the hidden canonical Reports and Overview labels
  even when the existing browser-profile logout renders the legacy public page.
- The copied shared SDK emits after adapter registration and includes restore
  capability in the report-render key. The live test deliberately holds app.js
  until saved records arrive, then verifies Open saved input appears and works.

Evidence: `races-red.log` reproduces all five original failures against worker26;
`dialect-cancel-red.log` reproduces the custom rollback defect against worker27.
`races-workspace-final.log` records **11/11 PASS** on the final deployed worker28:
7 focused race cases plus the 4 existing live workspace cases, including the
20 canonical axe/reflow states. A real 400-copy capture is canceled at a held
parser yield and immediately followed by a successfully parsed synthetic sample.
The keyboard matrix waits for responsive layout frames before operating the
Menu after a viewport switch; all original drawer assertions remain in place.

Command: `MAVFRAME_BASE_URL=http://127.0.0.1:3003 node --test --test-concurrency=1
tests/web/test_workspace_races.mjs tests/web/test_workspace.mjs`.

`races-adjacent-green.log` records **5/5 PASS** for the affected existing final-
handoff cancellation, chunk cancellation, custom XML upload, scenario quick-start
and unknown/download/input-recovery cases. Unaffected broad suites were not repeated.
The coordinating chat already passed 16 persistence/account/restart/recreation/
snapshot/cross-owner groups on worker26 and will rerun its enhanced source-hash
and saved-input checks on this final build. Native VoiceOver remains separately
owned by that chat; no native speech result is claimed here.

Final container health is healthy. Served app.js, shared SDK and sw.js match the
workspace; the copied SDK matches the current shared source exactly. All six
original native C/header/Wasm files retain their recorded SHA-256 values.


## Auxiliary privacy closure — deployment29

A central private reset now invalidates local-profile service operations and
decrypted backup stages, disconnects and aborts cloud work, clears private backup/
auth/cloud/feedback/team/share fields and previews, and cancels print callbacks.
Stored browser profiles, saved view bytes, local profile sessions and original
encrypted files are retained. A successful explicit restore that creates a new
local profile clears the prior profile's active capture/tools before showing the
authorized restore result.

Pending file reads, encryption/decryption, queued backup commits and cloud applies
are guarded before staging, download, write or UI. Cloud callbacks retain their
original provider identity so an old rejection cannot disconnect a new provider.
Report/finding/print/share work is private-epoch fenced; failed native sharing
after invalidation cannot start a clipboard fallback. Work already explicitly
handed to an external browser/OS service cannot be retracted by a later logout.

Scoped production files: `docs/js/app.js`, `docs/js/local-profile.js`,
`docs/js/pwa.js`, worker29, and exact copies of the coordinating chat's compact
`workspace-ui.js/css`. Domain engine/data/routes are unchanged.

- `auxiliary-unit-red.log`: **2/2 reproduced failures** against the old public
  service code: stale decrypted stage commit and post-invalidation clipboard fallback.
- `auxiliary-browser-red.log`: **9/9 reproduced failures** on deployment28.
- `auxiliary-unit-sync-green.log`: **10/10 PASS**, real Web Crypto/service lock
  lifecycle plus the existing sync-provider protocol tests.
- `auxiliary-browser-green.log`: **9/9 PASS** on deployed29: private fields/stage
  revocation, held backup file/decrypt/encrypt, old cloud connection versus a new
  provider, queued cloud apply, pending report, print and share output. Tests wait
  for the real registered async backup handlers to settle after held callbacks.
- `auxiliary-existing-green.log`: **7/7 PASS** for existing saved-write concurrency,
  PBKDF2 logout, backup roundtrip/tamper, UI encrypted restore, overflow/quota rollback,
  actual JSON/CSV/Markdown exports and printable Link Health report.

Commands: `node --test tests/web/test_private_operations.mjs
tests/web/test_sync_provider.mjs`; `MAVFRAME_BASE_URL=http://127.0.0.1:3003
node --test tests/web/test_auxiliary_privacy.mjs`; existing browser tests selected
with `--test-name-pattern` as recorded in the corresponding log. Chrome path and
Python fixture environment remain the ones documented above.

Final29 is healthy. All six protected C/header/Wasm files match their original
SHA-256; served lifecycle JS, shared SDK/CSS and worker match source. SDK/CSS and
persistence source match the coordinating runtime byte-for-byte. No commit, push,
publication or unrelated-app infrastructure change was performed.

## Final installation follow-up — deployment32, November17

Actual Chrome200% testing reproduced a blocked install manifest: the shipped
default-deny CSP omitted `manifest-src`. The only policy change permits the
same-origin manifest; the default, scripts, network origins and parser stay
unchanged. The regression fails on the prior policy and passes on32. Worker32
lets an existing installation discover the corrected HTML.

Current checks: **27 routed browser tests pass** (including opt-in screenshots),
**2 PWA tests pass with no skips** (manifest policy plus real offline caching,
failed-update retention and bad Markdown/SQL/Wasm MIME rejection), and all four
canonical routes pass real Chrome200% zoom with zero console errors or axe
violations. The PWA test opens the existing App and support disclosure before
asserting its visible status; closed disclosure text is not a rendered message.
Fixture generation uses the documented `pymavlink==2.4.50` in the coordinator's
local test venv, rather than the incompatible system Python environment.

Evidence is in the coordinating root's current verification folder:
`mavframe-manifest-red.log`, `mavframe-manifest-current.log` (27 route passes;
its earlier PWA visibility assertion is superseded by the final PWA run),
`mavframe-pwa-final.log`, `mavframe-zoom-fixed.log` and
`zoom/result-mavframe.json`. Source/image follow-up is local only; no commit,
push, public release or paid service was created.
