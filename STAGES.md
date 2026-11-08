# Personal Vault - Development and Public Release Tracker

Updated: November 7, 2026.

This tracker covers all development through public release. Detailed tasks belong in [TODO.md](TODO.md); verification evidence and limitations belong in [HANDOFF.md](HANDOFF.md).

## Current position

Stage 1, Stage 2, Stage 3, and Stage 4 are complete (independently accepted at `070e3cb`, `71e1af7`, `79bbf44`, and `1a1fb69`). Stages 5-8 are future work. Public release has not occurred and has no scheduled date.

## All stages

The project has **eight main stages**. Lettered substages divide the work; they do not add main stages.

| Stage | Deliverable                                                    | Status      | Acceptance                  |
| ----- | -------------------------------------------------------------- | ----------- | --------------------------- |
| 1     | Engineering foundation and secure desktop shell                | Complete    | `070e3cb`                   |
| 2     | Discovery, hashing, SQLite catalog, and resumable scan jobs    | Complete    | `71e1af7`                   |
| 3     | Exact duplicate grouping and review                            | Complete    | `79bbf44`                   |
| 4     | Verified vault copying and portable metadata                   | Complete    | `1a1fb69`                   |
| 5     | Fast photo browsing, ratings, and similarity review            | In progress | Substage 5A awaiting review |
| 6     | Semantic photo search and metadata filters                     | Planned     | Pending                     |
| 7     | Document extraction, classification, OCR, and unified search   | Planned     | Pending                     |
| 8     | Export, recovery, release validation, beta, and public release | Planned     | Pending                     |

Status meanings: **Planned** = future work; **Starting** = preparation underway; **In progress** = implementation underway or a parent stage partly complete; **Awaiting review** = submitted for independent review; **Complete** = independently accepted; **Blocked** = a named dependency prevents progress. A branch name alone does not establish implementation progress.

## Stage 1 - Foundation and desktop shell

**Complete; accepted at `070e3cb`.**

- [x] Electron, React, and TypeScript foundation and application shell.
- [x] Isolated renderer, sandboxed preload, validated IPC, and restricted navigation.
- [x] Honest loading, error, and empty states.
- [x] Behavioral tests, quality gates, packaging, and real-Electron smoke verification.

## Stage 2 - Discovery and resumable inventory

**Complete; accepted at `71e1af7`.**

| Substage | Deliverable                                                       | Status   | Accepted implementation | Documentation closeout |
| -------- | ----------------------------------------------------------------- | -------- | ----------------------- | ---------------------- |
| 2A       | Read-only discovery and filesystem inventory                      | Complete | `5dd6320`               | `000923e`              |
| 2B       | Read-only streaming SHA-256 hashing                               | Complete | `e4488a2`               | `ab2fd60`              |
| 2C       | SQLite schema, migrations, inventory, and observation persistence | Complete | `a674f9c`               | `d25ba50`              |
| 2D       | Resumable background scan jobs and IPC/UI integration             | Complete | `71e1af7`               | (this commit)          |

Stage 2D:

- [x] Connect existing discovery, hashing, and bounded persistence through background jobs.
- [x] Provide progress, pause/resume, cancellation, visible errors, and deterministic cleanup.
- [x] Persist checkpoints and recover interrupted jobs with source-file revalidation.
- [x] Add validated IPC and minimal controls within the existing UI design.
- [x] Verify actual scanning and recovery in Electron and applicable packaged execution.
- [x] Obtain independent acceptance and documentation closeout (`71e1af7`).

Exit: users can manage scans and recover interrupted work after restart without modifying originals or treating stale hashes as verified.

## Stage 3 - Exact duplicate review

**Complete; accepted at `79bbf44`.**

