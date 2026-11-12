# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-6c-photo-metadata` (created directly from verified Stage 6B documentation closeout `653c01e`, descending from accepted Stage 6B implementation `0b0c814`, Stage 6A closeout `ad796b4`, accepted Stage 6A implementation `155d7bd`, and Stage 5 closeout `9b8faa7`)
- **Base Commit**: `653c01e`
- **Accepted Stage 6B Commit**: `0b0c814` (`0b0c814eca332462d0ac24cfe2c865d9611e632d`)
- **Accepted Stage 6C Commit**: `c8a766f` (`c8a766f284c7c88b2098651f890c6488d5feae80`)
- **Stage 1 status**: Complete (independently accepted at `070e3cb`).
- **Stage 2 status**: Complete (all substages 2A-2D independently accepted; Stage 2D accepted at `71e1af7`, documentation closeout committed at `eea7daa`).
- **Stage 3 status**: Complete (independently accepted at `79bbf44`, documentation closeout committed at `cf91653`).
- **Stage 4 status**: Complete (independently accepted at `1a1fb69`, closeout at `8a17bfe`).
- **Stage 5 status**: **Complete; Substage 5A independently accepted at `951fd25`, 5B at `4071948`, 5C at `543135a`** (Stage 5 closeout at `9b8faa7`).
- **Stage 6 status**: **In progress**:
  - **Stage 6A (Offline Semantic Search Feasibility & Technical Spike)**: **Complete** (independently accepted at `155d7bd` on `feat/stage-6a-semantic-evaluation`, closeout at `ad796b4`).
  - **Stage 6B (Model Provisioning, Resumable Semantic Indexing & Persistent SQLite Index)**: **Complete** (independently accepted at `0b0c814` on `feat/stage-6b-semantic-index`, closeout at `653c01e`).
  - **Stage 6C (Photo Metadata Extraction & Fact/Inference-Separated SQL Filters)**: **Complete** (independently accepted at `c8a766f` on `feat/stage-6c-photo-metadata`).
  - **Substages 6D–6E**: **Planned** (not started); **Stage 6D (Natural-language photo search IPC, ranking, and Photos UI integration)** is the next planned assignment following Stage 6C acceptance.
- **Installed Electron Version**: `45.2.3` (`node` `v22.18.0`, `npm` `v10.9.3`)
- **Evidence Source**: Independent review accepted at `c8a766f`: reviewer inspected the correction diff and passed 10/10 parser tests (`tests/main/photo-metadata-parser.test.ts` exit 0). Full test suite (894 tests across 72 test files, all 23 required quality/build/Electron commands exiting with code 0, real Electron `verify:metadata` built 11/11 and unpacked 12/12, plus all 15 prior-stage regression and smoke checks) were executed directly and reported by the implementation host on `feat/stage-6c-photo-metadata`. Concurrency verification utilized 45 ms worker task delays (`PV_TEST_WORKER_METADATA_DELAY_MS=45` and `PV_TEST_WORKER_SEMANTIC_DELAY_MS=45` in `src/main/services/thumbnails/worker.ts`) to reliably observe simultaneous active metadata extraction and semantic embedding tasks during diagnostic polling across the shared image worker pool.
- **Constraints**: Never implement on `main`; no push, merge, or publication is authorized. Preserve source preservation invariance: source files strictly read-only. Source files and vault copies are never touched, altered, moved, or deleted.

---

## 1. Stage 6C Implementation Summary & Provenance Architecture

Stage 6C delivers explicit local extraction of technical metadata from catalog photographs (including existing cataloged photos), selected-photo provenance inspection, and SQL-backed Photos filters combined via `AND` with existing Stage 5B rating, flag, and collection filters before pagination — working completely offline and without requiring an installed semantic model.

### 1.1 Parser Selection, Licensing & Packaging

