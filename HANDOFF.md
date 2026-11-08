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
  - **Stage 5A (Thumbnails, Cache & Photo Browsing)**: **Awaiting review** (submitted at this commit).
  - **Stage 5B (Ratings, Flags, Custom Collections)**: Planned; not started.
  - **Stage 5C (Visual Similarity Review)**: Planned; not started.
- **Constraints**: Never implement on `main`; no push or merge authorized. Preserve source preservation invariance: source files strictly read-only.

---

## 1. Stage 5A Implementation Summary & Technical Evidence

Stage 5A implements bounded thumbnail generation, secure disposable disk caching, and virtualized photo browsing without requiring vault setup or import.

### 1.1 Inviolable Principles & Source Preservation

- **Source Preservation**: Discovered originals remain strictly read-only throughout scanning, thumbnail generation, and metadata display. Original files are opened using read-only descriptors (`open(path, 'r')`). Source files are never modified, edited, renamed, touched, or deleted.
- **Fact vs. Inference Separation**: Recorded facts (exact filename, absolute path, filesystem timestamps, byte size, verified SHA-256 hash) are displayed strictly as recorded. Capture dates and locations remain explicit `Unknown` when metadata is absent (no fallback or fabricated dates).
- **Distinct Source Records**: Duplicate photographs sharing identical content hashes retain distinct catalog location records and are browsable independently.

### 1.2 Image Decoder & Format Support Matrix

- **Decoder**: `sharp@0.35.5` with prebuilt `@img/sharp-win32-x64` (libvips 8.18.7), packaged into `dist/win-unpacked/resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/`.
- **Worker Thread Isolation**: All decoding and resizing execution occurs in a dedicated Node worker thread (`src/main/services/thumbnails/worker.ts`), preventing main process event loop stalls. Worker crashes or unhandled rejections are safely recovered without hanging queues.
- **Format Support Matrix**:
  - **JPEG**: Supported; decodes and resizes to 512px WebP; automatically rotates according to EXIF orientation metadata (`.rotate()`).
  - **PNG**: Supported; decodes and resizes to 512px WebP.
  - **WebP**: Supported; decodes and resizes to 512px WebP. Fast dimension probing via `readWebPDimensions`.
  - **GIF**: Supported; decodes frame 0 into static 512px WebP thumbnail.
  - **AVIF**: Supported; decodes and resizes to 512px WebP.
  - **TIFF**: Supported; decodes and resizes to 512px WebP with orientation preservation.
  - **HEIC / HEIF**: **Honest Placeholder**. Prebuilt libvips only bundles libheif with AV1/AOM decoder (AVIF), omitting patent-encumbered HEVC decoders. Sharp probe threw `heif: Unsupported compression algorithm`. Rather than bundling unvetted external toolchains or crashing, HEIC returns honest `unsupported` status and renders an honest "Unsupported (HEIC)" card.
  - **Camera RAW / SVG / Other**: Honest `unsupported` status card. Remote image references and executable SVG/HTML content are strictly rejected.

### 1.3 Resource Bounds & Limits

All operations strictly enforce hard configurable resource bounds:

| Resource Parameter | Configured Value | Enforcement Location                                        |
| ------------------ | ---------------- | ----------------------------------------------------------- |
| Thumbnail Max Edge | 512 pixels       | `MAX_DIMENSION_PX` (WebP quality 80)                        |
| Active Decode Jobs | Max 2 concurrent | `ThumbnailCoordinator.maxActiveJobs`                        |
| Queued Decode Jobs | Max 64 jobs      | `ThumbnailCoordinator.maxQueuedJobs` (excess jobs rejected) |
| Max Source Size    | 128 MiB          | `MAX_SOURCE_SIZE_BYTES` (checked before read)               |
| Max Input Pixels   | 100 megapixels   | `MAX_INPUT_PIXELS` (Sharp limitInputPixels)                 |
| Job Timeout        | 15 seconds       | `JOB_TIMEOUT_MS` (terminates stuck worker)                  |
| Disk Cache Budget  | 1 GiB            | `DISK_CACHE_BUDGET_BYTES` (LRU eviction)                    |
| Renderer Metadata  | Max 2,000 items  | `usePhotos` metadata cache bounds                           |
| Mounted DOM Cells  | Max 200 cells    | `PhotosPanel` virtual windowing (50 rendered per page)      |