- [x] Group identical content by verified SHA-256 and byte size across filenames and locations.
- [x] Present duplicate groups with side-by-side recorded metadata, explicit unknown values, and observation provenance.
- [x] Support explicit review decisions (reviewed/unreviewed, optional preferred location) without mutating recorded facts or modifying sources.
- [x] Enforce decision invalidation policy: reset decision when group membership, content, or observations change; reject stale writes.
- [x] Truly bounded constant-memory SQL queries and deterministic signatures with O(1) auxiliary JS memory.
- [x] Async safety: list summaries and reloads guarded against stale save responses; pure state updaters.
- [x] Distinguish catalog-index removal, vault-copy deletion, and original-source deletion as distinct operations (none implemented).
- [x] Verify real Electron IPC duplicate review across scan, inspection, restart persistence, and rescan invalidation (implementation host: built and freshly rebuilt unpacked passed 18/18 checks; reviewer host: window connection timeout noted).

Exit: users can understand and review duplicate groups without losing locations or differing metadata.

## Stage 4 - Verified vault copying

**Complete; independently accepted at 1a1fb69.**

- [x] Initialize vault storage directory with versioned identity manifest (`vault.json`) and validate separation from source roots. Conflicting or invalid existing identity files are rejected without modification (`VaultInitializationError`).
- [x] Strict source preservation: source files are strictly read-only; originals are never moved, renamed, touched, overwritten, or deleted.
- [x] Verified copy pipeline (`copyAndVerifyFileToVault`): pre/post `fstat` source descriptor checks, bounded 64 KiB chunk streaming SHA-256 calculation on every path (including shortcuts), post-read live path revalidation, and independent post-write destination staging SHA-256 verification before atomic publication.
- [x] Internal vault containment (`assertPathContainedInVault`): canonical realpath containment and iterative segment-by-segment `lstat` traversal checking rejecting symlinks and Windows directory junctions in `files/`, content directories, `.vault-temp/`, identity files, manifests, and destinations.
- [x] Content-addressed vault storage (`files/<prefix>/<sha256>/<safeName>`) with safe collision handling; duplicate content shares a verified copy while preserving multi-source provenance.
- [x] Portable metadata manifests (`manifest.json` sidecars) strictly validated with Zod (`VaultManifestSchema`), recording original paths, filesystem timestamps, byte size, verified hashes, observation provenance, and audit results; preserving explicit `null`s for missing capture dates/locations without SQLite dependency.
- [x] Safe publication and crash recovery: atomic directory publication using `.pv_in_progress_${vaultId}_${jobId}.json` markers, strictly non-overwriting collision checks with `COPYFILE_EXCL` fallback, and deterministic in-progress marker recovery for interrupted jobs.
- [x] Resumable import coordinator (`VaultImportCoordinator`) with exact job-scope preservation via `getVaultImportItems`, observation currency revalidation (`isDiscoveryCurrent`, `isHashActive`), bounded queries without 1,000-candidate cutoffs, concurrency locking on start and resume, pause, resume, cooperative cancellation via `AbortSignal`, restart recovery (`interrupted` status), truthful completion status (`failed` when all items fail), and prompt IPC acknowledgment.
- [x] SQLite catalog schema expansion (Migration 6) adding `vaults`, `vault_copies`, `vault_imports`, and `vault_import_items` tables with audit trail.
- [x] Narrow typed IPC channels (`VAULT_*`) with strict bidirectional Zod validation (`ResumeImportRequestSchema`, `CancelImportRequestSchema`, `PauseImportRequestSchema`) and top-level sender authorization.
- [x] Accessible renderer UI (`VaultImportPanel`) with functional "Change Vault", candidate pagination beyond 100 items with monotonic request token protection, real-time progress bar, pause/resume/cancel controls, interrupted job recovery alert, truth-aligned banners (no "Verified Success" for failures), and operations distinction notice.
- [x] Isolated-fixture verification script (`scripts/verify-electron-vault-import.mjs`) exercising vault initialization, overlap rejection, candidate queries, verified copying, duplicate content manifest merging, idempotency, modified source rejection, active cancellation during copying, restart recovery & resume, and source preservation invariance across real Electron built and unpacked modes.
- [x] Independent review verification passed at `1a1fb69`: 421 tests passed across 23 test files (exit 0); typecheck, lint, formatting, production build, and unpacked build clean pass (exit 0); real-Electron verified vault import (built & unpacked) 11/11 passed each (exit 0); duplicate review 18/18 passed (exit 0); scan workflow 14/14 passed (exit 0); SQLite 8/8 passed (exit 0); smoke checks (built & unpacked) passed (exit 0); source preservation invariance confirmed.