- **Selected Parser**: `exifreader@4.54.0` (exact version locked in `package.json` and `package-lock.json`; `npm audit --omit=dev` reports `0 vulnerabilities`), paired with `sharp@0.35.5` header inspection (`sharp(buffer).metadata()`).
- **License & Notice**: Mozilla Public License 2.0 (`MPL-2.0`, file-level copyleft permitting unmodified library bundling in larger works; zero transitive runtime dependencies). Full attribution and source notice recorded in `THIRD_PARTY_NOTICES.md` (Section 5, bundled into packaged builds via `electron-builder.json5`).
- **Worker Bundling & Header-Only Inspection**: Configured `electron.vite.config.ts` (`main.plugins: [externalizeDepsPlugin({ exclude: ['exifreader'] })]`) so `exifreader` is bundled directly into `out/main/thumbnail_worker.js` for both built and packaged `app.asar` execution without introducing any external executable. Both `sharp(buffer).metadata()` and `ExifReader.load()` inspect container headers/segments without performing full raster pixel decoding.

### 1.2 Four-Way Provenance & Fact/Inference Separation

1. **Immutable Filesystem Observations & Verified Hashes**: `file_locations`, `discovery_observations`, and `hash_observations` remain strictly untouched.
2. **Revision-Bound Extracted Technical Metadata (`photo_technical_metadata`)**: Stores verified container format (`detected_format`), `recorded_extension`, `extension_format_mismatch`, raw camera/lens tag strings, bounded normalized matching keys, encoded dimensions, EXIF orientation (`1..8`), orientation-adjusted display dimensions, bounded `raw_tags_json` (`<= 32 KiB`), `parser_recipe_version` (`exif_tech_v1`), `content_revision`, and `extraction_status` (`extracted`, `no_metadata`, `unsupported`, `failed`).
3. **Interpreted Capture Dates (`src/main/services/metadata/date-policy.ts`)**:
   - **Precedence & Conservative Conflict Policy**: Prefers valid EXIF `DateTimeOriginal` (paired with `OffsetTimeOriginal` and `SubSecTimeOriginal`). Falls back to valid EXIF `DateTimeDigitized` (`CreateDate`, paired with `OffsetTimeDigitized` and `SubSecTimeDigitized`) **only** when `DateTimeOriginal` is absent. When `DateTimeOriginal` is present but invalid (e.g. malformed syntax, impossible calendar date, or invalid offset), the system conservatively preserves the capture date as **Unknown** (`captureCalendarDate = null`, `captureLocalIso = null`), attributing the primary tag (`captureDateSourceTag = 'DateTimeOriginal'`), recording the exact `captureDateParseError`, and logging an explicit conflict note (`DateTimeOriginal ("...") is invalid while DateTimeDigitized ("...") is present; keeping capture date Unknown rather than masking invalid primary tag`), rather than silently falling back to a secondary tag and masking primary tag corruption. Image modification tags (`DateTime` / `ModifyDate`), filesystem `birthtimeMs`/`mtimeMs`, and filenames are **never** used to infer capture dates.
   - **Timezone Honesty**: Timestamps with a valid explicit offset (`Z` or `±HH:MM` within `-14:00..+14:00`) record `capture_timezone_kind = 'explicit_offset'`, `capture_offset_minutes`, and `capture_utc_ms`. Timestamps lacking an offset record `capture_timezone_kind = 'local_wall_clock_unknown_tz'` with `capture_offset_minutes = NULL` and `capture_utc_ms = NULL` — never coerced to the host timezone or UTC.
   - **Validation, Conflicts & Calendar Filtering**: Validates real Gregorian calendar dates (including leap-year February 29 rules), 24-hour clock bounds, and subseconds (`<= 9` digits). Malformed tags record `capture_date_parse_error` while preserving raw tag text in `raw_tags_json`. Contradictory tags (e.g., valid `DateTimeOriginal` vs. differing `DateTimeDigitized` calendar date, invalid `DateTimeOriginal` with valid `DateTimeDigitized` present, or invalid offset strings) populate `capture_date_conflict`. Date-range SQL filters match `capture_calendar_date` (`YYYY-MM-DD` recorded wall-clock date) deterministically without host-timezone dependence.
