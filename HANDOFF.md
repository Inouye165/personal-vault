# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-3-duplicate-review` (branched from accepted Stage 2 documentation closeout commit `eea7daa` / `71e1af7`)
- **Stage 1 status**: complete (`070e3cb`).
- **Stage 2 status**: complete (all substages 2A-2D independently accepted; Stage 2D accepted at `71e1af7`, closeout committed at `eea7daa`).
- **Stage 3 status**: **complete and awaiting independent review (not independently accepted)**.

---

## 1. Stage 3 Architecture & Module Responsibilities

Stage 3 implements exact duplicate grouping by current verified SHA-256 and byte size, persistent review decisions (reviewed/unreviewed status and optional preferred location), deterministic group state signatures, automatic decision invalidation upon membership/content/observation changes, stale write rejection, narrow typed IPC contracts with bidirectional runtime Zod validation, and side-by-side member inspection in the desktop renderer without altering source files.

### 1.1 Catalog Database Migration 5 & Review Persistence (`src/main/services/catalog/`)

- [`src/main/services/catalog/migrations.ts`](file:///d:/organizer/src/main/services/catalog/migrations.ts):
  - Incremented `CURRENT_SCHEMA_VERSION = 5`.
  - **Migration 5 (`duplicate_reviews`)**:
    - Creates `duplicate_reviews` table tracking `id`, `sha256` (64-char hex), `byte_size` (non-negative integer), `status` (`'unreviewed'` | `'reviewed'`), `preferred_location_id` (`REFERENCES file_locations(id) ON DELETE SET NULL`), `group_signature` (deterministic 64-char hex signature), `reviewed_at_ms`, and `updated_at_ms`.
    - Enforces uniqueness on `(sha256, byte_size)`.
    - Creates indexes on `(sha256, byte_size)` and `preferred_location_id`.
- [`src/main/services/catalog/database.ts`](file:///d:/organizer/src/main/services/catalog/database.ts):
  - `getDuplicateGroups(options?: DuplicateGroupOptions)`:
    - Queries duplicate content clusters where `d.is_current = 1 AND h.is_active = 1 AND h.observed_byte_size = d.byte_size` having `COUNT(DISTINCT h.file_location_id) > 1`.
    - Excludes inactive, invalidated, or superseded discovery observations.
    - Computes deterministic `groupSignature` for each cluster.
    - Applies review invalidation check: if stored signature does not match current signature, or if preferred location is no longer an active member, reverts status to `'unreviewed'`, clears preferred location, and sets `hasStaleDecision = true`.
    - Supports review status filtering (`'all'`, `'unreviewed'`, `'reviewed'`).
    - Deterministically ordered by `file_count DESC, byte_size DESC, sha256 ASC`.
    - Bounded pagination with `truncatedLocations` boolean indicating if preview locations list is truncated.
  - `getDuplicateGroupMembers(options: DuplicateGroupMembersOptions)`:
    - Dedicated keyset query retrieving all active members of an exact duplicate group.
    - Deterministically ordered by `file_location_id ASC`.
    - Independently paginated (`offset`, `limit`, `totalCount`, `hasMore`).
    - Returns full recorded facts (`fileName`, `originalPath`, `byteSize`, `filesystemBirthtimeMs`, `filesystemMtimeMs`, `firstDiscoveredAtMs`, `lastSeenAtMs`), inferred metadata (`inferredCaptureTimeMs`), hash provenance (`hashObservationId`, `discoveryObservationId`, `activeHash`, `activeHashVerifiedAtMs`), and `isPreferred` boolean.
  - `setDuplicateReview(input: SetDuplicateReviewInput)`:
    - Enforces that the target group exists with >= 2 active members.
    - Verifies that `expectedGroupSignature` matches the current group signature. If not, throws `StaleReviewError`.
    - Verifies that `preferredLocationId` (if specified) is an active member of the group. If not, throws `InvalidPreferredLocationError`.
    - Atomically upserts into `duplicate_reviews`.
    - Decisions are catalog annotations only; they never alter source files or mutate recorded facts.

### 1.2 Decision Invalidation Policy & Stale Write Detection

- **Group Signature Computation**:
  - The signature of an exact duplicate group is calculated as `SHA-256(tokens.join(';'))`, where each member token is `fileLocationId:discoveryObservationId:hashObservationId`, sorted deterministically by `fileLocationId ASC`.
  - Any change to group membership (new duplicate discovered, or file deleted), content (byte size changed), or verified observation (file modified on disk and rescanned, replacing discovery and hash observation IDs) changes the signature.
- **Automatic Decision Invalidation**:
  - If a group's current signature differs from the signature stored at review time:
    - The review decision is treated as invalidated.
    - `reviewStatus` is reported as `'unreviewed'`.
    - `preferredLocationId` is reported as `null`.
    - `hasStaleDecision` is set to `true`, notifying the user that the group changed.
  - Never silently carries a reviewed decision onto a changed group or retains an invalid preferred member.
- **Stale Write Rejection**:
  - When the client submits a review decision, it passes `expectedGroupSignature`.
  - If the group has changed since the user loaded the review screen, the catalog rejects the submission with `StaleReviewError` ("Stale review: the duplicate group has changed since it was loaded. Please refresh before saving.").

### 1.3 IPC Contracts & Boundary Validation (`src/shared/`, `src/preload/`, `src/main/ipc/`)

- [`src/shared/contracts/channels.ts`](file:///d:/organizer/src/shared/contracts/channels.ts):
  - Added channels: `DUPLICATES_GET_GROUPS`, `DUPLICATES_GET_MEMBERS`, `DUPLICATES_SET_REVIEW`.
- [`src/shared/validation/ipc-schemas.ts`](file:///d:/organizer/src/shared/validation/ipc-schemas.ts):
  - Zod schemas validating all channel requests and responses:
    - `DuplicateReviewStatusSchema`, `DuplicateReviewFilterSchema`, `DuplicatePreviewLocationSchema`, `DuplicateGroupSummarySchema`, `GetDuplicateGroupsRequestSchema`, `GetDuplicateGroupsResponseSchema`, `DuplicateMemberRecordSchema`, `GetDuplicateGroupMembersRequestSchema`, `GetDuplicateGroupMembersResponseSchema`, `SetDuplicateReviewRequestSchema`, `SetDuplicateReviewResponseSchema`.
- [`src/preload/index.ts`](file:///d:/organizer/src/preload/index.ts) & [`src/preload/index.d.ts`](file:///d:/organizer/src/preload/index.d.ts):
  - Exposes typed methods on `window.api`:
    - `getDuplicateGroups()`, `getDuplicateGroupMembers()`, `setDuplicateReview()`.
  - Bidirectional runtime Zod parsing guarantees invalid payloads throw immediate errors.
- [`src/main/ipc/handlers.ts`](file:///d:/organizer/src/main/ipc/handlers.ts):
  - Strict sender authorization (`validateSender`: WebContents ID, top-level frame, trusted application location) enforced on every duplicate review channel.

### 1.4 Renderer UI Integration (`src/renderer/src/`)

- [`src/renderer/src/components/DuplicateReviewPanel.tsx`](file:///d:/organizer/src/renderer/src/components/DuplicateReviewPanel.tsx):
  - **Operations Policy Notice**: Clearly explains catalog-index removal, vault-copy deletion, and original-source deletion as three distinct operations, emphasizing that none are implemented in Stage 3 and review decisions are annotations only.
  - **Confirmed Empty State**: Explicitly reports "No duplicate files found. All cataloged files have unique content." when no duplicates exist.
  - **Master-Detail Layout**:
    - Left sidebar: Duplicate groups list with review filter controls (All / Unreviewed / Reviewed), size, copy counts, status badges, and pagination.
    - Right panel: Group inspection header with full SHA-256 and byte sizes, stale review warning notice with refresh action, review status toggle ("Mark as Reviewed" / "Mark as Unreviewed"), and side-by-side member comparison cards.
    - Side-by-side member inspection: Filename, absolute path, exact byte size, creation date, modification date, inferred capture date (clearly labeled "(Inferred)"), and hash observation provenance (observation ID and verification timestamp). Missing filesystem dates are explicitly displayed as "Unknown", never fabricated.
    - Preferred location selection: Accessible "Set as Preferred" buttons and "Preferred Location" badges.
  - **Asynchronous Race Condition Guard**: `useDuplicateReview` hook utilizes monotonic selection tokens (`selectionTokenRef`), guaranteeing that slow responses from earlier group selections cannot overwrite a newly selected group.
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

### 2.7 Stage 3: Exact Duplicate Grouping and Review (Initial Implementation Evidence)

1. **Schema Migration 5 & Duplicate Queries/Reviews Repository**:
   - _Failing test_: [`tests/main/catalog-duplicates.test.ts`](file:///d:/organizer/tests/main/catalog-duplicates.test.ts) specified migration 5, grouping by exact SHA-256 + byte size, exclusion of inactive/superseded observations, independently bounded pagination for groups and members, persistent review decisions across reopen, invalidation upon changed membership, and rejection of invalid preferred locations and stale writes.
   - _Initial run_: Failed with `CURRENT_SCHEMA_VERSION was 4, expected >= 5; db.getDuplicateGroupMembers is not a function; db.setDuplicateReview is not a function`.
2. **IPC Duplicate Review Contracts & Validation**:
   - _Failing test_: [`tests/shared/ipc-duplicates-validation.test.ts`](file:///d:/organizer/tests/shared/ipc-duplicates-validation.test.ts) specified Zod validation for request/response schemas.
   - _Initial run_: Failed with `Cannot read properties of undefined (reading 'parse')`.
3. **Preload ContextBridge**:
   - _Failing test_: [`tests/preload/duplicate-bridge.test.ts`](file:///d:/organizer/tests/preload/duplicate-bridge.test.ts) specified exposure and IPC invoke validation of `getDuplicateGroups`, `getDuplicateGroupMembers`, `setDuplicateReview`.
   - _Initial run_: Failed with `api.getDuplicateGroups is not a function`.
4. **IPC Handlers & Security**:
   - _Failing test_: [`tests/main/duplicate-ipc.test.ts`](file:///d:/organizer/tests/main/duplicate-ipc.test.ts) specified sender authorization and rejection of untrusted frames for duplicate review channels.
   - _Initial run_: Failed with `no handler for undefined`.
5. **Renderer UI Integration**:
   - _Failing test_: [`tests/renderer/duplicate-ui.test.tsx`](file:///d:/organizer/tests/renderer/duplicate-ui.test.tsx) specified confirmed empty state, operation distinctions notice, member inspection cards with observation provenance, setting preferred location and marking as reviewed, stale error banners, and rapid selection race-condition prevention.
   - _Initial run_: Failed with `Unable to find element with text /no duplicate files found/i`.

### 2.8 Stage 3: Independent Review Findings Corrections (Red / Green / Refactor Evidence)

1. **Truly Bounded Database Queries**:
   - _Findings_: `getDuplicateGroups` and `getDuplicateGroupMembers` loaded all records into memory before applying `Array.slice`.
   - _Regression tests_: Added tests in [`tests/main/catalog-duplicates.test.ts`](file:///d:/organizer/tests/main/catalog-duplicates.test.ts) exercising complete deterministic pagination beyond page 1 for groups and members.
   - _Implementation_:
     - Implemented SQL-level pagination (`LIMIT ? OFFSET ?`) for `getDuplicateGroups` and `getDuplicateGroupMembers`.
     - Computed deterministic group signatures using bounded incremental streaming (`stmt.iterate`) with $O(1)$ memory.
     - Managed `_valid_reviewed_groups` SQLite temporary table for SQL-level filtering (`filter === 'all' | 'unreviewed' | 'reviewed'`) without materializing the catalog or all groups in JavaScript.
2. **Asynchronous Response Safety**:
   - _Findings_: `submitReview` applied response to whichever group was selected when resolving; requests inside React state updater functions; out-of-order filter/page/refresh responses.
   - _Regression tests_: Added test `keeps group B intact when saving group A resolves after selecting group B` in [`tests/renderer/duplicate-ui.test.tsx`](file:///d:/organizer/tests/renderer/duplicate-ui.test.tsx).
   - _Red evidence_: Initial run failed: group B had its status mutated to group A's reviewed status.
   - _Implementation_: Pure state updaters outside setter callbacks; selection token refs and `selectedGroupRef` guarding completions; group B retains its signature, review status, preferred location, and members.
3. **Member Errors and Changed/Unavailable Groups**:
   - _Findings_: `membersError` recorded by hook but never displayed; obsolete members displayed after failure/switching; groups falling below 2 members not treated as changed/unavailable.
   - _Regression tests_: Added tests for member error rendering with retry, obsolete member clearance, and single-member group unavailability in [`tests/renderer/duplicate-ui.test.tsx`](file:///d:/organizer/tests/renderer/duplicate-ui.test.tsx).
   - _Red evidence_: Initial run failed: error notice not rendered; review actions remained enabled for single-member group.
   - _Implementation_: Rendered accessible error with retry; immediate clearance of member list on selection change and failure; warning banner when group falls below 2 members; review action controls disabled when invalid or loading.
4. **Empty Filters and Truthful Messaging**:
   - _Findings_: Filter controls disappeared when filter returned 0 results, trapping users; claimed all files had unique content; out-of-range page after results shrink.
   - _Regression tests_: Added test `preserves filter controls and truthful messaging when filter returns zero results, allowing return to All`.
   - _Red evidence_: Initial run failed: filter buttons disappeared when switching to empty "Reviewed" filter.
   - _Implementation_: Filter controls remain visible and accessible in empty states; truthful messaging distinguishes "no groups match this filter" from "no currently verified duplicate groups"; auto-recovery from out-of-range pagination when results shrink.
5. **Preferred-Location Persistence**:
   - _Findings_: "Set as Preferred" only changed local state and required status toggle to save; local preference leaked across groups and refreshes.
   - _Regression tests_: Added unit and UI tests verifying immediate persistence on "Set as Preferred" and "Clear Preferred" without toggling status.
   - _Red evidence_: Initial run failed: `setDuplicateReview` not called immediately upon clicking preferred button.
   - _Implementation_: Removed unpersisted local state; "Set as Preferred" and "Clear" immediately persist to database with current review status; verified persistence across database close and real Electron application restart.

284:
285: ### 2.9 Stage 3: Independent Review Corrections (Pass 2: Constant Memory, Filter Refill, Request Invalidation)
286:
287: Following the second round of independent review on commit `c5da2f1`, four areas were addressed using failing behavioral regression tests before implementation:
288:
289: 1. **Truly Bounded Constant Memory Signature Computation & Decision Saving**:
290: - _Findings_: `computeGroupSignature` previously iterated rows but accumulated every member ID in a JavaScript `Set<number>`, which is $O(\text{group size})$ memory overhead. In `setDuplicateReview`, `membersSql.all()` and `.map().join()` were used across the entire group.
291: - _Regression test_: Added test in [`tests/main/catalog-duplicates.test.ts`](file:///d:/organizer/tests/main/catalog-duplicates.test.ts) spying on `rawDb.prepare` during `setDuplicateReview` and asserting that no `.all()` call is executed on member rows.
292: - _Red evidence_: Initial run failed: `expected [ Array(1) ] to have a length of +0 but got 1`.
293: - _Implementation_:
294: - Refactored `computeGroupSignature(sha256, byteSize, preferredLocationId?)` in [`src/main/services/catalog/database.ts`](file:///d:/organizer/src/main/services/catalog/database.ts) to stream member rows via `stmt.iterate` chunk-by-chunk into the SHA-256 hasher, tracking `memberCount` and a `containsPreferred` boolean in strictly $O(1)$ auxiliary JavaScript memory.
295: - Refactored `setDuplicateReview` to reuse `computeGroupSignature` to verify signature, group existence (memberCount >= 2), and preferred location membership with zero array/set materialization.
296: 2. **Filter & Count Consistency with Automatic Refilling**:
297: - _Findings_: `submitReview` updated list items locally without reapplying the active filter or updating `totalGroups`. Under a filtered view (e.g. `unreviewed`), marking a group `reviewed` left it in the view with stale counts.
298: - _Regression test_: Added test `removes group from unreviewed view and updates counts after marking as reviewed` in [`tests/renderer/duplicate-ui.test.tsx`](file:///d:/organizer/tests/renderer/duplicate-ui.test.tsx).
299: - _Red evidence_: Initial run failed: group remained visible in the unreviewed list and counts were not updated.
300: - _Implementation_:
301: - In [`src/renderer/src/hooks/useDuplicateReview.ts`](file:///d:/organizer/src/renderer/src/hooks/useDuplicateReview.ts), when a review status update results in `statusMatchesFilter === false`, triggers `fetchGroups` to purge the item, update `totalGroups`, and refill the page up to `groupsLimit`.
302: - Automatically recovers to previous page if the last item on a page is removed.
303: - Guards save completions against refreshed signatures (`groupSignature === targetSig`) and preserves user active navigation if the user moved to another group or filter while save was pending.
304: 3. **Request Generation Invalidation on Selection Clear, Filter Transitions, and Unmount**:
305: - _Findings_: Old member request responses could repopulate cleared selection state or trigger loading errors after selection was cleared; React state updaters contained side effects / ref mutations.
306: - _Regression test_: Added test `invalidates in-flight member requests when selection is cleared so deferred responses do not repopulate` and `ignores out-of-order group-list responses when switching filters rapidly` in [`tests/renderer/duplicate-ui.test.tsx`](file:///d:/organizer/tests/renderer/duplicate-ui.test.tsx).
307: - _Red evidence_: Initial run failed: deferred member resolution repopulated member list after selection was cleared.
308: - _Implementation_:
309: - Pure state updaters: synchronizer `useEffect` hooks maintain refs (`selectedGroupRef`, `groupsFilterRef`, `groupsOffsetRef`) cleanly outside setter callbacks.
310: - Invalidation tokens: `selectionTokenRef.current++` is synchronously incremented when selection is cleared (`nextSelected === null`), on filter transitions (`setFilter`), and on component unmount.
311: 4. **UI Preferred Location Clearing**:
312: - _Regression test_: Added test `clears preferred location through UI and calls setDuplicateReview with null` in [`tests/renderer/duplicate-ui.test.tsx`](file:///d:/organizer/tests/renderer/duplicate-ui.test.tsx).
313: - _Implementation_: Verified and exercised through UI tests and bridge tests; updated smoke check in [`scripts/smoke.mjs`](file:///d:/organizer/scripts/smoke.mjs) to include duplicate review bridge methods (`getDuplicateGroups`, `getDuplicateGroupMembers`, `setDuplicateReview`).
314:
315: ---
316:
317: ## 3. Verification Results
318:
319: ### 3.1 Test Suite & Skipped Test Analysis
320:
321: - **Implementation host**: **325 passed, 0 skipped** across all 16 test files.
322: - **Reviewer host on c5da2f1**: **319 passed, 1 skipped** across 16 test files.
323: - **Identified conditional test**: `tests/main/discovery.test.ts: it.runIf(canCreateRealJunction)('skips real directory junctions both as source roots and as nested entries without traversing outside the root')`.
324: - **Reason**: `probeRealJunctionSupport()` executes `symlinkSync(target, link, 'junction')` inside a `try / catch` block and returns `false` on any exception without inspecting the specific error. On environments where junction creation throws an exception, `canCreateRealJunction` evaluates to `false`, causing Vitest to skip this conditional test (producing 1 skipped). On environments where junction creation succeeds, all 21 tests in `discovery.test.ts` execute and pass.
325:
326: ### 3.2 Automated Quality Gates & Real-Process Verification
327:
328: Execution results on implementation host (`D:\organizer`):
329:
330: | Command | Result | Details |
331: | ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------- |
332: | `npm test` | **PASS** | 16 test files: 325 passed, 0 skipped repository-wide |
333: | `npm run typecheck` | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors) |
334: | `npm run lint` | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings) |
335: | `npm run format:check` | **PASS** | Prettier 100% compliant across entire repository |
336: | `npm run build` | **PASS** | `electron-vite` builds main (`index.js`, `catalog.js`, `jobs.js`), preload, renderer |
337: | `npm run build:unpack` | **PASS** | Packaged binary assembled into `dist/win-unpacked` with ASAR integrity |
338: | `npm run verify:sqlite` | **PASS** | Real Electron runtime exercises CatalogDatabase repository (8/8 checks) |
339: | `npm run verify:sqlite:unpacked` | **PASS** | Packaged ASAR catalog module exercised via unpacked binary (`Personal Vault.exe`) |
340: | `npm run verify:scan` | **PASS** | Real Electron runtime exercises scan workflow, IPC, crash & graceful recovery, digests (14/14) |
341: | `npm run verify:scan:unpacked` | **PASS** | Unpacked desktop binary exercises scan workflow, IPC, crash & graceful recovery (14/14) |
342: | `npm run verify:duplicates` | **PASS** | Real Electron runtime exercises duplicate grouping, review, restart, & invalidation (18/18) |
343: | `npm run verify:duplicates:unpacked` | **PASS** | Unpacked desktop binary exercises duplicate grouping, review, restart, & invalidation (18/18) |
344: | `npm run smoke:built` | **PASS** | Built desktop shell passes bridge and navigation smoke checks in real Electron |
345: | `npm run smoke:unpacked` | **PASS** | Unpacked desktop binary (`dist/win-unpacked`) passes bridge and navigation smoke checks |

---

## 4. Known Limitations & Boundaries

- **Review Decisions are Catalog Annotations Only**: Marking a duplicate group as reviewed or selecting a preferred location records metadata in the `duplicate_reviews` SQLite table. It does not copy, move, alter, or delete any source files, nor does it remove entries from the catalog index.
- **Decision Invalidation Policy**: If a member file is modified, deleted, or added out of band or via a scan, the group's deterministic signature changes. The catalog invalidates any existing review decision for that group upon query, reverting status to `unreviewed` with `hasStaleDecision = true`, and clears invalid preferred locations. Outdated client submissions are rejected with `StaleReviewError`.
- **Out of Scope for Stage 3**:
  - Vault storage initialization, verified copying, and manifests are deferred to Stage 4.
  - Source file deletion and catalog-index removal are distinct operations and are not implemented.
  - Photo grid thumbnails, virtualized browsing, ratings, and visual similarity review are deferred to Stage 5.
  - OCR, semantic search, and document classification are deferred to Stage 6 and Stage 7.
- **Source Preservation Invariance**: Originals remain strictly read-only. Personal Vault performs no file moves, writes, edits, or deletes on source roots.

---

## 5. Immediate Recommended Next Task

**Independent review of Stage 3 (Exact duplicate grouping and review) on `feat/stage-3-duplicate-review`. Do not push, merge, or begin Stage 4.**
