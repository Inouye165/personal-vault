# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-5b-photo-review` (created directly from verified Stage 5A closeout commit `53c1052fa904bf9bdc4e38dc4bf4bbde156e014f`, Stage 5A accepted at `951fd25b5af00a8ea166822cba014692ad4e06fb`)
- **Base Commit**: `53c1052`
- **Stage 1 status**: Complete (independently accepted at `070e3cb`).
- **Stage 2 status**: Complete (all substages 2A-2D independently accepted; Stage 2D accepted at `71e1af7`, documentation closeout committed at `eea7daa`).
- **Stage 3 status**: Complete (independently accepted at `79bbf44`, documentation closeout committed at `cf91653`).
- **Stage 4 status**: Complete (independently accepted at `1a1fb69`, closeout at `8a17bfe`).
- **Stage 5 status**: **In progress; Substage 5A Complete (independently accepted at `951fd25`); Substage 5B Awaiting review**.
  - **Stage 5A (Thumbnails, Cache & Photo Browsing)**: **Complete** (independently accepted at `951fd25`).
  - **Stage 5B (Ratings, Flags, Custom Collections)**: **Awaiting review** (implementation complete on `feat/stage-5b-photo-review`).
  - **Stage 5C (Visual Similarity Review)**: Planned; not started.
- **Constraints**: Never implement on `main`; no push or merge authorized. Preserve source preservation invariance: source files strictly read-only. Reject is strictly a review annotation; source files and vault copies are never touched, altered, moved, or deleted.

---

## 1. Stage 5B Implementation Summary & Technical Evidence

Stage 5B implements user review annotations (1–5 star ratings, review flags Pick / Reject / None), custom named collections, and pure SQL filtering with out-of-filter refilling, optimistic concurrency, and portable append-only journal storage. All reviewer findings have been resolved with failing tests and verified end-to-end.

### 1.1 Inviolable Principles & Source Preservation

- **Source Preservation**: Source photographs and vault copies are strictly read-only. Setting a rating, changing a review flag, or modifying collection memberships alters metadata only. Reject is strictly an organizational annotation and never deletes, moves, renames, touches, or overwrites source photographs or vault copies. Verified by test assertions and automated real-Electron verification.
- **Provenance & Separation of Facts vs. Inferences**: Recorded facts (exact filename, absolute path, filesystem timestamps, byte size, verified SHA-256 hash) remain immutable recorded facts. Ratings, review flags, and collection memberships are explicit user review annotations. Missing capture dates and locations remain explicit `Unknown`.
- **Distinction of Operations**: Explicitly distinguishes catalog removal, vault copy deletion, and source deletion (none performed automatically).

### 1.2 Database Architecture & Migration 7

Catalog database schema updated via Migration 7 (`CURRENT_SCHEMA_VERSION = 7`):

- `photo_annotations`: tracks `file_location_id`, `discovery_observation_id`, `content_sha256`, `rating` (1–5 stars, nullable), `flag` (`none`, `pick`, `reject`), monotonic `version`, and `is_current` boolean.
- `collections`: stores custom named collections with `name`, `normalized_name` (1–80 chars, trimmed, no control characters, case-insensitive unique constraint), creation/update timestamps.
- `collection_memberships`: records active memberships (`collection_id`, `file_location_id`, `discovery_observation_id`, `content_sha256`, `is_current`).
- `journal_operations`: tracks operation ID, entry sequence, operation kind, commit status, and timestamps.
- `journal_checkpoints`: singleton checkpoint tracking last applied journal sequence and operation ID.
- Dedicated indexes: `idx_photo_annotations_current`, `idx_collections_normalized_name`, `idx_collection_memberships_lookup`, `idx_collection_memberships_photo`.

### 1.3 Two-Phase Recoverable Protocol & Crash Consistency (Finding 1)

- Two-phase commit protocol: mutations check preconditions -> generate unique `opId` -> `BEGIN IMMEDIATE` -> append operation to journal with `fsync` -> apply SQLite updates and insert into `journal_operations` -> `COMMIT` -> append `op_committed` to journal. Rollback on pre-commit failure appends `op_aborted`.
- Post-COMMIT failure handling: if SQLite `COMMIT` succeeds but journal `op_committed` append fails (e.g. disk barrier stall or power loss), the transaction is NEVER marked aborted. The operation returns truthful `persistencePending: true` with `persistenceError`.
- UI Propagation and Safe Reconciliation: `usePhotoReview` and `PhotosPanel` propagate `persistencePending` across IPC and render an honest warning banner ("Journal finalization pending: Saved to database; awaiting journal finalization on disk") with a "Retry reconciliation" control. The retry action calls `photos:reconcile-journal` (`reconcileJournalWithDatabase()`), deterministically committing dangling records without re-executing already committed database mutations.
- Startup reconciliation (`reconcileJournalWithDatabase`): called during `CatalogDatabase.open(...)`, streams unterminated operations via bounded iterator (`stmt.iterate()`) joining `journal_operations` without accumulating rows in memory. Committed operations are finalized with `op_committed`, uncommitted operations with `op_aborted`.

