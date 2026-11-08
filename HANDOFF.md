# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-5a-photo-browsing` (created directly from verified Stage 4 closeout commit `8a17bfe2d7f34cea9c0aeb601dc14302ae3fb588`, ancestry `79bbf44 -> cf91653 -> 1a1fb69 -> 8a17bfe` verified)
- **Base Commit**: `8a17bfe`
- **Stage 1 status**: Complete (independently accepted at `070e3cb`).
- **Stage 2 status**: Complete (all substages 2A-2D independently accepted; Stage 2D accepted at `71e1af7`, documentation closeout committed at `eea7daa`).
- **Stage 3 status**: Complete (independently accepted at `79bbf44`, documentation closeout committed at `cf91653`).
- **Stage 4 status**: Complete (independently accepted at `1a1fb69`, closeout at `8a17bfe`).
- **Stage 5 status**: **In progress; Substage 5A awaiting review**.
  - **Stage 5A (Thumbnails, Cache & Photo Browsing)**: **Awaiting review** (corrected following independent review findings).
  - **Stage 5B (Ratings, Flags, Custom Collections)**: Planned; not started.
  - **Stage 5C (Visual Similarity Review)**: Planned; not started.
- **Constraints**: Never implement on `main`; no push or merge authorized. Preserve source preservation invariance: source files strictly read-only.

---

## 1. Stage 5A Implementation Summary & Technical Evidence

Stage 5A implements bounded thumbnail generation, secure disposable disk caching, and virtualized photo browsing without requiring vault setup or import. Following review findings, all review items have been resolved and verified with meaningful failing behavioral tests prior to implementation.

### 1.1 Inviolable Principles & Source Preservation

- **Source Preservation**: Discovered originals remain strictly read-only throughout scanning, thumbnail generation, and metadata display. Original files are opened using read-only descriptors (`open(path, 'r')`). Source files are never modified, edited, renamed, touched, or deleted. All 20 real-Electron checks verify source byte invariance against initial SHA-256 hashes.
- **Fact vs. Inference Separation**: Recorded facts (exact filename, absolute path, filesystem timestamps, byte size, verified SHA-256 hash) are displayed strictly as recorded. Capture dates and locations remain explicit `Unknown` when metadata is absent (no fallback or fabricated dates).
- **Distinct Source Records**: Duplicate photographs sharing identical content hashes retain distinct catalog location records and are browsable independently without collapsing.

### 1.2 Image Decoder & Worker Isolation

- **Decoder**: `sharp@0.35.5` with prebuilt `@img/sharp-win32-x64` (libvips 8.18.7), packaged into `dist/win-unpacked/resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/`.
- **Actual Bounded Worker Execution**: All decoding and resizing execution occurs in dedicated Node worker threads (`worker_threads.Worker` executing `src/main/services/thumbnails/worker.ts`), preventing main process event loop stalls. Worker timeouts, cancellations, or terminations properly terminate the worker thread and await termination before reallocating concurrency capacity.
- **Worker Management**:
  - Max 2 concurrent worker threads.
  - Max 64 queued jobs prioritized by visible cell order.
  - 15-second per-job timeout triggering worker termination.
  - Explicit cancellation (`photos:cancel-thumbnail`) terminating active worker jobs and dequeuing pending work.
  - Graceful coordinator shutdown terminating all workers and cleaning staging files.
- **Format Support Matrix**:
  - **JPEG**: Supported; decodes and resizes to 512px WebP; automatically rotates according to EXIF orientation metadata (`.rotate()`).
  - **PNG**: Supported; decodes and resizes to 512px WebP.
  - **WebP**: Supported; decodes and resizes to 512px WebP. WebP dimension parsing via `readWebPDimensions` (RIFF/WEBP header parsing) rejects malformed or truncated files.
  - **GIF**: Supported; decodes frame 0 into static 512px WebP thumbnail.
  - **AVIF**: Supported; decodes and resizes to 512px WebP.
  - **TIFF**: Supported; decodes and resizes to 512px WebP with orientation preservation.
  - **HEIC / HEIF**: **Honest Placeholder**. Prebuilt libvips only bundles libheif with AV1/AOM decoder (AVIF), omitting patent-encumbered HEVC decoders. Sharp probe threw `heif: Unsupported compression algorithm`. Rather than bundling unvetted external toolchains or crashing, HEIC returns honest `unsupported` status and renders an honest "Unsupported (HEIC)" card.
  - **Camera RAW / SVG / Other**: Honest `unsupported` status card. Remote image references and executable SVG/HTML content are strictly rejected.

