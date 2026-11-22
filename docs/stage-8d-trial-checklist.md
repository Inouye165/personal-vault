# Stage 8D — Representative Mixed-Library Trial Checklist

**Installed Build:** `D:\organizer\dist\Personal Vault Setup 0.1.0.exe` (SHA-256 `9f0d5ee78038c00371d4bfa68b3275ebfd332c021c7a31ad452b1938390aa998`; 8C-1 `f122ede`, 8C-2 `70f0616`, plus Stage 8D **Open original** slice)
**Rule:** Use a **disposable installation directory, disposable profile, disposable vault, and disposable copy of an explicitly approved local sample** outside `D:\organizer` (e.g., `D:\pv-stage-8d-trial\`). **Leave any existing installation, profile, and vault alone.** Keep source files strictly read-only.

---

## 1. Pre-Trial Setup & Source SHA-256 Evidence

- [ ] Copy an **explicitly approved** local sample into `D:\pv-stage-8d-trial\sources\`:
  - Full-resolution iPhone `.heic` photos (including EXIF-rotated/portrait) and full-resolution `.jpg`/`.jpeg` photos
  - Mixed `.pdf` (native text + scanned image-only), `.docx`, and `.txt`/`.md` documents (plus intentional duplicates and clutter files)
- [ ] Capture the pre-trial source SHA-256 manifest before launching Personal Vault:
  ```powershell
  Get-ChildItem -Path D:\pv-stage-8d-trial\sources -Recurse -File | Get-FileHash -Algorithm SHA256 | Export-Csv D:\pv-stage-8d-trial\source-hashes-before.csv -NoTypeInformation
  ```
- [ ] Install `Personal Vault Setup 0.1.0.exe` into a **disposable installation directory** (`D:\pv-stage-8d-trial\app`), **skip automatic launch from the installer** (uncheck "Run Personal Vault" or use `/S /D=D:\pv-stage-8d-trial\app`), and pass `--user-data-dir=D:\pv-stage-8d-trial\profile` on **every** trial launch (including after restart).
- [ ] Explicitly provision offline CLIP, BGE, and `eng.traineddata` models (confirm zero automatic downloads).

---

## 2. Trial Execution & Pass/Fail Criteria

| Step                                                                    | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Pass Criteria                                                                                                                                                                                                     | Fail Criteria                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. Scan & Concurrent Browsing + Photo Opening**                       | Add `sources\`, run **Start Scan**, then immediately scroll the **Photos** thumbnail grid continuously during scan and **Semantic Indexing**. Also **open representative full-resolution iPhone HEIC and JPEG photos** in the detail/viewer pane during/after indexing.                                                                                                                                                                                  | Scan & indexing complete; grid scrolls without persistent blank cells; opened full-resolution HEIC and JPEG photos render crisply with accurate orientation; record how any stall was measured or observed.       | Crash, worker hang, corrupted thumbnail or opened image, wrong HEIC rotation, or unrecovered UI freeze.                    |
| **B. Cold-Launch First Search & Repeat Searches**                       | Quit the app completely, cold-launch `D:\pv-stage-8d-trial\app\Personal Vault.exe --user-data-dir=D:\pv-stage-8d-trial\profile`, run the **first photo semantic search** immediately, then run repeat photo, document, and **All Items** searches.                                                                                                                                                                                                       | First and repeat searches return relevant items with accurate provenance; record first-query and repeat timings (compare against 8C-2 `681.4 ms` observation).                                                    | Search error, stuck spinner, wrong/missing provenance, or unresponsive UI.                                                 |
| **C. Mixed PDF/DOCX Ingestion & OCR**                                   | Open **Documents**, run extraction and **Run OCR** on scanned PDFs; test `Show all` vs `Hide clutter` and a classification override, then restart with `--user-data-dir=D:\pv-stage-8d-trial\profile`.                                                                                                                                                                                                                                                   | Native PDF/DOCX text and scanned-PDF OCR text extract cleanly; classification override persists across restart.                                                                                                   | Extraction/OCR crash, garbled/missing text on clear scans, or lost override after restart.                                 |
| **D. Duplicate Review, Annotations & Vault Import**                     | Review a duplicate group (mark reviewed + preferred location); set photo ratings/flags and a collection; initialize `D:\pv-stage-8d-trial\vault` and run **Start Verified Import**.                                                                                                                                                                                                                                                                      | Duplicate decision, annotations, and collection persist across restart (`--user-data-dir=D:\pv-stage-8d-trial\profile`); vault payloads match source SHA-256 hashes.                                              | Stale/lost review or annotation, import failure, or any vault/source hash mismatch.                                        |
| **E. Pre-Backup Vault Inventory, Local Backup & Restore After Restart** | Record every imported vault payload's relative path and SHA-256 (`vault-hashes-before.csv`). Configure `D:\pv-stage-8d-trial\backup`, run **Back up now** and **Verify backup**, restart app (`--user-data-dir=D:\pv-stage-8d-trial\profile`), then **Restore Files** into `D:\pv-stage-8d-trial\restore`. Relaunch with `--user-data-dir` pointing to the **actual restored profile** (`D:\pv-stage-8d-trial\restore\profile` or restored profile dir). | Restored profile launches cleanly; catalog, duplicate decisions, annotations, and collections are intact; restored vault payload relative paths, file counts, and SHA-256 hashes match `vault-hashes-before.csv`. | Backup/verify/restore error, missing annotations/catalog data, count/path mismatch, or any restored-file SHA-256 mismatch. |

---

## 3. Vault Payload & Source Invariance SHA-256 Evidence

- [ ] **Pre-backup vault payload manifest** (relative path + SHA-256 for every imported payload, excluding `manifest.json` sidecars):
  ```powershell
  $vRoot = 'D:\pv-stage-8d-trial\vault\files'
  Get-ChildItem -Path $vRoot -Recurse -File | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
    [pscustomobject]@{ RelPath = $_.FullName.Substring($vRoot.Length + 1); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
  } | Sort-Object RelPath | Export-Csv D:\pv-stage-8d-trial\vault-hashes-before.csv -NoTypeInformation
  ```
- [ ] **Post-restore vault payload comparison** (relative paths, counts, and SHA-256 hashes against `vault-hashes-before.csv`):
  ```powershell
  $rRoot = 'D:\pv-stage-8d-trial\restore\vault\files'
  Get-ChildItem -Path $rRoot -Recurse -File | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
    [pscustomobject]@{ RelPath = $_.FullName.Substring($rRoot.Length + 1); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
  } | Sort-Object RelPath | Export-Csv D:\pv-stage-8d-trial\vault-hashes-restored.csv -NoTypeInformation
  Compare-Object (Import-Csv D:\pv-stage-8d-trial\vault-hashes-before.csv) (Import-Csv D:\pv-stage-8d-trial\vault-hashes-restored.csv) -Property RelPath, Hash
  ```
- [ ] **Separate before/after source SHA-256 comparison** (`0` differences allowed):
  ```powershell
  Get-ChildItem -Path D:\pv-stage-8d-trial\sources -Recurse -File | Get-FileHash -Algorithm SHA256 | Export-Csv D:\pv-stage-8d-trial\source-hashes-after.csv -NoTypeInformation
  Compare-Object (Import-Csv D:\pv-stage-8d-trial\source-hashes-before.csv) (Import-Csv D:\pv-stage-8d-trial\source-hashes-after.csv) -Property Path, Hash
  ```

---

## 4. Recording Stalls, Renderer Errors & Recovery Failures

- Record any defect in `D:\pv-stage-8d-trial\trial-notes.md` with:
  1. **Timestamp, step (`A`–`E`), and operation** (e.g., `"Step A: opening full-res HEIC while CLIP indexing"`).
  2. **Measurement method & symptom**: State how any stall was measured or observed (wall-clock stopwatch, DevTools Performance/frame gap, or visual observation) and exact duration/error text.
  3. **Logs & DevTools**: Copy relevant lines from `<disposableProfile>\startup.log` (verifying zero OAuth tokens or recovery secrets appear) and any DevTools Console / `Runtime.exceptionThrown` error.
  4. **Recovery failure details**: Exact backup/restore/verify error code, destination path, and whether partial files were left behind.

---

## 5. Disposable Mixed-Library Execution Notes (November 22, 2026)

- **Steps B–E (`D:\pv-stage-8d-trial\trial-report.json`, preserved)**: Cold-launch first photo search (`487.9 ms`), repeat searches (`142.6`, `3.3`, `3.1`, `3.2 ms`), mixed PDF/DOCX extraction + OCR (`45` chars) + classification override persistence, duplicate review + annotations + verified vault import (`38` candidates / `37` payloads), and local backup/restore after restart (`37/37` restored vault payloads matching SHA-256; `38/38` source hashes unchanged) passed.
- **Step A Open original (`D:\pv-stage-8d-trial\step-a-open-original-report.json`, `SHA-256: 9f0d5ee78038c00371d4bfa68b3275ebfd332c021c7a31ad452b1938390aa998`)**: `fullres-01-landscape.jpg` (`4032x3024`), `fullres-02-portrait.jpg` (`3024x4032`), repo HEICs (`landscape.heic` `160x100`, `portrait_exif6.heic` `100x160`, `sunset_heic.heic` `256x256`), live `A -> B -> A` selection-race check (`openBeforeSwitch`, `closedOnB`, `stayedClosedOnReturnA`, `reopenedOnExplicitClick`), and `38/38` source SHA-256 invariance passed (`0` runtime errors).
- **Remaining Open Gates**: Genuine full-resolution iPhone HEIC coverage (only small repo HEIC fixtures exercised) and clean Windows x64 VM verification remain open.
