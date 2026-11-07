# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-2d-scan-jobs` (branched from accepted Stage 2C closeout commit `d25ba50` / `a674f9c`)
- **Stage 1 status**: complete (`070e3cb`).
- **Stage 2 status**: **Stage 2A, 2B, 2C accepted; Stage 2D complete and awaiting independent review (Stage 2 complete pending acceptance)**.

---

## 1. Stage 2D Architecture & Module Responsibilities

Stage 2D implements resumable background scan jobs, SQLite job state and checkpoint persistence, crash recovery, changed-file revalidation, typed IPC contracts with bidirectional runtime Zod validation, and accessible renderer UI integration without altering source files.

### 1.1 Catalog Database Migration & Job Persistence (`src/main/services/catalog/`)

- [`src/main/services/catalog/migrations.ts`](file:///d:/organizer/src/main/services/catalog/migrations.ts):
  - Incremented `CURRENT_SCHEMA_VERSION = 4`.
  - **Migration 3 (`scan_jobs_and_errors`)**:
    - Creates `scan_jobs` table tracking `id`, `roots_json`, `status` (`running`, `paused`, `cancelled`, `interrupted`, `failed`, `completed`), `phase` (`idle`, `discovery`, `hashing`, `completed`), `discovered_count`, `hashed_count`, `failed_count`, `created_at_ms`, `updated_at_ms`, `completed_at_ms`, and `last_checkpoint_ms`.
    - Creates `scan_job_errors` table tracking `id`, `job_id` (foreign key with `ON DELETE CASCADE`), `file_path`, `phase` (`discovery` | `hashing`), `error_code`, `error_message`, and `created_at_ms`.
    - Enforces check constraints on `status` and `phase`.
  - **Migration 4 (`scan_job_files_and_dismissal`)**:
    - Adds `is_dismissed INTEGER NOT NULL DEFAULT 0` column to `scan_jobs` for tracking user dismissal of terminal job reports.
    - Creates `scan_job_files` table (`job_id INTEGER NOT NULL`, `file_location_id INTEGER NOT NULL`, `PRIMARY KEY (job_id, file_location_id)`) with foreign keys and cascade deletion. Explicitly maps scan job membership independently of original `file_locations.source_id` registration.
- [`src/main/services/catalog/database.ts`](file:///d:/organizer/src/main/services/catalog/database.ts):
  - `createScanJob`: creates new scan job record in `running` status.
  - `getScanJob`: retrieves job by ID with parsed roots.
  - `getLatestScanJob(options?: { unDismissedOnly?: boolean })`: retrieves most recent scan job, optionally filtering dismissed records.
  - `getActiveScanJob`: retrieves current active (`running` or `paused`) or `interrupted` scan job.
  - `dismissScanJob(jobId)`: flags a job record as dismissed (`is_dismissed = 1`).
  - `clearScanJobFiles(jobId)`: cleans up mapped candidate file records for a job.
  - `countUnhashedFilesForJob(jobId)`: counts unhashed files explicitly mapped to the job in `scan_job_files`.
  - `getUnhashedFilesForJob(jobId, options)`: keyset-paginated retrieval (`afterId`) of unhashed files mapped to the job.
  - `linkUnhashedFilesForRootsToJob(jobId, roots)`: links unhashed candidate files matching approved root paths into `scan_job_files`.
  - `updateScanJobProgress`: persists incremental checkpoints (`discoveredCount`, `hashedCount`, `failedCount`).
  - `updateScanJobStatus`: updates lifecycle state, phase, and completion timestamps.
  - `recordScanJobError`: records typed error in `scan_job_errors`.
  - `getScanJobErrors`: paginated query for errors associated with a job.
  - `markRunningJobsAsInterrupted`: startup crash recovery helper transitioning stale `running` or `paused` jobs to `interrupted`.
  - `getUnhashedFilesForRoots`: bounded query finding file locations under roots whose current discovery observation has no active hash observation.
  - `countUnhashedFilesForRoots`, `countSources`, `countFileLocations`, `getFileLocationByOriginalPath`: summary queries supporting status reporting.

### 1.2 Scan Job Coordinator (`src/main/services/jobs/`)

- [`src/main/services/jobs/coordinator.ts`](file:///d:/organizer/src/main/services/jobs/coordinator.ts):
  - Coordinates read-only streaming discovery (`scanSourceRoots`), streaming SHA-256 content hashing (`hashFile`), and bounded SQLite persistence (`CatalogDatabase`).
  - **Single Active Job Concurrency Lock**: Enforces at most one running/paused job at a time; rejects concurrent scan attempts with `ActiveJobConflictError`. Ownership is reserved synchronously (`isStarting`) before asynchronous validation.
  - **Effective Roots & Overlapping Root Scoping**:
    - Discovers files using `getEffectiveRoots(roots)` to eliminate redundant descendant traversals when parent and child roots are supplied simultaneously, while preserving requested roots.
    - Tracks candidate discovery in `scan_job_files`, decoupling hashing membership from historic `file_locations.source_id` provenance.
    - Deduplicates candidate paths across roots via `seenCandidatePaths`.
  - **Cooperative Event Loop Yielding**: Yields control periodically to the Node/Electron event loop via `setImmediate`, keeping UI responsive during large directory traversals and hashing loops.
  - **Pause and Resume**:
    - `pauseScan()`: sets pause flag, checkpoints progress, gracefully pauses between files, and transitions job status to `paused`.
    - `resumeScan()`: re-runs discovery across configured roots, revalidating observations, and hashes remaining unhashed files to completion.
  - **Cancellation & Graceful Shutdown**:
    - `cancelScan()`: triggers `AbortController`, terminates discovery traversal and active file stream immediately, flushes committed state, and transitions status to `cancelled`. Awaits loop termination before returning.
    - `shutdown()`: triggers graceful abort with `state.status = 'interrupted'` before aborting, guaranteeing application quit records an `interrupted` (recoverable) state rather than `cancelled`.
  - **Restart Crash Recovery & Interruption Detection**:
    - `initialize()`: marks any leftover `running` or `paused` jobs as `interrupted`.
    - Resuming an interrupted job re-discovers all files and revalidates file sizes and timestamps.
  - **Changed-File Revalidation**:
    - Never trusts a saved checkpoint as proof of unchanged content.
    - If a file is modified out-of-band during an interruption or pause, subsequent discovery detects changed `byteSize` or `mtimeMs`, deactivates the prior discovery observation (`is_current = 0`), invalidates the old hash observation, creates a fresh current observation, and queues the file for re-hashing.
  - **Visible Errors**:
    - Non-fatal file errors (e.g. read permission denied) are recorded in `scan_job_errors` and counted in `failedCount`. Jobs complete with visible error lists rather than silently masking failures.

### 1.3 IPC Contracts & Boundary Validation (`src/shared/`, `src/preload/`, `src/main/ipc/`)

- [`src/shared/contracts/channels.ts`](file:///d:/organizer/src/shared/contracts/channels.ts):
  - Added channels: `SCAN_SELECT_ROOTS`, `SCAN_START_JOB`, `SCAN_PAUSE_JOB`, `SCAN_RESUME_JOB`, `SCAN_CANCEL_JOB`, `SCAN_GET_ACTIVE_JOB`, `SCAN_GET_LATEST_JOB`, `SCAN_DISMISS_JOB`, `SCAN_PROGRESS_EVENT`.
- [`src/shared/validation/ipc-schemas.ts`](file:///d:/organizer/src/shared/validation/ipc-schemas.ts):
  - Zod schemas validating all channel requests, responses, and progress events in both directions:
    - `SelectRootsResponseSchema`, `StartScanRequestSchema`, `JobIdRequestSchema`, `JobActionResponseSchema`, `GetActiveJobResponseSchema`, `GetLatestJobResponseSchema`, `DismissJobRequestSchema`, `DismissJobResponseSchema`, `ScanJobProgressSchema`, `ScanJobErrorSchema`.
- [`src/preload/index.ts`](file:///d:/organizer/src/preload/index.ts) & [`src/preload/index.d.ts`](file:///d:/organizer/src/preload/index.d.ts):
  - Exposes typed methods on `window.api`:
    - `selectRoots()`, `startScan()`, `pauseScan()`, `resumeScan()`, `cancelScan()`, `getActiveScanJob()`, `getLatestScanJob()`, `dismissScanJob()`, `onScanProgress()`.
  - Runtime Zod parsing guarantees that malformed requests from renderer or malformed responses from main throw explicit errors rather than corrupting state.
- [`src/main/ipc/handlers.ts`](file:///d:/organizer/src/main/ipc/handlers.ts):
  - Registers handlers with strict `validateSender` enforcement on every channel (top-level frame, trusted URL origin).
  - Native directory selection dialog via `dialog.showOpenDialog` with `openDirectory` and `multiSelections`.
  - Real-time progress broadcasting via `window.webContents.send(IPC_CHANNELS.SCAN_PROGRESS_EVENT, progress)`.

### 1.4 Renderer UI Integration (`src/renderer/src/`)

- [`src/renderer/src/components/ScanJobsPanel.tsx`](file:///d:/organizer/src/renderer/src/components/ScanJobsPanel.tsx):
  - Accessible folder selection button ("Choose Folders to Scan").
  - Active scan progress card displaying phase (`discovery` / `hashing`), counts (`discoveredCount`, `hashedCount`, `failedCount`), and accessible progress bar (`role="progressbar"` with `aria-valuenow`).
  - Action buttons: Pause, Resume, Cancel, and Dismiss (for terminal completed or completed-with-errors jobs).
  - Recovery banner for `interrupted` jobs with one-click "Resume Scan" button.
  - Visible error section detailing failed files and error messages with `role="alert"`.
- [`src/renderer/src/hooks/useScanJobs.ts`](file:///d:/organizer/src/renderer/src/hooks/useScanJobs.ts):
  - Manages job state, queries active/interrupted jobs first; if none exist, queries latest un-dismissed terminal job on startup.
  - Subscribes to `onScanProgress`, exposes `dismissJob`, and refreshes status on completion.
- [`src/renderer/src/App.tsx`](file:///d:/organizer/src/renderer/src/App.tsx) & [`src/renderer/src/components/EmptyState.tsx`](file:///d:/organizer/src/renderer/src/components/EmptyState.tsx):
  - Embeds `ScanJobsPanel` into the confirmed empty state and main application view.
  - Displays dynamic catalog inventory summary (indexed sources, registered files) updated immediately when a scan completes.

---

## 2. Test-Driven Development (Red / Green / Refactor) Evidence

### 2.1 Red Phase (Failing Behavior Tests)

1. **Schema Migration 3 & Scan Job Repository**:
   - Created [`tests/main/catalog-scan-jobs.test.ts`](file:///d:/organizer/tests/main/catalog-scan-jobs.test.ts) specifying migration 3, job lifecycle CRUD, unhashed file queries, and crash recovery.
   - Initial run failed: `CURRENT_SCHEMA_VERSION was 2, expected 3; db.createScanJob is not a function`.
2. **Scan Job Coordinator**:
   - Created [`tests/main/scan-jobs.test.ts`](file:///d:/organizer/tests/main/scan-jobs.test.ts) specifying end-to-end scan execution, concurrency conflict rejection, pause/resume, cancellation, crash recovery, changed-file revalidation, and visible error tracking.
   - Initial run failed: `Cannot find module '../services/jobs'`.
3. **IPC Contracts & Preload Bridge**:
   - Added scan schema validation tests in [`tests/shared/ipc-validation.test.ts`](file:///d:/organizer/tests/shared/ipc-validation.test.ts) and [`tests/preload/bridge.test.ts`](file:///d:/organizer/tests/preload/bridge.test.ts).
   - Initial run failed: `window.api.startScan is not a function`.
4. **IPC Handlers & Security**:
   - Added sender validation tests for all scan channels in [`tests/main/ipc.test.ts`](file:///d:/organizer/tests/main/ipc.test.ts).
   - Initial run failed: `No handler registered for 'scan:start-job'`.
5. **Renderer UI**:
   - Added UI tests in [`tests/renderer/scan-ui.test.tsx`](file:///d:/organizer/tests/renderer/scan-ui.test.tsx) specifying folder selection, progress reporting, pause/resume/cancel controls, and error display.
   - Initial run failed: `Cannot find module '../components/ScanJobsPanel'`.

### 2.2 Green Phase (Implementation)

1. Implemented migration 3 and scan job methods in `CatalogDatabase`.
2. Implemented `ScanJobCoordinator` with event loop yielding, discovery batching, streaming hashing, pause/resume/cancel state transitions, and restart recovery.
3. Added scan channels, Zod schemas, preload bridge methods, and sender-checked IPC handlers.
4. Implemented `useScanJobs` hook, `ScanJobsPanel` UI component, and integrated into `App.tsx` and `EmptyState.tsx`.
5. ### 2.4 Independent Review Corrections (Pass 2)

Following independent review feedback, seven issues were identified and addressed using failing behavioral regression tests before implementation:

1. **Hash Queue Traversal Past Failures**:
   - _Failing test_: Added test verifying coordinator advances past an unhashed missing file with `batchSize: 1` without skipping valid files, and across page boundaries without infinite loops. Initial run: failed with valid file never receiving a hash.
   - _Resolution_: Implemented keyset pagination (`afterId`) in `CatalogDatabase.getUnhashedFilesForRoots` (`WHERE fl.id > ? ORDER BY fl.id ASC LIMIT ?`) and updated `ScanJobCoordinator` loop to advance `lastSeenLocationId` rather than repeatedly requesting page 1 and filtering in memory.
2. **Lifecycle Serialization & Ownership Reservation**:
   - _Failing test_: Added tests for simultaneous `startScan` conflict rejection and starting a scan while a job is `paused`. Initial run: both simultaneous calls succeeded.
   - _Resolution_: Added synchronous `isStarting` ownership reservation flag and updated `hasActiveJob()` to treat `paused` as active in both in-memory coordinator and database state. Guarded execution loop completion against clearing newer active jobs.
3. **Deterministic Cancellation & Application Shutdown**:
   - _Failing test_: Added test ensuring `cancelScan` awaits loop termination, and test ensuring `coordinator.shutdown()` marks running jobs as `interrupted` (not `cancelled`) to preserve recoverable state on app exit.
   - _Resolution_: Updated `cancelScan` to await `completionPromise`. Added `coordinator.shutdown()` wired to `app.on('before-quit')` in `src/main/index.ts` to await drain before closing the catalog database.
4. **Accurate Progress & Recovery Accounting**:
   - _Failing test_: Added test verifying repeated pause/resume and restart recovery do not inflate `discoveredCount`, `totalBytes`, or `hashedCount`. Initial run: counts doubled on resume.
   - _Resolution_: Reset pass-specific discovery counters (`passDiscoveredCount`, `passTotalBytes`) for each discovery pass, and computed baseline hashed counts from catalog unhashed differences (`total - unhashedCount`).
5. **Bounded Resource Utilization**:
   - _Failing test_: Added test ensuring in-memory errors are capped while full history is retained in SQLite, and validation test for `batchSize: 0`.
   - _Resolution_: Capped in-memory `state.errors` to `MAX_RETAINED_ERRORS = 50` with FIFO shifting, while recording every error durably to SQLite `scan_job_errors`. Added `validateBatchSize` requiring a positive safe integer within catalog limits (`1 <= batchSize <= 1000`).
6. **Honest Reporting of Partial Results**:
   - _Failing test_: Added tests in `tests/main/scan-jobs.test.ts` and `tests/renderer/scan-ui.test.tsx` verifying that jobs with errors persist an error summary, display "Completed with errors", show a warning badge and alert notice, and display actual percentage (e.g. 90%) rather than forcing 100%.
   - _Resolution_: Updated `ScanJobCoordinator` to persist `errorMessage` summary on completion when `errorCount > 0`. Updated `ScanJobsPanel.tsx` to compute actual ratio when errors occur, render `.status-warning` badge, and show warning notice.
7. **Real Electron Scan Verification over IPC**:
   - _Resolution_: Rewrote `scripts/verify-electron-scan.mjs` to launch real Electron, exercise `window.api.startScan`, `pauseScan` (mandatory assertion), `resumeScan`, receive real IPC progress events via `onScanProgress`, simulate SQLite crash state, relaunch, recover active job as `interrupted`, resume and revalidate a modified file, and verify source file invariance. Added `--mode=unpacked` support via `npm run verify:scan:unpacked`.

### 2.5 Independent Review Corrections (Pass 3)

Following the third independent review round, four areas were addressed using failing behavioral regression tests before implementation:

1. **Scan Scope Across Overlapping Source Roots**:
   - _Failing test_: Added test reproducing the reviewer's finding where scanning a parent root (`D:/parent`), modifying a child file (`D:/parent/child/good.jpg`), and scanning the subfolder (`D:/parent/child`) left `activeHash = null` because historical `file_locations.source_id` pointed to the parent root. Also tested subfolder scan followed by parent scan, overlapping roots in the same job (`['D:/photos', 'D:/photos/vacation']`), and verified no hashing outside approved roots.
   - _Resolution_: Decoupled job hashing scope from historical `source_id` registration. Created Migration 4 introducing the `scan_job_files` junction table (`job_id`, `file_location_id`). Discovery candidates and unhashed files under the approved roots (`linkUnhashedFilesForRootsToJob`) are mapped directly to `scan_job_files`. Added `getEffectiveRoots(roots)` to eliminate redundant descendant directory scans when both parent and child are specified, and deduplicated candidate file paths. Provenance and original `source_id` remain preserved.
2. **Terminal Results Restoration & Dismissal After Restart**:
   - _Failing test_: Added unit, IPC, and renderer tests for restoring persisted completed/failed results across application restarts when no active job is running, prioritizing active/interrupted jobs over terminal jobs, and verifying dismissal behavior.
   - _Resolution_: Added `is_dismissed` column to `scan_jobs` (Migration 4). Added `getLatestScanJob({ unDismissedOnly: true })` and `dismissScanJob(jobId)` to `CatalogDatabase`, exposed via `SCAN_GET_LATEST_JOB` and `SCAN_DISMISS_JOB` IPC channels with Zod schema validation. Updated `useScanJobs` to check active jobs first, falling back to latest un-dismissed terminal job on mount, and added an accessible "Dismiss" button on the terminal status card.
3. **Actual Crash & Shutdown Recovery Verification in Real Electron**:
   - _Resolution_: Overhauled `scripts/verify-electron-scan.mjs` to eliminate synthetic SQL insertions. The suite now tests:
     - Real in-progress scan termination: spawns a background scan over 300 files and abruptly kills the Electron process tree mid-flight.
     - Relaunch on the same user data directory asserting that the job is recovered as `interrupted`.
     - Resumption of the recovered job and revalidation of a modified source file.
     - Direct SQLite inspection asserting that the modified file's new SHA-256 digest is `is_current = 1` and `is_active = 1`, while the previous hash observation is deactivated (`is_active = 0`).
     - Real graceful quit/reopen recovery asserting that normal `window.close()` / shutdown drain persists the job as `interrupted`.
     - Strict source preservation invariance ensuring original timestamps and sizes remain intact.
     - Supports both `--mode=built` and `--mode=unpacked` (14/14 checks).
4. **Accurate Verification Reporting & Shutdown Classification**:
   - _Audit_: Audited shutdown classification in `ScanJobCoordinator.ts`. When `shutdown()` is called on quit, the execution loop checks `isInterrupted()` before checking `abortController.signal.aborted`, ensuring that application exit consistently produces an `interrupted` (recoverable) result, emits `interrupted` events, and settles completion promises.
   - _Reporting_: Verification diagnostics now log explicit CDP target discovery status. Verification results on the implementation host are reported separately from reviewer environments without speculation.

### 2.6 Independent Review Corrections (Pass 4: Windows Root Containment and Bounded Memory Deduplication)

1. **Windows Root Containment & Directory Open Redundancy Elimination**:
   - _Failing test_: Added behavioral test with a spying directory adapter counting `opendir` calls on real Windows temporary directories. Selecting both parent and child roots caused the child directory to be opened twice because `getEffectiveRoots` checked `norm.startsWith(parentNorm + '/')`, failing on Windows where normalized paths use backslashes (`\`). Initial test run: failed with `expected 2 to be 1`.
   - _Resolution_: Implemented `isSameOrDescendantPath` and `getEffectiveRoots` in [`src/main/services/catalog/path-normalization.ts`](file:///d:/organizer/src/main/services/catalog/path-normalization.ts), supporting platform-correct containment across Windows drive roots (`C:\`), UNC roots (`\\server\share`), trailing separators, case-insensitivity on Windows, duplicate roots, and sibling boundaries (`C:\photos` vs `C:\photos_backup`). Added comprehensive unit tests in [`tests/main/catalog.test.ts`](file:///d:/organizer/tests/main/catalog.test.ts). Child directory opens are verified to be exactly 1.
2. **Bounded Discovery Deduplication**:
   - _Failing test_: Added tests for duplicate roots and candidate paths crossing batch boundaries with `batchSize: 1`, pause/resume, and verified that counts reflect unique observed files without inflating.
   - _Resolution_: Removed unbounded in-memory `seenCandidatePaths` Set entirely from `ScanJobCoordinator`. In-flight discovery candidate memory in Node is strictly bounded by `batchSize` (1 <= batchSize <= 1000). Candidates are persisted via `persistDiscoveryBatch`, which inserts into `scan_job_files` (`PRIMARY KEY (job_id, file_location_id)`). Added `CatalogDatabase.countDiscoveredFilesForJob(jobId)` to compute exact unique counts and bytes from SQLite upon every batch commit.

Ran `npm test`: **All 276 tests passed across 11 test suites (0 skipped)**.

---

## 3. Verification Results

Execution results on implementation host (`D:\organizer`):

| Command                          | Result   | Details                                                                                        |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `npm test`                       | **PASS** | 11 test files: 276 passed, 0 skipped repository-wide                                           |
| `npm run typecheck`              | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors)         |
| `npm run lint`                   | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                            |
| `npm run format:check`           | **PASS** | Prettier 100% compliant across entire repository                                               |
| `npm run build`                  | **PASS** | `electron-vite` builds main (`index.js`, `catalog.js`, `jobs.js`), preload, renderer           |
| `npm run build:unpack`           | **PASS** | Packaged binary assembled into `dist/win-unpacked` with ASAR integrity                         |
| `npm run verify:sqlite`          | **PASS** | Real Electron runtime exercises CatalogDatabase repository (8/8 checks)                        |
| `npm run verify:sqlite:unpacked` | **PASS** | Packaged ASAR catalog module exercised via unpacked binary (`Personal Vault.exe`)              |
| `npm run verify:scan`            | **PASS** | Real Electron runtime exercises scan workflow, IPC, crash & graceful recovery, digests (14/14) |
| `npm run verify:scan:unpacked`   | **PASS** | Unpacked desktop binary exercises scan workflow, IPC, crash & graceful recovery (14/14)        |
| `npm run smoke:built`            | **PASS** | Built desktop shell passes bridge and navigation smoke checks in real Electron                 |
| `npm run smoke:unpacked`         | **PASS** | Unpacked desktop binary (`dist/win-unpacked`) passes bridge and navigation smoke checks        |

---

## 4. Known Limitations & Boundaries

- **Single Active Scan Job Constraint**: Personal Vault enforces at most one active scan job (`running` or `paused`) at any time. Starting another job while one is active returns `ActiveJobConflictError`. Ownership is reserved synchronously (`isStarting`) before asynchronous root validation to eliminate race conditions.
- **Cooperative Event Loop Yielding vs Worker Threads**: Scan jobs execute cooperatively in the main process with `setImmediate` yields between file batches and chunk reads. This prevents IPC serialization bottlenecks and keeps the main process responsive. Background multi-threaded worker pools are deferred to future stages if CPU-heavy tasks (e.g. OCR or local AI) demand dedicated threads.
- **Out-of-Band File Changes**: Modifications to files on disk made outside Personal Vault are detected on the subsequent scan pass or resume: discovery notes size or timestamp changes, deactivates earlier observations, invalidates hashes, and re-hashes changed files.
- **Non-Fatal Error Visibility & Honest Reporting**: Unreadable files (e.g., `EACCES`) are logged to `scan_job_errors` and surfaced in the UI. They do not halt the scan job, but ensure partial scans are never misrepresented as complete. Jobs finishing with errors display "Completed with errors" status, warning badges, actual completion percentage, and persisted error summaries.
- **Deterministic Shutdown & Crash Recovery**: Normal application quit marks running scan jobs as `interrupted` in SQLite during shutdown drain, enabling resume upon relaunch. Abrupt process termination is detected on subsequent coordinator initialization and similarly marked `interrupted`.
- **Source Preservation Invariance**: Originals remain strictly read-only. Personal Vault performs no file moves, writes, edits, or deletes on source roots.

---

## 5. Immediate Recommended Next Task

**Independent review of Stage 2D review corrections on `feat/stage-2d-scan-jobs`. Upon acceptance and merge to `main`, Stage 2 will be complete, allowing Stage 3 (Exact duplicate grouping and review) to begin.**
