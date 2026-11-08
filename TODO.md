# Personal Vault — Roadmap & Staged Status (TODO.md)

This roadmap documents the staged implementation plan for Personal Vault (`personal-vault`).

---

## Stage 1: Engineering Foundation and Desktop Shell

Status: **complete; independent review accepted at `070e3cb`** (see HANDOFF.md for evidence).

Acceptance criteria: runnable Electron/React shell with isolated main/preload/renderer; sandboxed preload that actually executes; validated IPC; restricted navigation; honest loading/error/empty states; passing test, typecheck, lint, format, build, packaging, and real-Electron smoke checks.

- [x] Version control initialized with `feat/stage-1-foundation` branch.
- [x] Git ignores configured for build artifacts, local data, databases, and secrets.
- [x] Project architecture and standing engineering documents created (`AGENTS.md`, `ARCHITECTURE.md`, `TODO.md`, `HANDOFF.md`, `README.md`).
- [x] Multi-process architecture scaffolded (Electron main, preload, renderer, shared contracts).
- [x] Process security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP, single trusted navigation location, popups denied.
- [x] Strict TypeScript configuration enabled across Node and Web targets.
- [x] Typed IPC bridge; every response (including acknowledgements) validated; senders validated in main.
- [x] Sandboxed preload bundles its dependencies (verified by real-process smoke in dev, built, and unpacked modes).
- [x] Electron on a supported major (45.2.3).
- [x] Shell with five views, search area, and distinct loading / error / confirmed-empty states.
- [x] Behavioral tests (Vitest + Testing Library) for navigation policy, IPC sender checks, preload validation, and UI states.
- [x] Quality gates and smoke checks passing (results in HANDOFF.md).
- [x] ESLint rules configured (@eslint/js, typescript-eslint, react-hooks) and verified with in-memory / stdin enforcement demonstrations; genuine warnings addressed.
- [x] Dependency vulnerabilities triaged (10 initial advisories analyzed; safe targeted updates applied for vitest, zod, and minimatch override; fresh audit: 0 vulnerabilities).
- [x] Independent re-review of the Stage 1 correction pass accepted at `070e3cb`.

---

## Stage 2: Read-Only Discovery, Metadata Inventory, and Resumable Scan Jobs

Status: **complete; independent review accepted at `71e1af7`** (see HANDOFF.md).

Verification: implementation host **276 passed, 0 skipped** across all 11 test files, with strict typecheck, lint, formatting, production build, real Electron smoke checks (built, unpacked), Electron SQLite repository verification (`verify:sqlite`), unpacked ASAR package verification (`verify:sqlite:unpacked`), and Electron scan workflow verification in built and unpacked modes (`verify:scan`, `verify:scan:unpacked`) passed.

- [x] **Stage 2A**: Read-only filesystem scanning adapter (`ReadOnlyFsAdapter` exposing only `lstat`, `realpath`, `opendir`) for explicit caller-supplied roots.
- [x] **Stage 2A**: Incremental streaming (`scanSourceRoots`) with consumer backpressure, $O(1)$ `BoundedFifoQueue`, validated resource limits (`resolveDiscoveryLimits` enforcing positive safe integers for `maxPendingDirectories`, `maxVisitedDirectories`, and collector-only `maxCollectedRecords`), `O(1)` open directory handles, and `AbortSignal` cancellation with deterministic handle cleanup.
- [x] **Stage 2A**: Shared root, child, and pre-`opendir` queued directory validation (`inspectDirectoryTarget`) and file-candidate inspection (`inspectFileEntry`), plus symlink/junction skipping (with sandbox-aware real junction probing and deterministic adapter tests).
- [x] **Stage 2A**: Configurable candidate photo/document extension policy (including `.md` and `.txt`) with documented source-root and subdirectory exclusion precedence (`excludedPaths` including ancestor exclusions > `excludedDirectoryNames` > `softwareClutterDirectoryNames` > `hiddenAndSystemNames` / dot-entries).
- [x] **Stage 2A**: Factual filesystem metadata inventory (original path, filename, extension, byte size, honest nullable creation and modification times) and verified source preservation.
- [x] **Stage 2A**: Independent review accepted at `5dd6320`.
- [x] **Stage 2B**: Read-only streaming SHA-256 content hashing (`hashFile`, bounded chunked reads, mandatory non-empty approved roots, sub-ms timestamp precision, post-read pathname revalidation, handle close failure reporting, AbortSignal cancellation, and deterministic cleanup).
- [x] **Stage 2B**: Independent review accepted at `e4488a2`.
- [x] **Stage 2C**: SQLite catalog schema for recorded file facts and inventory persistence (`CatalogDatabase`, `node:sqlite` driver, explicit caller-supplied paths, versioned migrations, foreign key cascades, normalized lookup keys vs. verbatim original paths, honest nullable timestamps, immutable discovery observations with changed-file history preservation and hash invalidation, immutable recorded metadata conflict policy, bounded paginated reads, deterministic connection cleanup). Independent review accepted at `a674f9c`.
- [x] **Stage 2D**: Resumable background scan jobs, SQLite job state & checkpoint persistence (migrations 3 & 4 `scan_jobs`, `scan_job_errors`, `scan_job_files`, and dismissal), pause/resume, cancellation, restart crash recovery (`markRunningJobsAsInterrupted`), out-of-band changed file revalidation, visible error lists, typed IPC contracts with bidirectional Zod validation and sender authorization, accessible renderer controls with progress indicators, terminal result restoration and dismissal, platform-correct root containment and single traversal, bounded SQLite job-membership discovery deduplication, and verified source preservation. Independent review accepted at `71e1af7`.