Exit: originals can be copied with verified integrity and recoverable metadata outside SQLite.

## Stage 5 - Photo browsing and review

**In progress; Substage 5A complete; independently accepted at `951fd25`.**

| Substage | Deliverable                                                               | Status          | Submission reference         | Acceptance reference |
| -------- | ------------------------------------------------------------------------- | --------------- | ---------------------------- | -------------------- |
| 5A       | Bounded thumbnail generation, secure disposable cache, and photo browsing | Complete        | `5258b0a`                    | `951fd25`            |
| 5B       | User review tools: ratings, flags, and custom collections                 | Awaiting review | `feat/stage-5b-photo-review` | Pending              |
| 5C       | Perceptual hashing and visual similarity review                           | Planned         | Pending                      | Pending              |

### Stage 5A - Bounded thumbnail generation, secure disposable cache, and virtualized photo browsing

**Complete; independently accepted at `951fd25`.**

- [x] Responsive virtualized photo thumbnail grid adhering to dark theme token system with stable deterministic ordering by catalog location ID (`file_locations.id ASC`).
- [x] Pure SQL pagination (`LIMIT ? OFFSET ?`) for photo catalog records without full-table materialization in memory.
- [x] Sharp 0.35.5 decoder executing inside real Node worker threads (`worker_threads.Worker`) with bounded concurrency (max 2 active jobs, max 64 queued jobs, 15-second per-job timeout, max 128 MiB source size, max 100 megapixels input limit). Worker crashes, timeouts, or cancellations terminate worker execution without leaking concurrency capacity.
- [x] Large-collection browsing: virtual grid retains absolute collection scroll extent (`totalCount`) and positions, with sliding LRU page cache bounded to 2,000 records (40 pages of 50 items), mounted DOM cells bounded to <= 200, allowing distant jumps (e.g. to photo 7,500) and return to evicted pages without duplicates, gaps, or scroll jumps.
- [x] Format support matrix tested and verified: JPEG, PNG, WebP, GIF (frame 0), AVIF, TIFF with automatic EXIF orientation preservation (`.rotate()`).
- [x] Honest placeholders: Apple HEIC/HEIF (due to prebuilt libvips libheif lacking unbundled HEVC decoders), camera RAW, SVG, corrupted or oversized inputs return honest unsupported/error status cards without crashes or external toolchains.
- [x] Secure disposable disk cache in `<userData>/thumbnails/`: cache key bound to source identity (`locationId`/`normalizedPath`) for unhashed files so files with identical size/mtime never collide; canonical separation rejecting overlap with source roots or active vault; symlink/junction redirection rejected; WebP header and image decode integrity validated via `validateWebPIntegrity` in worker threads (corrupt pseudo-WebP headers rejected, unlinked, and regenerated); oversized entries rejected before reading or allocating contents; pre-allocation capacity reservation before staging/publication (`reserveCapacity`) accounting for existing target and staging bytes during replacement writes; put operations serialized to eliminate concurrent write budget races; atomic publication with asynchronous operations, nonblocking backoff retry, and immediate abort on shutdown; abandoned staging cleanup on startup and shutdown; source byte cap enforced during reading.
- [x] Residual out-of-band source modification detection (`statSync` check on cache hits) preventing stale image display.
- [x] Stale renderer response protection: monotonic generation counter incremented on refresh and unmount; revision-bound in-flight request tracking ensuring older delayed completions cannot overwrite newer cells or delete newer request bookkeeping.
- [x] Narrow typed IPC channels (`photos:get-page`, `photos:get-thumbnail`, `photos:cancel-thumbnail`, `photos:get-diagnostics`) with bidirectional Zod validation and top-level sender authorization.
- [x] Compact metadata details panel displaying filename, absolute source path, recorded byte size, recorded filesystem timestamps, and observation provenance, with explicit "Unknown" for absent capture dates/locations (no fabricated dates).
- [x] Header search input disabled with clear Stage 6 availability label in Photos tab.
- [x] Comprehensive verification suite in built and unpacked modes (`scripts/verify-electron-photos.mjs`, `verify:photos`, `verify:photos:unpacked`) with 19/19 checks passed: 10,000-photo scale test exercising actual Photos UI with real decodable image files with actual recorded filesystem timestamps, cold scrolling, warm reversal, distant jumps, return to evicted pages with verified image loading and expected photo identity at all checkpoints (zero error cards), continuous `requestAnimationFrame` frame interval p95 measurement (4.30 ms <= 33 ms target), continuous main thread delay sampling (p95 = 35.91–46.37 ms, max < 100 ms limit), real observed request cancellation with worker termination and capacity recovery, interrupted real publication restart cleanup & regeneration, and 0 re-decodes on cache reuse proven via diagnostics.
- [x] Independent review verification passed at `951fd25`: 503 tests passed across 31 test files (exit 0); all 15 required verification commands exit 0; typecheck, lint, formatting, production build, and unpacked build clean pass (exit 0); real-Electron photo verification (built & unpacked) 19/19 passed each (exit 0); duplicate review 18/18 passed (exit 0); scan workflow 14/14 passed (exit 0); vault import (built & unpacked) 11/11 passed each (exit 0); SQLite 8/8 passed (exit 0); smoke checks (built & unpacked) passed (exit 0); source preservation invariance confirmed.
- [x] Source preservation invariance verified: original source bytes, sizes, and timestamps remain completely untouched across all tests.