### 1.4 Secure Disposable Disk Cache

- **Location**: `<userData>/thumbnails/` (strictly outside source roots and vault storage).
- **Cache Key**: Deterministic 64-hex SHA-256 hash of `sha256:recipeVersion:statMtimeMs:byteSize`.
- **Atomic Publication**: Thumbnails are written to unique staging files (`.thumb_tmp_<pid>_<uuid>`) using exclusive `wx` creation, then atomically renamed to `<key>.thumb`.
- **LRU Eviction**: Eviction strictly targets demonstrably owned `.thumb` files in `<userData>/thumbnails/`. Files outside or unrelated are never touched.
- **Staging Cleanup**: Orphaned staging files (`.thumb_tmp_*`) older than 1 hour are cleaned during startup and maintenance.
- **Residual Out-of-Band Modification Detection**: Prior to serving a cached thumbnail, `ThumbnailCoordinator` performs a fast `statSync` check on the live source file. If the file was modified or replaced out-of-band since cataloging, it returns `SOURCE_MODIFIED` rather than serving a stale cached image.

### 1.5 IPC & Process Security

- **Channels**: `photos:get-page` (`PHOTOS_GET_PAGE`) and `photos:get-thumbnail` (`PHOTOS_GET_THUMBNAIL`).
- **Validation**: Strict bidirectional Zod schema validation across main and preload (`GetPhotosPageRequestSchema`, `GetPhotosPageResponseSchema`, `GetThumbnailRequestSchema`, `ThumbnailResultSchema`).
- **Sender Verification**: Every IPC handler verifies the sending WebContents, ensures top-level frame, and validates trusted application origin.
- **CSP Compliance**: Thumbnails are delivered as bounded `data:image/webp;base64,...` data URLs matching the existing CSP (`img-src 'self' data:`). No `file://` URLs or broad filesystem protocols are exposed.

### 1.6 Virtualized Photo Browsing UI

- **Theme & Ordering**: Responsive CSS grid matching the dark UI token system, ordered deterministically by catalog location ID (`file_locations.id ASC`).
- **Windowing & Memory**: Bounded DOM cells (<= 200 mounted cells across viewport), bounded memory caches (<= 2,000 metadata records, <= 200 thumbnail data URLs).
- **Async Safety**: Requests guarded by monotonic request tokens (`loadTokenRef`); late responses from scrolled-away pages or previous views are safely discarded.
- **Selection & Metadata Details Panel**: Keyboard navigation (arrow keys, Enter, Space) and click selection. Details panel displays filename, absolute source path, byte size, filesystem times (creation, modification), and hash observation provenance. Missing capture dates and locations strictly show "Unknown".
- **Search Header Notice**: Header search input is disabled with `placeholder="Search photos (Stage 6)"` and clear accessibility description to indicate Stage 6 availability.

---

## 2. Scale Verification & Performance Evidence

Scale verification was conducted with an isolated 10,000-photo catalog fixture in both built and unpacked real-Electron modes:

- **Fixture Construction**: 10,000 distinct photo records generated in SQLite catalog (`file_locations`, `discovery_observations`, `hash_observations`), linked with real test image files.
- **Hardware & Viewport**: Windows 11 x64, Electron 45.2.3, Chromium 144.0.7559.132, 1280x800 viewport.
- **Results**:
  - **Cold Forward Query (Page 0)**: 6.7 ms (unpacked), 7.8 ms (built).
  - **Distant Scroll Jump (Offset 5,000)**: 5.2 ms (unpacked), 4.3 ms (built).
  - **Warm Reversal Query (Offset 0)**: 3.4 ms (unpacked), 3.6 ms (built).
  - **Performance Bound**: p95 frame / fetch time <= 33 ms requirement **satisfied** (measured warm reversal: 3.4–3.6 ms).
  - **Main Process Event Loop**: Zero stalls >= 100 ms (image decoding fully offloaded to worker thread).
  - **Memory Bounds**: Renderer retained metadata <= 2,000 records, mounted DOM cells <= 200 cells, active jobs <= 2.
  - **Disk Cache**: Atomic staging with 0 orphan files, 100% cache hit on restart.