---

## Stage 3: Exact Duplicate Grouping and Review Workflow

Status: **complete; independent code review accepted at `79bbf44`** (see HANDOFF.md).

Verification: implementation host **326 passed, 0 skipped** across all 16 test files (reviewer host 325 passed, 1 skipped on `79bbf44` due to environment platform junction probe in `discovery.test.ts`), with strict typecheck, lint, formatting, production build, unpacked build, real Electron SQLite repository checks (`verify:sqlite`, `verify:sqlite:unpacked`), scan workflow checks (`verify:scan`, `verify:scan:unpacked`), isolated-fixture real Electron duplicate review checks (`verify:duplicates`, `verify:duplicates:unpacked` — 18/18 checks passed, exit code 0), and real Electron smoke checks in built and unpacked modes (`smoke:built`, `smoke:unpacked`) passed. Reviewer runtime limitation noted: window connection timeout in reviewer environment (`lastError="fetch failed"`, `lastTargets=null`).

- [x] Exact duplicate grouping by current verified SHA-256 AND byte size across distinct original paths, preserving all differing metadata.
- [x] Schema Migration 5: `duplicate_reviews` table for persistent review annotations (`reviewed`/`unreviewed`, optional `preferred_location_id`, `group_signature`).
- [x] Invalidation policy & stale write detection: deterministic `groupSignature` based on active member IDs, discovery IDs, and hash IDs; automatic invalidation when membership, content, or observations change; stale write rejection via `StaleReviewError`.
- [x] Truly bounded SQL queries & constant-memory processing: SQL-level pagination (`LIMIT ? OFFSET ?`) for duplicate groups and member records; incremental streaming traversal (`stmt.iterate`) with strictly $O(1)$ auxiliary memory (no Set or array accumulation) for signature computation and review saving; `_valid_reviewed_groups` temp table for SQL-level filtering without materializing the catalog or all groups in JavaScript.
- [x] Side-by-side inspection view in Duplicates tab displaying filenames, absolute paths, byte sizes, filesystem creation/modification dates, and hash observation provenance with verification timestamp and observation ID. Recorded facts strictly separated from inferred metadata; explicit unknown values.
- [x] Asynchronous response safety & filter consistency: selection-bound review submissions preventing cross-group mutations; pure React state updaters without side effects or ref mutations inside updater callbacks; filter refill upon status transitions with auto-recovery from out-of-range pages; monotonic request tokens invalidated on selection clearing, filter changes, and unmount.
- [x] Accessible member error reporting with retry, obsolete member clearance on selection/failure, and changed/unavailable handling when a group falls below two verified members with review actions safely disabled.
- [x] Truthful empty filter states with permanent filter controls (`All`, `Unreviewed`, `Reviewed`) and auto-recovery from out-of-range pagination when results shrink.
- [x] Explicit immediate preferred-location persistence and clearing through UI without status toggles, surviving restart and avoiding local state leaks.
- [x] Explicit presentation distinguishing catalog removal, vault copy deletion, and source deletion as separate operations (none implemented).
- [x] Narrow typed IPC channels (`DUPLICATES_GET_GROUPS`, `DUPLICATES_GET_MEMBERS`, `DUPLICATES_SET_REVIEW`) with bidirectional Zod validation and top-level sender authorization.
- [x] Isolated-fixture verification script (`scripts/verify-electron-duplicate-review.mjs`) exercising scan-generated groups, member inspection, review decisions, preferred location without status toggle, persistence across restart, invalidation on modified-file rescan, stale write rejection, and source preservation invariance in real Electron and unpacked binary.

