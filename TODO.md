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

Status: **complete; Substages 5A, 5B, and 5C independently accepted at `951fd25`, `4071948`, and `543135a`.**

Verification (Substage 5A): reviewer verification passed at `951fd25`: **503 passed, 0 skipped** across all 31 test files (exit code 0), all 15 required verification commands exit code 0, strict typecheck across Node and Web targets (exit code 0), ESLint clean pass (exit code 0), Prettier formatting clean pass (exit code 0), production bundle build (exit code 0), unpacked binary build (exit code 0), real Electron photo verification suite in built and unpacked modes (`verify:photos`, `verify:photos:unpacked` — 19/19 checks passed each, exit code 0, 10,000-photo scale test exercising actual Photos UI with real decodable image files and recorded actual fixture timestamps, cold scroll, warm reversal with frame interval p95 4.30 ms vs. 33 ms bound across 584 [built] / 599 [unpacked] rAF samples, continuous main process event-loop delay inside main p95 35.91 ms [built] / 44.40 ms [unpacked] vs. 100 ms bound, renderer-to-main IPC round-trip latency p95 28.39 ms [built] / 61.78 ms [unpacked], distant jumps, return to evicted pages with verified image loading [complete && naturalWidth > 0] and cell association at each checkpoint, terminating worker capacity counting ensuring live workers never exceed 2, active and queued cancellation capacity recovery, deterministic publication interruption observed at boundary with clean recovery, new decode, and subsequent cache reuse, hardened cache root/ancestor containment and dynamic separation validation, and 0 re-decodes on cache reuse proven via diagnostics), real Electron duplicate review (`verify:duplicates` — 18/18 checks passed, exit code 0), scan workflow (`verify:scan` — 14/14 checks passed, exit code 0), verified vault import in built and unpacked modes (`verify:vault`, `verify:vault:unpacked` — 11/11 checks passed each, exit code 0), SQLite catalog repository (`verify:sqlite` — 8/8 checks passed, exit code 0), real Electron smoke checks in built and unpacked modes (`smoke:built`, `smoke:unpacked` — passed, exit code 0), and source preservation invariance confirmed across all operations. Reviewer-host evidence recorded distinctly from other hosts' results; HEIC/RAW limitations and documented environmental uncertainty retained.

### Substage 5A: Bounded Thumbnail Generation, Disposable Cache, and Virtualized Photo Browsing

