# Stage 8C-2 Windows baseline

This baseline exercises the real packaged Windows x64 app through its renderer bridge on an isolated temporary profile. It creates 389 synthetic files using the repository's HEIC fixtures and the installer verifier's scanned PDF template. The mix is 360 JPEGs, 3 HEICs, 13 scanned PDFs, and 13 text documents. The scanned PDFs deliberately include byte-identical copies. The set helps compare runs, and the small HEIC fixtures and repeated PDFs limit what it tells us about full-resolution libraries.

## Repeat the run

Use a normal Windows session with Node 22, the unpacked build from `npm run build:unpack`, and the same local CLIP, BGE, and OCR model caches used by `scripts/verify-installer-windows.mjs`. Run from the repository root in PowerShell:

```powershell
node scripts/benchmark-mixed-library-windows.mjs '.\dist\win-unpacked\Personal Vault.exe' "$env:TEMP\pv-mixed-library-baseline.json"
```

Supply the path to the installed executable instead to measure that build. The JSON report records the executable SHA-256, host, fixture size, and source-hash invariant. Keep the app visible and compare runs with the same executable class, model caches, and foreground load. The script uses generated files and local model caches. It does not need an active vault or Google Drive credentials.

## What is measured

After creating an initial photo and document index, the script samples an idle reference, a scan of the remaining fixtures, and photo semantic indexing. Timing samples use renderer-side elapsed time across the actual IPC bridge. A workload sample is retained only when the job reports running both before and after it. Jobs may finish too quickly to yield a usable sample, which is reported as zero samples. Search timing covers responses with results, with empty or unavailable results counted separately. Renderer frame gaps are captured alongside the requests. This measures catalog paging and search calls, plus frame scheduling during those calls. Human interaction, rendered scrolling, and large-library performance remain for the mixed-library trial.

The report includes counts, median, p95 and maximum latency, job outcomes, HEIC thumbnail status, document extraction, OCR, renderer exceptions, and source SHA-256 preservation. Use the counts when interpreting percentiles. Missing or sparse samples are a reason to repeat a run with a larger intake, not a performance pass.

## Initial execution, November 22, 2026 (non-interactive session)

| Check                                 | Result                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| Host                                  | Intel Core i9-13900K, 32 GiB RAM, Windows build `10.0.26300`               |
| Fixture preparation                   | 389 files, 7,570,106 bytes                                                 |
| Fixture integrity                     | 389/389 source SHA-256 values unchanged                                    |
| Electron launch                       | Packaged process exited before the DevTools page opened, code `2147483651` |
| Browsing, search, and renderer timing | No samples collected                                                       |
| HEIC decoding, extraction, and OCR    | Not reached                                                                |

The existing built and unpacked Electron smoke scripts returned the same early exit code in that non-interactive session.

## Interactive Windows execution, November 22, 2026

Executed `node scripts/benchmark-mixed-library-windows.mjs '.\dist\win-unpacked\Personal Vault.exe' "$env:TEMP\pv-mixed-library-baseline.json"` in an interactive Windows session (`exit 0`, `runtimeErrors: 0`):

- **Host & Build**: `13th Gen Intel(R) Core(TM) i9-13900K`, `32 GiB` RAM, Windows `10.0.26300`; `D:\organizer\dist\win-unpacked\Personal Vault.exe` (SHA-256 `c6d8e18926c7f04fbea7bfd836181b613630501505940b8f424ea0213e009419`).
- **Fixtures & Integrity**: `389` files (`7,570,106` bytes), `389/389` source SHA-256 hashes unchanged.