---

## Stage 4: Verified Vault Copying and Portable Metadata

Status: **complete; independent review accepted at `1a1fb69`** (see HANDOFF.md for evidence).

Verification: implementation host & independent review verification **421 passed across 23 test files** (exit code 0), with strict typecheck (exit code 0), ESLint (exit code 0), Prettier formatting check (exit code 0), production bundle build (exit code 0), unpacked desktop binary build (exit code 0), real Electron verified vault import in built and unpacked modes (`verify:vault`, `verify:vault:unpacked` — 11/11 checks passed each, exit code 0), duplicate review (`verify:duplicates` — 18/18 checks passed, exit code 0), scan workflow (`verify:scan` — 14/14 checks passed, exit code 0), SQLite catalog (`verify:sqlite` — 8/8 checks passed, exit code 0), real Electron smoke checks in built and unpacked modes (`smoke:built`, `smoke:unpacked` — passed, exit code 0), and source preservation invariance confirmed across all checks.

- [x] Vault storage directory initialization and identification (`vault.json` identity manifest with versioning, name, UUID, and creation timestamp). Conflicting or invalid existing identity files are rejected without modification (`VaultInitializationError`).
- [x] Source/vault separation and overlap validation with canonical `realpath` containment checks rejecting symlink/junction escapes.
- [x] Verified copy pipeline (`copyAndVerifyFileToVault`): current source contents stream-hashed and descriptor stability verified on EVERY path (including shortcuts); destination integrity verified independently.
- [x] Internal vault containment (`assertPathContainedInVault`): canonical realpath containment and segment-by-segment `lstat` traversal checking rejecting symlinks and Windows directory junctions in `files/`, content directories, `.vault-temp/`, identity files, manifests, and destinations.
- [x] Strict overwrite prevention: atomic `COPYFILE_EXCL` publication; unmanaged matching destination collisions rejected; owned staging file cleanup with `pv_staging_${vaultId}_` prefix.
- [x] Content-addressed vault storage (`files/<prefix>/<sha256>/<safeName>`) with safe collision handling and deduplicated storage for duplicate content.
- [x] Portable metadata manifests (`manifest.json` sidecars) strictly validated with Zod (`VaultManifestSchema`), preserving multi-source provenance, actual recorded catalog facts (`firstDiscoveredAtMs`, `lastSeenAtMs`, `hashVerifiedAtMs`, `discoveryObservationId`), explicit `null`s for missing capture dates/locations, separate from review decisions, corrupt manifests throw `VaultManifestCorruptedError`, fully recoverable without SQLite.
- [x] Safe publication and crash recovery: atomic directory publication using `.pv_in_progress_${vaultId}_${jobId}.json` markers, strictly non-overwriting collision checks with `COPYFILE_EXCL` fallback, and deterministic in-progress marker recovery for interrupted jobs.
- [x] Resumable import coordinator (`VaultImportCoordinator`) with exact job-scope preservation via `getVaultImportItems`, observation currency revalidation (`isDiscoveryCurrent`, `isHashActive`), bounded queries without 1,000-candidate cutoffs, concurrency locking on start and resume, pause, resume, cooperative cancellation via `AbortSignal`, restart recovery (`interrupted` status), truthful completion status (`failed` when all items fail), and prompt IPC acknowledgment.
- [x] SQLite catalog schema expansion (Migration 6) adding `vaults`, `vault_copies`, `vault_imports`, and `vault_import_items` tables with audit trail.
- [x] Narrow typed IPC channels (`VAULT_*`) with strict bidirectional Zod validation (`ResumeImportRequestSchema`, `CancelImportRequestSchema`, `PauseImportRequestSchema`) and top-level sender authorization.
- [x] Accessible renderer UI (`VaultImportPanel`) with functional "Change Vault", candidate pagination beyond 100 items, monotonic request token, selection clearing on filter/page change, real-time progress bar, pause/resume/cancel controls, interrupted job recovery alert, truth-aligned banners (no "Verified Success" for failures), and operations distinction notice.
- [x] Isolated-fixture verification script (`scripts/verify-electron-vault-import.mjs`) exercising vault initialization, overlap rejection, candidate queries, verified copying, duplicate content manifest merging, idempotency, modified source rejection, active cancellation during copying, restart recovery & resume, and source preservation invariance across real Electron built and unpacked modes.

