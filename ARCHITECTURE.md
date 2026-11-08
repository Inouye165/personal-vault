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
│       └── catalog/       # Stage 2C: SQLite catalog schema and inventory persistence
│           ├── database.ts   # CatalogDatabase repository (parameterized, transactions, bounded queries)
│           ├── errors.ts     # Domain errors (UnsupportedSchemaVersionError, DatabaseClosedError, etc.)
│           ├── migrations.ts # Versioned transactional migrations and schema definition
│           ├── path-normalization.ts # Documented platform-aware lookup key normalization
│           ├── types.ts      # Persistence contracts, records, and pagination interfaces
│           └── index.ts      # Public catalog exports
│       └── jobs/          # Stage 2D: resumable scan jobs and coordinator
│           ├── coordinator.ts # ScanJobCoordinator (orchestrator, checkpointing, pause/resume, cancel)
│           ├── errors.ts     # Domain errors (ActiveJobConflictError, JobNotFoundError, JobStateError)
│           ├── types.ts      # Job options, progress, and event contracts
│           └── index.ts      # Public jobs exports
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
        ├── hooks/         # Custom hooks (e.g. useVaultApi)
        └── components/    # Layout, Sidebar, Header, and EmptyState views
```

---

## 4. Data Ownership & Fact vs. Inference Separation

### 4.1 Recorded Facts (Immutable)

- Stored as factual properties of discovered files.
- Original path, original filename, byte size, filesystem creation timestamp, filesystem modification timestamp, SHA-256 hash.
- Cannot be edited, guessed, or modified by classification engines.

### 4.2 Inferred Values (Derived & Mutable)

- Extracted or inferred by heuristics, OCR, or local AI classification models.
- Inferred capture date (from EXIF or filename heuristic), inferred location, document category (e.g. `receipts`, `legal`, `instructions`).
- Always recorded alongside a confidence score and provenance marker.
- When capture dates or GPS coordinates are not present, they remain explicit `null` / `undefined`.

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
    - **Decoder & Format Support (Sharp / libvips)**:
      - Maintained offline decoder: `sharp@0.35.5` with prebuilt `@img/sharp-win32-x64` (libvips 8.18.7), packaged into `app.asar.unpacked`.
      - Concurrency & event loop isolation: decoding runs in real Node worker threads (`worker_threads.Worker` running `src/main/services/thumbnails/worker.ts`), preventing main process event loop stalls. Worker crashes, timeouts, or cancellations terminate the worker process safely and await termination before reallocating concurrency capacity.
      - Supported formats: JPEG, PNG, WebP, GIF (frame 0), AVIF, TIFF.
      - Orientation preservation: Sharp `.rotate()` automatically applies EXIF orientation metadata to render photographs upright.
      - Honest placeholders: Apple HEIC/HEIF (libheif in prebuilt libvips only bundles AV1 decoder without patent-encumbered HEVC decoders), camera RAW, SVG, corrupted or oversized files return honest unsupported/error states without crashes or external toolchains.
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
      - Header search disabled with clear Stage 6 availability label.

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
      - Safe reconciliation & UI propagation: `usePhotoReview` tracks unfinalized committed operations in a bounded operation Map (`pendingOps`, max 500) across ratings, flags, collection changes, and memberships independently of selection and presentation guards. Successful unrelated operations do not clear pending status; an honest pending status banner and retry control calling `photos:reconcile-journal` snapshots and finalizes covered operations (`coveredOpIds`), preserving newer in-flight operations without repeating already committed mutations.
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
