# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-2c-sqlite-catalog` (branched from verified Stage 2B closeout commit `ab2fd60` / `e4488a2`)
- **Stage 1 status**: complete (`070e3cb`).
- **Stage 2 status**: **incomplete** — **Stage 2A and Stage 2B complete (accepted at `e4488a2`); Stage 2C corrections complete awaiting independent re-review; Stage 2D not started**.

---

## 1. Stage 2C Module Responsibilities (`src/main/services/catalog/`)

Modular, app-owned SQLite catalog repository independent of React, Electron IPC, and scan-job orchestration:

- [`src/main/services/catalog/database.ts`](file:///d:/organizer/src/main/services/catalog/database.ts):
  - `CatalogDatabase`: factory method `CatalogDatabase.open({ catalogPath, enableForeignKeyConstraints, timeoutMs, readOnly })`.
  - **Explicit initialization**: opened at caller-supplied path (creates parent directories if missing; zero import-time database creations). Failed open operations close raw connections deterministically without handle leaks.
  - **Full Transaction Rollback**: `persistDiscoveryBatch` includes source root registration inside the transaction, guaranteeing that any batch failure rolls back all sources, files, observations, and hashes completely.
  - **Resource Bounds & Input Limits**:
    - Validates batch sizes against `MAX_BATCH_SIZE = 1000`; rejects oversized discovery or hash batches eagerly before database mutation with `RangeError`.
    - Validates discovery candidate inputs strictly (`validateDiscoveryCandidateInput`): non-negative safe integer sizes, finite numbers or null for birthtime/mtime, positive safe integer timestamps, and valid photo/document categories.
    - Validates pagination parameters (`offset`, `limit`, `maxLocationsPerGroup`) as finite safe integers; rejects `NaN`, fractions, negative offsets, and zero/negative limits.
    - Paginated reads for sources (`listSources`), per-file discovery observation history (`getDiscoveryObservationsForFile`), per-file hash history (`getHashObservationsForFile`), catalog files (`queryFileLocations`), and duplicate groups (`getDuplicateGroups`, with member locations bounded per cluster).
  - **Preserved Discovery History & Creation Timestamp Changes**:
    - Records immutable discovery observations in `discovery_observations` (`file_location_id`, `byte_size`, `filesystem_birthtime_ms`, `filesystem_mtime_ms`, `inferred_capture_time_ms`, `observed_at_ms`, `last_seen_at_ms`, `is_current`).
    - Database constraint `idx_disc_obs_current` enforces at most one current discovery observation per file location.
    - Detects modifications to `byte_size`, `filesystem_mtime_ms`, or `filesystem_birthtime_ms` (including transitions between `null` and known timestamps). When any change is observed, the prior observation is deactivated (`is_current = 0`) preserving all earlier facts; a new observation is created (`is_current = 1`). Stale hashes are invalidated (`is_active = 0`) and never inherited.
    - Explicit retry / idempotency: re-scans with identical recorded facts update `last_seen_at_ms` and `updated_at_ms` without duplicating observation rows or invalidating active hashes.
  - **Hash Validation & Stage 2B Precision Contract**:
    - Validates SHA-256 strings using strict 64-character hexadecimal regex (`/^[0-9a-fA-F]{64}$/`).
    - Validates safe non-negative integer sizes and timestamps.
    - Precision contract (`isObservationTimestampMatching`): when both discovery expectation and hash observation retain fractional milliseconds, exact comparison is enforced; reduced tolerance (< 1.0 ms) is applied only when the discovery expectation was recorded as an integer (e.g. truncated precision); conservative null matching strictly rejects mismatches where one value is null and the other is not.
    - Shared validation across single (`recordHashObservation`) and batch (`recordHashObservationsBatch`) persistence.
    - Database constraint `idx_hash_obs_current` enforces at most one current verified hash per discovery observation.
  - **Deterministic Cleanup & Lifecycle Correctness**: `close()` closes the underlying handle and sets `isClosed() = true` only upon successful closure. Subsequent queries throw `DatabaseClosedError`.
  - **Source Preservation Invariance**: Catalog mutations touch only the SQLite database file; source files on disk remain strictly read-only and unaltered.
- [`src/main/services/catalog/migrations.ts`](file:///d:/organizer/src/main/services/catalog/migrations.ts):
  - Safe compatibility checking (`checkSchemaCompatibility`): inspects `sqlite_master` for `schema_migrations` and verifies version compatibility BEFORE changing journal mode or running DDL.
  - Both read-only and read-write opens reject unsupported future schema versions (`version > CURRENT_SCHEMA_VERSION`) with `UnsupportedSchemaVersionError`, preserving the file's existing contents, schema, and journal mode (e.g. `DELETE` mode).
  - Versioned transactional migrations (`CURRENT_SCHEMA_VERSION = 2`):
    - **Migration 1 (`initial_catalog_schema`)**: sets up original Stage 2C layout (`baa82e6`).
    - **Migration 2 (`discovery_observations_and_strict_hashes`)**: safely inspects table structure. If already conforming to the revised layout (`25a1b4f` with `discovery_observations`), records version 2 without table alteration. If conforming to `baa82e6`, creates `discovery_observations`, populates it with all historical facts, recreates `hash_observations` with `discovery_observation_id`, and rebuilds `file_locations` without inline observation columns. Rejects unexpected or corrupt layouts with `MigrationError`.
  - Enables `PRAGMA foreign_keys = ON;`, `PRAGMA journal_mode = WAL;`, and `PRAGMA synchronous = NORMAL;` only after compatibility is confirmed.
- [`src/main/services/catalog/path-normalization.ts`](file:///d:/organizer/src/main/services/catalog/path-normalization.ts):
  - Platform-aware lookup key normalization (`normalizePathForLookup`).
  - Windows (`win32`): standardizes forward slashes to backslashes (`\`), strips trailing slashes, and folds to lowercase for case-insensitive indexing while preserving exact original paths and filenames verbatim in database columns. Documented Windows case-folding limitations (per-directory NTFS case sensitivity) and verified collision handling (distinct files with differing casing are preserved without fact loss).
  - POSIX (`linux`, `darwin`): standardizes separators using `posix.normalize`, preserving backslashes (`\`) as valid filename characters without converting them to forward slashes.
- [`src/main/services/catalog/errors.ts`](file:///d:/organizer/src/main/services/catalog/errors.ts):
  - Typed domain errors: `CatalogError`, `UnsupportedSchemaVersionError`, `DatabaseClosedError`, `SourceNotFoundError`, `FileLocationNotFoundError`, `MigrationError`.
- [`src/main/services/catalog/types.ts`](file:///d:/organizer/src/main/services/catalog/types.ts) & [`src/main/services/catalog/index.ts`](file:///d:/organizer/src/main/services/catalog/index.ts):
  - Public TypeScript domain contracts, options, and pagination interfaces.

---

## 2. SQLite Implementation Selection & Real Electron Verification

### 2.1 Driver Selection Rationale

- **Evaluated alternatives**: `node:sqlite` vs external native addon `better-sqlite3`.
- **Selected**: `node:sqlite` (`DatabaseSync`), built directly into Node standard library (`v22.18.0` on host, `v24.22.2` / SQLite `3.53.4` inside Electron `45.2.3`).
- **Rationale**:
  1. **Zero ABI Mismatch**: Testing runs on Node 22 (`modules: 127`), whereas Electron 45 runs Node 24 (`modules: 150`). External native addons require compilation against Electron headers via `@electron/rebuild`, risking binary mismatch between test runs and desktop app execution. Built-in `node:sqlite` works seamlessly in both environments without compilation.
  2. **Zero Native Build Dependencies**: Requires no MSVC / `node-gyp` toolchain on Windows, eliminating build fragility.
  3. **Packaging Simplicity**: `electron-builder` does not need native `.node` file extraction or unpacking from `app.asar`.
  4. **Performance & Capabilities**: Synchronous API (`prepare`, `run`, `get`, `all`, `exec`, transactions), WAL mode, foreign keys, and sub-millisecond query performance.

### 2.2 Electron Driver & Packaging Verification Results

1. **Reviewer Exit 1 Investigation & Launcher Fix**:
   - The reviewer observed `npm run verify:sqlite` exit 1 without diagnostics. Investigation revealed that `package.json` had `"verify:sqlite": "electron scripts/verify-electron-sqlite.mjs"` which invoked GUI Electron without `ELECTRON_RUN_AS_NODE=1`. In headless environments or CI sandboxes lacking a display server, GUI Electron immediately terminates. Furthermore, dynamic ESM `import('D:\\...')` requires `pathToFileURL` on Windows.
   - Fixed by routing `npm run verify:sqlite` through `node scripts/verify-electron-sqlite.mjs`, which spawns the Electron binary with `ELECTRON_RUN_AS_NODE=1`, converts module paths with `pathToFileURL`, removes `process.exit` calls inside `try/catch` to ensure `finally` cleanup always runs, and outputs structured diagnostics.
2. **Real Module Repository Verification** (`scripts/verify-electron-sqlite.mjs` via `npm run verify:sqlite`):
   - Exercises the compiled `out/main/catalog.js` module inside the real Electron runtime across 7 diagnostic steps:
     1. Initializing catalog database at temporary path (v2 schema)
     2. Registering source root
     3. Persisting discovery batch
     4. Recording SHA-256 hash observation and active hash query
     5. Verifying reopen durability across independent connections
     6. Verifying changed-file observation and hash invalidation
     7. Verifying foreign key enforcement and cascading deletion (`ON DELETE CASCADE`)
3. **Packaged Unpacked Binary Verification** (`npm run verify:sqlite:unpacked` and `npm run smoke:unpacked`):
   - Package verification (`npm run verify:sqlite:unpacked`) executes `dist/win-unpacked/Personal Vault.exe` with `ELECTRON_RUN_AS_NODE=1` loading the packaged catalog module from `dist/win-unpacked/resources/app.asar/out/main/catalog.js`. All 7 repository steps passed cleanly, proving that `node:sqlite` and the bundled `CatalogDatabase` operate correctly from inside the packaged ASAR archive.
   - Packaged desktop executable launched and verified cleanly via CDP (`npm run smoke:unpacked`) with 0 preload or console errors.

---

## 3. Test-Driven Development (Red / Green / Refactor) Evidence

1. **Red phase (Re-Review Findings Regression Suite)**:
   - Added 7 behavioral regression tests in [`tests/main/catalog.test.ts`](file:///d:/organizer/tests/main/catalog.test.ts) targeting the second round review findings:
     1. Migration of original `baa82e6` schema (v1 without `discovery_observations`) to v2 preserving all data and active hashes.
     2. Migration of revised `25a1b4f` schema (v1 with `discovery_observations`) to v2 idempotently.
     3. Rejection of corrupted or unrecognized version 1 schema layout with `MigrationError`.
     4. Enforcement of Stage 2B precision contract for timestamp comparison (exact fractional comparisons, tolerance only for integer expectations, null mismatches rejected).
     5. Creation timestamp (`birthtimeMs`) change detection and preservation of both observations in history with hash invalidation.
     6. Detection of `birthtimeMs` transitions between null and known values.
     7. Strict validation of discovery candidate inputs (non-finite numbers, negative sizes).
   - Ran `npm test`: Demonstrated **7 failing tests** across all targeted review findings.
2. **Green phase**:
   - Updated `migrations.ts`: `CURRENT_SCHEMA_VERSION = 2`; implemented version 2 migration with schema inspection distinguishing `baa82e6` vs `25a1b4f` and migrating data safely.
   - Updated `database.ts`: implemented Stage 2B timestamp matching precision in `isObservationTimestampMatching`; added `validateDiscoveryCandidateInput`; updated `persistDiscoveryBatch` to detect `birthtimeMs` changes and preserve history; updated `close()` to set `closed = true` only after successful closure.
   - Updated `package.json`: routed `"verify:sqlite"` through Node launcher and added `"verify:sqlite:unpacked"`.
   - Updated `scripts/verify-electron-sqlite.mjs`: added `--mode=unpacked` support for ASAR package verification; removed `process.exit` calls from `try/catch` to guarantee `finally` cleanup.
   - Ran `npm test`: **All 38 tests in `tests/main/catalog.test.ts` passed; 162 tests passed repository-wide (0 skipped)**.
3. **Refactor & Quality Gates**:
   - Ran `npm run typecheck`: Strict TypeScript check passed across all configurations (0 errors).
   - Ran `npm run lint`: ESLint passed with 0 errors and 0 warnings.
   - Ran `npm run format:check`: Prettier 100% compliant across entire repository.
   - Ran `npm run build`: `electron-vite` builds main (`index.js`, `catalog.js`), preload, and renderer cleanly.
   - Ran `npm run verify:sqlite`: Real Electron verification passed all 7 steps with exit code 0.
   - Ran `npm run verify:sqlite:unpacked`: Packaged ASAR repository verification passed all 7 steps with exit code 0.
   - Ran `npm run smoke:built` and `npm run smoke:unpacked`: Passed with exit code 0.

---

## 4. Verification Results

Execution results on implementation host (`D:\organizer`):

| Command                          | Result   | Details                                                                                 |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `npm test`                       | **PASS** | 8 test files: 162 passed, 0 skipped repository-wide                                     |
| `npm run typecheck`              | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors)  |
| `npm run lint`                   | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                     |
| `npm run format:check`           | **PASS** | Prettier 100% compliant across entire repository                                        |
| `npm run build`                  | **PASS** | `electron-vite` builds main (`index.js`, `catalog.js`), preload, and renderer cleanly   |
| `npm run verify:sqlite`          | **PASS** | Real Electron runtime exercises CatalogDatabase repository, cascades, and durability    |
| `npm run verify:sqlite:unpacked` | **PASS** | Packaged ASAR catalog module exercised via unpacked binary (`Personal Vault.exe`)       |
| `npm run smoke:built`            | **PASS** | Built desktop shell passes bridge and navigation smoke checks in real Electron          |
| `npm run smoke:unpacked`         | **PASS** | Unpacked desktop binary (`dist/win-unpacked`) passes bridge and navigation smoke checks |

---

## 5. Known Limitations & Boundaries

- **User-Space Catalog vs. Out-of-Band File Changes**: The catalog records discovery facts and SHA-256 observations at the moment of scanning/hashing. If files are modified out-of-band by external tools while Personal Vault is not scanning, the catalog reflects the last known scan state until the next discovery scan detects the size, mtime, or birthtime change, preserves the prior facts in history, and invalidates the active hash.
- **Platform Lookup Key Case Folding & Collision Handling**: On Windows (`win32`), `normalized_path` folds paths to lowercase to support fast case-insensitive search. However, because Windows NTFS supports per-directory case sensitivity, `file_locations` enforces uniqueness on the verbatim `original_path`. Distinct files that share a case-folded key retain their own separate records without overwriting or discarding facts.
- **In-Memory vs File-Backed WAL Mode**: File-backed databases enable WAL mode (`PRAGMA journal_mode = WAL;`) and `NORMAL` synchronous mode for crash durability and performance. In-memory databases (`:memory:`) operate in memory rollback journal mode.
- **Stage 2 Scope Isolation**: Stage 2C provides database catalog persistence only. Background scan-job orchestration, progress events, pausing/cancellation, and IPC/UI integration are deferred to Stage 2D.

---

## 6. Immediate Recommended Next Task

**Stage 2D: Background worker job controller with progress reporting, pause, cancel, and resumable scan recovery; IPC/UI integration.**