Exit: users can browse discovered photographs smoothly with bounded memory and secure thumbnails, with ratings and similarity deferred to 5B and 5C.

### Stage 5B - User review tools: ratings, flags, and custom collections

**Awaiting review.** Implemented on `feat/stage-5b-photo-review`.

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
- [x] Comprehensive real Electron verification suite in built and unpacked modes (`scripts/verify-electron-photo-review.mjs`, `verify:photo-review`, `verify:photo-review:unpacked` — 12/12 checks passed each, exit code 0): scan -> initial DOM cards -> star ratings (1-5, clear, re-rate) & Pick/Reject flags via DOM -> selection switch concurrency guard -> custom collections (create, rename, add/remove member) -> combined SQL filters & out-of-filter eviction/refill -> deterministic pre-commit persistence interruption observed at barrier with process kill, SQLite uncommitted verification, restart reconciliation appending `op_aborted`, and subsequent write success -> filtered scale browsing beyond 2,000 photos (3,000 decodable fixtures, 2,200 filtered, cold scroll past 2,000 items, distant jump, return travel, mounted cells <= 200, zero error cards, workers and queue bounded) -> strict source preservation invariance. All 625 tests pass across 44 test files.
- [x] Review findings corrections:
  1. Post-COMMIT journal failure handling: tracks actual commit boundary, never appends `op_aborted` for committed database transactions, returns truthful committed-with-persistence-pending state, and startup reconciliation deterministically finalizes missing `op_committed` via bounded streaming scan and indexed queries on `journal_operations`.
  2. Bounded, UTF-8-safe journal recovery: pure Buffer chunk scanning across 64 KiB boundaries, bounded record lengths (<= 64 KiB), distinguishing complete malformed records ending in newline (which fail integrity checks and preserve corrupt evidence) from incomplete final lines at EOF without trailing newline (which are safely truncated).
  3. Dynamic runtime security wiring: revalidates dynamic source roots and active vault path getters on every mutation and checks storage directory ancestors against symlinks/junctions.
  4. Renderer response safety: rapid A -> B -> A selection switches guarded, live filter refs prevent stale filter eviction, collection and membership pagination windows bounded with in-flight duplicate request protection, and accessible membership error display with retry control.
  5. Restored Stage 5A strict worker bounds in photo review scale verification: `liveWorkers <= 2` and `queuedJobs <= 64`.