- [x] Responsive virtualized photo thumbnail grid adhering to dark theme token system with stable deterministic ordering by catalog location ID (`file_locations.id ASC`).
- [x] Pure SQL pagination (`LIMIT ? OFFSET ?`) for photo catalog records without full-table materialization in memory.
- [x] Offline image decoding with Sharp 0.35.5 (libvips 8.18.7) isolated in real Node worker threads (`worker_threads.Worker`) outside main event loop with termination on timeout, cancellation, or shutdown without leaking concurrency capacity.
- [x] Large-collection browsing: virtual grid retains absolute collection scroll extent (`totalCount`) and positions, with sliding LRU page cache bounded to 2,000 records (40 pages of 50 items), mounted DOM cells bounded to <= 200, allowing distant jumps (e.g. to photo 7,500) and return to evicted pages without duplicates, gaps, or scroll jumps.
- [x] Concurrency and resource bounds strictly enforced: max 2 active jobs, max 64 queued jobs with priority for visible cells, 15-second per-job timeout, max 128 MiB source size (enforced before and during streaming read), max 100 megapixels input limit.
- [x] Format support matrix verified: JPEG, PNG, WebP, GIF (frame 0), AVIF, TIFF with automatic EXIF orientation preservation (`.rotate()`).
- [x] Honest placeholders: Apple HEIC/HEIF (due to prebuilt libvips libheif lacking unbundled HEVC decoders), camera RAW, SVG, corrupted or oversized inputs return honest unsupported/error status cards without crashes or external toolchains.
- [x] Secure disposable disk cache in `<userData>/thumbnails/`: cache key bound to source identity (`locationId`/`normalizedPath`) for unhashed files so files with identical size/mtime never collide; canonical separation rejecting overlap with source roots or active vault; symlink/junction redirection rejected; WebP header and image decode integrity validated via `validateWebPIntegrity` in worker threads (corrupt pseudo-WebP headers rejected, unlinked, and regenerated); oversized entries rejected before reading or allocating contents; pre-allocation capacity reservation before staging/publication (`reserveCapacity`) accounting for existing target and staging bytes during replacement writes; put operations serialized to eliminate concurrent write budget races; atomic publication with asynchronous operations, nonblocking backoff retry, and immediate abort on shutdown; abandoned staging cleanup on startup and shutdown; source byte cap enforced during reading.
- [x] Residual out-of-band source modification detection (`statSync` check on cache hits) preventing stale image display.
- [x] Stale renderer response protection: monotonic generation counter incremented on refresh and unmount; revision-bound in-flight request tracking ensuring older delayed completions cannot overwrite newer cells or delete newer request bookkeeping.
- [x] Narrow typed IPC channels (`photos:get-page`, `photos:get-thumbnail`, `photos:cancel-thumbnail`, `photos:get-diagnostics`) with bidirectional Zod validation and top-level sender authorization.
- [x] Compact metadata details panel displaying filename, absolute source path, recorded byte size, recorded filesystem timestamps, and observation provenance, with explicit "Unknown" for absent capture dates/locations (no fabricated dates).
- [x] Header search input disabled with clear Stage 6 availability label in Photos tab.
- [x] Comprehensive verification suite in built and unpacked modes (`scripts/verify-electron-photos.mjs`, `verify:photos`, `verify:photos:unpacked`) with 19/19 checks passed: 10,000-photo scale test exercising actual Photos UI with real decodable image files and actual fixture timestamps, cold scrolling, warm reversal, distant jumps, return to evicted pages with verified image loading (`complete && naturalWidth > 0`) matched to expected cells and zero pending/error cards at each checkpoint, true `requestAnimationFrame` frame interval p95 measurement (4.30 ms <= 33 ms target) continuously sampled across the scroll workload, continuous main process event-loop delay measurement inside main (p95 57.38 ms [built] / 52.20 ms [unpacked] <= 100 ms limit), terminating worker capacity counting ensuring live workers never exceed 2, real active/queued cancellation capacity recovery, deterministic publication interruption observed at boundary with clean restart, new decode, and subsequent cache reuse, hardened cache root/ancestor containment and dynamic separation validation, and 0 re-decodes on cache reuse proven via diagnostics.
- [x] Source preservation invariance verified: original source bytes, sizes, and timestamps remain completely untouched.

### Substage 5B: Ratings, Flags, and Custom Collections

Status: **complete; independent review accepted at `4071948`** (see HANDOFF.md for evidence).

Verification: independent review verification passed at `4071948`: 657 passed across 52 test files (exit code 0), all 17 required verification commands exit code 0, strict typecheck across Node and Web targets (exit code 0), ESLint (exit code 0), Prettier formatting check (exit code 0), production bundle build (exit code 0), unpacked binary build (exit code 0), real Electron photo review verification in built and unpacked modes (`verify:photo-review`, `verify:photo-review:unpacked` — 12/12 checks passed each, exit code 0), photo browsing verification (`verify:photos`, `verify:photos:unpacked` — 19/19 checks passed each, exit code 0), duplicate review (`verify:duplicates` — 18/18 checks passed, exit code 0), scan workflow (`verify:scan` — 14/14 checks passed, exit code 0), SQLite catalog (`verify:sqlite` — 8/8 checks passed, exit code 0), verified vault import in built and unpacked modes (`verify:vault`, `verify:vault:unpacked` — 11/11 checks passed each, exit code 0), real Electron smoke checks in built and unpacked modes (`smoke:built`, `smoke:unpacked` — passed, exit code 0), and source preservation invariance confirmed across all checks.