### 1.3 Resource Bounds & Limits

All operations strictly enforce hard configurable resource bounds:

| Resource Parameter | Configured Value | Enforcement Location                                              |
| ------------------ | ---------------- | ----------------------------------------------------------------- |
| Thumbnail Max Edge | 512 pixels       | `MAX_DIMENSION_PX` (WebP quality 80)                              |
| Active Decode Jobs | Max 2 concurrent | `ThumbnailCoordinator.maxActiveJobs` (real worker thread pool)    |
| Queued Decode Jobs | Max 64 jobs      | `ThumbnailCoordinator.maxQueuedJobs` (excess jobs rejected)       |
| Max Source Size    | 128 MiB          | `MAX_SOURCE_SIZE_BYTES` (enforced before AND during chunked read) |
| Max Input Pixels   | 100 megapixels   | `MAX_INPUT_PIXELS` (Sharp limitInputPixels)                       |
| Job Timeout        | 15 seconds       | `JOB_TIMEOUT_MS` (terminates worker thread)                       |
| Disk Cache Budget  | 1 GiB            | `DISK_CACHE_BUDGET_BYTES` (LRU eviction)                          |
| Renderer Metadata  | Max 2,000 items  | `usePhotos` sliding page cache (40 pages of 50 items)             |
| Mounted DOM Cells  | Max 200 cells    | `PhotosPanel` virtual windowing (bounded visible indices)         |

### 1.4 Secure Disposable Disk Cache

- **Location**: `<userData>/thumbnails/` (canonical separation verified: overlaps with source roots or active vault storage are rejected; symlinks/junctions rejected).
- **Cache Key Identity**:
  - Hashed files: `hash:<sha256>:<recipe>`.
  - Unhashed files: `unhashed:<locationId>:<normalizedPath>:<byteSize>:<mtimeMs>:<recipe>`, strictly bound to source identity to guarantee files with identical size and mtime never collide.
- **Integrity & Dimension Parsing**: Validates WebP header (`RIFF....WEBPVP8 `) via `readWebPDimensions`. Corrupt, empty, or truncated cache files are unlinked and treated as cache misses, safely regenerating on next request without inventing dimensions.
- **Atomic Publication**: Thumbnails are written to unique staging files (`.thumb_tmp_<pid>_<uuid>`) using exclusive `wx` creation, then atomically renamed to `<key>.thumb`.
- **LRU Eviction**: Eviction strictly targets demonstrably owned `.thumb` files in `<userData>/thumbnails/`. Files outside or unrelated are never touched.
- **Staging Cleanup**: Orphaned staging files (`.thumb_tmp_*`) are cleaned during startup and shutdown.
- **Source Byte Cap Enforcement**: Checked on descriptor prior to read and on every chunk during streaming read.
- **Residual Out-of-Band Modification Detection**: Prior to serving a cached thumbnail, `ThumbnailCoordinator` performs a fast `statSync` check on the live source file. If the file was modified or replaced out-of-band since cataloging, it returns `SOURCE_MODIFIED` rather than serving a stale cached image.

### 1.5 IPC & Process Security

- **Channels**: `photos:get-page` (`PHOTOS_GET_PAGE`), `photos:get-thumbnail` (`PHOTOS_GET_THUMBNAIL`), `photos:cancel-thumbnail` (`PHOTOS_CANCEL_THUMBNAIL`), and `photos:get-diagnostics` (`PHOTOS_GET_DIAGNOSTICS`).
- **Validation**: Strict bidirectional Zod schema validation across main and preload (`GetPhotosPageRequestSchema`, `GetPhotosPageResponseSchema`, `GetThumbnailRequestSchema`, `ThumbnailResultSchema`, `CancelThumbnailRequestSchema`, `CancelThumbnailResponseSchema`, `PhotosDiagnosticsResponseSchema`).
- **Sender Verification**: Every IPC handler verifies the sending WebContents, ensures top-level frame, and validates trusted application origin.
- **CSP Compliance**: Thumbnails are delivered as bounded `data:image/webp;base64,...` data URLs matching the existing CSP (`img-src 'self' data:`). No `file://` URLs or broad filesystem protocols are exposed.

