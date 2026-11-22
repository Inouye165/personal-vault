# Stage 8C — Release-Readiness Plan

**Status:** Draft for Review (Stage 8B closed at `8cfebe6`; Stage 8C starting)  
**Baseline:** Branch `feat/stage-7b-document-extraction`, commit `8cfebe6` (`128/128` test files, `1,712/1,712` tests passing on Windows x64)

---

## 1. Supported Platforms & Installer Status

### What already has evidence

- **Windows x64 unpacked build (`dir`)**: `electron-builder.json5` packages `dist/win-unpacked/Personal Vault.exe` (Electron `45.2.3`), unpacking native/WASM runtime assets (`sharp`, `@img`, `@napi-rs`, `tesseract.js-core/*.wasm`, `onnxruntime-node/bin/napi-v6/win32/x64/**/*`) and bundling `THIRD_PARTY_NOTICES.md`.
- **Packaged runtime verification**: All Stage 1–8B unpacked Electron verification suites (`smoke:unpacked`, `verify:backup:unpacked`, `verify:recovery:unpacked`, `verify:unified-search:unpacked`, etc.) pass against `dist/win-unpacked/Personal Vault.exe` on Windows 11 x64.

### What still needs verification

- **Installers & upgrade/uninstall**: The Windows x64 NSIS installer passed install, upgrade, uninstall, and reinstall checks using isolated test data on the current host. The `0.0.9` installer was built from the same source as `0.1.0`, using an overridden package version. The v1 to v19 catalog schema migration was exercised separately. Clean-VM verification and macOS/Linux installers remain open.
- **Branding & build resources**: `build/` does not exist yet; `electron-builder` currently falls back to the default Electron icon.
- **Cross-platform native/lock gaps** (if macOS/Linux are included in v1):
  - `electron-builder.json5` `asarUnpack` only includes `onnxruntime-node/bin/napi-v6/win32/x64/**/*`.
  - `acquireOsProfileLock` (`src/main/services/backup/catalog-recovery.ts`) uses POSIX `.sock` files in `os.tmpdir()` without stale-socket cleanup after `SIGKILL`.

### Release blockers & decisions required

1. **Platform scope decision (8C-1 Locked for internal build: Windows x64 first)**: Slice 8C-1 targets an internal **Windows x64** NSIS installer (`dist/Personal Vault Setup 0.1.0.exe` alongside `dist/win-unpacked/Personal Vault.exe`). macOS / Linux packaging (`asarUnpack` rules, POSIX `.sock` cleanup in `acquireOsProfileLock`, and clean-machine OS verification) remains deferred.
2. **Code signing & SmartScreen / notarization decision (Open — deferred)**: `electron-builder` skips Authenticode signing (_"no code signing certificate configured"_). Public Windows distribution decisions (Authenticode signing / SmartScreen) remain open for later.
3. **Google Drive OAuth distribution decision (8C-1 Kept Opt-In; Public distribution Open — deferred)**: Live Drive OAuth remains opt-in using the existing `PV_GOOGLE_CLIENT_ID` / `PV_GOOGLE_CLIENT_SECRET` environment configuration. Public distribution decisions (embedded public Desktop OAuth client ID + Google OAuth app verification for `drive.file`) remain open for later.

---

## 2. Security & Privacy Checks

### What already has evidence

- **Process isolation & navigation**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, `will-navigate` and `setWindowOpenHandler` denial (`src/main/index.ts`, `tests/main/navigation.test.ts` 22/22), and 100% Zod-validated IPC/preload (`tests/preload/bridge.test.ts` 20/20, `tests/main/ipc.test.ts` 746/746).
- **Source preservation**: Read-only discovery, hashing, thumbnails, EXIF, OCR, semantic indexing, export, backup, and catalog recovery verified bitwise invariant across all Stage 2–8B suites.
- **Encryption & secrets**: Google Drive tokens stored via Electron `safeStorage`; cloud backups use `aes-256-gcm-v1` (`scrypt` + HKDF + HMAC-SHA256 chunk IDs + encrypted `snapshot.pvenc`), failing closed on wrong/missing secrets without creating target directories.
- **Offline-first AI/OCR**: CLIP, BGE, and `tesseract.js-core` `eng.traineddata` never auto-download and send zero personal files/queries over the network.

### What still needs verification

- **Fresh dependency vulnerability & license audit**: Run `npm audit` and verify `THIRD_PARTY_NOTICES.md` covers all production runtime dependencies (Stages 1–8B).
- **Recovered profile read-only coordinators**: `HANDOFF.md` notes `PhotoMetadataCoordinator`, `SemanticIndexCoordinator`, and `DocumentOcrCoordinator` are not yet wired through `resolveReadableFileLocation` for Stage 8B Slice 2 read-only recovered profiles — verify or explicitly gate/disclose before release.
- **Log & crash-report redaction review**: Confirm `startup.log` and backup/export error messages never persist OAuth tokens, recovery passphrases, or unintended PII.