- [x] Review findings corrections:
  - Accurate pending persistence tracking & lifecycle: pending journal finalization is tracked with unique per-invocation identities and monotonic generation counters (`mutationGenRef`) across ratings, flags, collection changes, and memberships. Outcomes are recorded independently of selection, photo revision, and stale presentation-response guards (so a save for photo A completing after navigating to B registers its unresolved operation while keeping obsolete badges and status updates guarded). Memory bounds employ an honest overflow policy (`overflowCount`) so capacity limits cannot silently forget unresolved work or report a false all-saved state. Reconciliation snapshots and clears only the operation generations actually covered (`gen <= coveredGen`), preserving newer unresolved operations added mid-flight until reconciled in turn without repeating mutations. React state updaters remain strictly pure without mutating refs.
  - Same-photo revision and response guards: selection generation is keyed by photo ID and content revision (`${photo.id}:${computePhotoRevision(photo)}`). Content replacement advances generation, resets save state, reloads memberships, and drops delayed in-flight responses before updating DOM badges or active star buttons.
  - Canonical journal overlap with safe ancestor policy: journal storage, source roots, and vault paths are canonicalized via realpath with ancestor traversal for missing subpaths (`canonicalizeWithAncestorPolicySync` / `Async`), detecting symlinks and Windows directory junctions and failing closed with `JournalSecurityError` when safety cannot be established.
  - Propagate `persistencePending` through the entire UI: committed-in-SQLite but journal-pending mutations (ratings, flags, collection create/rename, membership add/remove) display an honest pending status banner and retry control invoking `photos:reconcile-journal` without re-executing already committed database transactions.
  - Bounded pagination/reconciliation: collection and membership lists navigate via bounded 50-item pages with Prev/Next controls, absolute offsets, and page indicators; SQLite `reconcileJournalWithDatabase()` streams unterminated operations via bounded iterator (`stmt.iterate()`) without array accumulation.
  - Comprehensive stale-response guards: `updatePhotoLocal` guarded by per-photo mutation sequence counter, selection generation, and photo revision; membership loads guarded by request identity and selection generation; unmount invalidation.
  - Runtime journal security: lists all registered source roots without 1,000-item cap via `catalog.getAllSourceRoots()`; fails closed if security context cannot be obtained; canonical platform-correct path normalization; ensures source and vault security context is available before journal startup repair and revalidated on subsequent mutations.

- [x] Photo ratings: unrated (null) or 1–5 stars with toggle/clearing, optimistic UI updates, and monotonic version increments.
- [x] Review flags: mutually exclusive None, Pick, Reject. Reject is strictly a review annotation; source photographs and vault copies are never touched, altered, moved, or deleted.
- [x] Custom collections: create (1–80 chars, trimmed, no control characters, case-insensitive unique constraint), accessible rename, add photo membership with revision verification, and remove membership. Removing membership alters organization metadata only.
- [x] Pure SQL filtering before pagination: Rating filter (`all`, `unrated`, `1`..`5` stars), Flag filter (`all`, `none`, `pick`, `reject`), and Collection filter (`all` or selected collection ID), combined with `AND` in SQL.
- [x] Out-of-filter edit handling: editing rating or flag under an active filter immediately updates the item, smoothly removes it from the filtered view, clears/updates selection, and refills the grid from the next matching database record.
- [x] Explicit "Reset filters" action returning directly to unfiltered browsing.
- [x] Two-phase journal/SQLite recoverable protocol: fsync before commit, SQLite commit with `journal_operations` tracking, and startup reconciliation (`reconcileJournalWithDatabase`) resolving dangling transactions via `op_committed` or `op_aborted`.
- [x] Safe, bounded journal recovery: 64KB chunk buffer reading, strict sequence validation, interior corruption detection preserving file content, and safe truncation of torn final records at EOF with awaited sync.
- [x] Strict containment and ownership: recursive ancestor symlink/junction detection, forbidden overlap checking against source and vault paths, and exclusive marker creation with `wx` (`.pv_annotations_owner`).
- [x] Concurrency and rescan reconciliation: annotations bound to location and content revision (`rev:<discoveryId>:<byteSize>:<mtime>:<hash>`); unchanged rescan preserves annotations; touched with identical verified hash preserves; changed content invalidates active annotation and collection memberships while preserving prior history. Stale writes rejected atomically with conflict errors (`STALE_REVISION`, `STALE_ANNOTATION_VERSION`).
- [x] Renderer selection concurrency guarding: monotonic `selectionGenRef` and `prevSelectedPhotoIdRef` preventing rapid selection switches from leaking save status, errors, or filter evictions to newly selected photos; accessible rename controls (`Rename collection {name}`, input `New name for collection {name}`, Save, Cancel).
- [x] Comprehensive real Electron verification suite in built and unpacked modes (`scripts/verify-electron-photo-review.mjs`, `verify:photo-review`, `verify:photo-review:unpacked` — 12/12 checks passed each, exit code 0).
- [x] Source preservation invariance verified: original source bytes, sizes, and timestamps remain completely untouched across all tests (including rejected items).

### Substage 5C: Visual Similarity Review

