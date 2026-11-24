# Stage 8D — Personal Windows Trial Checklist & Readiness Record

- **Candidate Commit:** `b6e608bb5b3bd799545200fd2e657e6198a86bd0` (`b6e608b`, branch `chore/windows-closeout` on top of merged `main` `a61e0a10791519ea51a1296c5a90c538119f2704`)
- **Installer Executable:** `D:\workspace\personal-vault\dist\Personal Vault Setup 0.1.0.exe` (`259,312,272` bytes)
- **Installer SHA-256:** `fef0b47b358253b16df82283ab2d2a83a14c7ff200bcf7b374b316779212cb74`
- **Unpacked Executable SHA-256 (`dist/win-unpacked/Personal Vault.exe`):** `e88517887614a2d72197067f4b79e35558bc190aed56207d2de326a2bcd3f24e`
- **Status:** **Complete. Ron accepted the Windows x64 candidate for personal use on November 24, 2026.**

---

## 1. Safe Execution Rules Before You Start

1. **Protect existing personal data first**:
   - Leave your real `%APPDATA%\Personal Vault` profile, real vault, and prior trial folder (`D:\pv-stage-8d-trial\`) untouched—or run this candidate in an isolated trial directory (`D:\pv-stage-8d-candidate-trial\`).
   - To run completely isolated on the same Windows PC without touching `%APPDATA%\Personal Vault`, either install into a dedicated folder (or run `D:\workspace\personal-vault\dist\win-unpacked\Personal Vault.exe`) and launch with `--user-data-dir=D:\pv-stage-8d-candidate-trial\profile` on every launch, or if upgrading/replacing the installed app on disk, first copy `%APPDATA%\Personal Vault` and verify a backup of your active vault.
2. **Verify installer integrity before installing**:
   ```powershell
   (Get-FileHash 'D:\workspace\personal-vault\dist\Personal Vault Setup 0.1.0.exe' -Algorithm SHA256).Hash.ToLowerInvariant()
   # Expected: fef0b47b358253b16df82283ab2d2a83a14c7ff200bcf7b374b316779212cb74
   ```
3. **Keep original folders strictly read-only**: Personal Vault reads originals (`O_RDONLY`) and never edits, moves, or deletes source files. Optional source-hash snapshot before/after a disposable copy check:
   ```powershell
   Get-ChildItem -Path D:\pv-stage-8d-candidate-trial\sources -Recurse -File | Get-FileHash -Algorithm SHA256 | Export-Csv D:\pv-stage-8d-candidate-trial\source-hashes-before.csv -NoTypeInformation
   ```
4. **Provision offline models explicitly**: Download or import CLIP, BGE, and `eng.traineddata` (`tessdata_fast`) only if needed for offline search/OCR. If using encrypted Google Drive backup, keep `PV_GOOGLE_CLIENT_ID` / `PV_GOOGLE_CLIENT_SECRET` configured in your environment and save the recovery passphrase in your password manager.

---

## 2. Reference Checklist for Future Trials

- [ ] **UI Theme & Navigation**: Confirm default Light theme and **App menu -> Appearance -> Dark** switch persist cleanly across app restart (`All Items`, `Photos`, `Documents`, `Review`, `Duplicates`, `Backup & Restore`).
- [ ] **Scan & Verified Vault Import**: Scan a representative sample folder, initialize or open a dedicated vault outside source roots, run **Start Verified Import**, and verify imported copies succeed without altering source files.
- [ ] **HEIC, Thumbnails & Open Original**: Scroll Photos smoothly during scanning/indexing; open portrait/landscape iPhone `.heic` and `.jpg` files via **Open original**; confirm crisp resolution, accurate orientation, and clean reset when switching selection (`A -> B -> A`).
- [ ] **Photo, Document & Unified Search**: Run natural-language searches in **Photos** (**Top results** + **Show other results (N)** + **Search Relevance** detail + deep scroll), **Documents** (text extraction, **Run OCR**, `Hide clutter`, **Copy text**), and **All Items** (unified grouped results).
- [ ] **Duplicate Review & Selective Export to Non-Default Folder**: Mark a duplicate group reviewed with a preferred original; selectively export items to a **non-default folder** via **Browse** and inspect `.pv-meta.json` privacy defaults (no unintended source paths or extracted text unless opted in).
- [ ] **Local / Optional Encrypted Backup, Restore & Catalog Recovery**: Create and **Verify** a backup, perform a **Restore Files** drill into a fresh destination folder confirming SHA-256 integrity, and optionally verify **Recover from an existing vault** opens imported files read-only while refusing new imports.
- [ ] **Zero Source Modification & Log Hygiene**: Confirm source files remain bitwise unchanged (if snapshotting hashes, `Compare-Object` returns zero differences) and `<profile>\startup.log` contains no tokens or secrets.

---

## 3. Preserved Pre-Trial Verification Evidence (Do Not Conflate Builds)

- **Clean Windows x64 Sandbox (`4033b243`, Nov 22, 2026)**: Preserved build `D:\pv-sandbox-stage\Personal Vault Setup 0.1.0-4033b243.exe` (SHA-256 `4033b2431e7bc75a96df50890120eb9c03e0772050204a8c33d21c486db41d2d`) passed **8/8 checks** (`D:\pv-sandbox-out-4033b243-2\results.json`), including fresh `vc_redist.x64.exe` (`exit 0`), `0.0.9 -> 0.1.0` upgrade, `v1 -> v19` SQLite migration, uninstall/reinstall preservation, and recovered-profile background coordinators.
- **Earlier Host Trial & Genuine iPhone HEIC (`9f0d5ee7`, Nov 22, 2026)**: Installed `0.1.0` build (SHA-256 `9f0d5ee78038c00371d4bfa68b3275ebfd332c021c7a31ad452b1938390aa998`) passed disposable Steps B–E (`D:\pv-stage-8d-trial\trial-report.json`: cold-launch photo search `487.9 ms`, repeat `3.1–142.6 ms`, mixed PDF/DOCX + OCR, `37/37` restored payloads), Step A (`D:\pv-stage-8d-trial\step-a-open-original-report.json`), and genuine iPhone `IMG_2121.HEIC` (`D:\pv-stage-8d-heic-trial\iphone-heic-report.json`: `1,651,588` bytes, EXIF Orientation `6`, `384x512` Details preview, `2316 × 3088` `portrait` **Open original**, `0` runtime errors, before/after SHA-256 match `d6fc98447e3db4e188d16909a27a590753fe09b089e70e2b67d2f9ace0362c4d`).
- **Current Merged-UI Windows Closeout Candidate (`b6e608b`, Nov 24, 2026 — Candidate Ready for Trial)**: Installer SHA-256 `fef0b47b358253b16df82283ab2d2a83a14c7ff200bcf7b374b316779212cb74` passed full `npm test` (`136/136` files, `1,739/1,739` tests), real-Electron unpacked suites across photos, search (`38/38`, including PR #2 search LRU eviction fix), documents (`19/19`), document semantic search (`8/8`), unified search, backup (`5/5`), recovery (`5/5`), and `npm run verify:windows-candidate` (HEIC + Open original, non-default export folder, isolated-`appId` `0.0.9 -> 0.1.0` & `v1 -> v19` upgrade/uninstall/reinstall, and `100%` bitwise source preservation). The automated checks supplement the representative photo trial recorded below.

---

## 4. Personal Acceptance Sign-Off (Ron)

Ron personally verified scanning, browsing, and HEIC thumbnails. The other workflows are covered by the earlier automated candidate run. A separate rerun in a restricted Windows session passed 1,733 tests. Five stopped at junction creation, one was skipped, and Electron exited before the smoke checks could open a window.

| Field                     | Value                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Candidate Commit          | `b6e608bb5b3bd799545200fd2e657e6198a86bd0` (`chore/windows-closeout`)                                      |
| Verified Installer        | `D:\workspace\personal-vault\dist\Personal Vault Setup 0.1.0.exe` (`259,312,272` B)                        |
| Installer SHA-256         | `fef0b47b358253b16df82283ab2d2a83a14c7ff200bcf7b374b316779212cb74`                                         |
| Fixture / Candidate Ready | **Verified (Nov 24, 2026)** — all automated & Electron checks passed                                       |
| Ron Real-Library Trial    | **Passed on a representative sample.** Ron scanned and browsed 13 photos. iPhone HEIC thumbnails rendered. |
| Personal Acceptance       | **Accepted November 24, 2026** for personal Windows use.                                                   |