### 1.4 Safe, Bounded Journal Recovery & Streaming Reconciliation (Finding 2)

- Bounded streaming recovery: reads journal in 64 KiB chunks with buffer line scanning, UTF-8 multibyte boundary preservation, and tracks `lastValidByteOffset`.
- Interior corruption handling: any unparseable line or sequence disorder (`entrySeq !== prev + 1`) prior to EOF is treated as corruption. The journal refuses to truncate or alter the file, preserving evidence and throwing `JournalCorruptionError`.
- Safe EOF truncation: only a torn final record at EOF with no subsequent bytes is safely truncated to `lastValidByteOffset` and synced.
- Bounded UI pagination: collections and memberships implement windowed 50-item page navigation (`collectionsPage`, `totalCollectionsPages`, `goToNextCollectionsPage`, `goToPrevCollectionsPage`, `membershipsPage`, `totalMembershipsPages`, `goToNextMembershipsPage`, `goToPrevMembershipsPage`). Memory retention is strictly bounded to at most 50 items per list, eliminating unbounded array accumulation.

### 1.5 Strict Containment, Link Protections & Runtime Security (Finding 4)

- Security containment: recursive ancestor check detects symlinks and Windows directory junctions in the storage directory path (`lstatSync`), rejecting symlink/junction redirection.
- Fail-closed security context: `sourceRootsGetter` and `vaultPathGetter` are required to return valid context; if either throws or returns invalid types, the journal immediately throws `JournalSecurityError` and fails closed.
- Canonical platform-correct overlap check: resolves and normalizes paths, performing platform-specific case-insensitive boundary checks (`===` or prefix with separator).
- Uncapped source inventory: `catalog.getAllSourceRoots()` inspects all registered source roots without arbitrary limits (eliminating earlier 1,000-root truncations).
- Application startup wiring: `catalog` is opened prior to `journal.initialize()`, ensuring authoritative source roots and active vault context are available before journal repair can mutate storage on startup.

### 1.6 Concurrency, Revisions, and Stale Response Guards (Finding 3)

- Per-photo mutation sequence guarding: `photoMutationSeqRef` tracks sequential operation tokens per photo. Stale, out-of-order, or superseded save responses never call `updatePhotoLocal` or overwrite newer catalog state.
- Selection generation & revision guarding: asynchronous saves and membership loads are bound to `targetGen`, `targetPhotoId`, and computed photo revision (`rev:<discoveryId>:<byteSize>:<mtime>:<hash>`). If selection changes (A -> B -> A) or photo revision changes, stale responses are dropped.
- Unmount invalidation: `isMountedRef` guarantees unmounted components discard pending in-flight callbacks.
- Content change invalidation: when photo content (byte size or hash) changes on rescan, both `photo_annotations` and `collection_memberships` are cleanly invalidated while preserving prior version history in the journal. Stale writes rejected atomically with conflict errors (`STALE_REVISION`, `STALE_ANNOTATION_VERSION`).

### 1.7 Renderer Review Flow & Selection State (Finding 5)

- Selection switch concurrency guard: monotonic `selectionGenRef` and `prevSelectedPhotoIdRef` in `usePhotoReview.ts` ensure asynchronous IPC responses and save status updates apply only if the target photo is still selected.
- No cross-photo state leaks: rapid photo switching immediately resets save status, clears stale memberships, and ignores delayed mutations from older selections.
- Accessible collection rename controls: accessible button `Rename collection {name}`, input `New name for collection {name}`, submit Save, and Cancel controls.
- Clear status indicators: visible save states (`Saving...`, `Saved`, `Conflict`, `Error`) with accessible status announcements.

### 1.8 Real Electron Verification Suite (Finding 6)

