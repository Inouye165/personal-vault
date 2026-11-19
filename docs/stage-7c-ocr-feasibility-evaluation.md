# Personal Vault — Stage 7C: Offline OCR Feasibility & Technical Spike

- **Date**: November 14, 2026
- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-7b-document-extraction` (Stage 7B uncommitted implementation preserved intact; isolated spike in `spikes/ocr-eval/`, Slice 1 production foundation in `src/main/services/documents/ocr/`)

**Stage Status**: Stage 7B Complete (independently accepted); **Stage 7C Feasibility Spike Complete; Stage 7C Slice 1 (OCR Foundation) Implemented**

---

## 1. Executive Summary

An isolated real-Electron technical spike (`spikes/ocr-eval/`) verified all Stage 7C feasibility requirements in both **built Electron (`45.2.3`)** and a **separate unpacked Windows executable** (`spikes/ocr-eval/.dist-unpacked/win-unpacked/Personal Vault OCR Spike.exe`, launched from neutral `os.tmpdir()` working directories) without touching production UI, catalog migrations, root `package.json` / `package-lock.json`, personal profiles, or existing `dist/` and `dist-stage-7b-verify/` builds:

1. **Direct `tesseract.js-core@7.0.0` Offline OCR**: Executed Tesseract `5.1.0-288-g2a9c1` WASM SIMD (`tesseract-core-simd-lstm.js` + `tesseract-core-simd-lstm.wasm`) directly inside a single Node `worker_threads.Worker` with **0 nested worker threads** (`nestedWorkerSpawns = 0`) and **0 network/download attempts** (`outboundNetworkAttempts = 0`, enforced by runtime monkey-patching of `Worker`, `fetch`, `XMLHttpRequest`, `http`, `https`, `net`, and `tls`).
2. **Scanned-PDF Rasterization (`pdfjs-dist@6.5.438` + `@napi-rs/canvas@1.1.1`)**: Rasterized synthetic image-only and mixed PDFs at `200 DPI` (`1700x2200` px) inside the worker thread in both built Electron (`isPackaged = false`) and the separate unpacked executable (`isPackaged = true`, loading `app.asar` + `app.asar.unpacked`).
3. **Synthetic Fixtures & Honest No-Text Outcomes**: Verified character-exact recognition on `synthetic_receipt.png` (and `.tiff`), 2-page `scanned_only.pdf` (verified `0` selectable native characters prior to OCR), and 3-page `mixed_document.pdf`, while `blank_page.png` and `blank_scan.pdf` both returned honest `status = 'ocr_no_text'` (`text = null`, `extractedCharCount = 0`).
4. **Pinned Language-Data Integrity, Shared `AppWorkerBudget(3)`, Cancellation & Source Preservation**: Verified `eng.traineddata` (`4,113,088 B`, SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`), offline rejection of missing (`ocr_model_missing`) and bit-flipped (`ocr_model_hash_mismatch`) language data with `0` network calls, `AppWorkerBudget(3)` contention (`maxObservedLiveWorkers = 3 <= 3`, spawn-failure reservation release, `0` final live/reserved workers), active mid-OCR `worker.terminate()` cancellation (`52.86 ms`–`57.98 ms`) + recovery, and `100%` bitwise source preservation across all 6 fixtures and `eng.traineddata`.
5. **Resolved Implementation Details**: Verified explicit `64 MiB` (`67,108,864 B`) OCR source-reader enforcement (`34 MiB` passes under `64 MiB` while `32 MiB` Stage 7B limit truncates it; `65 MiB` truncates at `fstat` pre-check), per-page mixed-PDF inspection (`ocr_hybrid_pdf`), and dual-track coexistence (`document_extractions` vs `document_ocr_extractions`) so native and OCR results never overwrite provenance or falsely stale each other.

---

## 2. Measured Spike Results (Built Electron vs. Separate Unpacked Executable)

Both runs executed on Electron `45.2.3` (`Node 24.22.2`, `N-API / modules ABI 150`) from fresh `os.tmpdir()` launch directories:

| Metric / Verification Check                                                       | Built Electron (`--mode=built`)                 | Unpacked Executable (`--mode=unpacked`)         |
| :-------------------------------------------------------------------------------- | :---------------------------------------------- | :---------------------------------------------- |
| `app.isPackaged`                                                                  | `false`                                         | `true` (`...\resources\app.asar`)               |
| `wasmLoadedFromUnpackedAsar`                                                      | `false`                                         | `true` (`...\resources\app.asar.unpacked\...`)  |
| Nested worker spawns (`nestedWorkerSpawns`)                                       | `0`                                             | `0`                                             |
| Outbound network attempts (`outboundNetworkAttempts`)                             | `0`                                             | `0`                                             |
| Cold `TessBaseAPI` WASM + `eng.traineddata` init                                  | `72.46 ms`                                      | `44.21 ms`                                      |
| Cold `synthetic_receipt.png` total OCR                                            | `212.71 ms` (conf `95`)                         | `183.33 ms` (conf `95`)                         |
| Warm `synthetic_receipt.png` OCR                                                  | `76.72 ms` (conf `95`)                          | `78.26 ms` (conf `95`)                          |
| Warm `synthetic_receipt.tiff` OCR (`sharp` LZW TIFF)                              | `74.07 ms` (conf `95`)                          | `85.49 ms` (conf `95`)                          |
| 2-page `scanned_only.pdf` (`0` native chars -> `200 DPI` OCR)                     | `450.14 ms` (conf `93.5`, `196` chars)          | `430.87 ms` (conf `93.5`, `196` chars)          |
| 3-page `mixed_document.pdf` (`1` native + `1` OCR + `1` blank skipped)            | `175.61 ms` (`ocr_hybrid_pdf`, conf `95`)       | `166.19 ms` (`ocr_hybrid_pdf`, conf `95`)       |
| `blank_page.png` (`ocr_no_text`, `text: null`, `0` chars)                         | `25.01 ms`                                      | `24.64 ms`                                      |
| `blank_scan.pdf` (`ocr_no_text`, `text: null`, `0` chars)                         | `117.03 ms`                                     | `113.81 ms`                                     |
| Active mid-OCR `worker.terminate()` cancellation                                  | `57.98 ms`                                      | `52.86 ms`                                      |
| Post-cancellation fresh worker recovery OCR                                       | `171.06 ms`                                     | `159.37 ms`                                     |
| Main-process event-loop delay (`p50` / `p95` / `p99` / `max`)                     | `15.49 / 23.99 / 41.09 / 48.07 ms`              | `15.50 / 25.21 / 47.35 / 50.53 ms`              |
| Main RSS (`before` -> `after`, sampled whole-process RSS)                         | `148.02 MiB` -> `218.22 MiB`                    | `149.53 MiB` -> `252.09 MiB`                    |
| Sampled process-wide RSS / worker-isolate V8 heap (after 2-page PDF; not a peak)¹ | `345.63 MiB` / `10.96 MiB`                      | `343.39 MiB` / `11.08 MiB`                      |
| `AppWorkerBudget(3)` (`maxObserved` / `finalLive` / `finalReserved`)              | `3 <= 3` / `0` / `0`                            | `3 <= 3` / `0` / `0`                            |
| Missing / tampered `eng.traineddata` codes (`0` network calls)                    | `ocr_model_missing` / `ocr_model_hash_mismatch` | `ocr_model_missing` / `ocr_model_hash_mismatch` |
| Bitwise source preservation (`fixtures` + `eng.traineddata`)                      | `6/6` + `true`                                  | `6/6` + `true`                                  |

> ¹ **Memory-label correction**: `process.memoryUsage().rss` called inside a Node `worker_thread` reports a point-in-time sample of the **entire Electron/Node OS process resident set**, not a worker-specific footprint and not a continuous high-water-mark peak. In `spikes/ocr-eval/electron-main-spike.ts` and production telemetry, this metric is explicitly labeled `sampledProcessRssDuringPdfOcrMiB` / `sampledProcessRssBytes` alongside `sampledWorkerIsolateHeapUsedMiB` / `sampledWorkerHeapUsedBytes`.

### Key Technical Integration Findings from the Spike