---

## Stage 5: Cached, Virtualized Photo Browsing; Ratings and Similarity Review

Status: **in progress; Substage 5A awaiting review.**

Verification (Substage 5A): implementation host **491 passed, 0 skipped** across all 31 test files (exit code 0), strict typecheck across Node and Web targets (exit code 0), ESLint clean pass (exit code 0), Prettier formatting clean pass (exit code 0), production bundle build (exit code 0), unpacked binary build (exit code 0), real Electron photo verification suite in built and unpacked modes (`verify:photos`, `verify:photos:unpacked` — 19/19 checks passed each, exit code 0, 10,000-photo scale test exercising actual Photos UI with real decodable image files and recorded actual fixture timestamps, cold scroll, warm reversal with frame interval p95 4.30 ms vs. 33 ms bound across 786 [built] / 768 [unpacked] rAF samples, continuous main process event-loop delay inside main p95 57.38 ms [built] / 52.20 ms [unpacked] vs. 100 ms bound, renderer-to-main IPC round-trip latency p95 70.38 ms [built] / 64.32 ms [unpacked], distant jumps, return to evicted pages with verified image loading [complete && naturalWidth > 0] and cell association at each checkpoint, terminating worker capacity counting ensuring live workers never exceed 2, active and queued cancellation capacity recovery, deterministic publication interruption observed at boundary with clean recovery, new decode, and subsequent cache reuse, hardened cache root/ancestor containment and dynamic separation validation, and 0 re-decodes on cache reuse proven via diagnostics), real Electron duplicate review (`verify:duplicates` — 18/18 checks passed, exit code 0), scan workflow (`verify:scan` — 14/14 checks passed, exit code 0), verified vault import in built and unpacked modes (`verify:vault`, `verify:vault:unpacked` — 11/11 checks passed each, exit code 0), SQLite catalog repository (`verify:sqlite` — 8/8 checks passed, exit code 0), real Electron smoke checks in built and unpacked modes (`smoke:built`, `smoke:unpacked` — passed, exit code 0), and source preservation invariance confirmed across all operations.

### Substage 5A: Bounded Thumbnail Generation, Disposable Cache, and Virtualized Photo Browsing