Exit: users can rate, flag, group, and filter photos with persistent, portable annotations and guaranteed source file preservation.

## Stage 6 - Semantic photo search

**Planned.**

- [ ] Evaluate local embedding models and resource/packaging requirements.
- [ ] Implement content-based photo search and a persistent search index.
- [ ] Filter by available date, camera, lens, resolution, and file-type metadata.
- [ ] Preserve unknown dates/locations and separate inferences from recorded facts.

Exit: users can find photos by content and available metadata using the supported offline workflow.

## Stage 7 - Documents and unified search

**Planned.**

- [ ] Extract text from supported document formats.
- [ ] Add local OCR for scanned documents and document images.
- [ ] Classify documents with explicit inference provenance.
- [ ] Filter software clutter without excluding valuable personal notes.
- [ ] Provide unified search across photos and documents.

Exit: supported documents can be found and reviewed alongside photos without uploading private content by default.

## Stage 8 - Release preparation through public availability

**Planned.** These substages expand the existing final stage into explicit release checkpoints. They are future planning, not completed work or authorization to publish.

| Substage | Deliverable                                                         | Status  | Acceptance/release reference |
| -------- | ------------------------------------------------------------------- | ------- | ---------------------------- |
| 8A       | Selective export and portable metadata bundles                      | Planned | Pending                      |
| 8B       | Backup, restore, and catalog recovery from vault manifests          | Planned | Pending                      |
| 8C       | Release scope, security, performance, installers, and documentation | Planned | Pending                      |
| 8D       | Beta testing, defect resolution, and release candidate              | Planned | Pending                      |
| 8E       | Approved public release and verified distribution                   | Planned | Pending                      |

Public release checklist:

- [ ] Agree the release feature scope and supported operating systems; explicitly record any roadmap deferrals.
- [ ] Verify export, backup, restore, migration, and recovery with realistic data.
- [ ] Verify source preservation, import integrity, and destructive-action safeguards.
- [ ] Review IPC, navigation, local data handling, dependency security, and privacy behavior.
- [ ] Validate large-library performance, resource bounds, cancellation, and restart recovery.
- [ ] Test installers on clean machines for every advertised platform, including upgrades, uninstall behavior, and retention of user data.
- [ ] Set the distribution/signing approach and verify release artifacts.
- [ ] Review dependency/model redistribution licenses and third-party notices.
- [ ] Provide installation, usage, privacy, backup/recovery, known-limitations, and support documentation.
- [ ] Complete beta acceptance; resolve release-blocking defects and document accepted limitations.
- [ ] Independently accept the release candidate and record its version, commit, and tested artifacts.
- [ ] Obtain explicit user authorization to publish.
- [ ] Publish approved downloads and release notes; verify public installation and the issue-reporting route.
- [ ] Record the release date and distribution links below.

| Public release record               | Value                       |
| ----------------------------------- | --------------------------- |
| Version / accepted commit           | Pending                     |
| Supported platforms                 | To be confirmed before beta |
| Release candidate acceptance        | Pending                     |
| Publication approval                | Pending                     |
| Public release date                 | Not scheduled               |
| Downloads / release notes / support | Pending                     |

Exit: the approved release is publicly available, the advertised installation path works, and users have documentation and a route to report problems.

## Maintenance rules

Update this tracker at stage start, review submission, acceptance, blockage, and closeout. Record accepted implementation and documentation commits separately. Record release versions and links when available. Keep TODO.md and HANDOFF.md consistent when their status changes; keep detailed logs in the handoff.

Stage acceptance, pushing, merging, and public publication are separate actions. Completion does not imply that a branch is pushed or merged, or that publication is authorized.