4. **User Annotations & Machine Embeddings**: Stage 5B user review annotations (`photo_annotations`, `collection_memberships`) and Stage 6B semantic vectors (`photo_semantic_embeddings`) remain completely separate. GPS coordinates, maps, reverse geocoding, metadata editing, and writing EXIF are excluded.

### 1.3 Dimensions, Camera/Lens Normalization & File-Type Basis (`src/main/services/metadata/normalize.ts`)

- **Dimensions**: Preserves `encoded_width_px`, `encoded_height_px`, and `exif_orientation` (`1..8`), rejecting impossible or excessive values (`< 1`, `> 100,000` px per axis, or `> 100,000,000` pixels). Computes orientation-adjusted `display_width_px` and `display_height_px` (orientations `5..8` swap width and height); SQL resolution filters (`minWidthPx`, `minHeightPx`) evaluate against `display_width_px` and `display_height_px`.
- **Camera & Lens**: Sanitizes raw tag text (`<= 256` chars, Unicode NFC, stripping NUL/control bytes), preserves `camera_make_raw`, `camera_model_raw`, and `lens_model_raw`, and derives bounded lowercase `camera_normalized` and `lens_normalized` keys (deduplicating redundant Make prefixes in Model strings without inventing model labels).
- **File-Type Basis**: Keeps `recorded_extension` (filename suffix) separate from `detected_format` (verified magic-byte container header: `jpeg`, `png`, `webp`, `gif`, `tiff`, `avif`, `heic`, `cr2`, `nef`, `arw`, `dng`, `orf`, `rw2`, `raf`) and flags discrepancies (`extension_format_mismatch = 1`). File-type SQL filters explicitly label whether matching uses `detected_format` or `filename_extension`. Apple HEIC/HEIF (lacking patent-encumbered HEVC codecs in prebuilt libvips) and camera RAW containers report honest `unsupported` status (`UNSUPPORTED_FORMAT`).

### 1.4 SQLite Migration 10, Exact Job Scope & Combined SQL Filters (`src/main/services/catalog/`)

- **Schema Migration 10 (`CURRENT_SCHEMA_VERSION = 10`)**:
  - `photo_technical_metadata`: revision-bound rows with partial unique index `idx_ptm_curr ON photo_technical_metadata(file_location_id, parser_recipe_version) WHERE is_current = 1`, content-reuse index `idx_ptm_sha256_curr`, and filter/facet indexes on `capture_calendar_date`, `camera_normalized`, `lens_normalized`, `(display_width_px, display_height_px)`, and `detected_format`.
  - `photo_metadata_jobs` & `photo_metadata_job_items`: durable job state (`running`, `paused`, `cancelled`, `interrupted`, `failed`, `completed`), counters (`total_photos`, `processed_photos`, `extracted_photos`, `reused_photos`, `no_metadata_photos`, `unsupported_photos`, `failed_photos`), and per-photo snapshot scope (`expected_revision`, `status`, `error_code`, `error_message`).
- **Truthful Coverage & `Unknown` vs. `unprocessed` Separation**:
  - `getPhotoMetadataCoverage` reports exact counts across `extracted`, `no_metadata`, `unsupported`, `failed`, `stale`, and `unprocessed`.
  - `Unknown` filter options (`includeUnknownCaptureDate`, `onlyUnknownCamera`, `onlyUnknownLens`, `includeUnknownDimensions`, `onlyUnknownDetectedFormat`) require `m.id IS NOT NULL` (processed current revision for `exif_tech_v1` where the target column is `NULL`), so `unprocessed` or `stale` photos never masquerade as confirmed `Unknown` metadata.