Status: **complete; independent re-review accepted at `543135a`** (see HANDOFF.md). Earlier candidate `3ea3454` failed review on `npm run typecheck`; corrected in `543135a`. Reviewer-reported: 733 tests across 61 files, all 19 commands exit 0, `verify:similarity` and `verify:similarity:unpacked` 8/8 each. Algorithm limits retained; similarity scores are machine suggestions distinct from explicit user classifications.

Design & Numerical Resource Bounds:

- Module separation:
  - `src/main/services/similarity/fingerprint.ts`: Deterministic versioned perceptual fingerprinting (`dhash64_v1`, 64 bits, 9x8 grayscale) and Hamming distance comparison outside Electron main.
  - `src/main/services/similarity/candidate-search.ts`: Indexed/partitioned candidate search using 4x16-bit bucket sub-keys avoiding all-pairs comparisons, with candidate caps against dense similarity.
  - `src/main/services/similarity/coordinator.ts`: Resumable background analysis orchestrator (`SimilarityCoordinator`), snapshotting authorized job scope in `similarity_job_items`, tracking truthful progress, cancellation, unsupported/error counts, and restart recovery.
  - `src/main/services/catalog/migrations.ts` (Migration 8): Tables for `photo_perceptual_hashes`, `similarity_candidate_pairs`, `similarity_decisions`, `similarity_jobs`, and `similarity_job_items`.
  - `src/main/services/annotations/journal.ts`: Durable portable persistence of `similarity_decision` records with two-phase commit, fsync durability, and bounded startup reconciliation.
  - `src/shared/contracts/channels.ts` & `src/shared/validation/ipc-schemas.ts`: Narrow typed IPC contracts with bidirectional Zod validation and top-level sender checks.
  - `src/renderer/src/components/SimilarityReviewPanel.tsx` & `src/renderer/src/hooks/useSimilarityReview.ts`: Side-by-side comparison cards, paginated candidate pairs, decision controls, progress/cancellation/resume banners, and stale response guards.
- Numerical resource bounds:
  - Aggregate decode workers: <= 2 live workers (including terminating workers) shared with thumbnail decoding.
  - Queued decode jobs: <= 64 jobs; interactive thumbnails get high priority, similarity analysis gets low priority.
  - Per-job execution timeout: 15,000 ms with worker termination and concurrency recovery.
  - Source file size cap: <= 128 MiB (`MAX_SOURCE_SIZE_BYTES`).
  - Max input pixels: <= 100 megapixels (`MAX_INPUT_PIXELS`).
  - Renderer mounted cells: <= 200 mounted DOM cells.
  - Retained browsing metadata: <= 2,000 items.
  - Fingerprint algorithm: `dhash64_v1` (64 bits, 9x8 grayscale raw matrix).
  - Algorithmic similarity threshold: Hamming distance <= 10 / 64 bits (>= 84.375% algorithmic similarity).
  - Dense candidate limits: max 50 candidates per photo, max 10,000 candidate pairs persisted per run to prevent memory and quadratic storage explosion.
  - Candidate pagination: 10 pairs per page with absolute offsets and monotonic request tokens.

Tasks:

- [x] Migration 8: SQLite schema for perceptual hashes, candidate pairs, similarity decisions, and jobs.
- [x] Perceptual fingerprinting module (`dhash64_v1`) in worker threads with source containment, pre/post descriptor checks, and revision tracking.
- [x] Partitioned candidate search with bucket indexing, distance thresholding, exact duplicate exclusion, and dense candidate bounds.
- [x] Durable portable journal persistence for similarity review decisions (`edited_version`, `similar_scene`, `unrelated`, `unreviewed`) with two-phase SQLite commit.
- [x] SimilarityCoordinator: Resumable analysis jobs, progress streaming, cancellation, restart recovery, and scope preservation.
- [x] Narrow typed IPC channels (`similarity:*`) with bidirectional Zod validation and sender authorization.
- [x] Renderer UI: `SimilarityReviewPanel` and `useSimilarityReview` hook with side-by-side comparison, recorded facts, pagination, decision buttons, progress/cancellation, and stale guards.
- [x] Comprehensive unit and integration test suite with failing behavior tests first.
- [x] Real Electron verification scripts (`verify:similarity` and `verify:similarity:unpacked`).

---

## Stage 6: Semantic Photo Search and Metadata Filters

Status: **In progress — Substage 6A Complete (independently accepted at `155d7bd`); Substages 6B-6E Planned.**

