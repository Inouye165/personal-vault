# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-2c-sqlite-catalog` (branched from verified Stage 2B closeout commit `ab2fd60` / `e4488a2`)
- **Stage 1 status**: complete (`070e3cb`).
- **Stage 2 status**: **incomplete** — **Stage 2A and Stage 2B complete (accepted at `e4488a2`); Stage 2C complete awaiting independent review; Stage 2D not started**.

---

## 1. Stage 2C Module Responsibilities (`src/main/services/catalog/`)

Modular, app-owned SQLite catalog repository independent of React, Electron IPC, and scan-job orchestration:

- [`src/main/services/catalog/database.ts`](file:///d:/organizer/src/main/services/catalog/database.ts):
  - `CatalogDatabase`: factory method `CatalogDatabase.open({ catalogPath, enableForeignKeyConstraints, timeoutMs, readOnly })`.
  - Explicit initialization at caller-supplied path (creates parent directories if missing; zero import-time side effects).
  - Source registration and inventory tracking (`registerSource`, `getSourceByPath`, `listSources`).
  - Transactional, bounded batch discovery persistence (`persistDiscoveryBatch`):
    - Inserts new file locations with recorded facts.
    - Idempotent re-scans: unchanged files update `last_seen_at_ms` without duplicating rows.
    - Changed-file detection: if discovery observes modified `byte_size` or `mtime_ms`, updates discovery facts and immediately invalidates any active hash observation (`is_active = 0`), ensuring old hashes are never presented as verified for newly observed content.
    - Transaction rollback on any constraint or validation failure.
  - Transactional hash observation recording (`recordHashObservation`, `recordHashObservationsBatch`):
    - Verifies observed size matches catalog discovery facts and observed mtime is consistent within 1.0 ms tolerance.
    - Marks existing active hashes for that file location as inactive, sets new observation with `is_active = 1`.
  - Bounded and paginated queries (`queryFileLocations`, `getDuplicateGroups`) with `limit` (max 1000, default 50) and `offset`, preventing unbounded memory loading.
  - Aggregate statistics (`getCatalogStats`).
  - Deterministic cleanup (`close`, `isClosed`, throws `DatabaseClosedError` on closed instance).
  - Source file read-only invariance: database writes affect only the SQLite database file; source files remain strictly untouched.
- [`src/main/services/catalog/migrations.ts`](file:///d:/organizer/src/main/services/catalog/migrations.ts):
  - Versioned, transactional schema migrations runner (`runMigrations`, `CURRENT_SCHEMA_VERSION = 1`).
  - Reopening is safe and idempotent.
  - Unsupported future schema versions (`version > CURRENT_SCHEMA_VERSION`) fail immediately with `UnsupportedSchemaVersionError` without modifying the database.
  - Enables `PRAGMA foreign_keys = ON;`, `PRAGMA journal_mode = WAL;`, and `PRAGMA synchronous = NORMAL;`.
  - Schema tables:
    - `sources`: `id`, `root_path`, `normalized_root_path` (UNIQUE), `created_at_ms`, `updated_at_ms`.
    - `file_locations`: `id`, `source_id` (FK CASCADE), `original_path`, `normalized_path` (UNIQUE), `file_name`, `extension`, `category` (CHECK 'photo' | 'document'), `byte_size` (CHECK >= 0), `filesystem_birthtime_ms`, `filesystem_mtime_ms`, `inferred_capture_time_ms` (NULL default, distinct from filesystem dates), `first_discovered_at_ms`, `last_seen_at_ms`.
    - `hash_observations`: `id`, `file_location_id` (FK CASCADE), `sha256` (CHECK length 64), `observed_byte_size` (CHECK >= 0), `observed_mtime_ms`, `hashed_at_ms`, `is_active` (CHECK 0 or 1).
    - `schema_migrations`: `version` (PK), `name`, `applied_at_ms`.
- [`src/main/services/catalog/path-normalization.ts`](file:///d:/organizer/src/main/services/catalog/path-normalization.ts):
  - Platform-aware lookup key normalization (`normalizePathForLookup`).
  - Windows (`win32`): standardizes separators (`\`), strips trailing slashes, and folds to lowercase for case-insensitive unique matching, while preserving verbatim original paths and filenames in database columns.
  - POSIX (`linux`, `darwin`): standardizes separators (`/`), normalizes path, preserves case.
- [`src/main/services/catalog/errors.ts`](file:///d:/organizer/src/main/services/catalog/errors.ts):
  - Typed domain errors: `CatalogError`, `UnsupportedSchemaVersionError`, `DatabaseClosedError`, `SourceNotFoundError`, `FileLocationNotFoundError`, `MigrationError`.
- [`src/main/services/catalog/types.ts`](file:///d:/organizer/src/main/services/catalog/types.ts) & [`src/main/services/catalog/index.ts`](file:///d:/organizer/src/main/services/catalog/index.ts):
  - Public TypeScript domain contracts, options, and pagination interfaces.

---

## 2. SQLite Implementation Selection & Electron Driver Verification

### 2.1 Driver Selection Rationale

- **Evaluated alternatives**: `node:sqlite` vs external native addon `better-sqlite3`.
- **Selected**: `node:sqlite` (`DatabaseSync`), built directly into Node standard library (`v22.18.0` on host, `v24.22.2` / SQLite `3.53.4` inside Electron `45.2.3`).
- **Rationale**:
  1. **Zero ABI Mismatch**: Testing runs on Node 22 (`modules: 127`), whereas Electron 45 runs Node 24 (`modules: 150`). External native addons require compilation against Electron headers via `@electron/rebuild`, risking binary mismatch between test runs and desktop app execution. Built-in `node:sqlite` works seamlessly in both environments without compilation.
  2. **Zero Native Build Dependencies**: Requires no MSVC / `node-gyp` toolchain on Windows, eliminating build fragility.
  3. **Packaging Simplicity**: `electron-builder` does not need native `.node` file extraction or unpacking from `app.asar`.
  4. **Performance & Capabilities**: Synchronous API (`prepare`, `run`, `get`, `all`, `exec`, transactions), WAL mode, foreign keys, and sub-millisecond query performance.

### 2.2 Electron Driver & Packaging Verification Results

1. **Driver verification script** (`scripts/verify-electron-sqlite.mjs` via `npm run verify:sqlite`):
   - Successfully launched Electron runtime, created tables, performed parameterized inserts, foreign key cascading, and queries.
2. **Packaged unpacked binary check** (`npm run build:unpack` and `npm run smoke:unpacked`):
   - Packaged desktop executable `dist/win-unpacked/Personal Vault.exe` launched and verified cleanly via CDP with 0 preload or console errors.

---

## 3. Test-Driven Development (Red / Green / Refactor) Evidence

1. **Red phase**:
   - Authored 22 behavioral tests in [`tests/main/catalog.test.ts`](file:///d:/organizer/tests/main/catalog.test.ts) covering initialization, missing parent directories, deterministic cleanup, schema migrations, reopen durability, unsupported future version rejection, foreign key enforcement, cascade deletion, verbatim Unicode path and filename preservation, distinct capture vs filesystem dates, duplicate content preservation at distinct paths, changed-file hash invalidation, repeated scan idempotency, transactional batch rollback, sub-ms mtime tolerance, bounded pagination, aggregate statistics, and source file read-only preservation.
   - Initial run failed with `Cannot find module '../../src/main/services/catalog'`.
2. **Green phase**:
   - Implemented `types.ts`, `path-normalization.ts`, `errors.ts`, `migrations.ts`, and `database.ts`.
   - All 22 tests in `tests/main/catalog.test.ts` passed; all 146 tests passed repository-wide.
3. **Refactor & Quality Gates**:
   - Resolved strict TypeScript type casting for `node:sqlite` output values (`SQLInputValue` and `unknown as Raw...Row`).
   - Removed unused imports and variables in accordance with ESLint rules.
   - Verified formatting with Prettier, clean `electron-vite build`, and verified Electron execution.

---

## 4. Verification Results

| Command                  | Result   | Details                                                                                   |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| `npm test`               | **PASS** | 8 test files: 146 passed, 0 skipped repository-wide                                       |
| `npm run typecheck`      | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors)    |
| `npm run lint`           | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                       |
| `npm run format:check`   | **PASS** | Prettier 100% compliant across entire repository                                          |
| `npm run build`          | **PASS** | `electron-vite` builds main, preload, and renderer cleanly                                |
| `npm run verify:sqlite`  | **PASS** | Real Electron runtime executes SQLite table creation, foreign keys, cascades, and queries |
| `npm run smoke:built`    | **PASS** | Built desktop shell passes bridge and navigation smoke checks                             |
| `npm run smoke:unpacked` | **PASS** | Unpacked desktop binary (`dist/win-unpacked`) passes bridge and navigation smoke checks   |

---

## 5. Known Limitations & Boundaries

- **User-Space Catalog vs. Kernel-Level File Observation**: The catalog records discovery facts and SHA-256 observations at the moment of scanning/hashing. If files are modified out-of-band by external tools while Personal Vault is not scanning, the catalog reflects the last known scan state until the next discovery scan detects the size/mtime change and invalidates the hash.
- **Platform Lookup Key Case Folding**: On Windows (`win32`), `normalized_path` folds paths to lowercase to honor NTFS/ReFS case-insensitivity and prevent duplicate entries for `D:\Photos\a.jpg` and `D:\photos\A.jpg`. On POSIX platforms, case is preserved. Verbatim original casing is always preserved in `original_path` and `file_name`.
- **In-Memory vs File-Backed WAL Mode**: File-backed databases enable WAL mode (`PRAGMA journal_mode = WAL;`) and `NORMAL` synchronous mode for crash durability and performance. In-memory databases (`:memory:`) operate in memory rollback journal mode.
- **Stage 2 Scope Isolation**: Stage 2C provides database catalog persistence only. Background scan-job orchestration, progress events, pausing/cancellation, and IPC/UI integration are deferred to Stage 2D.

---

## 6. Immediate Recommended Next Task

**Stage 2D: Background worker job controller with progress reporting, pause, cancel, and resumable scan recovery; IPC/UI integration.**
