# Stage 8C — Windows Personal-Use Packaging & Readiness Record

**Status:** Complete for personal Windows x64 desktop use (Candidate commit `b6e608bb5b3bd799545200fd2e657e6198a86bd0` / `b6e608b`; `Personal Vault Setup 0.1.0.exe` SHA-256 `fef0b47b358253b16df82283ab2d2a83a14c7ff200bcf7b374b316779212cb74`).

**Scope Decision (Ron):** Windows x64 is the only supported platform for this closeout. Public release (Stage 8E), public Authenticode signing / SmartScreen reputation, public Google Drive OAuth app verification / embedded client credentials, macOS / Linux installers, mobile, and enabled public auto-update feeds are **out of scope**. Private local/USB/NAS backup, opt-in env-var Google Drive encrypted backup (`PV_GOOGLE_CLIENT_ID` / `PV_GOOGLE_CLIENT_SECRET`), and catalog recovery remain active and verified.

---

## 1. Windows x64 Packaging & Clean-Machine Verification

- **Bundled Installer & Unpacked Build (`electron-builder.json5`, `build/installer.nsh`)**:
  - `dist/Personal Vault Setup 0.1.0.exe` (`259,312,272` bytes, SHA-256 `fef0b47b358253b16df82283ab2d2a83a14c7ff200bcf7b374b316779212cb74`) alongside `dist/win-unpacked/Personal Vault.exe` (`249,831,936` bytes, SHA-256 `e88517887614a2d72197067f4b79e35558bc190aed56207d2de326a2bcd3f24e`).
  - `build/icon.ico` bundled; native/WASM assets (`sharp`, `@img`, `@napi-rs/canvas`, `tesseract.js-core/*.wasm`, `onnxruntime-node/bin/napi-v6/win32/x64/**/*`) unpacked into `app.asar.unpacked` with zero `spikes/` packaged.
  - Embeds Microsoft-signed `vc_redist.x64.exe` (`14.44.35211.0`, SHA-256 `cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b`, `Valid` Microsoft Authenticode signature), installed automatically when any of the 5 VC++ 2015–2022 runtime DLLs is absent from `System32`.
- **Clean Windows x64 Sandbox Evidence (`4033b243`)**:
  - Preserved build `Personal Vault Setup 0.1.0-4033b243.exe` (SHA-256 `4033b2431e7bc75a96df50890120eb9c03e0772050204a8c33d21c486db41d2d`) passed **8/8 checks** in fresh Windows Sandbox (`D:\pv-sandbox-out-4033b243-2\results.json`), including fresh `vc_redist.x64.exe` install from zero preinstalled DLLs (`exit 0`), bridge smoke, `0.0.9 -> 0.1.0` upgrade, `v1 -> v19` SQLite migration, uninstall/reinstall profile & vault preservation, and `recoveredProfileChecks` across all 4 coordinators (`PhotoMetadataCoordinator`, `SemanticIndexCoordinator`, `DocumentExtractionCoordinator`, `DocumentOcrCoordinator`).
- **Merged-UI Candidate Verification (`b6e608b`)**:
  - Passes all quality gates (`typecheck`, `lint`, `npm test` `136/136` files / `1,739/1,739` tests after `npm run build`, `npm audit --omit=dev` = `0` vulnerabilities, `npx prettier --end-of-line auto --check .`), unpacked Electron suites (`smoke:unpacked`, `verify:vault:unpacked`, `verify:duplicates:unpacked`, `verify:photos:unpacked`, `verify:semantic-search:unpacked`, `verify:documents:unpacked`, `verify:doc-semantic-search:unpacked`, `verify:unified-search:unpacked`, `verify:backup:unpacked`, `verify:recovery:unpacked`), and `verify:windows-candidate` (including non-default export folder, search LRU eviction fix, Dark/Light theme persistence, and isolated-`appId` NSIS lifecycle).

---

## 2. Security, Privacy & License Summary

- **Process Isolation & IPC Validation**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, restricted `will-navigate`/`setWindowOpenHandler`, top-frame sender validation, sandboxed preload requiring only `electron` (`147`-method typed `window.api`), and bidirectional Zod validation.
- **Source Preservation**: Strict `O_RDONLY` reads across discovery, hashing, thumbnails, **Open original** (`photos:get-original`), EXIF, semantic indexing, document extraction, OCR, export, backup, and catalog recovery; zero in-app file deletion.
- **Dependency & License Hygiene**: `npm audit --omit=dev` reported `0` vulnerabilities; `THIRD_PARTY_NOTICES.md` and `tests/main/release-audit.test.ts` cover production packages, models, and secret/token redaction in `startup.log` and Drive auth errors.
- **Manual Upgrade Path (No Feed Enabled)**: Ron installs updates manually using a verified Windows NSIS build; `%APPDATA%\Personal Vault` (`vault-catalog.db`) and external vaults are preserved across manual installs and uninstalls.