- Comprehensive verification script (`scripts/verify-electron-photo-review.mjs`): passes 12/12 checks in both built and unpacked modes.
- Exercises actual UI controls via DOM in CDP: star ratings (1-5 stars, clear, re-rate), review flags (Pick, Reject, None), live badge overlay, selection switch concurrency, custom collections (create, rename, add/remove member), combined SQL filters (Rating, Flag, Collection), out-of-filter eviction and grid refill.
- Deterministic persistence interruption: pre-commit barrier holds write, process is terminated, uncommitted SQLite state verified, restart reconciliation appending `op_aborted` verified, and subsequent write success verified.
- Filtered scale browsing beyond 2,000 photos: 3,000 decodable image fixtures seeded via hard links, 2,200 annotated and filtered, cold scroll past 2,000 items, distant jump, return travel, mounted cells bounded <= 200, active workers bounded <= 4, zero error cards.
- Strict source preservation invariance: all original source files and scale base files verified byte-for-byte identical, with Reject confirmed as purely a review annotation.

---

## 2. Stage 5A Implementation Summary & Technical Evidence

Stage 5A implements bounded thumbnail generation, secure disposable disk caching, and virtualized photo browsing without requiring vault setup or import. Following review findings, all review items have been resolved and verified with meaningful failing behavioral tests prior to implementation.

### 1.1 Inviolable Principles & Source Preservation

- **Source Preservation**: Discovered originals remain strictly read-only throughout scanning, thumbnail generation, and metadata display. Original files are opened using read-only descriptors (`open(path, 'r')`). Source files are never modified, edited, renamed, touched, or deleted. All 20 real-Electron checks verify source byte invariance against initial SHA-256 hashes.
- **Fact vs. Inference Separation**: Recorded facts (exact filename, absolute path, filesystem timestamps, byte size, verified SHA-256 hash) are displayed strictly as recorded. Capture dates and locations remain explicit `Unknown` when metadata is absent (no fallback or fabricated dates).
- **Distinct Source Records**: Duplicate photographs sharing identical content hashes retain distinct catalog location records and are browsable independently without collapsing.

### 1.2 Image Decoder & Worker Isolation

- **Decoder**: `sharp@0.35.5` with prebuilt `@img/sharp-win32-x64` (libvips 8.18.7), packaged into `dist/win-unpacked/resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/`.
- **Actual Bounded Worker Execution**: All decoding and resizing execution occurs in dedicated Node worker threads (`worker_threads.Worker` executing `src/main/services/thumbnails/worker.ts`), preventing main process event loop stalls. Worker timeouts, cancellations, or terminations properly terminate the worker thread and await termination before reallocating concurrency capacity.
- **Worker Management**:
  - Max 2 concurrent worker threads (`ThumbnailCoordinator.maxActiveJobs = 2`).
  - Max 64 queued jobs prioritized by visible cell order.
  - 15-second per-job timeout triggering worker termination.
  - Explicit cancellation (`photos:cancel-thumbnail`) terminating active worker jobs and dequeuing pending work.
  - Terminating workers are strictly counted against capacity until confirmed exit so actual live workers never exceed `maxActiveJobs = 2`.
  - Cancellation, timeouts, and worker crashes are handled consistently: the thread is terminated, capacity is held until exit confirmation, and the next queued job is processed.
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
- **Worker-Bounded Integrity & Dimension Parsing**: Validates WebP header dimensions and full image decode integrity via `validateWebPIntegrity` inside bounded worker threads (`action: 'validate_cache'`), preventing main-process event-loop blockage from cache reads. Corrupt pseudo-WebP headers (such as 30-byte truncated buffers with valid RIFF/VP8 chunk headers but missing image payloads) are detected and reported by workers as corrupt. Corrupt cache entries are discarded, unlinked from disk via `cache.delete(key)`, recorded as cache misses (`cacheMisses++`), and safely regenerated from source via worker decodes without inventing dimensions.
- **Resource Bounds & Pre-Allocation Capacity Reservation**:
  - Maximum encoded thumbnail size: 1 MiB (`MAX_THUMBNAIL_BYTES = 1,024 * 1,024`).
  - Maximum dimensions: 512x512 pixels (`MAX_DIMENSION_PX`).
  - Capacity reservation & Replacement-Write Budget Accounting: `reserveCapacity` executes _before_ creating staging files, accurately counting all existing target files and owned staging files (`.thumb_tmp_*`). When replacing an existing cache entry, target bytes and staging bytes are both accounted for, evicting oldest `.thumb` entries down to `maxSizeBytes - neededBytes` before staging so disk usage strictly never exceeds `DISK_CACHE_BUDGET_BYTES`. Concurrent `put()` calls are serialized via a promise lock chain to eliminate write budget races.
  - Failed eviction and disk-full errors are safely handled and rethrown rather than silently claiming success; no orphan temporary files are left behind.
