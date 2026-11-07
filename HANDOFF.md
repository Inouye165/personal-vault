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
  - **Resource Bounds & Limits**:
    - Validates batch sizes against `MAX_BATCH_SIZE = 1000`; rejects oversized discovery or hash batches eagerly before database mutation with `RangeError`.
    - Validates pagination parameters (`offset`, `limit`, `maxLocationsPerGroup`) as finite safe integers; rejects `NaN`, fractions, negative offsets, and zero/negative limits.
    - Paginated reads for sources (`listSources`), per-file discovery observation history (`getDiscoveryObservationsForFile`), per-file hash history (`getHashObservationsForFile`), catalog files (`queryFileLocations`), and duplicate groups (`getDuplicateGroups`, with member locations bounded per cluster).
  - **Preserved Discovery History**:
    - Records immutable discovery observations in `discovery_observations` (`file_location_id`, `byte_size`, `filesystem_birthtime_ms`, `filesystem_mtime_ms`, `inferred_capture_time_ms`, `observed_at_ms`, `last_seen_at_ms`, `is_current`).
    - Database constraint `idx_disc_obs_current` enforces at most one current discovery observation per file location.
    - When a file changes, the prior observation is deactivated (`is_current = 0`) preserving all earlier facts; a new observation is created (`is_current = 1`). Stale hashes are not inherited.
    - Idempotent re-scans with unchanged facts update `last_seen_at_ms` without duplicating observation rows.
  - **Hash Validation & Integrity**:
    - Validates SHA-256 strings using strict 64-character hexadecimal regex (`/^[0-9a-fA-F]{64}$/`).
    - Validates safe non-negative integer sizes and timestamps.
    - Conservative null timestamp matching: rejects mismatches where discovery recorded null mtime but hashing observed a non-null timestamp (or vice versa); accepts matching nulls; tolerates sub-millisecond precision loss (< 1.0 ms) while strictly detecting shifts >= 1.0 ms.
    - Shared validation across single (`recordHashObservation`) and batch (`recordHashObservationsBatch`) persistence.
    - Database constraint `idx_hash_obs_current` enforces at most one current verified hash per discovery observation.
  - **Deterministic Cleanup**: `close()` closes the handle; subsequent queries throw `DatabaseClosedError`.
  - **Source Preservation Invariance**: Catalog mutations touch only the SQLite database file; source files on disk remain strictly read-only and unaltered.