- [x] Responsive virtualized photo thumbnail grid adhering to dark theme token system with stable deterministic ordering by catalog location ID (`file_locations.id ASC`).
- [x] Pure SQL pagination (`LIMIT ? OFFSET ?`) for photo catalog records without full-table materialization in memory.
- [x] Offline image decoding with Sharp 0.35.5 (libvips 8.18.7) isolated in real Node worker threads (`worker_threads.Worker`) outside main event loop with termination on timeout, cancellation, or shutdown without leaking concurrency capacity.
- [x] Large-collection browsing: virtual grid retains absolute collection scroll extent (`totalCount`) and positions, with sliding LRU page cache bounded to 2,000 records (40 pages of 50 items), mounted DOM cells bounded to <= 200, allowing distant jumps (e.g. to photo 7,500) and return to evicted pages without duplicates, gaps, or scroll jumps.
- [x] Concurrency and resource bounds strictly enforced: max 2 active jobs, max 64 queued jobs with priority for visible cells, 15-second per-job timeout, max 128 MiB source size (enforced before and during streaming read), max 100 megapixels input limit.
- [x] Format support matrix verified: JPEG, PNG, WebP, GIF (frame 0), AVIF, TIFF with automatic EXIF orientation preservation (`.rotate()`).
- [x] Honest placeholders: Apple HEIC/HEIF (due to prebuilt libvips libheif lacking unbundled HEVC decoders), camera RAW, SVG, corrupted or oversized inputs return honest unsupported/error status cards without crashes or external toolchains.
- [x] Secure disposable disk cache in `<userData>/thumbnails/`: cache key bound to source identity (`locationId`/`normalizedPath`) for unhashed files so files with identical size/mtime never collide; canonical separation rejecting overlap with source roots or active vault; symlink/junction redirection rejected; WebP header and image decode integrity validated via `validateWebPIntegrity` (corrupt pseudo-WebP headers rejected, unlinked, and regenerated); oversized entries rejected before reading or allocating contents; pre-allocation capacity reservation before staging/publication (`reserveCapacity`); abandoned staging cleanup on startup and shutdown; source byte cap enforced during reading.
- [x] Residual out-of-band source modification detection (`statSync` check on cache hits) preventing stale image display.
- [x] Stale renderer response protection: monotonic generation counter incremented on refresh and unmount; revision-bound in-flight request tracking ensuring older delayed completions cannot overwrite newer cells or delete newer request bookkeeping.
- [x] Narrow typed IPC channels (`photos:get-page`, `photos:get-thumbnail`, `photos:cancel-thumbnail`, `photos:get-diagnostics`) with bidirectional Zod validation and top-level sender authorization.
- [x] Compact metadata details panel displaying filename, absolute source path, recorded byte size, recorded filesystem timestamps, and observation provenance, with explicit "Unknown" for absent capture dates/locations (no fabricated dates).
- [x] Header search input disabled with clear Stage 6 availability label in Photos tab.
- [x] Comprehensive verification suite in built and unpacked modes (`scripts/verify-electron-photos.mjs`, `verify:photos`, `verify:photos:unpacked`) with 19/19 checks passed: 10,000-photo scale test exercising actual Photos UI with real decodable image files and actual fixture timestamps, cold scrolling, warm reversal, distant jumps, return to evicted pages with verified image loading (`complete && naturalWidth > 0`) matched to expected cells and zero pending/error cards at each checkpoint, true `requestAnimationFrame` frame interval p95 measurement (4.30 ms <= 33 ms target) continuously sampled across the scroll workload, continuous main process event-loop delay measurement inside main (p95 57.38 ms [built] / 52.20 ms [unpacked] <= 100 ms limit), terminating worker capacity counting ensuring live workers never exceed 2, real active/queued cancellation capacity recovery, deterministic publication interruption observed at boundary with clean restart, new decode, and subsequent cache reuse, hardened cache root/ancestor containment and dynamic separation validation, and 0 re-decodes on cache reuse proven via diagnostics.
- [x] Source preservation invariance verified: original source bytes, sizes, and timestamps remain completely untouched.

### Substage 5B: Ratings, Flags, and Custom Collections (Planned)

- [ ] User review tools: flags, 1–5 star ratings, and custom collections.

### Substage 5C: Visual Similarity Review (Planned)

- [ ] Perceptual hashing and visual similarity review (distinguishing edited copies from similar photos).

---

## Stage 6: Semantic Photo Search and Metadata Filters

- [ ] Local offline embedding model evaluation and selection.
- [ ] Semantic query vector generation and search indexing.
- [ ] Metadata filter controls (capture date range, camera model, lens, resolution, file type).

---

## Stage 7: Document Extraction, Classification, OCR, and Unified Search

- [ ] Text extraction from common document formats (`.pdf`, `.docx`, `.txt`, `.md`, `.csv`).
- [ ] Local offline OCR pipeline for scanned documents and document photos.
- [ ] Purpose-based document classifier (`personal`, `software_project`, `application_system`, `legal`, `lists`, `instructions`, `receipts`, `recipes`).
- [ ] Software clutter filter avoiding exclusion of valuable markdown or text notes.
- [ ] Unified multi-modal search across photos and documents.

---

## Stage 8: Sharing/Export, Recovery, Packaging, and Acceptance Testing

- [ ] Selective export bundles with preserved metadata sidecars.
- [ ] Catalog recovery from vault manifests.
- [ ] Cross-platform installers and production packaging verification.
- [ ] End-to-end acceptance testing on large test datasets.