### Release blockers

- Any unresolved `high` or `critical` production dependency vulnerability in `npm audit`.
- Missing Google OAuth app verification if shipping a built-in `PV_GOOGLE_CLIENT_ID` to public users.

---

## 3. Performance & Reliability Baselines

### What already has evidence

- **Photo browsing & search at 10k+ scale**: Stage 5A (`10,000` photos: `rAF` p95 `4.30 ms <= 33 ms`, main-loop p95 `35.91–57.38 ms <= 100 ms`, `<= 200` mounted DOM cells) and Stage 6E (`10,216` vectors: `mainLoopP95 = 17.1–18.2 ms`, `rAF p95 = 4.3 ms`).
- **Bounded workers**: `AppWorkerBudget(3)` enforces bounded concurrency, cancellation, and startup `interrupted` recovery across thumbnail, metadata, semantic, OCR, document, and backup workers.
- **Backup & restore**: Verified cross-drive atomic restore, crash-boundary cleanup, and live Google Drive cold-restart verify/restore with exact SHA-256 match.

### What still needs verification

- **Realistic mixed-library end-to-end validation**: Run a realistic personal corpus (large photos, multi-page PDFs, DOCX, duplicates, annotations, export, and backup/restore) rather than synthetic fixtures alone.
- **Live NAS SMB/UNC throttling**: `TransferRateLimiter` is unit-tested, but live Windows UNC/SMB throttling remains unverified.
- **Packaged installer cold-start & upgrade migration**: Verify SQLite schema migrations (`1 -> 19`) and `<userData>` retention across an actual installed upgrade.

### Release blockers

- Any unbounded memory growth, worker leak, or main-thread stall on realistic mixed-library runs.

---

## 4. User Documentation

### What already has evidence

- **Developer & contributor docs**: `README.md` (dev setup, verification scripts, Stage 6–7F workflows/limitations), `ARCHITECTURE.md`, `THIRD_PARTY_NOTICES.md`, and stage evaluation plans in `docs/`.

### What still needs creation

1. **User Installation & Quick-Start Guide**: Installing/uninstalling, choosing source folders, initializing a vault, and understanding read-only source guarantees.
2. **Privacy & Offline Guarantees**: What stays strictly local, when network access occurs (explicit model downloads, opt-in Google Drive backup), and how `Export` / `Backup` handle metadata.
3. **Backup, Recovery Secret & Disaster Recovery Guide**: Local USB/NAS vs. encrypted Google Drive, custody of the recovery secret (cannot be reset if lost), full profile restore vs. `"Recover from an existing vault"`.
4. **Known Limitations & Support Route**: Supported formats (e.g., camera RAW/SVG unsupported, uncalibrated AI similarity scores), and where users report defects.

### Release blockers

- Shipping without user-facing backup/recovery-secret custody guidance and a documented issue-reporting route.

---

## 5. Recommended First Bounded 8C Implementation Slice

### Slice 8C-1: Release Scope Lock, Dependency/Security Audit & Windows NSIS Installer

**Goal:** Lock v1 platform scope (Windows x64 first, with macOS/Linux explicitly deferred or scheduled), verify dependency/notice hygiene, and produce a working, tested Windows installer.

**Deliverables:**

1. Record platform, signing, and Google Drive OAuth distribution decisions in `STAGES.md` / `docs/stage-8c-release-readiness-plan.md`.
2. Add Windows app icon / build resources (`build/`) and configure `nsis` target in `electron-builder.json5` (producing an installer alongside `dir`).
3. Run `npm audit --omit=dev`, audit `THIRD_PARTY_NOTICES.md` against `package-lock.json`, and audit `startup.log`/error paths for secret/token redaction.
4. Execute clean-environment Windows install → smoke check → upgrade → uninstall test verifying `<userData>` and vault preservation.

**Acceptance Tests for Slice 8C-1:**

- `npm audit --omit=dev` reports `0` high/critical vulnerabilities (or documented, mitigated exceptions).
- `THIRD_PARTY_NOTICES.md` matches all bundled production packages and model artifacts.
- `electron-builder` produces a clean Windows NSIS installer that installs, launches with passing `window.api` bridge & CSP checks, upgrades without data loss, and uninstalls cleanly while preserving user vault/profile data.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run smoke:unpacked` all pass (`exit 0`).