### 1.6 Virtualized Photo Browsing UI & Large-Collection Support

- **Theme & Ordering**: Responsive CSS grid matching the dark UI token system, ordered deterministically by catalog location ID (`file_locations.id ASC`).
- **Full Collection Extent & Windowing**: Virtual container height represents full collection extent (`totalRows * rowHeight` based on `totalCount`), maintaining absolute positions. Mounted DOM cells are strictly bounded to `<= 200`. Supports distant jumps (e.g. to photo 7,500) and return to evicted pages without duplicates, gaps, or scroll jumps.
- **Sliding Metadata Page Cache**: Bounded to 40 pages (2,000 records). Evicts LRU pages when user scrolls to distant regions.
- **Monotonic Generations & Stale Response Protection**: Request bookkeeping tracks `{ requestId, generation, revision }`. Monotonic generation increments on refresh and unmount. Late completions from older requests or stale generations cannot overwrite newer cells or clear newer request tracking.
- **Selection & Metadata Details Panel**: Keyboard navigation (arrow keys, Enter, Space) and click selection. Details panel displays filename, absolute source path, byte size, filesystem times (creation, modification), and hash observation provenance. Missing capture dates and locations strictly show "Unknown".
- **Search Header Notice**: Header search input is disabled with `placeholder="Search photos (Stage 6)"` and clear accessibility description to indicate Stage 6 availability.

---

## 2. Scale Verification & Performance Evidence

Scale verification was conducted with an isolated 10,000-photo catalog fixture backed by real decodable image files in both built and unpacked real-Electron modes:

- **Fixture Construction**: 10,000 distinct photo records generated in SQLite catalog (`file_locations`, `discovery_observations`, `hash_observations`), backed by real decodable image files inside the source root.
- **Hardware & Viewport**: Windows 11 x64, Electron 45.2.3, Chromium 144.0.7559.132, 1280x800 viewport.
- **Measured Metrics**:
  - **Cold Forward Scroll beyond 2,000 records**: Completed in 375.8 ms (built) / 455.3 ms (unpacked). Mounted DOM cells: 20 <= 200.
  - **Distant Scroll Jump (offset 405,000 near photo 7,500)**: Completed in 153.6 ms (built) / 156.0 ms (unpacked). Mounted DOM cells: 20 <= 200.
  - **Warm Reversal Scroll (back to offset 0)**: Completed in 679.8 ms (built) / 770.5 ms (unpacked) with safe reload of evicted page 0.
  - **Scrolling Frame Interval p95**: Measured via `requestAnimationFrame` over 293–333 recorded frame intervals: **4.3 ms** (satisfies <= 33 ms requirement).
  - **Main Process Event Loop Latency**: **0.9–1.0 ms** during active operations (satisfies < 100 ms limit; zero stalls).
  - **Resource Bounds**: Mounted DOM cells <= 200, active worker pool <= 2, queued jobs <= 64.
  - **Cache Reuse Assertions**: 0 re-decodes on restart verified via diagnostics counters (`totalDecodes` invariant, `cacheHits` incremented).
  - **Source Preservation Invariance**: 100% byte-for-byte invariance confirmed across all test source files.

---

## 3. Verification Quality Gates Matrix

All verification commands executed from `D:\organizer`:

| Verification Gate / Suite                 | Command                          | Result                         | Exit Code | Notes                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------- | ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Unit & Behavioral Tests**               | `npm test`                       | **488 passed across 31 files** | 0         | Pure SQL photo queries, thumbnail cache, worker pool, decoder, coordinator, windowing hooks, IPC schemas, preload bridge, renderer UI                                                                                                                                                            |
| **Strict Typecheck**                      | `npm run typecheck`              | **Clean pass**                 | 0         | TypeScript strict checking across Node and Web targets (0 errors)                                                                                                                                                                                                                                |
| **ESLint**                                | `npm run lint`                   | **Clean pass**                 | 0         | Codebase compliant (0 errors, 0 warnings)                                                                                                                                                                                                                                                        |
| **Formatting Compliance**                 | `npm run format:check`           | **Clean pass**                 | 0         | 100% Prettier compliant                                                                                                                                                                                                                                                                          |
| **Production Bundle Build**               | `npm run build`                  | **Clean pass**                 | 0         | Main, preload, worker, and renderer bundles built cleanly                                                                                                                                                                                                                                        |
| **Desktop Unpacked Build**                | `npm run build:unpack`           | **Clean pass**                 | 0         | `dist/win-unpacked/Personal Vault.exe` built with native Sharp binaries in `app.asar.unpacked`                                                                                                                                                                                                   |
| **Real Electron Photos (Built)**          | `npm run verify:photos`          | **20/20 passed**               | 0         | Real Electron CDP: scan, photo query, distinct duplicate locations, JPEG/WebP decode, orientation, HEIC/RAW honest unsupported, cancellation, metadata details, cache persistence, restart reuse with 0 decodes, out-of-band modification reject, 10k scale test, source preservation invariance |
| **Real Electron Photos (Unpacked)**       | `npm run verify:photos:unpacked` | **20/20 passed**               | 0         | Complete 20-step photo verification on packaged Windows executable                                                                                                                                                                                                                               |
| **Real Electron Vault Import (Built)**    | `npm run verify:vault`           | **11/11 passed**               | 0         | Regression check: vault init, overlap reject, import, manifests, duplicate merging, idempotency, cancel, restart recovery, source preservation                                                                                                                                                   |
| **Real Electron Vault Import (Unpacked)** | `npm run verify:vault:unpacked`  | **11/11 passed**               | 0         | Regression check on packaged Windows binary                                                                                                                                                                                                                                                      |
| **Real Electron Duplicate Review**        | `npm run verify:duplicates`      | **18/18 passed**               | 0         | Regression check: duplicate grouping, review persistence, out-of-band invalidation, stale rejection, source preservation                                                                                                                                                                         |
| **Real Electron Scan & Recovery**         | `npm run verify:scan`            | **14/14 passed**               | 0         | Regression check: scan, pause/resume, mid-flight process kill recovery, restart revalidation, source preservation                                                                                                                                                                                |
| **Real Electron SQLite Repository**       | `npm run verify:sqlite`          | **8/8 passed**                 | 0         | Electron `node:sqlite` driver verification                                                                                                                                                                                                                                                       |
| **Real Electron Smoke (Built)**           | `npm run smoke:built`            | **Passed**                     | 0         | Preload bridge surface (`getPhotosPage`, `getThumbnail`, `cancelThumbnail`, `getPhotosDiagnostics`), navigation guards, CSP                                                                                                                                                                      |
| **Real Electron Smoke (Unpacked)**        | `npm run smoke:unpacked`         | **Passed**                     | 0         | Packaged binary smoke check                                                                                                                                                                                                                                                                      |
| **Source Preservation Invariance**        | Across all suites                | **Confirmed**                  | 0         | Byte-for-byte identical, untouched source originals across all workflows                                                                                                                                                                                                                         |

---

## 4. Preserved Unrelated Files & Working Tree

The following unrelated files remain intact and untouched:

- `.codex/` directory
- `scripts/launch-desktop.ps1`
- `scripts/verify-bridge-and-dialog.mjs`
- `scripts/verify-desktop-window.ps1`

---

## 5. Scope Exclusions & Next Steps

- **Scope Exclusions**: Stage 5A is implemented only. Stage 5B (ratings, flags, custom collections) and Stage 5C (perceptual hashing and visual similarity review) are planned and not started. No catalog deletion, vault deletion, source deletion, OCR, semantic search, or cloud uploads.
- **Stage 5A Status**: Awaiting review.
- **Stage 5 Overall Status**: In progress.
- **Git State**: Work committed on `feat/stage-5a-photo-browsing` branched directly from `8a17bfe`. Do NOT push or merge.
