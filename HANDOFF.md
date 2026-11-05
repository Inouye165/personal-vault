# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer` · **Branch**: `feat/stage-1-foundation` (not pushed, not merged)
- **Reviewed implementation**: `e8e3a2c` (Stage 1 implementation); `a1cc006` is the branch head that was reviewed (it only added the revision line to this file).
- **Correction pass**: committed on top of `a1cc006`. `git log` is authoritative for its hash; this file deliberately does not embed it.
- **Stage 1 status**: all required checks below passed on the correction pass; awaiting independent re-review before Stage 1 is declared closed.

## Correction pass results

| Finding                            | Resolution                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandboxed preload `require("zod")` | `electron.vite.config.ts` bundles Zod into the preload (`externalizeDepsPlugin({ exclude: ['zod'] })`). `out/preload/index.js` now requires only `electron`.                                  |
| Mocked bridge hid failures         | `scripts/smoke.mjs` drives the real app over CDP. `useVaultApi` no longer invents defaults; UI has distinct loading (`role=status`), error (`role=alert`), and confirmed-empty states.        |
| Unsupported Electron 34            | Electron pinned to exact `45.2.3` (Electron 43–45 are the supported majors per electronjs.org timelines checked on 2026-11-05).                                                               |
| Navigation / IPC validation        | `src/main/navigation.ts` (single trusted location, popups denied), `src/main/ipc/sender.ts` (WebContents/frame/URL check), `setTab` ack validated in `src/preload/index.ts` (`TabAckSchema`). |
| Reporting and docs                 | Dev-stage commentary removed from UI; versions recorded below; runtime verification defined as the smoke check.                                                                               |

### Defect found only because of the real-Electron check

The original strict CSP broke `npm run dev` (React Refresh's inline preamble was blocked, so the UI never rendered). This was not caught earlier because development mode was never actually exercised. Fix: a dev-only Vite plugin allows exactly those inline scripts by hash; production CSP is unchanged. The header CSP is applied only for non-dev locations (the dev policy is delivered by the `<meta>` tag).

## Test-first evidence (this correction pass only)

The original implementation's tests were written after the code; no test-first process is claimed for it. In this pass the tests below were written first and run red before any implementation:

- Command: `npm test` → **11 failed tests, 2 suites failed to load** (modules `src/main/navigation` and `src/main/ipc/sender` did not exist), 16 passed.
- Red: preload rejects non-boolean `setTab` acknowledgements (3 failures); renderer loading/error/empty-state and wording tests (8 failures); navigation policy and IPC sender suites (not loadable).
- Then implemented; `npm test` → 5 files, 68 tests passing.
- The smoke check was also validated against the original defect: with Zod externalized again it failed with `window.api is missing`, `Unable to load preload script`, `module not found: zod`, and exit code 1; after restoring the bundling it passed. The dev-mode smoke likewise failed on the CSP defect above before the fix.

## Installed versions (from `npm ls`, lockfile committed)

Changed this pass: `electron` 34.5.8 → **45.2.3** (exact pin; transitive `@electron/get` 2.0.3 → 5.1.0, `extract-zip` removed). No other direct dependency changed.

Direct dependencies as installed: react 19.3.1, react-dom 19.3.1, zod 3.25.76, lucide-react 1.69.0; dev: electron 45.2.3, electron-builder 26.18.0, electron-vite 3.1.0, vite 6.4.5, @vitejs/plugin-react 4.7.0, typescript 5.9.3, vitest 3.2.7, jsdom 26.1.0, @testing-library/react 16.3.3, @testing-library/jest-dom 6.9.1, eslint 9.39.5, prettier 3.9.10, @types/node 22.20.5, @types/react 19.3.0, @types/react-dom 19.3.0.

`npm audit` reports 10 vulnerabilities (7 moderate, 1 high, 2 critical) in the installed tree. This was not triaged; an audit result is not evidence that the application is or is not secure.

## Verification performed

| Command                                  | Result                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `npm test`                               | pass — 5 files, 68 tests                                                       |
| `npm run typecheck`                      | pass                                                                           |
| `npm run lint`                           | pass (see limitation: ESLint has no rules configured)                          |
| `npm run format:check`                   | pass                                                                           |
| `npm run build`                          | pass                                                                           |
| `npm run build:unpack`                   | pass — Electron 45.2.3, `dist/win-unpacked/Personal Vault.exe`                 |
| `node scripts/smoke.mjs --mode=dev`      | pass — bridge values, empty state, hostile navigation/popup blocked, no errors |
| `node scripts/smoke.mjs --mode=built`    | pass                                                                           |
| `node scripts/smoke.mjs --mode=unpacked` | pass — `isPackaged: true`                                                      |

Visual inspection: a screenshot captured over CDP from the unpacked executable was viewed; it showed the shell with navigation, disabled search, and the confirmed empty state with no development commentary. Screenshots of the dev and built runs were captured by the smoke check but only the unpacked one was visually reviewed.

## Limitations and open items

- **ESLint has no rules**: `eslint.config.mjs` only sets ignores, so `npm run lint` passing says little. Out of scope for this pass; recommended before Stage 2 feature code grows.
- Smoke check is Windows-verified only (the unpacked mode looks for `dist/win-unpacked`).
- Unauthorized-sender and navigation policy behavior is covered by unit tests with fake events and, for navigation/popups, by the real-process hostile probe; an unauthorized real second frame calling IPC is not exercised (sandboxed subframes do not receive the preload).
- Renderer bundle is 663 kB (single chunk); acceptable for the shell, revisit with real views.
- Application icon and code signing are not configured.
- No Stage 2 work has been started.

## Immediate next task

Have the correction pass independently re-reviewed; if it passes, close Stage 1 and begin Stage 2 (read-only discovery, metadata inventory, resumable scan jobs) with a first failing test for the read-only scanner boundary.