Verification (Substage 6A): independent reviewer-reported verification passed at `155d7bd` (reviewer-executed; not re-run during closeout): **741 passed across 62 test files** (`npm test` exit 0), with strict typecheck (`npm run typecheck` exit 0), ESLint (`npm run lint` exit 0), Prettier formatting check (`npm run format:check` exit 0), production bundle build (`npm run build` exit 0), cached model verification (`node spikes/semantic-eval/fetch-model.mjs` exit 0, 7 files / 148.63 MiB, 0 network downloads), Electron spike (`node spikes/semantic-eval/run-electron-spike.mjs` via `ELECTRON_RUN_AS_NODE=1`, exit 0), and synthetic vector index benchmark (`node spikes/semantic-eval/benchmark-index.mjs` exit 0) all passing. `ELECTRON_RUN_AS_NODE=1` verification exercises the native N-API v6 addon (`onnxruntime-node`), `sharp`, `@huggingface/tokenizers`, `worker_threads`, and `node:sqlite` inside the Electron 45.2.3 runtime binary, and does **not** establish `BrowserWindow`/IPC responsiveness or packaged-app (`app.asar.unpacked`) compatibility. The 50,000-photo index cap and model provisioning choices (148.63 MiB checksum-verified download and/or local bundle import) remain explicitly **proposed**, not user-approved.

- [x] **Stage 6A (Complete; independently accepted at `155d7bd`)**: Offline semantic search feasibility evaluation and isolated real-Electron technical spike (`docs/stage-6a-semantic-search-evaluation.md`, `spikes/semantic-eval/`, `tests/main/semantic-spike-core.test.ts`). Evaluated CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32` quantized ONNX @ `6b7c5237`) via `onnxruntime-node@1.31.1` + `@huggingface/tokenizers@0.2.0` + `sharp@0.35.5`, SigLIP Base Patch16-224, and `@huggingface/transformers` WASM; verified MIT/Apache-2.0 runtime code and model weight licenses; measured cold/warm latency, throughput, sampled process-wide RSS vs. sampled worker-isolate V8 heap (not a continuous peak), headless parent event-loop delay probe, and synthetic index scan costs (1k–50k vectors) on both implementation run (367.36 ms cold load, 28.37 ms warm image mean, 3.39 ms warm text mean, 453.98 MiB sampled process-wide RSS, 16.94 MiB sampled worker heap, 26.78 ms in-memory / 202.15 ms SQLite streaming scan at 50k vectors) and reviewer rerun at `155d7bd` (467.56 ms cold load, 46.70 ms warm image mean, 5.32 ms warm text mean, 455.34 MiB sampled process-wide RSS, 19.99 MiB sampled worker heap, 34.21 ms in-memory / 300.06 ms–340.32 ms SQLite streaming scan at 50k vectors); proposed Stage 6B contract and Stage 6C/6D metadata filter integration note.
- [ ] **Stage 6B (Planned)**: Explicit offline model provisioning, SQLite Migration 9 (`photo_semantic_embeddings`, `semantic_index_jobs`, `semantic_index_job_items`), resumable background semantic indexing coordinator, content-revision invalidation, and `asarUnpack` packaging configuration. Retained Stage 6A review follow-ups for Stage 6B+: align preprocessing recipe naming (`clip_vit_b32_224_bicubic_center_rgb_v1` matching `sharp.kernel.cubic`) with single-pass `sharp` decode, enforce `approvedRoots` containment directly inside the production semantic worker, count terminating workers in aggregate worker/resource accounting ($\le 2$ live workers) while yielding to interactive thumbnail decodes, and verify real unpacked native-runtime (`app.asar.unpacked`) execution.
- [ ] **Stage 6C (Planned)**: Read-only EXIF/technical metadata extraction (capture date, camera, lens, resolution, file type) with strict separation of recorded facts vs. inferences and explicit `NULL` ("Unknown") preservation.
- [ ] **Stage 6D (Planned)**: Semantic query vector generation, bounded SQL + cosine similarity search ranking, typed IPC contracts, and Photos search & metadata filter UI controls.
- [ ] **Stage 6E (Planned)**: Real-Electron built and unpacked verification suites (`BrowserWindow`/IPC responsiveness and `app.asar.unpacked` native runtime) for semantic search and metadata filters, plus Stage 6 closeout.

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