- **Atomic Publication & Deterministic Interruption**: Thumbnails are written to unique staging files (`.thumb_tmp_<pid>_<uuid>`) using exclusive `wx` creation, then atomically renamed to `<key>.thumb`. Deterministic publication interruption at the publication boundary (staging file created and verified before rename) was verified in real Electron via narrowly scoped test barrier instrumentation (`PV_TEST_PUBLICATION_BARRIER_SIGNAL`). On mid-flight process termination, the staging file is proven abandoned on disk, cleaned up on restart, decoded afresh on the first request after restart (`totalDecodes + 1`, `cacheHits + 0`), and cleanly reused from cache on subsequent requests (`totalDecodes + 0`, `cacheHits + 1`).
- **Windows Rename EPERM Investigation, Uncertainty Documentation & Asynchronous Nonblocking Resolution**:
  - Reviewer Rerun Findings: The reviewer rerun reported 28 passed and 7 failed (5 rename `EPERM` failures, 1 missing regenerated file, and stuck-validation receiving `ready` instead of `error`).
  - Analysis & Precondition Gap: When cache publication fails due to rename `EPERM` on the reviewer host during warmup, no `.thumb` file exists on disk. On the subsequent request, `candidateBuf` is null, causing the request to enter `action: 'decode'` rather than `action: 'validate_cache'`, decoding the image afresh and returning `ready` instead of timing out in validation. Preconditions in `thumbnail-coordinator.test.ts` now explicitly assert `existsSync(cacheFile)` and observe `activeJob.item.action === 'validate_cache'` before testing stuck validation.
  - Uncertainty & Host Differences: On the implementation host, all 503 tests and real-Electron suites pass cleanly without rename errors. The hypothesis that Windows NTFS `STATUS_DELETE_PENDING` or virus scanner / search indexer filter drivers caused the rename `EPERM` in the reviewer sandbox remains an unverified hypothesis and has not been directly demonstrated on that environment. Potential differences in sandbox virtualization, container hooks, or filesystem permissions could also account for the failures. We document this uncertainty accurately rather than asserting the hypothesis as fact.
  - Nonblocking Asynchronous Retries & Deterministic Testing: Rather than blocking the Electron main thread with `Atomics.wait` (which previously blocked the event loop for up to 420 ms), `publishFile` now uses asynchronous filesystem operations (`fsPromises.writeFile`, `fsPromises.stat`, `fsPromises.rename`) and nonblocking timer backoff (`setTimeout`). Retries are bounded to a maximum of 5 attempts with total retry duration bounded, and pending retries abort immediately upon `cache.abort()` / `coordinator.shutdown()`. Deterministic unit tests using an injected rename adapter verify event-loop responsiveness (proving timers fire during backoff), transient error recovery, truthful failure and staging cleanup when retries are exhausted, and immediate abort without waiting out delay timers.
- **LRU Eviction**: Eviction strictly targets demonstrably owned `.thumb` files matching `/^[0-9a-fA-F]{64}\.thumb$/` in `<userData>/thumbnails/`. Files outside or unrelated are never touched.
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

Scale verification was conducted with an isolated 10,000-photo catalog fixture backed by real decodable image files with actual recorded filesystem timestamps (`statSync` birthtime/mtime) in both built and unpacked real-Electron modes:

- **Fixture Construction**: 10,000 distinct photo records generated in SQLite catalog (`file_locations`, `discovery_observations`, `hash_observations`), with exact live filesystem stats (`statSync(filePath)` for `birthtimeMs`, `mtimeMs`, `byte_size`), backed by real decodable image files inside the source root.
- **Hardware & Viewport**: Windows 11 x64, Electron 45.2.3, Chromium 144.0.7559.132, 1280x800 viewport.
- **Verified Browsing Checkpoints**:
  - **Checkpoint 1 (Cold Forward Scroll beyond 2,000 records)**: 20 mounted cells, 20 loaded images (`complete && naturalWidth > 0`), 0 unsupported cards, 0 pending cards, 0 error cards, expected photo identity (`photo_002300.jpg`) verified in 1,252.7 ms (built) / 1,304.9 ms (unpacked).
  - **Checkpoint 2 (Distant Scroll Jump near photo 7,500 / offset 405,000)**: 20 mounted cells, 20 loaded images (`complete && naturalWidth > 0`), 0 unsupported cards, 0 pending cards, 0 error cards, expected photo identity (`photo_007488.jpg`) verified in 265.6 ms (built) / 265.2 ms (unpacked).
  - **Checkpoint 3 (Warm Reversal Return to Page 0)**: 20 mounted cells, 18 loaded images (`complete && naturalWidth > 0`), 2 unsupported cards (`iphone_shot.heic` and `camera_raw.cr2`), 0 pending cards, 0 error cards, expected photo identity verified in 1,775.3 ms (built) / 1,650.5 ms (unpacked).