- [`src/main/services/catalog/migrations.ts`](file:///d:/organizer/src/main/services/catalog/migrations.ts):
  - Safe compatibility checking (`checkSchemaCompatibility`): inspects `sqlite_master` for `schema_migrations` and verifies version compatibility BEFORE changing journal mode or running DDL.
  - Both read-only and read-write opens reject unsupported future schema versions (`version > CURRENT_SCHEMA_VERSION`) with `UnsupportedSchemaVersionError`, preserving the file's existing contents, schema, and journal mode (e.g. `DELETE` mode).
  - Transactional migration runner (`runMigrations`, `CURRENT_SCHEMA_VERSION = 1`) with rollback on error.
  - Enables `PRAGMA foreign_keys = ON;`, `PRAGMA journal_mode = WAL;`, and `PRAGMA synchronous = NORMAL;` only after compatibility is confirmed.
  - Schema tables:
    - `sources`: `id`, `root_path`, `normalized_root_path` (UNIQUE), `created_at_ms`, `updated_at_ms`.
    - `file_locations`: `id`, `source_id` (FK CASCADE), `original_path` (UNIQUE), `normalized_path` (indexed), `file_name`, `extension`, `category` (CHECK 'photo' | 'document'), `created_at_ms`, `updated_at_ms`.
    - `discovery_observations`: `id`, `file_location_id` (FK CASCADE), `byte_size` (CHECK >= 0), `filesystem_birthtime_ms`, `filesystem_mtime_ms`, `inferred_capture_time_ms` (NULL default, distinct from filesystem dates), `observed_at_ms`, `last_seen_at_ms`, `is_current` (CHECK 0 or 1; partial unique index on `(file_location_id)` WHERE `is_current = 1`).
    - `hash_observations`: `id`, `file_location_id` (FK CASCADE), `discovery_observation_id` (FK CASCADE), `sha256` (CHECK length 64), `observed_byte_size` (CHECK >= 0), `observed_mtime_ms`, `hashed_at_ms`, `is_active` (CHECK 0 or 1; partial unique index on `(discovery_observation_id)` WHERE `is_active = 1`).
    - `schema_migrations`: `version` (PK), `name`, `applied_at_ms`.
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

1. **Reviewer Exit 1 Investigation**:
   - The reviewer observed `verify:sqlite` exit 1 without diagnostics. Investigation revealed that in Node/Electron ESM on Windows, dynamically importing absolute Windows paths (e.g. `import('D:\\...')`) throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` unless converted via `pathToFileURL(path).href`. Additionally, running GUI Electron in headless/CI sandboxes without an active desktop session resulted in silent process termination if uncaught exception handlers were absent.
   - Fixed by wrapping ESM module resolution with `pathToFileURL`, registering top-level `uncaughtException` and `unhandledRejection` handlers that write diagnostics to `stderr`, and ensuring execution under Electron's Node runtime (`ELECTRON_RUN_AS_NODE=1`).
2. **Real Module Repository Verification** (`scripts/verify-electron-sqlite.mjs` via `npm run verify:sqlite`):
   - Exercises the compiled `out/main/catalog.js` module inside the real Electron runtime across 7 diagnostic steps:
     1. Initializing catalog database at temporary path
     2. Registering source root
     3. Persisting discovery batch
     4. Recording SHA-256 hash observation
     5. Verifying reopen durability
     6. Verifying changed-file observation and hash invalidation
     7. Verifying foreign key enforcement and cascading deletion (`ON DELETE CASCADE`)
3. **Packaged Unpacked Binary Verification** (`npm run build:unpack` and `npm run smoke:unpacked`):
   - Packaged desktop executable `dist/win-unpacked/Personal Vault.exe` launched and verified cleanly via CDP with 0 preload or console errors.

---

## 3. Test-Driven Development (Red / Green / Refactor) Evidence

1. **Red phase (Review Findings Regression Suite)**:
   - Added 8 behavioral regression tests in [`tests/main/catalog.test.ts`](file:///d:/organizer/tests/main/catalog.test.ts) targeting the review findings:
     1. Unregistered source rollback when batch persistence fails.
     2. Rejection of oversized batches (> 1000 items) with `RangeError`.
     3. Strict pagination parameter validation (finite safe integers).
     4. Safe migration check in read-only mode and preservation of `DELETE` journal mode without mutation.
     5. Immutable discovery history preservation on file change without overwriting prior facts.
     6. Strict SHA-256 64-hex format, conservative null mtime matching, and numeric validation.
     7. POSIX backslash preservation as valid filename characters.
     8. Windows case-folding collision handling without silent fact discarding.
   - Ran `npm test`: Demonstrated **8 failing tests** across all targeted review findings.
2. **Green phase**:
   - Updated `path-normalization.ts` (POSIX backslash preservation, Windows collision documentation).
   - Updated `types.ts` (`DiscoveryObservationRecord`, updated `CatalogFileRecord`, pagination interfaces).
   - Updated `migrations.ts` (`checkSchemaCompatibility` before DDL/journal mode changes, `discovery_observations` table, partial unique indexes for current observations and active hashes).
   - Updated `database.ts` (source registration within batch transaction, resource limits validation, history preservation on change, shared hash validation with conservative null matching).
   - Updated `electron.vite.config.ts` to output `out/main/catalog.js`.
   - Updated `scripts/verify-electron-sqlite.mjs` with `pathToFileURL`, diagnostic reporting, and real repository testing.
   - Ran `npm test`: **All 30 tests in `tests/main/catalog.test.ts` passed; 154 tests passed repository-wide (0 skipped)**.
3. **Refactor & Quality Gates**:
   - Ran `npm run typecheck`: Strict TypeScript check passed across all configurations (0 errors).
   - Ran `npm run lint`: ESLint passed with 0 errors and 0 warnings.
   - Ran `npm run format:check`: Prettier 100% compliant across entire repository.
   - Ran `npm run build`: `electron-vite` builds main (`index.js` and `catalog.js`), preload, and renderer cleanly.
   - Ran `npm run verify:sqlite`: Real Electron verification passed all 7 steps with exit code 0.
   - Ran `npm run smoke:built` and `npm run smoke:unpacked`: Passed with exit code 0.

---

## 4. Verification Results

Execution results on implementation host (`D:\organizer`):

| Command                  | Result   | Details                                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------------------------- |
| `npm test`               | **PASS** | 8 test files: 154 passed, 0 skipped repository-wide                                     |
| `npm run typecheck`      | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors)  |
| `npm run lint`           | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                     |
| `npm run format:check`   | **PASS** | Prettier 100% compliant across entire repository                                        |
| `npm run build`          | **PASS** | `electron-vite` builds main (`index.js`, `catalog.js`), preload, and renderer cleanly   |
| `npm run verify:sqlite`  | **PASS** | Real Electron runtime exercises CatalogDatabase repository, cascades, and durability    |
| `npm run smoke:built`    | **PASS** | Built desktop shell passes bridge and navigation smoke checks in real Electron          |
| `npm run smoke:unpacked` | **PASS** | Unpacked desktop binary (`dist/win-unpacked`) passes bridge and navigation smoke checks |

_Note: Independent review previously verified 123 passed, 1 junction test skipped under sandbox permissions for Stage 2B. Stage 2C correction results above reflect execution on the implementation host._

---

## 5. Known Limitations & Boundaries

- **User-Space Catalog vs. Out-of-Band File Changes**: The catalog records discovery facts and SHA-256 observations at the moment of scanning/hashing. If files are modified out-of-band by external tools while Personal Vault is not scanning, the catalog reflects the last known scan state until the next discovery scan detects the size/mtime change, preserves the prior facts in history, and invalidates the active hash.
- **Platform Lookup Key Case Folding & Collision Handling**: On Windows (`win32`), `normalized_path` folds paths to lowercase to support fast case-insensitive search. However, because Windows NTFS supports per-directory case sensitivity, `file_locations` enforces uniqueness on the verbatim `original_path`. Distinct files that share a case-folded key retain their own separate records without overwriting or discarding facts.
- **In-Memory vs File-Backed WAL Mode**: File-backed databases enable WAL mode (`PRAGMA journal_mode = WAL;`) and `NORMAL` synchronous mode for crash durability and performance. In-memory databases (`:memory:`) operate in memory rollback journal mode.
- **Stage 2 Scope Isolation**: Stage 2C provides database catalog persistence only. Background scan-job orchestration, progress events, pausing/cancellation, and IPC/UI integration are deferred to Stage 2D.

---

## 6. Immediate Recommended Next Task

**Stage 2D: Background worker job controller with progress reporting, pause, cancel, and resumable scan recovery; IPC/UI integration.**
