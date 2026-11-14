# Personal Vault — Architecture Document

## 1. System Overview

Personal Vault (`personal-vault`) is a high-integrity desktop photo and document discovery, cataloging, classification, and vault copying system. It prioritizes source preservation, explicit data provenance, exact and content-based duplicate identification, and resilient local-first cataloging.

---

## 2. Process Boundaries & Isolation

The system enforces strict multi-process isolation:

```
┌────────────────────────────────────────────────────────┐
│                   Main Process                         │
│ - Window lifecycle management                          │
│ - IPC request router & handler                         │
│ - Security headers and webRequest policies             │
│ - (Future Stages) SQLite engine, worker controller     │
└──────────────────────────┬─────────────────────────────┘
                           │ IPC invoke / handle
                           ▼
┌────────────────────────────────────────────────────────┐
│                   Preload Facade                       │
│ - Runs in isolated context with contextBridge          │
│ - Runtime payload validation (Zod)                     │
│ - Strictly typed `window.api` boundary                 │
└──────────────────────────┬─────────────────────────────┘
                           │ contextBridge
                           ▼
┌────────────────────────────────────────────────────────┐
│                   Renderer Process                     │
│ - React 19 UI component hierarchy                      │
│ - Design token styling & accessible UI controls        │
│ - State management for active view & local search      │
│ - NO Node.js APIs (`nodeIntegration: false`)           │
│ - Sandboxed execution (`sandbox: true`)                │
└────────────────────────────────────────────────────────┘
```

### 2.1 IPC Communication Contract

- Channels are defined as immutable string constants in `src/shared/contracts/channels.ts`.
- Every channel payload crossing between processes is validated via Zod schemas defined in `src/shared/validation/ipc-schemas.ts`.
- If an invalid payload is sent or received, the validation helper returns an explicit failure, preventing runtime type drift or malformed data propagation.

---

## 3. Module Responsibilities & Directory Layout

```
src/
├── main/
│   ├── index.ts           # App lifecycle, single-instance lock, window setup
│   ├── navigation.ts      # Trusted-location policy, navigation guards, popup denial
│   ├── security.ts        # CSP response headers, permission denial
│   ├── ipc/
│   │   ├── sender.ts      # Validates the sending WebContents, frame, and URL
│   │   └── handlers.ts    # Sender-checked handlers: app info, vault status, tab ack
│   └── services/
│       ├── discovery/     # Stage 2A: read-only traversal, policy, and metadata inventory
│       │   ├── fs-adapter.ts # Narrow read-only adapter (lstat, realpath, opendir)
│       │   ├── policy.ts     # Candidate extension & exclusion/software-clutter rules
│       │   ├── scanner.ts    # Incremental bounded scanner with AbortSignal cleanup
│       │   ├── types.ts      # Candidate, skip, error, and result contracts
│       │   └── index.ts      # Public discovery exports
│       ├── hashing/       # Stage 2B: read-only streaming SHA-256 hashing
│       │   ├── fs-adapter.ts # Narrow read-only adapter (lstat, realpath, open 'r')
│       │   ├── limits.ts     # Resource limit validation (chunkSizeBytes, maxFileSizeBytes)
│       │   ├── path-security.ts # Approved-root canonical containment check
│       │   ├── hasher.ts     # Streaming SHA-256 hasher with pre/post fstat verification
│       │   ├── types.ts      # Discriminated union outcomes and configuration contracts
│       │   └── index.ts      # Public hashing exports
│       └── catalog/       # Stage 2C + Pre-Stage-7 Maintenance: SQLite catalog schema, connection ownership, and repositories
│           ├── database.ts   # CatalogDatabase connection/transaction owner & facade (delegates semantic search to SemanticSearchRepository)
│           ├── photo-filter-sql.ts # Shared parameterized SQL WHERE & metadata-JOIN builder for Stage 5B/6C photo filters
│           ├── semantic-search-repository.ts # SemanticSearchRepository (coverage counts, candidate vector streaming, compatibility checks, ranking delegation, hydration)
│           ├── errors.ts     # Domain errors (UnsupportedSchemaVersionError, DatabaseClosedError, etc.)
│           ├── migrations.ts # Versioned transactional migrations and schema definition
│           ├── path-normalization.ts # Documented platform-aware lookup key normalization
│           ├── types.ts      # Persistence contracts, records, and pagination interfaces
│           └── index.ts      # Public catalog exports
│       ├── jobs/          # Stage 2D: resumable scan jobs and coordinator
│       │   ├── coordinator.ts # ScanJobCoordinator (orchestrator, checkpointing, pause/resume, cancel)
│       │   ├── errors.ts     # Domain errors (ActiveJobConflictError, JobNotFoundError, JobStateError)
│       │   ├── types.ts      # Job options, progress, and event contracts
│       │   └── index.ts      # Public jobs exports
│       ├── thumbnails/    # Stage 5A/5C/6B/6C: shared decode, dHash, semantic inference, and EXIF extraction worker pool
│       │   ├── coordinator.ts # ThumbnailCoordinator (<=2 live workers, <=64 queue, priority scheduling)
│       │   ├── decoder.ts    # Sharp decode & 224x224 bicubic CLIP preprocessing outside main
│       │   ├── worker.ts     # Node worker_threads entry (thumbnails, dHash, ONNX CLIP, EXIF metadata, off-main SHA-256)
│       │   ├── cache.ts      # Disposable WebP disk cache
│       │   └── types.ts      # Worker request/response discriminated unions
│       ├── semantic/      # Stage 6B/6D/6E: offline CLIP model provisioning, resumable index & natural-language search
│       │   ├── manifest.ts   # Pinned model identity, 7 artifact digests/sizes, recipe, approved CDN hosts
│       │   ├── vector.ts     # 512-d Float32Array validation, L2 normalization, and blob conversion
│       │   ├── model-manager.ts # SemanticModelManager (download, offline import, staging, off-main verification)
│       │   ├── coordinator.ts # SemanticIndexCoordinator (resumable job execution, reuse verification, yielding)
│       │   ├── text-embedder.ts # Worker-safe CLIP text tokenizer & ONNX text encoder with 77-token truncation
│       │   ├── ranking.ts    # TopKMinHeap (<=1,000) & disk-backed SQLite ranker (>1,000) with ScoredEmbeddingIdentity
│       │   ├── search-worker.ts # Dedicated search worker (off-main model check, text embedding, WAL snapshot ranking)
│       │   ├── search-coordinator.ts # SemanticSearchCoordinator (<=1 live worker, <=16 pending queue, hydration revalidation)
│       │   ├── types.ts      # Model status, job progress, search, and coordinator interfaces
│       │   └── index.ts      # Public semantic exports
│       └── metadata/      # Stage 6C: read-only EXIF technical metadata extraction & normalization
│           ├── types.ts      # Technical metadata, date interpretation, facet, and job contracts
│           ├── date-policy.ts # EXIF DateTimeOriginal/DateTimeDigitized precedence, offset/wall-clock & leap-year validation
│           ├── normalize.ts  # Display dimensions (orientation 1..8), camera/lens normalization, format mismatch checks
│           ├── extractor.ts  # Worker-safe header & EXIF parser (sharp header + exifreader@4.54.0, no full raster decode)
│           ├── coordinator.ts # PhotoMetadataCoordinator (snapshotted scope, live SHA-256 reuse, cancel/resume)
│           └── index.ts      # Public metadata service exports
├── preload/
│   ├── index.ts           # Exposes window.api via contextBridge; validates every response
│   └── index.d.ts         # TypeScript declaration for window.api
├── shared/
│   ├── contracts/         # IPC channel definitions
│   ├── types/             # Domain definitions (Item, Facts, Inferred, Source)
│   ├── validation/        # Zod schemas & runtime validation logic
│   └── index.ts           # Shared exports
└── renderer/
    ├── index.html         # HTML root with Content Security Policy meta
    └── src/
        ├── main.tsx       # React 19 root bootstrap
        ├── App.tsx        # Application shell container
        ├── index.css      # Design tokens, typography, dark theme layout
        ├── hooks/         # Custom hooks (useVaultApi, useScanJobs, usePhotos, usePhotoMetadata, usePhotoReview, useSimilarityReview, useFocusTrap, useMediaQuery)
        └── components/    # Layout, Sidebar, Header, and EmptyState views
```

---

## 4. Data Ownership & Fact vs. Inference Separation

### 4.1 Recorded Facts (Immutable)

- Stored as factual properties of discovered files.
- Original path, original filename, byte size, filesystem creation timestamp, filesystem modification timestamp, SHA-256 hash.
- Cannot be edited, guessed, or modified by classification engines.

### 4.2 Extracted & Inferred Values (Derived & Provenance-Tagged)

- Extracted from embedded container metadata or inferred by OCR / local AI models, strictly separated from recorded filesystem facts.
- Photograph technical metadata (Stage 6C): raw EXIF tag strings, parser recipe version (`exif_tech_v1`), encoded dimensions & EXIF orientation, orientation-adjusted display dimensions, camera/lens normalized keys, and interpreted capture dates derived solely from EXIF `DateTimeOriginal` (or documented `DateTimeDigitized` fallback) — never fabricated from filesystem creation/modification times, EXIF modification `DateTime`, or filenames.
- Document category inferences (Stage 7, e.g. `receipts`, `legal`, `instructions`) and semantic embeddings (Stage 6B).
- Always recorded alongside explicit provenance markers (source tag, parser/model recipe, content revision).
- When capture dates, camera/lens tags, dimensions, or locations are absent or invalid, they remain explicit `null` ("Unknown").

---

## 5. Technology Decisions & Rationale