| Phase                                                | Metric              | Samples | p50 (ms) | p95 (ms) | Max (ms) |
| ---------------------------------------------------- | ------------------- | ------: | -------: | -------: | -------: |
| **Idle** (`4,956 ms`)                                | `photoPageIpc`      |      20 |      1.2 |      2.0 |      6.1 |
|                                                      | `semanticSearchIpc` |      20 |      5.4 |      7.3 |    681.4 |
|                                                      | `documentSearchIpc` |      20 |    113.2 |    130.8 |    387.2 |
|                                                      | `rendererFrameGap`  |     805 |      4.2 |      4.3 |     10.0 |
| **Scan** (`3,687 ms`, 360/360 hashed, 1 boundary)    | `photoPageIpc`      |      15 |      1.3 |      2.6 |      2.6 |
|                                                      | `semanticSearchIpc` |      15 |     11.6 |     13.8 |     13.8 |
|                                                      | `documentSearchIpc` |      15 |    131.6 |    139.7 |    139.7 |
|                                                      | `rendererFrameGap`  |     505 |      4.2 |      4.3 |      4.3 |
| **Index** (`18,048 ms`, 336 processed / 363 indexed) | `photoPageIpc`      |      82 |      1.1 |      1.4 |      1.7 |
|                                                      | `semanticSearchIpc` |      82 |     16.1 |     20.4 |     25.7 |
|                                                      | `documentSearchIpc` |      82 |    115.6 |    127.5 |    155.9 |
|                                                      | `rendererFrameGap`  |   2,601 |      4.2 |      4.3 |     10.5 |

- **Post-index checks**: `0` empty photo pages, `0` searches without results, `3/3` HEIC thumbnails `ready` (`landscape.heic`, `portrait_exif6.heic`, `sunset_heic.heic`), document extraction `completed` (`24` processed, `12` reused, `0` failed; `13` extracted / `13` no-text scanned PDFs), and OCR `completed` (`13` processed, `1` extracted, `12` reused, `0` failed).
- **Observations & limits**: The first photo query in Idle (`semanticSearchIpc` max `681.4 ms`) was slower than subsequent queries (`5.4 ms` p50, `7.3 ms` p95); this is recorded as an observation with its cause unconfirmed. `documentSearchIpc` showed `113.2–131.6 ms` p50 (`387.2 ms` max in Idle). No crashes or frame stalls (`rendererFrameGap` p95 `4.3 ms <= 33 ms`) were observed; human interaction, rendered scrolling, and full-resolution mixed-library behavior belong to the Stage 8D real-library trial (`docs/stage-8d-trial-checklist.md`).

## Subsequent Windows Clean-VM & Closeout Candidate Verification

- **Clean Windows x64 Sandbox Verification (`4033b243`, Nov 22, 2026)**: Preserved installer `Personal Vault Setup 0.1.0-4033b243.exe` (SHA-256 `4033b2431e7bc75a96df50890120eb9c03e0772050204a8c33d21c486db41d2d`, `D:\pv-sandbox-out-4033b243-2\results.json`) passed **8/8 checks** in fresh Windows Sandbox with no preinstalled VC++ DLLs (`vc_redist.x64.exe` exit `0`, bridge smoke, `0.0.9 -> 0.1.0` upgrade, `v1 -> v19` SQLite migration, uninstall/reinstall preservation, and `recoveredProfileChecks` across all 4 coordinators).
- **Merged-UI Windows Closeout Candidate (`b6e608bb5b3bd799545200fd2e657e6198a86bd0` / `b6e608b`, Nov 24, 2026)**: Rebuilt `dist/Personal Vault Setup 0.1.0.exe` (`259,312,272` bytes, SHA-256 `fef0b47b358253b16df82283ab2d2a83a14c7ff200bcf7b374b316779212cb74`) and `dist/win-unpacked/Personal Vault.exe` (`249,831,936` bytes, SHA-256 `e88517887614a2d72197067f4b79e35558bc190aed56207d2de326a2bcd3f24e`). Post-build verification passed `npm test` (`136/136` files, `1,739/1,739` tests), `npm run smoke:unpacked`, `npm run verify:semantic-search:unpacked` (`38/38`, including the PR #2 search LRU eviction fix and `Top results` / `Search Relevance` checks), and `npm run verify:windows-candidate` (`=== WINDOWS CANDIDATE VERIFICATION PASSED ===`: payload match against `win-unpacked` + pinned `vc_redist.x64.exe`, Dark/Light theme & onboarding UI, HEIC + Open original + `A -> B -> A` race, CLIP/OCR/BGE/Unified search + `Copy text`, duplicates + verified import, non-default folder export, restart persistence, local backup/restore `8/8`, catalog recovery + all 4 coordinators + read-only vault refusal, `100%` bitwise source preservation, isolated-`appId` NSIS lifecycle `0.0.9 -> 0.1.0` / `v1 -> v19` / uninstall / reinstall, and `0` changes to Ron's existing host install).