- **Bounded Facets & Combined SQL Pagination**:
  - `getPhotoMetadataFacet` provides bounded searchable/paginated (`LIMIT <= 100`, `OFFSET >= 0`) options for camera, lens, detected format, and filename extension alongside `unknownCount` and `unextractedCount`.
  - `getPhotosPage` combines all Stage 6C filters with Stage 5B `ratingFilter`, `flagFilter`, and `collectionId` via parameterized SQL `AND` clauses before `ORDER BY fl.id ASC LIMIT ? OFFSET ?`.

### 1.5 Shared Worker Pool & Numerical Resource Bounds (`ThumbnailCoordinator` + `PhotoMetadataCoordinator`)

| Resource / Parameter             | Enforced Production Bound                                                                                                  | Implementation Mechanism                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Aggregate Live Image Workers** | $\le 2$ live workers (including terminating workers until `'exit'`)                                                        | Shared `ThumbnailCoordinator` pool across thumbnails, `dhash64_v1`, `semantic_embed`, and `extract_photo_metadata`                     |
| **Active Metadata Tasks**        | $\le 1$ concurrent `extract_photo_metadata` task                                                                           | `activeMetadataCount < 1` gate in `ThumbnailCoordinator.processQueue()`                                                                |
| **Active Semantic Tasks**        | $\le 1$ concurrent `semantic_embed` task, $\le 1$ worker holding loaded ONNX session                                       | `activeSemanticCount < 1` + `semanticSessionWorkerId` in `ThumbnailCoordinator`                                                        |
| **Aggregate Worker Queue**       | $\le 64$ total queued requests ($\ge 8$ reserved for interactive thumbnails; background yields)                            | Low-priority jobs rejected when `queue.length >= 56`; `PhotoMetadataCoordinator` yields while interactive thumbnail decodes are active |
| **Per-Task Execution Timeout**   | $15,000\text{ ms}$                                                                                                         | Worker terminated on timeout or `cancelMetadataRequests()`; capacity recovered upon `'exit'`                                           |
| **Source & Metadata Caps**       | $\le 128\text{ MiB}$ source, $\le 100\text{ MP}$ dimensions, $\le 8\text{ MiB}$ EXIF segment, $\le 32\text{ KiB}$ raw JSON | Enforced in worker before/during read and normalization                                                                                |
| **Live-Source Reuse & Commits**  | Off-main `verify_source` SHA-256 check + transactional `content_revision` check                                            | Unchanged content reused only after live SHA-256 + timestamp verification; changed revision rejected with `REVISION_MISMATCH`          |
| **Renderer Virtual Grid Bounds** | $\le 200$ mounted DOM cells, $\le 2,000$ retained browsing records                                                         | Preserved in `PhotosPanel.tsx` and `usePhotos.ts`; filter changes synchronously advance `filterGeneration` and reset pagination/scroll |

---

## 2. Verification Scope Distinctions & Real Electron Measurements

### 2.1 Repository Scale Tests vs. Real-Electron Binary Image Suites

- **Repository Scale Test (`tests/main/catalog-photo-metadata.test.ts`)**:
  - Verifies SQLite Migration 10, bounded 500-item job scope snapshotting (`createPhotoMetadataJob`, `getPhotoMetadataJobPendingItems`), coverage aggregation, bounded facet queries, and combined SQL filtering across **50,001 cataloged photo rows** (`3.09 s` in Vitest) with zero permanent collection-size cap and without materializing catalog arrays in memory. Synthetic SQLite rows establish SQL repository scalability only, **not** binary image parsing throughput.