---

## 3. Audit of Separate Local Auto-Updater Work (`D:\organizer` commit `809b0b8`)

Inspecting `D:\organizer` read-only on branch `feat/windows-release-updater` (`809b0b8`, _`"feat(release): add Windows release pipeline and safe NSIS auto-updater"`_, kept separate and **not** integrated here):

- **What `809b0b8` contains (`43` files changed, `+4,632/-381` lines)**:
  - Adds runtime dependency `electron-updater@^6.8.11` and Windows updater subsystem (`src/main/services/updater/coordinator.ts`, `electron-adapter.ts`, `index.ts`), active backup/vault job deferral hooks (`src/main/services/backup/coordinator.ts`, `src/main/services/vault/coordinator.ts`), updater IPC/schemas (`src/main/ipc/update-handlers.ts`, `src/shared/validation/update-ipc-schemas.ts`, `channels.ts`), UI banner & hook (`src/renderer/src/components/UpdateBanner.tsx`, `src/renderer/src/hooks/useAppUpdater.ts`, `App.tsx`, `Sidebar.tsx`, `index.css`), GitHub Actions workflows (`.github/workflows/ci-pr.yml`, `release-candidate.yml`, `publish-update-feed.yml`, `.github/CODEOWNERS`), release scripts (`scripts/build-release.mjs`, `scripts/verify-release-bundle.mjs`, `scripts/verify-updater-windows.mjs`), documentation (`docs/windows-release-pipeline.md`, `THIRD_PARTY_NOTICES.md`), and unit tests (`tests/main/{release-pipeline,update-coordinator,update-ipc}.test.ts`, `tests/renderer/update-banner.test.tsx`).
- **What would be required to integrate and verify it later (only if Ron decides to add auto-updates)**:
  1. **Rebase/Merge onto `main` and Resolve UI & Contract Conflicts**: `809b0b8` branched from `00f3f5d` _before_ PR #1 (`ba1fa94` onboarding) and PR #2 (`e50cecb` Light/Dark theme + Photos search UX), so `src/renderer/src/App.tsx`, `Sidebar.tsx`, `index.css`, `scripts/smoke.mjs` (`147` current `window.api` methods vs updater's extra methods), and top-level docs (`HANDOFF.md`, `TODO.md`, `README.md`, `AGENTS.md`, `ARCHITECTURE.md`) require clean reconciliation and `tests/preload/bridge.test.ts` updates.
  2. **Align Repository Metadata & Formatting Rules**: Update GitHub default branch `origin/HEAD` (currently pointing to `refs/heads/feat/stage-1-foundation`) to `main` before activating `.github/CODEOWNERS` or workflows; reconcile `.github/workflows/ci-pr.yml` (`npm run format:check` fails on Windows checkouts under Git `core.autocrlf=true` unless `--end-of-line auto` or `.gitattributes` is configured).
  3. **Define Signing, Feed Hosting & Safety Policy**: Choose whether an update feed is private/local or GitHub Releases (`publish-update-feed.yml`), configure Windows Authenticode signing or explicit signature-check policy, define rollback/channel metadata, and review `electron-updater` in `THIRD_PARTY_NOTICES.md` and `npm audit --omit=dev`.
  4. **Run Dedicated Updater & Release Verification**: Install dependencies (`electron-updater`), rebuild, run full unit + Electron tests including the updater unit/IPC/banner suites, run `npm run build:release` and `npm run verify:release-bundle`, and run the two-build installed Windows updater E2E test (`npm run verify:updater`) against an isolated test feed before publishing any release feed.
  - **Current Status**: Kept strictly separate in `D:\organizer`; no update feed is enabled or published.

---

## 4. Explicitly Out of Scope / Deferred

- **Out of Scope**: Stage 8E public release, Authenticode/SmartScreen public signing, public Google Drive OAuth app verification / embedded client ID, macOS & Linux installers (`asarUnpack` rules + POSIX `.sock` stale cleanup in `acquireOsProfileLock`), mobile clients, and public update feeds.
- **Deferred (Non-Blocking)**: Remaining Pre-Stage-7 modularity splits, Stage 7D `F2`/`F3` doc-search polish, Stage 8A orphaned top-level `.pv-meta.json` inspection note, live NAS UNC throttling benchmark, in-app file deletion (excluded/not implemented), and `D:\organizer` `809b0b8` auto-updater (awaiting Ron decision if wanted post-closeout).