1. **Electron + React + TypeScript**:
   - Electron follows a three-major-version support window; the project pins an exact supported major (see HANDOFF.md for the installed version) and must be re-checked against electronjs.org/docs/latest/tutorial/electron-timelines when upgrading.
2. **electron-vite (v3.1) + Vite (v6)**:
   - Separate build configurations for main (Node target), preload (sandbox target), and renderer (browser ESM target).
   - A sandboxed preload can only `require` `electron` and a few built-ins, so every other import (including Zod) must be bundled into `out/preload/index.js`. Main keeps its dependencies external.
   - Development only: the Vite dev server injects an inline React Refresh preamble. A dev-only Vite plugin allows exactly those inline scripts by SHA-256 hash in the `<meta>` CSP; `unsafe-inline` is never added to `script-src`. Production output has no inline scripts and keeps the strict policy.

### 5.1 Trust and navigation

- Exactly one application location is trusted: the built `renderer/index.html` when packaged, or one explicitly configured http(s) dev origin when not packaged. `ELECTRON_RENDERER_URL` is ignored by packaged builds.
- `will-navigate`, `will-redirect`, and `will-frame-navigate` block everything else. Popups are denied in one place (`secureWebContents`) and URLs are never passed to `shell.openExternal`.
- Every IPC handler accepts a call only from the top-level frame of the application window while it shows the trusted location; other senders are rejected.
- The renderer distinguishes **loading**, **error** (missing bridge, rejected request, or unacknowledged request), and **confirmed empty** states. It never substitutes default data for a missing bridge.

### 5.2 Other decisions

3. **Zod Runtime Validation**:
   - TypeScript types guarantee compile-time correctness, but IPC payloads cross process serialization boundaries. Zod ensures runtime defense-in-depth against corrupt or unexpected data.
4. **Vitest + @testing-library/react**:
   - Fast execution, jsdom support for DOM and component behavior testing, and full compatibility with Vite TypeScript paths.
5. **No AI / Embedding / OCR / Python tooling in Stage 1**:
   - Deferred to subsequent stages to evaluate memory, packaging, and offline performance trade-offs without bloat.