- **Real-Electron Built & Unpacked Suites (`scripts/verify-electron-metadata.mjs` via `npm run verify:metadata` and `npm run verify:metadata:unpacked`)**:
  - Exercises real `BrowserWindow`, sandboxed preload (`out/preload/index.js` verified requiring only `"electron"`), validated IPC, and actual DOM controls in both built mode and freshly packaged `dist/win-unpacked/Personal Vault.exe` across **99 real binary image files on disk** (66 immutable source photos including 52 Canon EOS R5 JPEGs for multi-page `> 50` SQL pagination, Sony leap-day `+02:00` with subseconds, Fujifilm `DateTimeDigitized` wall-clock fallback, Orientation-6 `600×400` -> `400×600` display dimensions, Nikon modification-only `DateTime`, metadata-free PNG/WebP, PNG disguised with `.jpg` extension, unsupported `.heic`/`.cr2`, corrupt `.jpg`, 1 mutable source photo, 8 crash/resume scope photos, and 24 concurrent-load Olympus JPEGs):
    1. Launches **without** a semantic model installed, scans 67 real fixtures, verifies truthful `67 unprocessed` coverage, and proves `Unknown` filters return `0` matches before extraction.
    2. Exercises DOM `Extract Metadata`, live progress, active DOM `Cancel` (`2/67` processed, `65` remaining unprocessed), and full completion without any semantic model (`58` extracted, `6` `no_metadata`, `2` `unsupported` HEIC/CR2, `1` `failed` corrupt JPEG, `0` unprocessed).
    3. Verifies selected-photo provenance (`2024-02-29T08:15:30.250` `+02:00`, `DateTimeDigitized` fallback with `Timezone unknown`, `400 × 600 px (orientation-adjusted)` vs. encoded `600 × 400 px` `Orientation 6`, `.jpg` vs. `png` container mismatch badge, and `DateTime` modification tag remaining `Unknown`).
    4. Exercises every Stage 6C SQL filter (capture date range + `Include Unknown`, camera search/select + multi-page SQL pagination to page 2 `canon_052.jpg` + `Only Unknown`, lens select + `Only Unknown`, minimum display width/height + `Include Unknown`, file-type `detected_format` vs. `filename_extension` + `Only Unknown`), `AND` combinations with Stage 5B Rating (`4+ Stars`), Flag (`Pick`), and Collection (`Highlights 6C`), scroll reset to `0` on filter change, and `Reset filters`.
    5. Modifies `mutable_source.jpg` out of band, rescans, and verifies current metadata invalidates to `Stale` while preserving `1 historical revision(s)`.
    6. Triggers deterministic mid-job process kill (`exit code 99`) after committing 2 items of a 7-photo scope, relaunches, verifies `interrupted` recovery (`2/7` processed), scans 2 additional Hasselblad photos **before** clicking `Resume Scope`, and proves exact-scope resume completes the 7-photo snapshot while leaving the 2 newly scanned photos `unprocessed`.
    7. Imports the verified offline CLIP model and runs interactive virtual-grid scrolling concurrently with **both** active metadata extraction and active ONNX semantic indexing over 99 real photos.
    8. Verifies bitwise source preservation across all 66 immutable source photos and 7 model files (`SHA-256`, `byteSize`, `birthtimeMs`, and `mtimeMs` 100% unchanged; accurately reports that Windows NTFS updated `atimeMs` on `66/66` read-only file opens because Personal Vault never touches source files with `utimes`).

### 2.2 Real-Electron Responsiveness, Resource & Sampled Memory Summary

_(Note: Memory figures below are periodic point samples collected every ~100 ms during concurrent metadata extraction + ONNX semantic indexing + virtual-grid scrolling; they represent sampled maxima across the 99-photo workload, distinct from continuous OS kernel high-water marks.)_

