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
     - Migrations are tracked in `schema_migrations` (`version`, `name`, `applied_at_ms`).
     - Reopening an existing database at the current version is idempotent and safe.
     - Reopening with an unsupported future schema version (`version > CURRENT_SCHEMA_VERSION`) fails immediately with `UnsupportedSchemaVersionError` without executing any SQL modifications.
     - Migrations execute inside an explicit transaction (`BEGIN TRANSACTION` ... `COMMIT`), rolling back changes completely on error.
   - **Normalized Lookup Keys vs. Verbatim Original Paths**:
     - `original_path` and `file_name` are preserved exactly as discovered (verbatim case, whitespace, and Unicode characters like emojis or non-ASCII scripts).
     - `normalized_path` is kept separate solely as a lookup and uniqueness key (`UNIQUE` constraint).
     - Platform behavior: on Windows (`win32`), slashes are standardized to `\`, trailing separators stripped, and paths folded to lowercase (`.toLowerCase()`) for case-insensitive matching; on POSIX systems (`linux`, `darwin`), standardizes separators and normalizes while preserving case.
   - **Fact vs. Inference Separation & Timestamp Honesty**:
     - Filesystem dates (`filesystem_birthtime_ms`, `filesystem_mtime_ms`) are recorded as immutable discovery facts.
     - `inferred_capture_time_ms` is kept distinct and initialized to `null`. Unknown values remain `null`; filesystem dates are never fabricated as capture dates.
   - **Changed-File Modeling & Explicit Hash Validity**:
     - `file_locations` stores the latest recorded discovery facts.
     - `hash_observations` stores SHA-256 observations with `observed_byte_size`, `observed_mtime_ms`, `hashed_at_ms`, and `is_active` boolean flag.
     - When a subsequent discovery scan observes that a file's `byte_size` or `filesystem_mtime_ms` has changed, the file's facts are updated and any existing active hash is immediately invalidated (`is_active = 0`). A new scan can never present an old hash as verified for modified file contents.
     - If discovery observes identical size and mtime, `last_seen_at_ms` is updated while active hash validity is preserved without duplicate rows.
   - **Foreign Keys, Cascades & Parameterized Transactions**:
     - Foreign keys are enforced (`PRAGMA foreign_keys = ON;`).
     - Deleting a source cascades deletion to associated `file_locations` and `hash_observations` (`ON DELETE CASCADE`).
     - Batch persistence (`persistDiscoveryBatch`, `recordHashObservationsBatch`) executes in a single transaction with automatic rollback if any candidate or observation fails validation.
   - **Bounded & Paginated Queries**:
     - Reads are bounded using `LIMIT` and `OFFSET` (`queryFileLocations`, `getDuplicateGroups`) with configurable limits (default 50, maximum 1000) and accurate total counts.
     - Prevents unbounded memory consumption on large catalogs.
   - **Source Preservation Invariance**:
     - Database writes affect strictly the app-owned SQLite catalog file.
     - Source files on disk remain strictly read-only and unaltered.