1. **Zero-Overhead Grayscale PGM (`P5`) Transfer into `TessBaseAPI`**: `tesseract.js-core`'s WebIDL `TessBaseAPI.prototype.SetImageFile(exif, angle)` reads `/input` from Emscripten `MEMFS`. Prepending a 15-byte ASCII PGM header (`P5\n<width> <height>\n255\n`) to 8-bit grayscale bytes (from `sharp(...).rotate().grayscale().raw()` for images or direct RGBA-over-white luma conversion from `@napi-rs/canvas` `ctx.getImageData(...)` for PDF pages) avoids intermediate PNG re-encoding/decoding and unlinks `/input` + calls `api.Clear()` in `finally`.
2. **Worker-Thread Canvas Polyfills Required by `pdfjs-dist@6.5.438`**: In Node/Electron `worker_threads`, `globalThis.DOMMatrix`, `globalThis.ImageData`, and `globalThis.Path2D` are undefined by default. Assigning those three constructors from `@napi-rs/canvas` before `await import('pdfjs-dist/legacy/build/pdf.mjs')` and passing `{ canvasContext: ctx, viewport, canvas }` to `page.render(...)` renders cleanly in both built and unpacked ASAR modes, followed by `page.cleanup()`, `await pdfDoc.cleanup()`, and `await loadingTask.destroy()`.
3. **Packaged `tesseract.js-core` File Filtering Saves `39.63 MiB`**: Unfiltered `tesseract.js-core@7.0.0` contains 8 build variants plus base64 `.wasm.js` duplicates (`45.26 MiB`). Including only `tesseract-core-simd-lstm.{js,wasm}` and scalar fallback `tesseract-core-lstm.{js,wasm}` reduces the packaged OCR engine footprint to **`5.63 MiB` total** (`0.18 MiB` JS/metadata in `app.asar` + `5.45 MiB` `.wasm` in `app.asar.unpacked`).

---

## 3. Dependency, License & Packaged Footprint Findings