6. **Read-Only Discovery & Exclusion Policy (Stage 2A)**:
   - Informed by digiKam collection root/ignore-directory rules and PhotoPrism indexing conventions:
     - **Explicit Approved Roots & Boundary Enforcement**: Only caller-supplied root directories are scanned. Symbolic links and Windows directory junctions are skipped by default (including roots that are links) and reported as structured skips, avoiding cyclic traversal, duplicate references, and escapes. Every visited path is checked with `realpath` against the canonical approved root.
     - **Source-Root & Subdirectory Exclusion Precedence**: Exclusion rules apply to explicitly supplied source roots before `lstat`/`opendir` (so excluded roots are never opened) as well as to descendant directories, in strict precedence order:
       1. `excludedPaths` (matching the target path itself or any ancestor path via `isPathOrAncestorExcluded`) -> `excluded_directory`
       2. `excludedDirectoryNames` (matched against the directory's own basename) -> `excluded_directory`
       3. `softwareClutterDirectoryNames` (matched against the directory's own basename) -> `software_clutter_directory`
       4. `hiddenAndSystemNames` / `excludeHiddenEntries` dot-prefix rule (matched against the directory's own basename) -> `hidden_or_system_entry`
          Ancestor directory names above an explicitly supplied root do not trigger name-based exclusions (2–4), whereas explicit path exclusions (1) apply to both roots and roots nested under an excluded ancestor.
     - **Configurable Extension & Clutter Policy**: Candidate photos and documents are identified by extension policy (including `.md`, `.markdown`, and `.txt` documents). Boilerplate clutter files (`CMakeLists.txt`, `requirements.txt`, `CHANGELOG.md`, lockfiles) are skipped with explicit, testable reasons while preserving user `.md` and `.txt` files.
     - **Streaming Backpressure, O(1) Queue, & Validated Resource Bounds**: `scanSourceRoots` is an `AsyncGenerator` yielding structured `DiscoveryEvent` items (`candidate`, `skip`, `error`) directly to its consumer without retaining emitted records in arrays, while tracking summary counters (`DiscoveryStats`) independently. Pending subdirectories are held in a linked-list `BoundedFifoQueue` ($O(1)$ enqueue/dequeue, no `Array.prototype.shift()`). Resource limits (`maxPendingDirectories`, `maxVisitedDirectories`, and collector-only `maxCollectedRecords`) are validated at the public API boundary via `resolveDiscoveryLimits` (`discoverFiles` validates eagerly on invocation; `scanSourceRoots` validates lazily when generator iteration begins, before any filesystem operations or callbacks), requiring finite positive safe integers (`>= 1`) and rejecting `NaN`, `Infinity`, `<= 0`, fractions, and unsafe integers with `RangeError`. Reaching a configured limit returns `status: 'resource_limit_reached'` with `limitReached` metadata and closes open handles deterministically.
     - **Modular Discovery Responsibilities**: Discovery under `src/main/services/discovery/` separates read-only OS calls (`fs-adapter.ts`), extension/clutter/exclusion policy (`policy.ts`), limit validation and bounded queueing (`limits.ts`), shared root/queued/child directory and file-candidate inspection (`inspection.ts`), and streaming/collector orchestration (`scanner.ts`).
     - **Pre-Open Directory Revalidation & TOCTOU Boundaries**: Each queued subdirectory is revalidated (`signal.aborted`, policy, `lstat`, `realpath`, and canonical root containment) immediately before `opendir` is called, rejecting directories that were replaced by links, files, or outside-root targets while queued. Note: user-space path revalidation narrows the TOCTOU window between queuing and opening, though Node's path-based filesystem APIs do not provide a race-proof kernel-level `openat` descriptor sandbox.
     - **Preservation & Provenance Honesty**: `ReadOnlyFsAdapter` exposes only `lstat`, `realpath`, and `opendir` (frozen, no mutation methods). File contents, `birthtime`, and `mtime` are never altered (note: operating systems may update `atime` during read-only directory reads depending on mount/filesystem settings). Missing or unreliable timestamps (such as `0` or non-finite values) are recorded as `null` rather than fabricated from `mtime`. Stage 2A records extension-based candidates and filesystem metadata only; SHA-256 content hashing and embedded metadata extraction belong to subsequent Stage 2 tasks.
7. **Read-Only Streaming SHA-256 Hashing (Stage 2B)**:
   - **Bounded Memory & Stream Chunking**: Hashing consumes a constant-sized chunk buffer (default 64 KiB, configurable between 1 KiB and 16 MiB). Files are never loaded entirely into memory.
   - **Mandatory Non-Empty Approved Roots**: An explicit, non-empty list of approved roots (`approvedRoots`) is required and validated before filesystem operations. Supplied roots must exist and resolve to regular directories; candidates outside approved canonical roots or attempting path traversal are rejected.
   - **Strict Read-Only Preservation & Timestamp Precision**: The underlying descriptor is opened strictly in read-only mode (`open(path, 'r')`). Creation (`birthtime`) and modification (`mtime`) times are unaltered (retaining the documented OS-managed access time limitation). Comparisons between live `lstat` and `fstat` preserve full sub-millisecond precision without flooring; discovery expectations with reduced integer precision are compared with strict 1 ms tolerance (`isTimestampConsistentWithExpectation`).
   - **Descriptor Pre/Post Verification (`fstat`) & Pathname Revalidation**: An opened file descriptor is inspected via `handle.stat()` (`fstat`) both immediately after opening and immediately after reading reaches EOF. Furthermore, the candidate pathname is revalidated on disk after reading (`lstat` and `realpath`), detecting observable replacement, disappearance, link substitution, changed canonical destinations, or descriptor inode/dev mismatches. No successful digest is ever returned for a detected unstable read or path change. While user-space path and descriptor checks drastically narrow the TOCTOU window, Node does not provide a race-proof kernel-level `openat` sandbox.
   - **Deterministic Cleanup, Error Preservation & Cancellation**: Bounded reads observe `AbortSignal` cooperative cancellation. Handle closure failures on otherwise-successful reads surface as typed errors without a digest; when both processing and cleanup fail, primary failure information is preserved without masking.
   - **Typed Discriminated Outcomes**: Returns typed results (`success`, `cancelled`, `file_changed`, `rejected`, `error`). Partial digests are strictly excluded from non-success outcomes.
8. **SQLite Catalog Schema & Persistence Architecture (Stage 2C)**:
   - **Driver Selection & Electron/Testing Compatibility**:
     - Evaluated `node:sqlite` (`DatabaseSync`, built into Node 22.18.0 and Electron 45.2.3's Node 24.22.2 with SQLite 3.53.4) against external C++ addons (`better-sqlite3`).
     - Selected `node:sqlite`: requires zero native compilation or `@electron/rebuild`, eliminates ABI mismatch risks between testing (Node 22) and Electron main (Electron 45), avoids unpacking native binaries during packaging (`electron-builder`), and natively supports WAL mode, foreign keys, and synchronous parameterized statements.
     - Verified working in real Electron runtime (`npm run verify:sqlite`, `npm run smoke:built`, and `npm run smoke:unpacked`).
   - **Explicit Initialization & App-Owned Location**:
     - Database connection is initialized explicitly via `CatalogDatabase.open({ catalogPath })` at a caller-supplied path.
     - Never creates files on module import or begins automatic scans.
     - Parent directories are created automatically if missing.
   - **Versioned Transactional Schema Migrations**:
     - Pre-checks schema compatibility (`checkSchemaCompatibility`) via `sqlite_master` in both read-only and read-write modes BEFORE changing journal mode or running DDL.
     - Preserves existing database contents, schema, and journal mode (e.g. `DELETE` mode is never overwritten with `WAL` when encountering a future schema).
     - Versioned migrations (`CURRENT_SCHEMA_VERSION = 2`): safely accounts for both earlier version-1 layouts: the original `baa82e6` layout (inline facts in `file_locations`) and the interim `25a1b4f` layout (with `discovery_observations`). Safely inspects schema structure, migrating `baa82e6` data into `discovery_observations` and rebuilding `hash_observations` with `discovery_observation_id` without fact loss, and rejects unrecognized/corrupted layouts with `MigrationError`.
     - Unsupported future schema versions (`version > CURRENT_SCHEMA_VERSION`) fail immediately with `UnsupportedSchemaVersionError` without modifying the database.
     - Failed open attempts close the connection cleanly without leaking handles.
     - Migrations execute inside an explicit transaction (`BEGIN TRANSACTION` ... `COMMIT`), rolling back changes completely on error.
   - **Normalized Lookup Keys vs. Verbatim Original Paths**:
     - `original_path` and `file_name` are preserved exactly as discovered (verbatim case, whitespace, and Unicode characters like emojis or non-ASCII scripts).
     - `file_locations` enforces uniqueness on `original_path`, while indexing `normalized_path` separately for search and lookups.
     - Platform behavior: on Windows (`win32`), slashes are standardized to `\`, trailing separators stripped, and paths folded to lowercase (`.toLowerCase()`) for case-insensitive matching; distinct files that share a case-folded key (e.g. on per-directory case-sensitive NTFS) retain separate records without fact loss. On POSIX systems (`linux`, `darwin`), standardizes separators via `posix.normalize` while preserving case and backslashes (`\`) as valid filename characters without converting them to forward slashes.
   - **Fact vs. Inference Separation & Timestamp Honesty**:
     - Filesystem dates (`filesystem_birthtime_ms`, `filesystem_mtime_ms`) are recorded as immutable discovery facts.
     - `inferred_capture_time_ms` is kept distinct and initialized to `null`. Unknown values remain `null`; filesystem dates are never fabricated as capture dates.
     - Timestamp matching adheres to Stage 2B precision contract (`isObservationTimestampMatching`): when both discovery and hash observations retain fractional milliseconds, exact comparison is enforced; reduced tolerance (< 1.0 ms) is applied only when the discovery expectation was recorded as an integer; null mismatches are strictly rejected.
   - **Preserved Discovery History & Hash Validity**:
     - Discovery facts are stored immutably in `discovery_observations`.
     - When a subsequent discovery scan observes that a file's `byte_size`, `filesystem_mtime_ms`, or `filesystem_birthtime_ms` (including transitions to/from `null`) has changed, the prior observation is marked `is_current = 0` (retaining prior sizes and timestamps in history), and a new observation is created with `is_current = 1`.
     - Database constraint `idx_disc_obs_current` enforces at most one current discovery observation per file location.
     - Hash observations in `hash_observations` are tied directly to the specific `discovery_observation_id` they verify. A changed observation does not inherit an earlier verified hash.
     - Database constraint `idx_hash_obs_current` enforces at most one active verified hash per discovery observation.
     - If discovery observes identical size, birthtime, and mtime, `last_seen_at_ms` is updated while active hash validity is preserved without duplicate rows.
   - **Immutable Recorded File Metadata & Conflict Policy**:
     - `file_name`, `extension`, and `category` are immutable recorded facts for an exact `original_path`.
     - Conflicting metadata supplied for an already recorded exact path is rejected eagerly with `FileMetadataConflictError`, rolling back the batch and preserving original facts without silent overwriting. A renamed file at a different exact path remains a separate location.
   - **Foreign Keys, Cascades & Full Transaction Rollback**:
     - Foreign keys are enforced (`PRAGMA foreign_keys = ON;`).
     - Deleting a source cascades deletion to associated `file_locations`, `discovery_observations`, and `hash_observations` (`ON DELETE CASCADE`).
     - Batch persistence (`persistDiscoveryBatch`, `recordHashObservationsBatch`) executes in a single transaction with automatic rollback if any candidate or observation fails validation. Source root registration is included within the transaction so failed batches leave no orphaned source records.
   - **Enforced Resource Limits & Bounded Queries**:
     - Enforces finite batch size limits (`MAX_BATCH_SIZE = 1000`) before database mutation; oversized batches are rejected eagerly with `RangeError`.
     - Validates candidate discovery inputs strictly (finite numbers or null for timestamps, non-negative safe integers for sizes).
     - Validates pagination parameters (`offset`, `limit`, `maxLocationsPerGroup`) as finite safe integers, rejecting `NaN`, negative offsets, fractions, and invalid limits.
     - Reads are bounded using `LIMIT` and `OFFSET` across all entity queries (`listSources`, `getDiscoveryObservationsForFile`, `getHashObservationsForFile`, `queryFileLocations`, `getDuplicateGroups`), with member locations bounded per duplicate group to prevent unbounded memory allocation.
   - **Deterministic Lifecycle & Cleanup**:
     - `CatalogDatabase.close()` transitions `isClosed()` to `true` only after the underlying SQLite connection closure succeeds.
   - **Source Preservation Invariance**:
     - Database writes affect strictly the app-owned SQLite catalog file.
     - Source files on disk remain strictly read-only and unaltered.
9. **Resumable Scan Jobs & IPC/UI Integration (Stage 2D)**:
   - **Job State Machine & Migration 3**:
     - Schema migration 3 introduces `scan_jobs` and `scan_job_errors` tables.
     - Scan job lifecycle states: `running`, `paused`, `cancelled`, `interrupted`, `failed`, `completed`.
     - Checkpoint progress (`discovered_count`, `hashed_count`, `failed_count`, `last_checkpoint_ms`) is committed incrementally during scanning.
     - Structured error records in `scan_job_errors` store `file_path`, `phase` (`discovery` | `hashing`), `error_code`, `error_message`, and timestamp, keeping failures visible rather than silently dropping files.
   - **Concurrency Control & Event Loop Yielding**:
     - `ScanJobCoordinator` enforces at most one active job across the application (`ActiveJobConflictError`).
     - Processing loop interleaves batch discovery and chunked hashing with cooperative `setImmediate` event loop yielding, keeping Electron's main process and UI completely responsive without worker thread IPC serialization overhead.
   - **Pause, Resume, and Cancellation**:
     - `pauseScan()` checkpoints progress and yields gracefully.
     - `cancelScan()` aborts the active pipeline via `AbortSignal`, flushes committed work, and marks the job status as `cancelled`.
   - **Restart Recovery & Changed-File Revalidation**:
     - On coordinator startup (`initialize()`), any jobs left in `running` or `paused` state (e.g. from an abrupt crash or power loss) are transitioned to `interrupted` via `markRunningJobsAsInterrupted()`.
     - When an interrupted job is resumed, the coordinator re-runs discovery across the configured roots. The catalog inspects existing observations: if file size, birthtime, or mtime have changed out-of-band, the prior observation is deactivated, its active hash is invalidated, and the file is queued for fresh SHA-256 hashing. Saved checkpoints are never trusted as proof that file contents remain unchanged.
   - **Typed IPC Contracts & Preload Boundary**:
     - Typed IPC channels: `SCAN_SELECT_ROOTS`, `SCAN_START_JOB`, `SCAN_PAUSE_JOB`, `SCAN_RESUME_JOB`, `SCAN_CANCEL_JOB`, `SCAN_GET_ACTIVE_JOB`, and `SCAN_PROGRESS_EVENT`.
     - All arguments and responses are strictly validated in both main and preload using Zod schemas (`ipc-schemas.ts`).
     - IPC handlers enforce sender authorization (`validateSender`) matching application security policies.
   - **Accessible Renderer UI**:
     - `ScanJobsPanel` integrates into the existing desktop layout without unsolicited redesign.
     - Accessible controls: folder selection via native dialog, progress indicators (`role="progressbar"`), status badges, control buttons (Pause, Resume, Cancel, Dismiss), recovery alerts for interrupted jobs, and expandable error logs.
10. **Exact Duplicate Grouping & Review Workflow (Stage 3)**:
    - **Exact Content Identity**: Duplicate groups are formed by matching verified SHA-256 AND observed byte size across active observations (`discovery_observations.is_current = 1 AND hash_observations.is_active = 1 AND hash_observations.observed_byte_size = discovery_observations.byte_size`). Inactive, invalidated, or superseded observations are strictly excluded.
    - **Deterministic Group Signatures & Constant-Memory Processing**: Every duplicate group's membership and observation state is represented by a deterministic `groupSignature` (SHA-256 digest of sorted member tokens `file_location_id:discovery_observation_id:hash_observation_id`). Computed using bounded streaming iteration (`stmt.iterate`) chunk-by-chunk with strictly $O(1)$ auxiliary memory (no `Set` or arrays). Review persistence (`setDuplicateReview`) reuses this streaming helper to verify group membership, signature, and target preferred location without calling `.all()` or `.map()` across members.
    - **Persistent Review Annotations (Migration 5)**: The `duplicate_reviews` table persists user decisions: `(sha256, byte_size, status, preferred_location_id, group_signature, reviewed_at_ms, updated_at_ms)`. Decisions are catalog annotations only; they never mutate recorded facts or imply copying or deletion. Preferred location changes and clearing persist immediately through the UI without requiring review status toggles.
    - **Decision Invalidation Policy & Stale Write Rejection**:
      - A review decision is valid if and only if the current group signature matches the recorded signature and any selected `preferred_location_id` remains an active member.
      - If membership or observations change out of band or through a rescan, the decision is automatically invalidated: the group reports `reviewStatus: 'unreviewed'`, `preferredLocationId: null`, and `hasStaleDecision: true`.
      - Stale writes from an outdated review screen are detected and rejected via `StaleReviewError` when `expectedGroupSignature` differs from the current signature.
    - **Truly Bounded SQL Queries & SQL Pagination**:
      - Groups query (`getDuplicateGroups`) deterministically orders by `file_count DESC, byte_size DESC, sha256 ASC` using SQL `LIMIT ? OFFSET ?`.
      - Members query (`getDuplicateGroupMembers`) deterministically orders by `file_location_id ASC` using SQL `LIMIT ? OFFSET ?`.
      - Filtering for `reviewed` and `unreviewed` groups maintains a temporary table `_valid_reviewed_groups` populated via incremental candidate checks, ensuring SQL-level pagination and counts without materializing the catalog or all groups in JavaScript.
    - **Side-by-Side Review UI, Async Safety & Operation Distinctions**:
      - Integrated into the existing Duplicates view with honest loading, empty, and error states.
      - Displays side-by-side filenames, absolute paths, byte sizes, filesystem creation/modification dates (with explicit "Unknown" for null values), and observation provenance (observation ID and verification timestamp).
      - Prominently explains catalog-index removal, vault-copy deletion, and original-source deletion as distinct operations (none implemented).
      - Async safety: selection-bound review submissions prevent mutations across groups; state updater functions are completely pure (refs updated exclusively via `useEffect` synchronizers); monotonic sequence tokens (`groupsTokenRef`, `selectionTokenRef`) are invalidated on selection clearing, filter transitions, and unmount to discard obsolete responses and prevent repopulating cleared state; auto-recovery handles out-of-range pagination when results shrink.
      - Filter consistency & page refilling: when a review save modifies status under a filtered view (e.g. marking a group reviewed while viewing Unreviewed), the group is removed from the active view, `totalGroups` is decremented, the page is refilled from the catalog up to `groupsLimit`, and the user's active navigation is preserved.
      - Accessible member errors with retry; obsolete member data cleared on selection/failure; changed/unavailable notice when a group falls below two verified members with review controls safely disabled.
      - Truthful empty filter states with permanent filter controls (`All`, `Unreviewed`, `Reviewed`).

11. **Verified Vault Copying & Portable Metadata (Stage 4)**:
    - **Inviolable Principle — Source Preservation**:
      - Source files remain strictly read-only throughout discovery, review, and import.
      - Never move, rename, touch, overwrite, or delete source originals.
      - Source preservation invariance verified via cryptographic hash and sub-millisecond filesystem timestamp baseline comparison.
    - **Separation of Source & Vault Storage**:
      - Strict separation enforced using canonical `realpath` checks.
      - Symlink and Windows directory junction escapes rejected eagerly with `VaultOverlapError` across all IPC boundaries (`initializeVault`, `setActiveVault`, and `startScan`).
    - **Identification of Managed Vault Storage & Overwrite Prevention**:
      - Vault directory is explicitly identified by a versioned identity manifest `vault.json` in the root of the vault (`formatVersion: 1`, `vaultId`, `vaultName`, `createdAtMs`, `appVersion`).
      - Conflicting or invalid existing identity files are rejected without modification (`VaultInitializationError`).
      - Internal vault containment: `assertPathContainedInVault` validates canonical realpath containment and walks all path segments with `lstat` to reject symlink and directory junction redirections in `files/`, content directories, `.vault-temp/`, identity files, manifests, and destination files.
      - Arbitrary existing unmanaged files at the destination cannot be treated as vault copies: unmanaged matching files are rejected with `destination_collision`.
      - Safe publication and interruption recovery:
        - Files are staged in `.vault-temp/` and independently stream-hashed before publication.
        - Prior to publication, an in-progress marker `.pv_in_progress_${vaultId}_${jobId}.json` is recorded.
        - Destination publication uses atomic filesystem `renameSync` within the same vault filesystem with strictly non-overwriting collision checks and `constants.COPYFILE_EXCL` fallback.
        - If interrupted post-publication before manifest creation, resuming the job recognizes the workflow in-progress marker, independently verifies published file bytes, creates the manifest, and cleans the marker.
        - The in-progress marker is unlinked immediately following manifest publication.
    - **Content-Addressed Vault Storage & Collision Avoidance**:
      - Managed copies are stored content-addressed under `files/<prefix>/<sha256>/<safeName>` with a machine-readable `manifest.json` sidecar alongside.
      - Repeated imports of identical content share a single verified managed file on disk while preserving differing source locations, filenames, and metadata in the manifest.
      - Temporary staging files are created strictly inside an app-owned `.vault-temp` staging directory in the vault root, prefixed with `pv_staging_${vaultId}_` and `pv_manifest_${vaultId}_`.
      - Cleanup is restricted strictly to demonstrably owned temporary staging files.
    - **Verified Copy Pipeline (`copyAndVerifyFileToVault`)**:
      - Read-only descriptor open on source file.
      - Pre-copy `fstat` verifies regular file status, byte size match, and modification timestamp consistency against recorded catalog facts.
      - Live source contents are ALWAYS stream-hashed and verified on EVERY path (including shortcuts); destination integrity is verified independently.
      - Post-copy descriptor `fstat` verifies source remained stable and unaltered during entire read.
      - Post-read disk revalidation (`statSync` and `realpath`) ensures candidate path was not swapped or replaced.
      - Destination staging file descriptor sync (`fdatasync`), independent descriptor reopening and re-read SHA-256 computation to confirm disk bits match expected hash before publication.
      - Publication into `files/<prefix>/<sha256>/` with `COPYFILE_EXCL`.
      - Documented limitations: Narrowed TOCTOU window through descriptor and pathname revalidation; user-space filesystem APIs on POSIX and Win32 lack atomic copy primitives.
    - **Portable Metadata Manifest (`manifest.json`)**:
      - Versioned schema (`formatVersion: 1`), fully portable and self-contained without SQLite.
      - Strictly validated at runtime with Zod (`VaultManifestSchema`), validating relative path containment (rejecting path traversal `..` and absolute paths), UUID/string vault IDs, 64-hex SHA-256 hashes, and cross-field consistency between manifest headers, managed copies, and source entries.
      - Encodes `vaultId`, `sha256`, `byteSize`, `managedCopy` details, and array of `sources`.
      - Records actual catalog facts: `firstDiscoveredAtMs`, `lastSeenAtMs`, `hashVerifiedAtMs`, and `discoveryObservationId`.
      - Corrupt or invalid manifests throw `VaultManifestCorruptedError` rather than silently dropping provenance.
      - Preserves multi-source provenance: merges entries matching on exact provenance `(fileLocationId, discoveryObservationId, hashObservationId)` to avoid unbounded duplicates while retaining multiple source locations for duplicate content.
      - Strict separation of facts vs inferences: unknown capture times and locations remain explicit `null` (never fabricated).
      - Audit trail: records `importJobId`, `importedAtMs`, verified SHA-256 and byte size, and source stability stats (`preCopyMtimeMs`, `postCopyMtimeMs`, sizes).
    - **Catalog Persistence (Migration 6) & Exact Authorization**:
      - Adds `vaults`, `vault_copies`, `vault_imports`, and `vault_import_items` tables with foreign keys and indexes.
      - Tracks job state: `running`, `paused`, `cancelled`, `interrupted`, `failed`, `completed`.
      - Exact scope preservation on resume: queries strictly authorized items via `getVaultImportItems(jobId)`.
      - Revalidates observation currency (`isDiscoveryCurrent`, `isHashActive`) on resume.
      - Supports resume, pause, cooperative cancellation via `AbortSignal`, direct cancellation of paused jobs in SQLite, and restart recovery (`markRunningImportJobsAsInterrupted()`).
      - Truthful completion status: job status is `'failed'` when all items fail; `'completed'` with `failedFiles > 0` on partial failure.
      - Start and resume acknowledge the job record promptly across IPC, running the pipeline asynchronously in the background.
    - **IPC & Renderer Integration**:
      - Narrow typed IPC contracts with bidirectional Zod validation (`ResumeImportRequestSchema`, `CancelImportRequestSchema`, `PauseImportRequestSchema`).
      - Sender-validated handlers for vault selection, initialization, candidate listing, import control, and progress streaming.
      - UI components in `VaultImportPanel`: functional "Change Vault", candidate selection table with filters, pagination beyond 100 items with monotonic request token protection, real-time progress bar, pause/resume/cancel controls, interrupted job recovery alert, truth-aligned banners (no "Verified Success" for failures), and operations distinction notice.
      - Clear separation of operations: catalog index removal, vault copy deletion, and source deletion are distinct operations (none implemented).

12. **Bounded Thumbnail Generation, Disposable Cache & Virtualized Photo Browsing (Stage 5A)**:
    - **Inviolable Principles & Source Preservation**:
      - Source files are strictly read-only: opened via read-only descriptors (`open(path, 'r')`).
      - Never modify, touch, overwrite, or delete originals during thumbnail generation or cache maintenance.
      - All original source timestamps, byte sizes, and SHA-256 hashes are verified before decoding and invariant across application execution.
    - **Decoder & Format Support (Sharp / libvips + libheif-js)**:
      - Maintained offline decoders: `sharp@0.35.5` with prebuilt `@img/sharp-win32-x64` (libvips 8.18.7), packaged into `app.asar.unpacked`, paired with `libheif-js@1.23.5` (`LGPL-3.0`, self-contained WASM+JS HEVC decoder in `src/main/services/thumbnails/heic-decoder.ts`) for offline HEIC/HEIF pixel decoding without OS codecs.
      - Concurrency & event loop isolation: decoding runs in real Node worker threads (`worker_threads.Worker` running `src/main/services/thumbnails/worker.ts`), preventing main process event loop stalls. Worker crashes, timeouts, or cancellations terminate the worker process safely and await termination before reallocating concurrency capacity.
      - Supported formats: JPEG, PNG, WebP, GIF (frame 0), AVIF, TIFF, HEIC/HEIF.
      - Orientation preservation: Sharp `.rotate()` applies EXIF orientation for JPEG/TIFF/WebP; for HEIC/HEIF, `libheif-js` applies HEIF `irot` container rotation during `display()`, so `openSharpFromImageBuffer` avoids double-rotating HEIC pixels.
      - Honest placeholders: camera RAW, SVG, corrupted or oversized files return honest unsupported/error states without crashes or external toolchains.
    - **Resource Limits & Bounded Execution**:
      - Thumbnail longest edge: 512 pixels, preserving aspect ratio, encoded as WebP (recipe version: `v1_512_webp`).
      - Maximum active decode jobs: 2 concurrent workers.
      - Maximum queued decode jobs: 64 jobs with visible cells prioritized; excess requests rejected.
      - Maximum source file size: 128 MiB (`MAX_SOURCE_SIZE_BYTES`, enforced both before and during streaming read).
      - Maximum input pixel limit: 100 megapixels (`MAX_INPUT_PIXELS`).
      - Per-job execution timeout: 15 seconds with worker termination on timeout or crash.
      - Disposable disk cache budget: 1 GiB (`DISK_CACHE_BUDGET_BYTES`).
      - Renderer metadata cache: at most 2,000 records (40 pages of 50 items, LRU-evicted).
      - Mounted photo cells: at most 200 for supported window sizes.
    - **Secure Disposable Disk Cache**:
      - Located in `<userData>/thumbnails/` (canonical separation verified: overlaps with source roots or active vault storage are rejected; symlinks/junctions rejected).
      - Cache key derivation: for unhashed files, strictly bound to source identity `unhashed:<locationId>:<normalizedPath>:<byteSize>:<mtimeMs>:<recipe>` to prevent collisions between different unhashed files with identical size/mtime; for hashed files, bound to `hash:<sha256>:<recipe>`.
      - Atomic staging: written to `.thumb_tmp_<pid>_<uuid>` with `wx` exclusive flag before atomic `renameSync` to `<key>.thumb`.
      - WebP header validation: cached buffers verified via `readWebPDimensions`; 0-byte or corrupted files are unlinked and safely regenerated.
      - LRU eviction: strictly targets owned `.thumb` files in the thumbnails directory. Never deletes or traverses outside files.
      - Staging cleanup: cleans owned `.thumb_tmp_*` regular files on startup and shutdown without touching unrelated files.
      - Residual out-of-band source modification detection: fast `statSync` check on source file prior to returning cached thumbnail ensures modified sources return `SOURCE_MODIFIED` rather than serving stale images.
    - **IPC & Process Security**:
      - Narrow typed IPC channels: `photos:get-page`, `photos:get-thumbnail`, `photos:cancel-thumbnail`, and `photos:get-diagnostics`.
      - Bidirectional Zod schema validation: `GetPhotosPageRequestSchema`, `GetPhotosPageResponseSchema`, `GetThumbnailRequestSchema`, `ThumbnailResultSchema`, `CancelThumbnailRequestSchema`, `CancelThumbnailResponseSchema`, `PhotosDiagnosticsResponseSchema`.
      - Top-level sender validation on all handlers.
      - Data URL transport (`data:image/webp;base64,...`) compliant with CSP (`img-src 'self' data:`), without exposing file URLs or filesystem protocols.
    - **Renderer Presentation & Virtualized Browsing**:
      - Responsive CSS grid adhering to dark theme token system.
      - Deterministic ordering by catalog location ID (`file_locations.id ASC`).
      - Virtual windowing retaining full collection scroll extent (`totalCount`), with absolute cell positions and at most 200 mounted DOM cells.
      - Monotonic generation tokens incremented on refresh and unmount, with revision-bound in-flight request tracking ensuring older delayed completions cannot overwrite newer cells or clear newer request bookkeeping.
      - Selection state and compact metadata details panel reporting recorded facts (filename, absolute source path, byte size, filesystem times, hash provenance) and explicit "Unknown" for absent capture dates/locations.
      - Header global search box is hidden on the Photos tab (`currentTab === 'photos'`), where `PhotosSearchBar` provides the single natural-language search input.

13. **User Review Tools: Ratings, Flags, and Custom Collections (Stage 5B)**:
    - **Inviolable Principle — Source Preservation**:
      - Rating, flagging, or adding/removing collection memberships alters organization metadata only.
      - Reject is strictly a review annotation; source photographs and vault copies are never touched, altered, moved, or deleted.
    - **Separation of Facts vs. Inferences**:
      - Recorded facts (filename, source path, sizes, filesystem timestamps, verified SHA-256) remain immutable.
      - Ratings (1–5 stars or null) and review flags (Pick, Reject, None) are explicit user review annotations.
    - **Catalog Schema Expansion (Migration 7)**:
      - `photo_annotations`: tracks `file_location_id`, `discovery_observation_id`, `content_sha256`, `rating`, `flag`, monotonic `version`, and `is_current`.
      - `collections`: stores custom named collections with `name`, `normalized_name` (1–80 chars, trimmed, no control characters, case-insensitive unique constraint).
      - `collection_memberships`: records active memberships (`collection_id`, `file_location_id`, `discovery_observation_id`, `content_sha256`, `is_current`).
      - `journal_operations`: tracks operation id, entry sequence, operation kind, commit status, and timestamps.
      - `journal_checkpoints`: singleton checkpoint tracking last applied journal sequence and operation id.
    - **Two-Phase Recoverable Protocol & Review Journal**:
      - Stored in app-owned storage (`<userData>/annotations/review-journal.jsonl`) with ownership marker (`.pv_annotations_owner`).
      - Strict containment & canonical ancestor policy: recursive ancestor traversal canonicalizes directory paths via `realpath` (`canonicalizeWithAncestorPolicySync` / `Async`), resolving symlinks and Windows directory junctions in existing directory paths and safe ancestor chains for non-existent subpaths. Fail-closed security context checking against live source roots (`catalog.getAllSourceRoots()`) and active vault paths fails closed with `JournalSecurityError` before mutations, with exclusive marker creation via `wx`.
      - Append-only JSONL format recording all annotation and collection lifecycle events with full provenance and fsync durability.
      - Two-phase protocol: operations are recorded to the journal, staged and committed in SQLite transactions, then marked `op_committed` in the journal.
      - Post-COMMIT failure handling: tracks actual commit boundary; never records committed database work as aborted. Returns truthful `persistencePending: true` state on post-commit append failure.
      - Safe reconciliation & UI propagation: `usePhotoReview` tracks unfinalized committed operations with unique per-invocation identities and monotonic generation counters (`mutationGenRef`) across ratings, flags, collection changes, and memberships independently of selection and presentation guards. Memory bounds employ an honest overflow policy (`overflowCount`) preventing unresolved work from being silently forgotten or causing a false all-saved status. React state updaters remain strictly pure without mutating refs. An honest pending status banner and retry control calling `photos:reconcile-journal` snapshots and finalizes covered operation generations (`gen <= coveredGen`), preserving newer in-flight operations without repeating already committed mutations.
      - Startup reconciliation (`reconcileJournalWithDatabase`): reconciles uncommitted operations across SQLite and journal via bounded streaming passes (`stmt.iterate()`) and indexed queries on `journal_operations`, appending `op_committed` or `op_aborted` appropriately without accumulating uncommitted records or journal entries in Node heap.
      - Safe, bounded streaming recovery: 64KB chunk buffer reading with multibyte UTF-8 safety across chunk boundaries, strict sequence validation, bounded record length checking (<= 64 KiB), interior corruption detection preserving file content, and safe truncation restricted strictly to torn final records at EOF without trailing newline.
      - Bounded pagination: collections and memberships implement windowed 50-item page navigation with Prev/Next controls and absolute offsets, ensuring memory retention never accumulates lists indefinitely.
    - **Concurrency & Rescan Reconciliation**:
      - Annotations and memberships bound to location and content revision: `rev:<discoveryId>:<byteSize>:<mtime>:<hash>`.
      - Selection generation is keyed by both photo ID and content revision string (`${photo.id}:${computePhotoRevision(photo)}`). Same-ID content replacement or rescan immediately advances generation, resets save state, reloads memberships, and drops delayed in-flight responses before updating DOM badges or active star buttons.
      - Unchanged rescan: annotations preserved without version change.
      - Touched without change: verified content SHA-256 match preserves active annotation across discovery observations.
      - Changed content: invalidated active annotation and memberships present photo as unreviewed, while preserving historical records.
      - Optimistic concurrency: `setPhotoAnnotation`, `addCollectionMember`, and `removeCollectionMember` verify expected revision string and expected version; stale requests reject atomically with conflict errors.
    - **Pure SQL Filtering & Grid Refill**:
      - Rating filter (`all`, `unrated`, `1`..`5` stars), Flag filter (`all`, `none`, `pick`, `reject`), and Collection filter combined with `AND` in SQL before pagination.
      - Out-of-filter edit handling: editing rating or flag under an active filter immediately updates the item, smoothly removes it from the filtered view, clears/updates selection, and refills the page from the next matching database record so the grid remains full.
      - Explicit "Reset filters" action returning directly to unfiltered browsing.
    - **Renderer Review Flow & Selection State**:
      - Selection switch concurrency guard (`selectionGenRef`, `prevSelectedPhotoIdRef`) ensuring rapid photo switching does not leak save state, errors, or filter evictions.
      - Current filter refs ensure in-flight saves do not evict photos when user switches filters concurrently.
      - Bounded pagination windows and in-flight request guards for collection and membership queries.
      - Accessible collection rename controls (`Rename collection {name}`, input `New name for collection {name}`, Save, Cancel) and explicit membership error banner with retry control.

14. **Perceptual Hashing & Visual Similarity Review (Stage 5C)**:
    - **Inviolable Principles & Source Preservation**:
      - Source photographs and vault copies are strictly read-only. Fingerprinting uses read-only descriptors (`open(path, 'r')`) and verifies pre/post descriptor identity and content SHA-256 before accepting derived results.
      - Similarity classification is an explicit user review annotation; neither perceptual hashing nor similarity suggestions touch or alter original files.
      - Exact byte duplicates remain strictly under Stage 3 exact duplicate grouping; photos sharing verified SHA-256 are excluded from perceptual similarity candidate pairs.
    - **Separation of Facts vs. Inferred Similarity vs. User Decisions**:
      - Recorded facts (filename, original path, dimensions when known, byte size, filesystem timestamps, verified SHA-256) remain immutable.
      - Algorithmic similarity score (`(64 - distance) / 64`) is an uncalibrated machine inference, never presented as calibrated probability or proof of an edited copy.
      - Review decisions (`edited_version`, `similar_scene`, `unrelated`, `unreviewed`) are explicit user determinations persisted with two-phase journal durability.
    - **Deterministic Fingerprinting Algorithm (`dhash64_v1`)**:
      - Resize to 9x8 grayscale raw pixels ignoring aspect ratio (`fit: 'fill'`) after `.rotate()` orientation normalization.
      - Row adjacent gradient comparison ($P(x, y) > P(x+1, y)$) yields 64-bit integer formatted as 16 hexadecimal characters.
      - Documented limits: robust against recompression and resizing; crops shift gradients and may be missed; rotations without EXIF metadata alter adjacencies; burst shots produce close distances requiring explicit user discrimination; solid color/noise images may collide.
    - **Resource Limits & Bounded Execution**:
      - Image decoding and fingerprinting execute in existing Node worker threads outside Electron main.
      - Aggregate concurrency shared with thumbnails: live workers <= 2 (including terminating workers), queued jobs <= 64.
      - Interactive photo browsing requests take priority (`high`) over background fingerprinting (`low`), keeping browsing responsive during analysis.
      - Candidate search partitions 64-bit hashes into 4x16-bit indexed buckets (`bucket_0`..`bucket_3`), querying candidates via SQLite index without full-table materialization.
      - Algorithmic similarity threshold: Hamming distance <= 10 / 64 bits (>= 84.375% similarity).
      - Dense similarity bounds: max 50 candidates per photo, max 10,000 total candidate pairs persisted per analysis run.
      - Pagination: 10 candidate pairs per page with monotonic request tokens.
    - **Catalog Persistence (Migration 8) & Resumable Coordinator**:
      - Adds `photo_perceptual_hashes`, `similarity_candidate_pairs`, `similarity_decisions`, `similarity_jobs`, and `similarity_job_items`.
      - Pair identity canonicalization: `file_location_id_a < file_location_id_b` strictly prevents reversed pairs.
      - Resumable `SimilarityCoordinator`: captures authorized photo items into `similarity_job_items` upon start; resume processes only originally authorized pending items without including newly cataloged photos; cancellation/interruption never appears as completed; startup marks running jobs interrupted.
    - **Portable Journal Persistence**:
      - User decisions append `similarity_decision` to `review-journal.jsonl` with fsync before SQLite commit, followed by `op_committed`.
      - Post-commit journal failures return `persistencePending: true` for truthful UI reporting and retry without re-running transactions.
    - **IPC & Renderer Integration**:
      - Bidirectional Zod validation across `similarity:*` IPC channels with sender validation.
      - `SimilarityReviewPanel` renders side-by-side thumbnail comparisons, recorded facts, unknown values, decision controls, and progress/cancellation bars.

15. **Model Provisioning & Resumable Semantic Index (Stage 6B)**:
    - **Inviolable Principles & Source Preservation**:
      - Source files remain strictly read-only (`open(path, 'r')`) during image decoding, off-main content verification, and embedding inference. Original bytes, sizes, and filesystem creation/modification timestamps (`birthtimeMs`, `mtimeMs`) are invariant (noting that OS mounts may update read access time `atime` during read-only file opens).
      - Derived 512-dimensional semantic embeddings are stored strictly separate from immutable recorded facts (`file_locations`, `discovery_observations`, `hash_observations`). Embeddings are rebuildable derived data, not factual object labels, and are not journaled into the portable annotation log.
      - Privacy & offline first: no personal photographs, filenames, metadata, or queries ever leave the device.
    - **Pinned Model Provenance & Provisioning (`src/main/services/semantic/manifest.ts`, `model-manager.ts`)**:
      - Pinned model: `Xenova/clip-vit-base-patch32` at revision `6b7c523703ae26e39be4b03774966f8571c7f523` (7 required files totaling exactly `155,851,918` bytes / `148.63 MiB`, verified against pinned SHA-256 digests and overall manifest SHA-256).
      - Preprocessing recipe identifier: `clip_vit_b32_224_bicubic_center_rgb_v1` (224x224 bicubic center-crop RGB via `sharp.kernel.cubic`, normalized with CLIP channel means/stds), producing L2-normalized 512-dimensional `Float32Array` vectors (`2,048` bytes).
      - Explicit user-initiated setup only: in-app download (`semantic:download-model`) or offline local folder import (`semantic:import-model-folder`, selected exclusively via main-process native dialog) after displaying the ~148.63 MiB model size requirement. Zero automatic startup or inference downloads.
      - App-owned storage in `<userData>/models/` with canonical `realpath` + ancestor policy separation rejecting any overlap or symlink/junction redirection with source roots or active vault storage.
      - Exclusive staging in `.pv_model_staging_<pid>_<uuid>`, off-main SHA-256 and byte-length verification (`validate_files` worker action), atomic publication (`model_manifest.json` written last after verified files), startup cleanup of abandoned staging directories, and preservation of existing verified installations when a replacement install fails or is cancelled.
      - Strict download policy: HTTPS only to approved Hugging Face / XetHub CDN hosts (`huggingface.co`, `cas-bridge.xethub.hf.co`, `cdn-lfs.hf.co`, `cdn-lfs-us-1.hf.co`, `cdn-lfs-eu-1.hf.co`), redirect hop limit ($\le 5$), exact size and SHA-256 verification.
      - Pre-load integrity revalidation off main before starting or resuming any semantic indexing job.
    - **Persistent SQLite Index (Migration 9, `CURRENT_SCHEMA_VERSION = 9`)**:
      - `photo_semantic_embeddings`: binds each 512-d `Float32Array` blob (`2,048` bytes) to `file_location_id`, `discovery_observation_id`, `content_sha256`, `content_revision`, `model_id`, `model_commit`, `model_manifest_sha256`, `preprocessing_version`, and `vector_dimensions = 512` with partial unique index `idx_sem_emb_curr` on `(file_location_id, model_id, model_commit, model_manifest_sha256, preprocessing_version) WHERE is_current = 1`.
      - `semantic_index_jobs` & `semantic_index_job_items`: disk-backed job state (`running`, `paused`, `cancelled`, `interrupted`, `failed`, `completed`), counters (`total_photos`, `processed_photos`, `indexed_photos`, `reused_photos`, `unsupported_photos`, `failed_photos`), and per-photo snapshot scope (`expected_revision`, `status`, `error_code`, `error_message`).
      - No permanent 50,000-photo catalog cap: job creation snapshots only photos lacking a current embedding for the target model/recipe in SQLite, and job item queries paginate in bounded batches (`<= 500` items per batch).
      - Vector validation (`src/main/services/semantic/vector.ts`): rejects non-finite (`NaN`/`Infinity`), wrong-dimension, non-unit-norm ($|\lVert v \rVert_2 - 1.0| > 10^{-3}$), or malformed-size blobs before SQLite persistence.
      - Content-addressed reuse with live source verification: an existing current vector with matching `(content_sha256, model_id, model_commit, model_manifest_sha256, preprocessing_version)` is reused only after the worker verifies the live source file on disk (`verify_source` action: `approvedRoots` containment, pre/post `fstat`, sub-millisecond `mtimeMs`/`birthtimeMs` consistency, and streaming SHA-256).
      - Pre-commit revision check: `recordSemanticEmbeddingAndCompleteItem` re-checks the current catalog `content_revision` inside a SQLite transaction and records `REVISION_MISMATCH` if the source changed while in flight.
    - **Shared Worker Pool & Resource Bounds (`ThumbnailCoordinator` + `SemanticIndexCoordinator`)**:
      - Aggregate live image-processing workers across interactive thumbnails, perceptual hashing (`dhash64_v1`), and semantic indexing (`semantic_embed`): **$\le 2$ live workers**, counting terminating workers until process `'exit'`.
      - Active semantic embedding tasks: **$\le 1$ concurrent task** and at most **1 worker holding a loaded ONNX session** (`intraOpNumThreads: 2`, `interOpNumThreads: 1`, `cpuMemArena: false`). Idle or finished sessions are explicitly released (`release_semantic_session`).
      - Aggregate worker queue: **$\le 64$ queued requests**, reserving $\ge 32$ slots for high-priority interactive thumbnail requests; `SemanticIndexCoordinator` yields whenever high-priority thumbnail decodes are queued or active.
      - Thumbnail scroll cancellation isolation: `ThumbnailCoordinator.cancelRequest(locationId)` cancels only thumbnail `decode` and `validate_cache` items, never terminating background `fingerprint` or `semantic_embed` worker tasks for the same `locationId`.
      - Packaging: `electron-builder.json5` unpacks `node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**/*` alongside `sharp` into `app.asar.unpacked`, bundles `THIRD_PARTY_NOTICES.md`, and excludes `spikes/` and model caches.

16. **Photo Metadata Extraction & Fact/Inference-Separated SQL Filters (Stage 6C)**:
    - **Inviolable Principles & Four-Way Provenance Separation**:
      - Source files remain strictly read-only (`open(path, 'r')`) inside the worker thread, enforcing `approvedRoots` canonical containment, symlink/junction rejection, pre/post descriptor `fstat` stability, sub-millisecond `mtimeMs`/`birthtimeMs` verification, and streaming SHA-256 verification.
      - Separates four distinct layers: (1) immutable filesystem observations & verified SHA-256 hashes (`file_locations`, `discovery_observations`, `hash_observations`); (2) extracted technical metadata bound to `parser_recipe_version = 'exif_tech_v1'` and `content_revision` (`photo_technical_metadata`, preserving bounded `raw_tags_json` evidence); (3) interpreted capture dates derived from EXIF tags; and (4) user review annotations (`photo_annotations`, `collection_memberships`) and machine embeddings (`photo_semantic_embeddings`).
      - Works completely offline and without requiring a provisioned semantic model. GPS coordinates, maps, reverse geocoding, metadata editing, and writing EXIF are excluded.
    - **Parser Selection, Licensing & Header-Only Inspection**:
      - Uses `exifreader@4.54.0` (MPL-2.0, zero transitive runtime dependencies, locked exact version; documented in `THIRD_PARTY_NOTICES.md` and bundled into `out/main/thumbnail_worker.js` via `electron.vite.config.ts` `externalizeDepsPlugin({ exclude: ['exifreader'] })` for unpacked ASAR compatibility) alongside `sharp@0.35.5` header inspection (`sharp(buffer).metadata()`), avoiding full raster pixel decoding solely to read technical metadata.
      - Inspects container magic bytes (`jpeg`, `png`, `webp`, `gif`, `tiff`, `avif`, `heic`, `cr2`, `nef`, `arw`, `dng`, `orf`, `rw2`, `raf`) independently of filename extensions. Supported containers (`jpeg`, `png`, `webp`, `gif`, `tiff`, `avif`, `heic`) extract EXIF/dimensions (preserving HEIF `irot` dimensions reported by `sharp(buffer).metadata()` without double-swapping on EXIF `Orientation`), while camera RAW and BMP containers report honest `unsupported` status (`UNSUPPORTED_RAW_CONTAINER` / `UNSUPPORTED_BMP_CONTAINER`) rather than masquerading as empty metadata.
    - **Capture-Date Precedence, Timezone Honesty & Conflict Policy (`date-policy.ts`)**:
      - **Precedence & Conservative Conflict Policy**: Prefers valid EXIF `DateTimeOriginal` (combined with `OffsetTimeOriginal` and `SubSecTimeOriginal`). Falls back to valid EXIF `DateTimeDigitized` (`CreateDate`, combined with `OffsetTimeDigitized` and `SubSecTimeDigitized`) **only when `DateTimeOriginal` is absent**. When `DateTimeOriginal` is present but invalid (e.g. malformed syntax, impossible calendar date, or invalid offset), the system conservatively preserves the capture date as **Unknown** (`capture_calendar_date = NULL`, `capture_local_iso = NULL`), attributing the primary tag (`capture_date_source_tag = 'DateTimeOriginal'`), recording the exact parse error in `capture_date_parse_error`, and logging an explicit conflict note in `capture_date_conflict` (`DateTimeOriginal is invalid while DateTimeDigitized is present; keeping capture date Unknown rather than masking invalid primary tag`), rather than silently falling back to a secondary tag and masking primary tag corruption. Image modification tags (`DateTime` / `ModifyDate`), filesystem `birthtimeMs`/`mtimeMs`, and filenames are **never** used to populate capture dates.
      - **Timezone Honesty**: Timestamps carrying a valid explicit offset (`Z` or `±HH:MM` within `-14:00..+14:00`) record `capture_timezone_kind = 'explicit_offset'`, `capture_offset_minutes`, and `capture_utc_ms`. Timestamps without an offset record `capture_timezone_kind = 'local_wall_clock_unknown_tz'` with `capture_offset_minutes = NULL` and `capture_utc_ms = NULL` — never coerced to the host timezone or UTC.
      - **Calendar Validation & Range Filtering**: Validates real Gregorian calendar dates (including leap-year rules for February 29), 24-hour clock bounds, subsecond digits (`<= 9` digits), and tag conflicts (such as valid `DateTimeOriginal` vs. differing `DateTimeDigitized` calendar date, invalid `DateTimeOriginal` with valid `DateTimeDigitized` present, or malformed offset strings). Date-range SQL filters compare `capture_calendar_date` (`YYYY-MM-DD` recorded capture wall-clock date) deterministically without host-timezone dependence. Raw tag strings remain preserved in `raw_tags_json` when interpretation fails.
    - **Dimensions, Camera/Lens Normalization & File-Type Basis (`normalize.ts`)**:
      - Preserves `encoded_width_px`, `encoded_height_px`, and EXIF `exif_orientation` (`1..8`), rejecting impossible or excessive dimensions (`< 1`, `> 100,000` px per axis, or `> 100,000,000` pixels). Computes orientation-adjusted `display_width_px` and `display_height_px` (orientations `5..8` swap width and height); SQL minimum width/height filters (`minWidthPx`, `minHeightPx`) apply consistently to `display_width_px` and `display_height_px`.
      - Preserves sanitized original `camera_make_raw`, `camera_model_raw`, and `lens_model_raw` strings (`<= 256` chars, Unicode NFC, control/null bytes stripped) alongside separate lowercase normalized matching keys (`camera_display`, `camera_normalized`, `lens_normalized`), deduplicating redundant Make prefixes in Model strings without inventing model labels.
      - Keeps `recorded_extension` (filesystem suffix) strictly separate from `detected_format` (verified container header) and flags discrepancies via `extension_format_mismatch = 1`. File-type SQL filters explicitly label whether matching uses `detected_format` or `filename_extension`.
    - **SQLite Migrations 10–11 (`CURRENT_SCHEMA_VERSION = 11`), Bounded Facets & Combined SQL Filters**:
      - Migration 10 adds `photo_technical_metadata` (revision-bound with `extraction_status IN ('extracted', 'no_metadata', 'unsupported', 'failed')`, `is_current` partial unique index, content-reuse index, and filter/facet indexes on `capture_calendar_date`, `camera_normalized`, `lens_normalized`, `display_width_px`/`display_height_px`, and `detected_format`), `photo_metadata_jobs`, and `photo_metadata_job_items`. Migration 11 marks legacy `UNSUPPORTED_HEIC_CONTAINER` rows as `stale` (`is_current = 0`) on upgrade so previously scanned HEIC photos recover cleanly without clearing the catalog or losing user annotations.
      - Effective status distinguishes `unprocessed` (no metadata row yet) and `stale` (`content_revision` or `parser_recipe_version` superseded) from processed terminal rows (`extracted`, `no_metadata`, `unsupported`, `failed`). `Unknown` metadata filters match only processed photos whose target field is `NULL` (`m.id IS NOT NULL`), ensuring incomplete extraction coverage never masquerades as exhaustive `Unknown` results.
      - Combines capture date range (`+ includeUnknownCaptureDate`), camera (`+ onlyUnknownCamera`), lens (`+ onlyUnknownLens`), minimum display width/height (`+ includeUnknownDimensions`), and file type (`detected_format` or `filename_extension` `+ onlyUnknownDetectedFormat`) with Stage 5B rating, flag, and collection filters using SQL `AND` before `LIMIT ? OFFSET ?` pagination.
      - Camera, lens, and file-type option lists use bounded searchable/paginated SQL facet queries (`getPhotoMetadataFacet`, `LIMIT <= 100`, `OFFSET >= 0`) with accurate `unknownCount` and `unextractedCount`, avoiding whole-catalog materialization.
    - **Shared Worker Governance, Resumable Scope & Stale-Response Safety**:
      - Executes inside `ThumbnailCoordinator` (`<= 2` live workers including terminating, `<= 1` active `extract_photo_metadata` task, `<= 1` active `semantic_embed` task, `<= 64` queue reserving `>= 8` interactive slots and yielding whenever high-priority thumbnail decodes are queued or active, `15,000 ms` timeout, `<= 8 MiB` EXIF buffer cap, `<= 32 KiB` raw tag JSON cap).
      - `PhotoMetadataCoordinator` snapshots exact authorized catalog scope in `photo_metadata_job_items` in bounded 500-item batches (no permanent collection-size cap); resume processes only originally snapshotted `pending` items; unchanged content reuse requires live off-main source SHA-256 verification (`verify_source`); commits revalidate catalog `content_revision` transactionally (`REVISION_MISMATCH`).
      - Narrow typed IPC (`metadata:start-extraction`, `metadata:pause-extraction`, `metadata:resume-extraction`, `metadata:cancel-extraction`, `metadata:get-progress`, `metadata:progress-event`, `metadata:get-photo-detail`, `metadata:get-facets`, plus expanded `photos:get-page`) with bidirectional Zod schemas, top-level sender validation, and renderer monotonic sequence/generation guards (`usePhotos.ts`, `usePhotoMetadata.ts`, `PhotoMetadataFilterPanel.tsx`, `PhotosPanel.tsx`).

17. **Natural-Language Photo Search, Ranking & Photos UI Integration (Stage 6D & Stage 6E)**:
    - **Inviolable Principles & Machine Inference Separation**:
      - Semantic match scores are cosine similarities in $[-1.0, 1.0]$ derived from multimodal CLIP embeddings, rendered in UI as percentage match badges. They are machine inferences, not factual object labels, ground-truth classification, or probabilistic confidence.
      - Source preservation: source files are strictly read-only and 100% untouched.
      - Privacy & offline-first: text tokenization, text ONNX embedding inference, and cosine vector ranking run 100% locally on CPU without external network transmission.
    - **Dedicated Search Worker Lifecycle & Bounds (`search_worker.ts`, `search-coordinator.ts`)**:
      - Dedicated worker thread (`out/main/search_worker.js`) executing outside Electron main and renderer for tokenizer evaluation (`@huggingface/tokenizers@0.2.0`), ONNX text inference (`text_model_quantized.onnx`), candidate traversal, vector decoding, and ranking.
      - Worker capacity: $\le 1$ live search worker (`ensureWorker` waits on `terminatingWorkers` and `spawningWorkerPromise` so live workers never exceed 1), $\le 2$ image workers, and $\le 3$ total live workers across the application (counting terminating workers until process `'exit'`), plus bounded pending request capacity (`maxPendingRequests = 16`, throwing `SearchOverloadError`).
      - Aggregate worker diagnostics (`PHOTOS_GET_DIAGNOSTICS`): reports `searchActiveWorkers`, `searchTerminatingWorkers`, `searchLiveWorkers`, `searchPendingRequests`, `searchActiveCalls`, `searchMaxPendingRequests`, and `totalAppLiveWorkers` alongside `ThumbnailCoordinator` diagnostics so runtime bounds can be inspected continuously across IPC.
      - Pre-load model directory integrity revalidation (`verifyModelDirIntegrity`) off main before every load/search without a directory `mtimeMs` shortcut (verifying `realpathSync` containment, non-symlink `lstatSync`, and SHA-256 of all 7 artifacts, releasing cached ONNX text session/tokenizer via `releaseTextSession()` on failure or installation change); duplicate concurrent session loads prevented via retry-safe in-flight promise caching (`getOrEmbedQuery`).
      - Active worker cancellation, query supersession (checking `hadOlderActiveWork` before clearing old `activeRequests` so busy workers are terminated), execution timeouts (15,000 ms), shutdown cleanup, and capacity recovery.
      - Text input bound: $\le 500$ characters, trimmed, non-empty. Honestly truncates queries exceeding CLIP's 77-token context window with `truncated: true` and reported `tokenCount`.
      - Query vector validation at the ranking boundary (`validateQueryVector`): 512 dimensions, finite float32 values, non-zero L2 norm, unit normalization ($|\lVert v \rVert_2 - 1.0| \le 10^{-2}$).
    - **Query Identity vs. Page-Request Generation (`search-coordinator.ts`, `usePhotos.ts`)**:
      - Separates query identity (query text + filter parameters) from page requests. Multiple concurrent page requests for the same query generation (e.g. prefetching offset 0 and offset 50) proceed concurrently without cancelling each other.
      - Truly older queries are superseded and rejected with `SearchCancelledError` (never masked as an empty `{ items: [] }` result).
      - Renderer sequence safety: handles out-of-order pages, query replacement, clearing search, and filter changes without state corruption or stale cell overwrites.
    - **Complete Embedding Compatibility, Hydration Revalidation & Corrupt Candidate Isolation (`database.ts`, `search-worker.ts`, `search-coordinator.ts`, `vector.ts`)**:
      - Complete compatibility validation (`isSemanticEmbeddingRecordCompatible`) in candidate and coverage queries without `LIKE` wildcards or loose tolerance: `model_id`, `model_commit`, `model_manifest_sha256`, `preprocessing_version`, `embedding_dimensions = 512`, `observed_byte_size = d.byte_size`, Stage 2B timestamp precision (`isObservationTimestampMatching`: exact equality for fractional `filesystem_mtime_ms`, `< 1.0 ms` for integer, conservative null check), exact canonical 5-part `content_revision` parsing (`^(semrev|rev):(\d+):(\d+):([^:]+):([0-9a-f]{64})$`), and active `hash_observations` `sha256` match (`h.sha256 IS NULL OR h.sha256 = se.content_sha256`).
      - Scoring-snapshot binding & hydration revalidation: `executeSearchDatabaseQuery` wraps coverage and candidate traversal in a SQLite WAL read transaction (`BEGIN DEFERRED;` ... `ROLLBACK;` in `finally`) and carries `ScoredEmbeddingIdentity` directly through `rankCandidatesWithBoundedPaging` (both `TopKMinHeap` and disk-backed `DatabaseSync('')`), preventing post-ranking identity drift. Main-process hydration revalidates scored identity (`discoveryObservationId`, `observedByteSize`, `filesystemMtimeMs`, `activeHash`) against current catalog state with a single retry and count reconciliation on catalog mutation.
      - Corrupt candidate isolation (`tryDeserializeEmbeddingVector`): safely handles malformed lengths, NaN/Infinity, zero vectors, and non-unit vectors per candidate, skipping corrupt records without failing the search, excluding them from `eligibleCount`, and reporting `corruptCount` to the UI (`data-testid="search-corrupt-warning"`).
    - **Filter-Before-Ranking & Bounded Cosine Ranking (`ranking.ts`, `database.ts`, `TopKMinHeap`)**:
      - Stage 5B (rating, flag, collection) and Stage 6C (date range, camera, lens, dimensions, file-type) filters are applied in SQLite BEFORE top-$K$ selection and cosine ranking. Non-matching photos are pruned at the database level and never occupy candidate heap space.
      - Streaming candidate vector traversal via SQLite `stmt.iterate()` with `rankCandidatesWithBoundedPaging`: uses `TopKMinHeap` in JS memory for `offset + limit <= 1,000` ($O(\log K)$ sift operations, $O(1)$ rejection) and a private disk-backed temporary SQLite database (`new DatabaseSync('')` with `PRAGMA temp_store = FILE; PRAGMA cache_size = -2000;` — 2 MiB cache cap) for `offset + limit > 1,000`, keeping all offsets reachable without whole-catalog JS vector index materialization or an unapproved collection/offset cap. Tested and verified over >50,000 synthetic embeddings and beyond offset 10,000.
      - Coverage counters report `eligibleCount` (compatible non-corrupt searchable embeddings), `unindexedCount`, `staleCount`, and `corruptCount`.
      - Stable deterministic ordering: `score DESC, fileLocationId ASC`.
      - Pagination bounds: `limit <= 100`, `offset >= 0` (unbounded non-negative integer). Renderer `usePhotos` tracks per-page photo IDs in `pagePhotoIdsRef` outside pure React state updaters, evicting only `evictedPhotoIds` from `searchScores` when pages are evicted from the 40-page LRU cache (`MAX_PAGES = 40`) and preserving cached scores when returning to evicted Page 0.
    - **Typed IPC & Sandboxed Preload**:
      - Narrow IPC channels: `SEMANTIC_SEARCH_PHOTOS` (`'semantic:search-photos'`), `SEMANTIC_SEARCH_CANCEL` (`'semantic:search-cancel'`).
      - Bidirectional Zod schema validation (`SemanticSearchRequestSchema`, `SemanticSearchResponseSchema`, `SemanticSearchCancelRequestSchema`, `SemanticSearchCancelResponseSchema`). Sender validation enforced.
      - Sandboxed preload bundle verified to require only `electron`.
    - **Photos View UI Integration (`PhotosSearchBar.tsx`, `usePhotos.ts`, `PhotosPanel.tsx`)**:
      - Compact natural-language search bar in the Photos toolbar with query input, clear button, loading spinner, match count badge, latency/token badge, unindexed/stale/corrupt coverage warnings (`[data-testid="search-corrupt-warning"]`), and prominent non-factual AI inference disclaimer.
      - Model setup & recovery guidance: displays `[data-testid="search-model-missing-notice"]` when `modelStatus` is `'unprovisioned'` or `'missing'`, and an accessible alert banner `[data-testid="search-model-corrupt-notice"]` (`role="alert"`) when `modelStatus` is `'corrupt'` or `'error'`, directing the user to re-download or re-import the verified CLIP ViT-B/32 model in the Semantic Index panel.
      - Seamlessly combines with rating, flag, collection, and Stage 6C technical metadata filters.
      - Clearing search restores ordinary browsing without reload or state corruption.
      - Photo cards display similarity percentage badges for machine inference matches.

18. **Pre-Stage-7 Modularity Maintenance Plan (In progress — Slice 1 Complete / accepted at `2e6e54c`)**:
    - Prior to Stage 7 document extraction and unified search, a bounded sequence of behavior-preserving modularity refactoring slices is decomposing oversized coordination surfaces:
      - **Catalog Repositories — Slice 1: Semantic Photo Search (Complete; independently accepted at `2e6e54c`)**: Extracted `searchPhotosSemantic` into `SemanticSearchRepository` (`src/main/services/catalog/semantic-search-repository.ts`) and shared SQL filter construction into `buildPhotoFilterClauses` (`src/main/services/catalog/photo-filter-sql.ts`), preserving `CatalogDatabase` public API, connection lifecycle, and transaction ownership via delegation. Remaining catalog repository slices (`SourceRepository`, `ScanRepository`, `DuplicateRepository`, `VaultRepository`, `PhotoMetadataRepository`, `SemanticIndexRepository`) remain **Planned**.
      - **IPC Routing (Planned)**: Split `src/main/index.ts` IPC registration into domain routers with encapsulated sender checks and channel dispatch.
      - **Preload & Shared Contracts (Planned)**: Group IPC schemas and preload APIs by domain (`photos`, `metadata`, `semantic`, `vault`, `duplicates`, `scan`).
      - **Photos UI Decomposition (Planned)**: Break `PhotosPanel.tsx` into decoupled subcomponents and domain hooks (toolbar, filter panel, search bar, virtual grid, provenance sidebar).