- **Scale Workload Verification Evidence**:
  - **Continuously Enforced Architectural Guarantees**:
    - Worker thread capacity: $\le 2$ live workers (including busy and terminating workers).
    - Job queue capacity: $\le 64$ queued jobs (excess rejected).
    - DOM virtualization window: $\le 200$ mounted cells.
    - LRU metadata page cache: $\le 2,000$ photos (40 pages of 50 items).
    - Source input size cap: $\le 128$ MiB (enforced before and during streaming read).
    - Source image pixel cap: $\le 100$ megapixels.
    - Decoder job timeout: 15,000 ms per job.
    - Disk cache storage budget: $\le 1,024$ MiB (LRU evicted).
    - Atomic publication: exclusive `wx` staging write $\to$ stat check $\to$ atomic rename.
    - Source preservation invariance: source files strictly read-only.
  - **Sampled Workload Maxima & Measurements (10,000 Photos)**:
    - Frame intervals sampled: 584 frames (built) / 599 frames (unpacked) recorded via `requestAnimationFrame` loop.
    - Frame interval p95: **4.30 ms** (satisfies $\le 33$ ms requirement; max frame interval: 16.60–16.70 ms).
    - Main process event loop delay (measured inside main via Node `monitorEventLoopDelay`): p95 = **45.38 ms** (built) / **44.40 ms** (unpacked), max = 73.66 ms (built) / 72.42 ms (unpacked), mean = 18.33 ms (built) / 18.18 ms (unpacked), satisfying the $< 100$ ms responsiveness bound with zero main process event loop stalls.
    - Renderer-to-main IPC round-trip latency: p95 = **28.39 ms** (built) / **61.78 ms** (unpacked), max = 28.94 ms (built) / 64.35 ms (unpacked), mean = 16.75 ms (built) / 22.53 ms (unpacked).
    - Peak worker threads observed: live = 2 ($\le 2$ bound), active = 2, terminating = 0.
    - Peak queued decode jobs: 18 ($\le 64$ bound).
    - Peak mounted DOM cells: 20 ($\le 200$ bound).
    - Peak renderer JS heap: 9.54 MiB.
    - Disk cache usage: final = 0.00 MiB, sampled peak = 0.00 MiB / 1,024 MiB (0 orphan temporary files at rest, sampled peak active staging files = 0).
  - **Worker Cancellation**: Observed active/queued request cancellation across IPC verified with worker thread termination and capacity recovery.
  - **Deterministic Publication Interruption**: Staging file verified on disk before rename, interrupted mid-flight, verified clean restart with 0 orphan staging files, verified new decode on first request after restart, and subsequent cache reuse.
  - **Source Preservation Invariance**: 100% byte-for-byte invariance confirmed across all test source files.

---

## 3. Verification Quality Gates Matrix

All verification commands executed from `D:\organizer`:

| Verification Gate / Suite                 | Command                                | Result                         | Exit Code | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------- | ------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit & Behavioral Tests**               | `npm test`                             | **625 passed across 44 files** | 0         | Full coverage: Stage 5B review/annotation schemas, collection normalization, journal ownership/containment, bounded recovery, two-phase protocol, startup reconciliation, Migration 7, catalog review/filter queries, concurrency & revisions, photo review IPC, preload bridge, renderer UI review components, post-commit journal failure handling, UTF-8 safety & record bounds, runtime security revalidation, and renderer response safety |
| **Strict Typecheck**                      | `npm run typecheck`                    | **Clean pass**                 | 0         | TypeScript strict checking across Node and Web targets (0 errors)                                                                                                                                                                                                                                                                                                                                                                               |
| **ESLint**                                | `npm run lint`                         | **Clean pass**                 | 0         | Codebase compliant (0 errors, 0 warnings)                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Formatting Compliance**                 | `npm run format:check`                 | **Clean pass**                 | 0         | 100% Prettier compliant                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Production Bundle Build**               | `npm run build`                        | **Clean pass**                 | 0         | Main, preload, worker, and renderer bundles built cleanly                                                                                                                                                                                                                                                                                                                                                                                       |
| **Desktop Unpacked Build**                | `npm run build:unpack`                 | **Clean pass**                 | 0         | `dist/win-unpacked/Personal Vault.exe` built with native Sharp binaries in `app.asar.unpacked`                                                                                                                                                                                                                                                                                                                                                  |
| **Real Electron Photo Review (Built)**    | `npm run verify:photo-review`          | **12/12 passed**               | 0         | Stage 5B real Electron: scan, initial load, DOM ratings/flags/badges, selection concurrency guard, DOM collections lifecycle (create, rename, add/remove member), combined SQL filters, out-of-filter eviction/refill, pre-commit barrier persistence interruption & restart reconciliation, 3k filtered scale browsing past 2,000 photos, source preservation invariance                                                                       |
| **Real Electron Photo Review (Unpacked)** | `npm run verify:photo-review:unpacked` | **12/12 passed**               | 0         | Complete 12-check photo review verification on packaged Windows executable                                                                                                                                                                                                                                                                                                                                                                      |
| **Real Electron Photos (Built)**          | `npm run verify:photos`                | **19/19 passed**               | 0         | Real Electron CDP: scan, photo query, distinct duplicate locations, JPEG/WebP decode, orientation, HEIC/RAW honest unsupported, real cancellation, details, cache persistence, restart reuse with 0 decodes, interrupted real publication restart recovery, out-of-band modification reject, 10k scale checkpoints, continuous frame/main metrics, source preservation                                                                          |
| **Real Electron Photos (Unpacked)**       | `npm run verify:photos:unpacked`       | **19/19 passed**               | 0         | Complete 19-step photo verification on packaged Windows executable                                                                                                                                                                                                                                                                                                                                                                              |
| **Real Electron Vault Import (Built)**    | `npm run verify:vault`                 | **11/11 passed**               | 0         | Regression check: vault init, overlap reject, import, manifests, duplicate merging, idempotency, cancel, restart recovery, source preservation                                                                                                                                                                                                                                                                                                  |
| **Real Electron Vault Import (Unpacked)** | `npm run verify:vault:unpacked`        | **11/11 passed**               | 0         | Regression check on packaged Windows binary                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Real Electron Duplicate Review**        | `npm run verify:duplicates`            | **18/18 passed**               | 0         | Regression check: duplicate grouping, review persistence, out-of-band invalidation, stale rejection, source preservation                                                                                                                                                                                                                                                                                                                        |
| **Real Electron Scan & Recovery**         | `npm run verify:scan`                  | **14/14 passed**               | 0         | Regression check: scan, pause/resume, mid-flight process kill recovery, restart revalidation, source preservation                                                                                                                                                                                                                                                                                                                               |
| **Real Electron SQLite Repository**       | `npm run verify:sqlite`                | **8/8 passed**                 | 0         | Electron `node:sqlite` driver verification                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Real Electron Smoke (Built)**           | `npm run smoke:built`                  | **Passed**                     | 0         | Preload bridge surface (including all 8 Stage 5B review/collection methods), navigation guards, CSP                                                                                                                                                                                                                                                                                                                                             |
| **Real Electron Smoke (Unpacked)**        | `npm run smoke:unpacked`               | **Passed**                     | 0         | Packaged binary smoke check                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Source Preservation Invariance**        | Across all suites                      | **Confirmed**                  | 0         | Byte-for-byte identical, untouched source originals across all workflows                                                                                                                                                                                                                                                                                                                                                                        |

---

## 4. Preserved Unrelated Files & Working Tree

The following unrelated files remain intact and untouched:

- `.codex/` directory
- `scripts/launch-desktop.ps1`
- `scripts/verify-bridge-and-dialog.mjs`
- `scripts/verify-desktop-window.ps1`

---

## 5. Scope Exclusions & Next Steps

- **Scope Exclusions**: Stage 5B is implemented only. Stage 5C (perceptual hashing and visual similarity review) is planned and not started. No catalog deletion, vault deletion, source deletion, OCR, semantic search, or cloud uploads.
- **Stage 5A Status**: Complete (independently accepted at `951fd25`).
- **Stage 5 Overall Status**: In progress.
- **Stage 5B Status**: **Awaiting review** (implemented on `feat/stage-5b-photo-review`).
- **Stage 5C Status**: Planned; not started.
- **Git State**: Work committed on `feat/stage-5b-photo-review` branched directly from `53c1052`. Do NOT push or merge.