| Component                                                    | Version / Revision                                             | License                                                                                        | Primary Source                                                                                 | Packaged Placement & Measured Size                                                                                                                                                                                                                                 |
| :----------------------------------------------------------- | :------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`tesseract.js-core`**                                      | `7.0.0` (Tesseract `5.1.0`)                                    | **`Apache-2.0`** (+ Leptonica `BSD-2-Clause` & permissive libpng/libjpeg/libtiff/zlib in WASM) | `node_modules/tesseract.js-core/LICENSE`; `github.com/naptha/tesseract.js-core`                | Filtered: **`0.18 MiB`** in `app.asar` + **`5.45 MiB`** `.wasm` in `app.asar.unpacked` (`5.63 MiB` total; zero transitive npm deps)                                                                                                                                |
| **`tesseract-ocr/tessdata_fast` (`eng.traineddata`)**        | Tag `4.1.0`, commit `65727574dfcd264acbb0c3e07860e4e9e9b22185` | **`Apache-2.0`**                                                                               | `github.com/tesseract-ocr/tessdata_fast/blob/65727574dfcd264acbb0c3e07860e4e9e9b22185/LICENSE` | External user-provisioned model dir (`<userData>/ocr-models/...`): **`4,113,088 B`** (`3.92 MiB`), SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`, manifest SHA-256 `1188a29f249ebac38f8b453929233bbec87a57799e384294f4c1ea6413f445b8` |
| **`@napi-rs/canvas`** + **`@napi-rs/canvas-win32-x64-msvc`** | `1.1.1`                                                        | **`MIT`** + Chromium `BSD-3-Clause` (`broken_image.png`) + Skia `BSD-3-Clause`                 | `node_modules/@napi-rs/canvas/LICENSE`; `github.com/Brooooooklyn/canvas`                       | **`37.12 MiB`** in `app.asar.unpacked` (`0.00 MiB` duplicated in `app.asar`; N-API prebuild, no `@electron/rebuild` compilation required)                                                                                                                          |
| **`pdfjs-dist`**                                             | `6.5.438` (existing Stage 7B)                                  | **`Apache-2.0`**                                                                               | Already in `THIRD_PARTY_NOTICES.md`                                                            | Already in `app.asar` (`35.46 MiB`)                                                                                                                                                                                                                                |
| **`sharp`** + **`libheif-js`**                               | `0.35.5` / `1.23.5` (existing Stage 5A/6C)                     | **`Apache-2.0`** / **`LGPL-3.0`**                                                              | Already in `THIRD_PARTY_NOTICES.md`                                                            | Already in `app.asar.unpacked` (`19.58 MiB`); `.bmp` and camera RAW remain honestly `unsupported`                                                                                                                                                                  |

- **Net incremental packaged binary size added by Stage 7C**: **`42.75 MiB`** (`37.12 MiB` `@napi-rs/canvas` + `5.63 MiB` filtered `tesseract.js-core`), plus **`3.92 MiB`** explicitly provisioned `eng.traineddata` outside `app.asar`.
- **Required `electron-builder.json5` updates for Stage 7C**:
  - `files`: filter `node_modules/tesseract.js-core/**/*` to ship only `package.json`, `LICENSE`, `tesseract-core-simd-lstm.{js,wasm}`, and `tesseract-core-lstm.{js,wasm}`.
  - `asarUnpack`: add `'node_modules/@napi-rs/**/*'` and `'node_modules/tesseract.js-core/*.wasm'`.

---

## 4. Resolution of Required Implementation Details (Requirement 5)

### 4.1 Explicit `64 MiB` OCR Limit (`MAX_OCR_INPUT_BYTES = 67,108,864`)

- **Problem**: Stage 7B's `readAndVerifySource` (`src/main/services/documents/worker.ts`) and `extractDocumentFromBuffer` (`src/main/services/documents/extractor.ts`) default `maxInputBytes` to `DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES` (`32 MiB`). Reusing that helper without an explicit parameter would silently truncate scanned PDFs in `(32 MiB, 64 MiB]`.
- **Resolution**:
  1. Extract shared `src/main/services/documents/source-reader.ts` (`readAndVerifySourceWithLimit`) where `maxInputBytes: number` is a **required** non-optional parameter (validated positive integer), enforcing `fstatBefore.size > maxInputBytes` before buffer allocation and `totalBytes > maxInputBytes` mid-stream during `64 KiB` chunked reads, alongside approved-root canonical containment and pre/post `lstat`↔`fstat` + SHA-256 verification.
  2. Stage 7B `document_worker.ts` passes `DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES` (`32 MiB`); Stage 7C `ocr_worker.ts` passes `DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES` (`64 MiB`).
  3. Eligible `.pdf` documents in `(32 MiB, 64 MiB]` that Stage 7B marked `truncated` due to the `32 MiB` native-extraction cap are included in Stage 7C's explicit OCR candidate scope.
  4. Verified in spike: `34 MiB` synthetic input -> `truncated` under `32 MiB`, `ok` (`35,651,584 B` verified) under `64 MiB`; `65 MiB` synthetic input -> `truncated` (`max_input_bytes_exceeded`) under `64 MiB`.

### 4.2 Conservative Mixed-PDF Per-Page OCR Policy (`src/main/services/documents/ocr/pdf-page-policy.ts`)

- **Problem**:
  1. Document-level `joined.length === 0` detection misses scanned pages inside mixed PDFs whenever any other page contains selectable text.
  2. Even per-page character thresholds alone (`selectableCharCount < 16`) are unsafe: a scanned page with a selectable running header, letterhead, Bates banner, or digital signature footer easily exceeds `16`–`60+` selectable characters while its entire body is a rasterized scan. Treating selectable header text as proof that the page needs no OCR would silently drop the scanned body.
- **Production Conservative Mixed-Page Policy (`inspectPdfPageForOcr` + `classifyPdfPageForOcr`)**:
  1. Inspect every page $p \in [1, \min(\text{numPages}, \text{maxPages})]$ individually using `page.getTextContent()` (`selectableCharCount` excluding whitespace, plus lossless `nativeText`) and `page.getOperatorList()`.
  2. Track the PDF graphics-state Current Transformation Matrix (`CTM = [a, b, c, d, e, f]`) across `OPS.save` (`10`), `OPS.restore` (`11`), `OPS.transform` (`12`), and Form XObject scopes (`OPS.paintFormXObjectBegin` `74` / `OPS.paintFormXObjectEnd` `75`). Because PDF.js paints single-image XObjects (`83` `paintImageMaskXObject`, `85` `paintImageXObject`, `86` `paintInlineImageXObject`) in the unit square $[0, 1]^2$, each painted image's page-area coverage ratio is:
     $$\text{areaRatio} = \min\!\left(1,\; \frac{|ad - bc|}{\text{pageWidthPt} \cdot \text{pageHeightPt}}\right)$$
     Group, repeat, or non-finite-transform image operators (`84`, `87`, `88`, `89`) set `hasUnboundedRasterOp = true`.
  3. **Decision rules (`classifyPdfPageForOcr`)**:
     - `rasterImageOpCount === 0` and `!hasUnboundedRasterOp` -> **`needsOcr = false`** (`'native_text_only'` if `selectableCharCount > 0`, else `'blank_or_vector_only'`).
     - `selectableCharCount === 0` (any raster present) -> **`needsOcr = true`** (`'image_only_page'`).
     - `hasUnboundedRasterOp === true` -> **`needsOcr = true`** (`'unbounded_raster_op_conservative'`).
     - **`maxSingleRasterAreaRatio >= 0.08` (`8%` of page area), `totalRasterAreaRatio >= 0.12` (`12%` of page area), or `rasterImageOpCount > 3`** -> **`needsOcr = true`** (`'substantial_raster_with_native_text'`) **regardless of how many selectable native characters exist on the page**. A selectable header, footer, or letterhead never suppresses OCR on a scanned body.
     - `selectableCharCount < 32` (`MIN_TRUSTED_NATIVE_CHARS`) with small rasters -> **`needsOcr = true`** (`'sparse_native_text_with_raster'`).
     - Otherwise (`selectableCharCount >= 32`, `<= 3` small rasters with `< 8%` single and `< 12%` total page area, such as a corner letterhead logo at `0.67%` page area) -> **`needsOcr = false`** (`'native_text_with_small_raster'`).
  4. **Lossless Native + OCR Page Text Merge (`mergeNativeAndOcrPageText`)**: When a mixed page (`'substantial_raster_with_native_text'` or `'sparse_native_text_with_raster'`) is OCR'd, its exact selectable `nativeText` is preserved first and non-duplicate recognized OCR lines are appended underneath (`extractionMethod = 'ocr_hybrid_pdf'`), so neither selectable header strings nor scanned body clauses are lost.
  5. Verified in production synthetic fixtures (`tests/helpers/ocr-synthetic-fixtures.ts` & `tests/main/ocr-pdf-page-policy.test.ts`):
     - `header_plus_scanned_body.pdf` (`> 60` selectable header chars + `62%` page-area scanned body): classified `'substantial_raster_with_native_text'` (`needsOcr = true`), preserving both `"SELECTABLE RUNNING HEADER"` and OCR'd `"SCANNED BODY CLAUSE 4410"` / `"ZETA88"`.
     - `native_body_plus_small_logo.pdf` (`> 80` selectable body chars + `90x36 pt` corner logo = `0.67%` page area): classified `'native_text_with_small_raster'` (`needsOcr = false`), skipping needless rasterization.

### 4.3 Coexistence of Native Extraction & OCR Without False Staleness or Overwritten Provenance

- **Problem**: `document_extractions` enforces `UNIQUE(file_location_id) WHERE is_current = 1` and `DocumentRepository` checks `recipe_version === 'doc_extract_v1'`. Writing OCR rows into `document_extractions` would either fail the `'doc_extract_v1'` currency check (falsely marking OCR `stale`) or overwrite the native extraction row and its provenance.
- **Resolution**:
  1. Keep `document_extractions` (`recipe_version = 'doc_extract_v1'`) strictly for native text extraction (adding only nullable `ocr_candidate_page_count INTEGER` in Migration 13).
  2. Add dedicated OCR tables in SQLite Migration 13 (`CURRENT_SCHEMA_VERSION = 13`): `document_ocr_extractions` (`UNIQUE(file_location_id) WHERE is_current = 1`), `document_ocr_jobs`, and `document_ocr_job_items`.
  3. Validate each track with its own currency predicate:
     - Native track (`isNativeExtractionCurrent`): `recipe_version === 'doc_extract_v1'` + matching `discovery_observation_id` / `observed_sha256` / `observed_byte_size`.
     - OCR track (`isOcrExtractionCurrent`): `recipe_version === 'doc_ocr_v1'` + matching `ocr_model_id` + `ocr_model_manifest_sha256` + `ocr_language` + matching `discovery_observation_id` / `observed_sha256` / `observed_byte_size`.
  4. Provenance & UI composition: Document list/detail/preview payloads return **both** `nativeExtraction` and `ocrExtraction` provenance summaries independently (`Extracted text` vs `OCR text (machine-recognized)` with model ID, manifest SHA-256 prefix, language, OCR page count, and mean confidence). Rotating or invalidating the OCR model marks only `ocrExtraction` as `stale` while leaving `nativeExtraction` `extracted`; modifying the source file advances `discovery_observation_id` / `sha256` and naturally stales both tracks together.

---

## 5. Refined Bounded Stage 7C Implementation Sequence (TDD)

1. **Dependencies, Notices & Build Packaging (`package.json`, `electron.vite.config.ts`, `electron-builder.json5`, `THIRD_PARTY_NOTICES.md`)**:
   - Add `tesseract.js-core@7.0.0` and `@napi-rs/canvas@1.1.1`; configure `ocr_worker` Rollup entry in `electron.vite.config.ts`; add filtered `tesseract.js-core` + `asarUnpack` rules in `electron-builder.json5`; record `tesseract.js-core`, `tessdata_fast`, and `@napi-rs/canvas` notices in `THIRD_PARTY_NOTICES.md`.
2. **Pinned OCR Model Provisioning (`src/main/services/documents/ocr-manifest.ts`, `ocr-model-manager.ts`, unit tests)**:
   - Implement pinned `tessdata_fast` `eng.traineddata` manifest (`4,113,088 B`, SHA-256 `7d4322bd...`), offline status check (`unprovisioned | ready | corrupt | downloading`), local folder import, and explicit user-triggered HTTPS download from allowlisted GitHub raw/CDN hosts with temp-file atomic rename and zero background network activity.
3. **Shared Bounded Source Reader & Per-Page PDF OCR Classifier (`source-reader.ts`, `pdf-ocr-classifier.ts`, `extractor.ts`, unit tests)**:
   - Refactor Stage 7B `worker.ts` to use `readAndVerifySourceWithLimit` with explicit `32 MiB`, while Stage 7C `ocr_worker.ts` passes explicit `64 MiB`; record `ocrCandidatePageCount` during native PDF inspection without regressing existing Stage 7B behavior.
4. **SQLite Migration 13 & `DocumentOcrRepository` (`migrations.ts`, `document-ocr-repository.ts`, `document-snapshot-worker.ts`, unit tests)**:
   - Add `ocr_candidate_page_count` to `document_extractions` and create `document_ocr_extractions`, `document_ocr_jobs`, and `document_ocr_job_items`; support point-in-time snapshot scoping (`selected` IDs including explicit image items vs `ocr_needed` cataloged documents including mixed PDFs and `(32 MiB, 64 MiB]` PDFs, never bulk-scanning unselected `category = 'photo'` items); enforce `REVISION_MISMATCH` stale-commit rejection and format-compatible hash reuse (`pdf_ocr` vs `raster_image_ocr`).
5. **Isolated `ocr_worker.ts` & `DocumentOcrCoordinator` (`src/main/services/documents/ocr-worker.ts`, `ocr-coordinator.ts`, unit tests)**:
   - Single OCR worker under shared `AppWorkerBudget(3)` (reclaiming idle search/extract workers when needed, releasing reservations in `try / finally`, counting terminating workers until `'exit'`); `200 DPI` `@napi-rs/canvas` + `pdfjs-dist` rasterization (`<= 50` OCR pages/doc, `<= 3200 px` / `<= 9 MP`), `sharp` + `libheif-js` image prep (`<= 40 MP`), PGM `TessBaseAPI` recognition, per-page (`15 s`) & per-document (`120 s`) timeouts, pause/resume/cancel, and startup `interrupted` recovery.
6. **Narrow Typed IPC, Preload & Accessible Renderer Controls (`document-schemas.ts`, `channels.ts`, `document-handlers.ts`, `preload/index.ts`, `DocumentsPanel.tsx`, `useDocuments.ts`, tests)**:
   - Add OCR model setup & job/preview Zod schemas and top-level-sender-validated IPC handlers; add OCR setup state, explicit `"Run OCR"` controls (`Selected` / `OCR Needed`), progress/pause/resume/cancel bar, distinct native vs `"OCR text (machine-recognized)"` inert `<pre>` tabs/sections with machine-inference provenance disclaimer; zero original-layout viewing, zero File Explorer actions, zero Stage 7D–7F scope.
7. **Quality Gates & Built/Unpacked Electron Acceptance (`scripts/verify-electron-document-ocr.mjs`)**:
   - Run full `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `git diff --check`, and real Electron built + separate unpacked verification from neutral `$env:TEMP` `cwd`.