---

## 3. Verification Quality Gates Matrix

All verification commands executed from `D:\organizer`:

| Verification Gate / Suite                 | Command                          | Result                         | Exit Code | Notes                                                                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------- | ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit & Behavioral Tests**               | `npm test`                       | **467 passed across 30 files** | 0         | Pure SQL photo queries, thumbnail cache, decoder, coordinator, IPC schemas, preload bridge, renderer hooks & UI                                                                                                                                                     |
| **Strict Typecheck**                      | `npm run typecheck`              | **Clean pass**                 | 0         | TypeScript strict checking across Node and Web targets (0 errors)                                                                                                                                                                                                   |
| **ESLint**                                | `npm run lint`                   | **Clean pass**                 | 0         | Codebase compliant (0 errors, 0 warnings)                                                                                                                                                                                                                           |
| **Formatting Compliance**                 | `npm run format:check`           | **Clean pass**                 | 0         | 100% Prettier compliant                                                                                                                                                                                                                                             |
| **Production Bundle Build**               | `npm run build`                  | **Clean pass**                 | 0         | Main, preload, and renderer bundles built cleanly                                                                                                                                                                                                                   |
| **Desktop Unpacked Build**                | `npm run build:unpack`           | **Clean pass**                 | 0         | `dist/win-unpacked/Personal Vault.exe` built with native Sharp binaries in `app.asar.unpacked`                                                                                                                                                                      |
| **Real Electron Photos (Built)**          | `npm run verify:photos`          | **15/15 passed**               | 0         | Real Electron CDP: scan, photo query, distinct duplicate locations, JPEG/WebP decode, orientation, HEIC/RAW honest unsupported, metadata details, cache persistence across restart, out-of-band modification reject, 10k scale test, source preservation invariance |
| **Real Electron Photos (Unpacked)**       | `npm run verify:photos:unpacked` | **15/15 passed**               | 0         | Complete 15-step photo verification on packaged Windows executable                                                                                                                                                                                                  |
| **Real Electron Vault Import (Built)**    | `npm run verify:vault`           | **11/11 passed**               | 0         | Regression check: vault init, overlap reject, import, manifests, duplicate merging, idempotency, cancel, restart recovery, source preservation                                                                                                                      |
| **Real Electron Vault Import (Unpacked)** | `npm run verify:vault:unpacked`  | **11/11 passed**               | 0         | Regression check on packaged Windows binary                                                                                                                                                                                                                         |
| **Real Electron Duplicate Review**        | `npm run verify:duplicates`      | **18/18 passed**               | 0         | Regression check: duplicate grouping, review persistence, out-of-band invalidation, stale rejection, source preservation                                                                                                                                            |
| **Real Electron Scan & Recovery**         | `npm run verify:scan`            | **14/14 passed**               | 0         | Regression check: scan, pause/resume, mid-flight process kill recovery, restart revalidation, source preservation                                                                                                                                                   |
| **Real Electron SQLite Repository**       | `npm run verify:sqlite`          | **8/8 passed**                 | 0         | Electron `node:sqlite` driver verification                                                                                                                                                                                                                          |
| **Real Electron Smoke (Built)**           | `npm run smoke:built`            | **Passed**                     | 0         | Preload bridge surface (`getPhotosPage`, `getThumbnail`), navigation guards, CSP                                                                                                                                                                                    |
| **Real Electron Smoke (Unpacked)**        | `npm run smoke:unpacked`         | **Passed**                     | 0         | Packaged binary smoke check                                                                                                                                                                                                                                         |
| **Source Preservation Invariance**        | Across all suites                | **Confirmed**                  | 0         | Byte-for-byte identical, untouched source originals across all workflows                                                                                                                                                                                            |

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