| Metric                                              | Built Mode (`npm run verify:metadata`)         | Unpacked Mode (`npm run verify:metadata:unpacked`)  | Enforced Bound / Target             |
| --------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| **Verification Checks Passed**                      | **11 / 11** (exit 0)                           | **12 / 12** (exit 0, incl. `app.asar` binary check) | 100% pass                           |
| **Renderer rAF Frame Intervals Sampled**            | `2,452` (`p95 = 4.30 ms`, `max = 4.30 ms`)     | `2,356` (`p95 = 4.30 ms`, `max = 4.30 ms`)          | `p95 <= 33 ms` (bound >= 50 frames) |
| **Main Process Event-Loop Delay p95**               | `20.82 ms`                                     | `21.38 ms`                                          | `< 100 ms`                          |
| **Renderer-to-Main IPC Round-Trip Latency**         | `p95 = 13.35 ms` (`max = 20.74 ms`)            | `p95 = 10.38 ms` (`max = 23.54 ms`)                 | `p95 < 100 ms`                      |
| **Peak Live Image Workers (incl. terminating)**     | `2` (`active=2`, `terminating=2`)              | `2` (`active=2`, `terminating=0`)                   | `<= 2`                              |
| **Peak Active Metadata Extraction Tasks**           | `1` (simultaneous active execution verified)   | `1` (simultaneous active execution verified)        | `<= 1`                              |
| **Peak Active Semantic Tasks / Loaded Sessions**    | `1` / `1`                                      | `1` / `1`                                           | `<= 1` / `<= 1` (asserted bound)    |
| **Peak Queued Worker Jobs**                         | `9`                                            | `9`                                                 | `<= 64`                             |
| **Peak Mounted DOM Photo Cells**                    | `20`                                           | `20`                                                | `<= 200`                            |
| **Sampled Main Process RSS Max (`rss`)**            | `372.13 MiB`                                   | `381.96 MiB`                                        | Point-sampled process-wide RSS      |
| **Sampled Worker Isolate V8 Heap Max (`heapUsed`)** | `11.12 MiB`                                    | `11.59 MiB`                                         | Point-sampled worker isolate heap   |
| **Sampled Renderer JS Heap Max**                    | `11.35 MiB`                                    | `10.68 MiB`                                         | Point-sampled renderer V8 heap      |
| **Source Preservation Invariance**                  | **Confirmed** (`0` byte/mtime/birthtime diffs) | **Confirmed** (`0` byte/mtime/birthtime diffs)      | Bitwise & timestamp invariant       |

---

## 3. Verification Quality Gates Matrix (All 23 Gates Executed)

All 23 required verification commands executed sequentially from `D:\organizer` on `feat/stage-6c-photo-metadata`:

| #   | Verification Gate / Suite                   | Command                                  | Result                         | Exit Code | Evidence Notes                                                                                                         |
| --- | ------------------------------------------- | ---------------------------------------- | ------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | **Unit & Behavioral Tests**                 | `npm test`                               | **894 passed across 72 files** | 0         | Includes parser/date/normalization, 50,001-row SQL scale, worker/coordinator, IPC/preload, and React UI race tests     |
| 2   | **Strict Typecheck**                        | `npm run typecheck`                      | **Clean pass**                 | 0         | Strict TypeScript checking across `tsconfig.node.json` and `tsconfig.web.json` (0 errors)                              |
| 3   | **ESLint**                                  | `npm run lint`                           | **Clean pass**                 | 0         | 0 errors, 0 warnings (including React 19 `react-hooks/set-state-in-effect`)                                            |
| 4   | **Formatting Compliance**                   | `npm run format:check`                   | **Clean pass**                 | 0         | 100% Prettier compliant                                                                                                |
| 5   | **Production Bundle Build**                 | `npm run build`                          | **Clean pass**                 | 0         | Main, preload (`requires` only `electron`), worker (`exifreader` bundled), and renderer bundles built cleanly          |
| 6   | **Desktop Unpacked Build**                  | `npm run build:unpack`                   | **Clean pass**                 | 0         | `dist/win-unpacked/Personal Vault.exe` packaged with updated `THIRD_PARTY_NOTICES.md`, `sharp`, and `onnxruntime-node` |
| 7   | **Real Electron Metadata & SQL (Built)**    | `npm run verify:metadata`                | **11/11 passed**               | 0         | Stage 6C real Electron built verification: simultaneous worker tasks verified, frame set verified, bounds asserted     |
| 8   | **Real Electron Metadata & SQL (Unpacked)** | `npm run verify:metadata:unpacked`       | **12/12 passed**               | 0         | Stage 6C packaged `Personal Vault.exe` verification: simultaneous worker tasks verified, frame set, bounds asserted    |
| 9   | **Real Electron Semantic Index (Built)**    | `npm run verify:semantic-index`          | **10/10 passed**               | 0         | Stage 6B regression check (`frame p95 = 4.20 ms`, `event-loop p95 = 16.16 ms`)                                         |
| 10  | **Real Electron Semantic Index (Unpacked)** | `npm run verify:semantic-index:unpacked` | **11/11 passed**               | 0         | Stage 6B unpacked regression check (`frame p95 = 4.20 ms`, `event-loop p95 = 16.48 ms`)                                |
| 11  | **Real Electron Similarity (Built)**        | `npm run verify:similarity`              | **8/8 passed**                 | 0         | Stage 5C regression check                                                                                              |
| 12  | **Real Electron Similarity (Unpacked)**     | `npm run verify:similarity:unpacked`     | **8/8 passed**                 | 0         | Stage 5C unpacked regression check                                                                                     |
| 13  | **Real Electron Photo Review (Built)**      | `npm run verify:photo-review`            | **12/12 passed**               | 0         | Stage 5B regression check                                                                                              |
| 14  | **Real Electron Photo Review (Unpacked)**   | `npm run verify:photo-review:unpacked`   | **12/12 passed**               | 0         | Stage 5B unpacked regression check                                                                                     |
| 15  | **Real Electron Photos (Built)**            | `npm run verify:photos`                  | **19/19 passed**               | 0         | Stage 5A 10,000-photo regression check                                                                                 |
| 16  | **Real Electron Photos (Unpacked)**         | `npm run verify:photos:unpacked`         | **19/19 passed**               | 0         | Stage 5A unpacked 10,000-photo regression check                                                                        |
| 17  | **Real Electron Duplicate Review**          | `npm run verify:duplicates`              | **18/18 passed**               | 0         | Stage 3 regression check                                                                                               |
| 18  | **Real Electron Scan & Recovery**           | `npm run verify:scan`                    | **14/14 passed**               | 0         | Stage 2 regression check                                                                                               |
| 19  | **Real Electron SQLite Repository**         | `npm run verify:sqlite`                  | **8/8 passed**                 | 0         | Electron `node:sqlite` driver verification                                                                             |
| 20  | **Real Electron Vault Import (Built)**      | `npm run verify:vault`                   | **11/11 passed**               | 0         | Stage 4 regression check                                                                                               |
| 21  | **Real Electron Vault Import (Unpacked)**   | `npm run verify:vault:unpacked`          | **11/11 passed**               | 0         | Stage 4 unpacked regression check                                                                                      |
| 22  | **Real Electron Smoke (Built)**             | `npm run smoke:built`                    | **Passed**                     | 0         | Preload bridge surface (including all Stage 6C `metadata:*` methods), navigation guards, CSP                           |
| 23  | **Real Electron Smoke (Unpacked)**          | `npm run smoke:unpacked`                 | **Passed**                     | 0         | Packaged binary smoke check                                                                                            |

---

## 4. Preserved Unrelated Files & Working Tree

The following unrelated files remain intact, untracked, and untouched:

- `.codex/` directory
- `scripts/launch-desktop.ps1`
- `scripts/verify-bridge-and-dialog.mjs`
- `scripts/verify-desktop-window.ps1`

---

## 5. Next Assignment (Following Stage 6C Acceptance)

- **Current Substage**: **Stage 6C — Photo Metadata Extraction & Fact/Inference-Separated SQL Filters** (**Complete**; independently accepted at `c8a766f` on `feat/stage-6c-photo-metadata`).
- **Overall Stage 6 Status**: **In progress** (Substages 6A, 6B, and 6C Complete; Substages 6D–6E Planned).
- **Next Planned Substage**: **Stage 6D — Natural-Language Photo Search IPC, Ranking, and Photos UI Integration** (`Planned`).
  - Scope: Offline text query tokenization & CLIP text embedding generation, bounded cosine similarity search ranking combined with Stage 5B/6C SQL filters, narrow typed search IPC, and Photos search UI controls.
