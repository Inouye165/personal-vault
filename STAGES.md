# Personal Vault - Development and Public Release Tracker

Updated: November 13, 2026.

This tracker covers all development through public release. Detailed tasks belong in [TODO.md](TODO.md); verification evidence and limitations belong in [HANDOFF.md](HANDOFF.md).

## Current position

Stages 1-5 are complete (independently accepted at `070e3cb`, `71e1af7`, `79bbf44`, `1a1fb69`, and Stage 5 via substages 5A `951fd25`, 5B `4071948`, and 5C `543135a`). Stage 6 is In progress (Substage 6A: Offline semantic search feasibility evaluation and technical spike is Complete, independently accepted at `155d7bd`; Substage 6B: Model provisioning, resumable semantic indexing, and persistent SQLite index is Complete, independently accepted at `0b0c814`; Substage 6C: EXIF technical metadata extraction and fact/inference-separated SQL filters is Complete, independently accepted at `c8a766f`; Substage 6D: Natural-language photo search IPC, ranking, and Photos UI integration is Complete, independently accepted at `1f07012` on `feat/stage-6d-semantic-search`; Substage 6E is Planned). Stages 7-8 are Planned. Public release has not occurred and has no scheduled date.

## All stages

The project has **eight main stages**. Lettered substages divide the work; they do not add main stages.

| Stage | Deliverable                                                    | Status      | Acceptance                                                         |
| ----- | -------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| 1     | Engineering foundation and secure desktop shell                | Complete    | `070e3cb`                                                          |
| 2     | Discovery, hashing, SQLite catalog, and resumable scan jobs    | Complete    | `71e1af7`                                                          |
| 3     | Exact duplicate grouping and review                            | Complete    | `79bbf44`                                                          |
| 4     | Verified vault copying and portable metadata                   | Complete    | `1a1fb69`                                                          |
| 5     | Fast photo browsing, ratings, and similarity review            | Complete    | 5A `951fd25`, 5B `4071948`, 5C `543135a`                           |
| 6     | Semantic photo search and metadata filters                     | In progress | 6A `155d7bd`, 6B `0b0c814`, 6C `c8a766f`, 6D `1f07012`; 6E Planned |
| 7     | Document extraction, classification, OCR, and unified search   | Planned     | Pending                                                            |
| 8     | Export, recovery, release validation, beta, and public release | Planned     | Pending                                                            |

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

**Complete; Substages 5A, 5B, and 5C independently accepted at `951fd25`, `4071948`, and `543135a`.**

| Substage | Deliverable                                                               | Status   | Submission reference              | Acceptance reference |
| -------- | ------------------------------------------------------------------------- | -------- | --------------------------------- | -------------------- |
| 5A       | Bounded thumbnail generation, secure disposable cache, and photo browsing | Complete | `5258b0a`                         | `951fd25`            |
| 5B       | User review tools: ratings, flags, and custom collections                 | Complete | `feat/stage-5b-photo-review`      | `4071948`            |
| 5C       | Perceptual hashing and visual similarity review                           | Complete | `feat/stage-5c-visual-similarity` | `543135a`            |

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

**Complete; independently accepted at `4071948`.**

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
- [x] Comprehensive real Electron verification suite in built and unpacked modes (`scripts/verify-electron-photo-review.mjs`, `verify:photo-review`, `verify:photo-review:unpacked` — 12/12 checks passed each, exit code 0): scan -> initial DOM cards -> star ratings (1-5, clear, re-rate) & Pick/Reject flags via DOM -> selection switch concurrency guard -> custom collections (create, rename, add/remove member) -> combined SQL filters & out-of-filter eviction/refill -> deterministic pre-commit persistence interruption observed at barrier with process kill, SQLite uncommitted verification, restart reconciliation appending `op_aborted`, and subsequent write success -> filtered scale browsing beyond 2,000 photos (3,000 decodable fixtures, 2,200 filtered, cold scroll past 2,000 items, distant jump, return travel, mounted cells <= 200, zero error cards, workers and queue bounded) -> strict source preservation invariance.
- [x] Review findings corrections:
  1. Accurate pending persistence tracking & lifecycle: pending journal finalization is tracked with unique per-invocation identities and monotonic generation counters (`mutationGenRef`) across ratings, flags, collection changes, and memberships. Outcomes are recorded independently of selection, photo revision, and stale presentation-response guards (so a save for photo A completing after navigating to B registers its unresolved operation while keeping obsolete badges and status updates guarded). Memory bounds employ an honest overflow policy (`overflowCount`) so capacity limits cannot silently forget unresolved work or report a false all-saved state. Reconciliation snapshots and clears only the operation generations actually covered (`gen <= coveredGen`), preserving newer unresolved operations added mid-flight until reconciled in turn without repeating mutations. React state updaters remain strictly pure without mutating refs.
  2. Same-photo revision and response guards: selection generation is keyed by photo ID and content revision (`${photo.id}:${computePhotoRevision(photo)}`). Content replacement advances generation, resets save state, reloads memberships, and drops delayed in-flight responses before updating DOM badges or active star buttons.
  3. Canonical journal overlap with safe ancestor policy: journal storage, source roots, and vault paths are canonicalized via realpath with ancestor traversal for missing subpaths (`canonicalizeWithAncestorPolicySync` / `Async`), detecting symlinks and Windows directory junctions and failing closed with `JournalSecurityError` when safety cannot be established.
  4. Propagate `persistencePending` through the entire UI: committed-in-SQLite but journal-pending mutations display an honest pending status banner and retry control invoking `photos:reconcile-journal` without re-executing already committed database transactions.
  5. Bounded pagination/reconciliation: collection and membership lists navigate via bounded 50-item pages with Prev/Next controls, absolute offsets, and page indicators; SQLite `reconcileJournalWithDatabase()` streams unterminated operations via bounded iterator (`stmt.iterate()`) without array accumulation.
  6. Comprehensive stale-response guards: `updatePhotoLocal` guarded by per-photo mutation sequence counter, selection generation, and photo revision; membership loads guarded by request identity and selection generation; unmount invalidation.
  7. Runtime journal security: lists all registered source roots without 1,000-item cap via `catalog.getAllSourceRoots()`; fails closed if security context cannot be obtained; canonical platform-correct path normalization; ensures source and vault security context is available before journal startup repair and revalidated on subsequent mutations.
- [x] Independent review verification passed at `4071948`: 657 tests passed across 52 test files (exit 0); all 17 required verification commands exit 0; typecheck, lint, formatting, production build, and unpacked build clean pass (exit 0); real-Electron photo review verification (built & unpacked) 12/12 passed each (exit 0); photo browsing verification (built & unpacked) 19/19 passed each (exit 0); duplicate review 18/18 passed (exit 0); scan workflow 14/14 passed (exit 0); vault import (built & unpacked) 11/11 passed each (exit 0); SQLite 8/8 passed (exit 0); smoke checks (built & unpacked) passed (exit 0); source preservation invariance confirmed.

Exit: users can rate, flag, group, and filter photos with persistent, portable annotations and guaranteed source file preservation.

### Stage 5C - Perceptual hashing and visual similarity review

**Complete; independently accepted at `543135a` (corrected candidate). Earlier candidate `3ea3454` failed independent review because `npm run typecheck` reported TypeScript errors; those were corrected and the corrected candidate was re-reviewed and accepted.**

- [x] Deterministic 64-bit perceptual fingerprinting (`dhash64_v1`) suitable for recompression, resizing, and modest edits; computes 4x16-bit partition bucket integers for sub-key indexing; Hamming distance comparison (0–64 bits) and bounded algorithmic similarity percentage `(1 - distance / 64) * 100%`. Explicitly documented algorithm limits (crops, rotations, burst scenes, extreme contrast shifts).
- [x] Shared decode worker pool integration (`requestFingerprint`): executes outside Electron main with low priority, respecting the aggregate concurrency bounds (<= 2 live decode workers including terminating workers, <= 64 queued jobs, 15-second per-job timeout, max 128 MiB source size, max 100 megapixels input limit).
- [x] Database migration 8 (`src/main/services/catalog/migrations.ts`): introduces `photo_perceptual_hashes` (content-revision keyed, algorithm-versioned), `similarity_candidate_pairs` (canonical location ordering `file_location_id_a < file_location_id_b`, Hamming distance, algorithmic score), `similarity_decisions` (canonical ordering, partial unique index `idx_sim_decision_pair_curr` on `is_current = 1`), `similarity_jobs`, and `similarity_job_items`.
- [x] Partitioned candidate search (`findAndPersistCandidatePairs`): bucket-indexed matching avoiding all-pairs quadratic explosion; excludes exact byte duplicates (`sha256_a === sha256_b`, preserved for Stage 3 exact duplicate workflow); enforces per-photo candidate limit (<= 50) and catalog-wide candidate limit (<= 10,000 pairs).
- [x] Resumable similarity coordinator (`SimilarityCoordinator`): snapshot job-scope authorization, cooperative cancellation via `AbortSignal`, restart recovery (`interrupted` status), and startup interruption reconciliation. Unchanged verified content reuses existing fingerprints; out-of-band changes advance revision and invalidate stale entries.
- [x] Portable two-phase decision persistence: durable annotation journal (`appendSimilarityDecisionSync`, `kind: 'similarity_decision'`) with pre-commit fsync, SQLite commit, `persistencePending` UI propagation, startup reconciliation (`reconcileJournalWithDatabase`), and revision matching preventing stale mutations (`REVISION_MISMATCH`, `STALE_DECISION_VERSION`).
- [x] Pure SQL pagination for candidate pairs (`getSimilarityCandidatePairs`): deterministic sorting (`distance ASC, id ASC`), bounded pages, and decision filtering (`all`, `unreviewed`, `edited_version`, `similar_scene`, `unrelated`).
- [x] Responsive side-by-side comparison UI (`SimilarityReviewPanel`): toggleable view in Photos tab (`#photos-mode-similarity`), comparison cards showing filenames, source locations, dimensions when known (unknown remain explicit "Unknown"), recorded facts, algorithmic similarity score, Hamming distance, and explicit user decision buttons (`Edited Version`, `Similar Scene`, `Dismiss (Unrelated)`, `Clear Decision`).
- [x] Stale presentation and selection guards: monotonic request tokens and pure render state updaters preventing racing queries or delayed completions from corrupting presentation.
- [x] Narrow typed IPC channels (`similarity:start-analysis`, `similarity:cancel-analysis`, `similarity:resume-analysis`, `similarity:get-progress`, `similarity:get-pairs`, `similarity:set-decision`, `similarity:reconcile`) with bidirectional Zod validation and top-level sender frame authorization.
- [x] Isolated-fixture verification scripts (`scripts/verify-electron-similarity.mjs`, `verify:similarity`, `verify:similarity:unpacked`): exercises DOM controls in real Electron across built and unpacked modes — scan -> navigate to similarity review -> trigger analysis -> progress bar -> inspect cards -> exercise all 4 decision actions -> filter candidate pairs -> restart persistence -> bitwise source preservation invariance.
- [x] Independent reviewer-reported verification at `543135a` (reviewer executed; not re-run during closeout): 733 tests passed across 61 test files; all 19 quality/build/Electron verification commands exited 0; `verify:similarity` and `verify:similarity:unpacked` each passed 8/8 phases; prior-stage regressions passed.
- Algorithm limits retained: `dhash64_v1` similarity is an uncalibrated machine suggestion, not proof of an edited copy; crops, rotations without EXIF, bursts, and difficult images may be missed or confused; candidate caps (<= 50 per photo, <= 10,000 pairs per run) mean coverage can be incomplete. Only explicit user decisions (`edited_version`, `similar_scene`, `unrelated`, `unreviewed`) classify a pair. Exact duplicates remain under the Stage 3 SHA-256 workflow.

Exit: users can run local perceptual analysis, browse similar candidates side by side, and record explicit review decisions with guaranteed source file preservation.

## Stage 6 - Semantic photo search

**In progress; Substages 6A, 6B, 6C, and 6D Complete (independently accepted at `155d7bd`, `0b0c814`, `c8a766f`, and `1f07012`); Substage 6E Planned.**

| Substage | Deliverable                                                                  | Status   | Submission reference                | Acceptance reference |
| -------- | ---------------------------------------------------------------------------- | -------- | ----------------------------------- | -------------------- |
| 6A       | Offline semantic search feasibility evaluation and real-Electron spike       | Complete | `feat/stage-6a-semantic-evaluation` | `155d7bd`            |
| 6B       | Model provisioning, resumable semantic indexing, and persistent SQLite index | Complete | `feat/stage-6b-semantic-index`      | `0b0c814`            |
| 6C       | EXIF technical metadata extraction and fact/inference-separated SQL filters  | Complete | `feat/stage-6c-photo-metadata`      | `c8a766f`            |
| 6D       | Natural-language photo search IPC, ranking, and Photos UI integration        | Complete | `feat/stage-6d-semantic-search`     | `1f07012`            |
| 6E       | End-to-end packaged Electron verification and Stage 6 closeout               | Planned  | Pending                             | Pending              |

### Stage 6A - Offline semantic search feasibility evaluation and real-Electron spike

**Complete; independently accepted at `155d7bd`.**

- [x] Evaluate local embedding models (`Xenova/clip-vit-base-patch32` quantized INT8 ONNX via `onnxruntime-node@1.31.1` + `@huggingface/tokenizers@0.2.0` + `sharp@0.35.5`, `Xenova/siglip-base-patch16-224`, and `@huggingface/transformers` WASM) and primary-source runtime/weight licenses (MIT for `onnxruntime-node` and CLIP weights; Apache-2.0 for `@huggingface/tokenizers`, `sharp`, and SigLIP weights) in `docs/stage-6a-semantic-search-evaluation.md`.
- [x] Pinned offline model provenance (`Xenova/clip-vit-base-patch32` @ `6b7c523703ae26e39be4b03774966f8571c7f523`, 7 files, 155,851,918 bytes / 148.63 MiB) with SHA-256 verification (`spikes/semantic-eval/fetch-model.mjs`) and zero runtime network calls in `spikes/semantic-eval/semantic-worker.mjs`.
- [x] Executable spike under Electron (`node spikes/semantic-eval/run-electron-spike.mjs` via `ELECTRON_RUN_AS_NODE=1`) and pure logic unit tests (`tests/main/semantic-spike-core.test.ts`):
  - Implementation-host run: cold model load 367.36 ms; warm image embedding mean 28.37 ms (2.85 ms decode + 25.52 ms vision ONNX; 35.24 images/sec); warm text query mean 3.39 ms; sampled process-wide RSS during worker inference 453.98 MiB (main process RSS at completion 449.91 MiB) and sampled worker-isolate V8 heap max 16.94 MiB (post-inference point samples, not a continuous peak); headless parent event-loop delay probe p95 16.49 ms (max 24.40 ms); synthetic 512-d `Float32Array` exact scan at 50,000 vectors: 26.78 ms median / 32.32 ms p95 in-memory and 202.15 ms SQLite streaming (`stmt.iterate()`).
  - Independent reviewer rerun at `155d7bd` (reviewer-executed; not re-run during closeout): 741 passing tests across 62 test files (`npm test` exit 0); `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build` all exit 0; cached `fetch-model.mjs` verified 7 files with 0 network downloads (exit 0); `run-electron-spike.mjs` passed (exit 0: cold load 467.56 ms, warm image mean 46.70 ms [4.86 ms decode + 41.84 ms vision ONNX; 21.41 images/sec], warm text query mean 5.32 ms, 7/7 synthetic queries passed rubric, sampled process-wide RSS 455.34 MiB [end 451.64 MiB], sampled worker-isolate V8 heap 19.99 MiB, headless parent event-loop delay p95 16.28 ms [max 24.13 ms], missing model `MISSING_MODEL`, unsupported HEIC `unsupported`, corrupt JPEG `DECODE_FAILED`, active cancellation `CANCELLED` + worker recovery, and 100% bitwise source preservation); `benchmark-index.mjs` passed (exit 0: 50,000-vector in-memory scan 34.21 ms median / 39.09 ms p95; SQLite streaming scan 300.06 ms–340.32 ms).
- [x] Scope & evidence boundaries retained: `ELECTRON_RUN_AS_NODE=1` verification proves N-API v6 native addon loading and worker inference inside the Electron 45.2.3 runtime binary, and does **not** establish `BrowserWindow`/IPC responsiveness or packaged-app (`app.asar.unpacked`) compatibility. The 50,000-photo index cap and model provisioning choices (148.63 MiB checksum-verified download and/or local bundle import) remain explicitly **proposed**, not user-approved.
- [x] Stage 6B+ production follow-ups retained from independent review: align preprocessing identifier naming (`clip_vit_b32_224_bicubic_center_rgb_v1` matching `sharp.kernel.cubic`) with single-pass `sharp` decode, enforce `approvedRoots` containment directly inside the production semantic worker, count terminating workers in aggregate worker/resource accounting ($\le 2$ live workers) while yielding to interactive thumbnail decodes, and exercise real unpacked native-runtime (`app.asar.unpacked`) and `BrowserWindow`/IPC verification.

### Stage 6B - Model provisioning, resumable semantic indexing, and persistent SQLite index

**Complete; independently accepted at `0b0c814`.**

- [x] Modular production model provisioning (`src/main/services/semantic/manifest.ts`, `model-manager.ts`) without importing runtime code from `spikes/`:
  - Pinned `Xenova/clip-vit-base-patch32` @ `6b7c523703ae26e39be4b03774966f8571c7f523` (7 files, 155,851,918 bytes / ~148.63 MiB), preprocessing recipe `clip_vit_b32_224_bicubic_center_rgb_v1` (actual bicubic `sharp.kernel.cubic` center-crop 224x224 RGB), and 512-d `Float32Array` vector dimensions.
  - Explicit in-app download (`semantic:download-model`) and offline folder import (`semantic:import-model-folder` with main-process native folder picker) displaying the ~148.63 MiB model requirement before installation; zero automatic startup or inference downloads.
  - App-owned storage in `<userData>/models/` with canonical realpath separation against registered source roots and active vault storage; exclusive staging, off-main SHA-256 verification, safe atomic publication with completion receipt, startup cleanup of abandoned staging directories, and preservation of existing verified installs on failed replacement.
  - Strict download policy: HTTPS only to approved Hugging Face / XetHub CDN origins (`huggingface.co`, `cas-bridge.xethub.hf.co`, `cdn-lfs.hf.co`, `cdn-lfs-us-1.hf.co`, `cdn-lfs-eu-1.hf.co`), redirect hop limit (<= 5), exact byte size and SHA-256 validation, and zero outbound transmission of personal files, metadata, or queries.
  - Pre-load integrity revalidation off main before starting or resuming any indexing job.
  - `THIRD_PARTY_NOTICES.md` included in packaged builds (`electron-builder.json5`) alongside `asarUnpack` rules for `onnxruntime-node` native binaries (`app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node`).
- [x] Persistent SQLite index (Migration 9, `CURRENT_SCHEMA_VERSION = 9` in `src/main/services/catalog/migrations.ts`):
  - `photo_semantic_embeddings`, `semantic_index_jobs`, and `semantic_index_job_items` tables keeping derived vectors strictly separate from immutable recorded facts.
  - Vectors bound to `file_location_id`, `discovery_observation_id`, `content_sha256`, `content_revision`, `model_id`, `model_commit`, `model_manifest_sha256`, `preprocessing_version`, and `vector_dimensions = 512`, validated for finite float32 values, L2 unit normalization, and exact 2,048-byte blob length.
  - Disk-backed job scope snapshotting without any 50,000-photo permanent catalog cap (verified at 50,001 photos with bounded paginated batches in `tests/main/catalog-semantic-index.test.ts`).
  - Content-addressed embedding reuse only after off-main live source file SHA-256 and sub-millisecond timestamp verification (`verify_source` worker action); pre-commit catalog revision revalidation (`REVISION_MISMATCH`); model/recipe invalidation (`invalidateEmbeddingsForModelOrRecipe`).
- [x] Shared worker pool & resource bounds (`src/main/services/thumbnails/worker.ts`, `coordinator.ts`, `src/main/services/semantic/coordinator.ts`):
  - Single-pass `sharp` decode (`.rotate()` + `.resize(224, 224, { fit: 'cover', position: 'centre', kernel: sharp.kernel.cubic })` + `.removeAlpha().raw()`) and CPU `onnxruntime-node` vision inference (`intraOpNumThreads: 2`, `interOpNumThreads: 1`) in worker threads.
  - Approved-root canonical containment (`assertSourcePathAllowed` with symlink/junction rejection) and pre/post descriptor `fstat` + streaming SHA-256 verification enforced directly inside the worker.
  - Enforces <= 2 live image-processing workers (counting terminating workers until `'exit'`), <= 1 active `semantic_embed` task, <= 1 worker holding a loaded ONNX session, and <= 64 total queued jobs (reserving >= 32 slots for interactive high-priority thumbnail decodes and yielding background indexing while interactive decodes are active).
  - Prompt IPC acknowledgment on start/resume; cooperative pause/cancel and immediate active worker termination on cancel/timeout; startup recovery marking running/paused jobs `interrupted`.
- [x] Narrow typed IPC (`semantic:*`) with bidirectional Zod validation and sender checks, plus compact `SemanticIndexPanel` in the Photos tab with honest coverage/progress counts, stale-response guards, and clear messaging that indexing prepares offline semantic search for Stage 6D without fabricating factual labels.
- [x] Independent reviewer verification passed at `0b0c814`: 827 tests passed across 67 test files (exit 0); all 21 required quality, build, and real-Electron verification commands exited with code 0 (`verify:semantic-index` passed 10/10 in built mode; `verify:semantic-index:unpacked` passed 11/11 in unpacked mode with native `app.asar.unpacked` `onnxruntime_binding.node` verification and zero bundled `spikes/`; all 13 prior-stage regression suites passed).
- [x] Scope boundaries retained: CPU-only execution baseline preserved; discovered source files strictly read-only and invariant across all operations; natural-language search UI deferred to Stage 6D; Stage 6C (read-only EXIF extraction and technical metadata filters) identified as the next planned assignment.

### Stage 6C - EXIF technical metadata extraction and fact/inference-separated SQL filters

**Complete; independently accepted at `c8a766f`.**

- [x] Modular read-only EXIF & header parser (`src/main/services/metadata/extractor.ts`, `date-policy.ts`, `normalize.ts`, `types.ts`) using `exifreader@4.54.0` (MPL-2.0, zero transitive dependencies, bundled into worker via `electron.vite.config.ts`, documented in `THIRD_PARTY_NOTICES.md`) + `sharp@0.35.5` header inspection without full raster pixel decode, working completely offline and without requiring an installed semantic model.
- [x] Four-way provenance separation: immutable filesystem observations & verified SHA-256 hashes; revision-bound extracted EXIF metadata (`parser_recipe_version = 'exif_tech_v1'`, bounded `raw_tags_json`); interpreted capture dates (`DateTimeOriginal` preferred with documented `DateTimeDigitized` fallback only when absent; invalid `DateTimeOriginal` conservatively preserves Unknown with parse/conflict details; `DateTime` modification tag, filesystem timestamps, and filenames never used; explicit offsets vs. `local_wall_clock_unknown_tz` without host-TZ/UTC coercion; leap-year Gregorian validation; `capture_calendar_date` `YYYY-MM-DD` range filtering); and user review annotations / semantic embeddings.
- [x] Encoded dimensions + EXIF orientation (`1..8`) preserved separately from orientation-adjusted display dimensions (`display_width_px`, `display_height_px`, orientations `5..8` swap axes) used consistently for SQL resolution filters; camera/lens raw strings preserved alongside bounded normalized matching keys; recorded `filename_extension` kept separate from magic-byte `detected_format` with mismatch detection; Apple HEIC/HEIF and camera RAW formats reported honestly as `unsupported`.
- [x] SQLite Migration 10 (`CURRENT_SCHEMA_VERSION = 10` in `src/main/services/catalog/migrations.ts`, `database.ts`): `photo_technical_metadata`, `photo_metadata_jobs`, and `photo_metadata_job_items` with filter/facet indexes, exact snapshotted resume scope (bounded 500-item batches, verified at 50,001 photos without collection-size caps), bounded searchable/paginated camera/lens/file-type facets (`LIMIT <= 100`), explicit `Unknown` vs. `unprocessed`/`stale` separation, and SQL `AND` combination with Stage 5B rating/flag/collection filters before `LIMIT ? OFFSET ?` pagination.
- [x] Shared worker pool & coordinator (`ThumbnailCoordinator` + `PhotoMetadataCoordinator`): executes outside Electron main enforcing `approvedRoots` containment, symlink/junction rejection, pre/post descriptor `fstat` stability, live off-main SHA-256 reuse verification (`verify_source`), transactional pre-commit `content_revision` revalidation, active cancellation, startup `interrupted` recovery, and aggregate resource bounds (`<= 2` live workers including terminating, `<= 1` active metadata task, `<= 1` active semantic task, `<= 64` queue yielding to interactive thumbnails).
- [x] Narrow typed `metadata:*` IPC + expanded `photos:get-page` with bidirectional Zod validation and sender checks, compact expandable `PhotoMetadataFilterPanel` and selected-photo provenance section in `PhotosPanel` with stale-response sequence/generation guards (`usePhotos.ts`, `usePhotoMetadata.ts`).
- [x] Verification scope & evidence distinctions:
  - Independent review accepted at `c8a766f`: reviewer inspected the correction diff and passed 10/10 parser tests (`tests/main/photo-metadata-parser.test.ts` exit 0).
  - Full test suite (894 tests across 72 test files, `npm test` exit 0, including 50,001-row SQL scale test) and real Electron verification results (`verify:metadata` 11/11 in built mode, `verify:metadata:unpacked` 12/12 in unpacked mode, and all 15 prior-stage regression/smoke checks) were reported by the implementation host.
  - Concurrency verification utilized 45 ms worker task delays (`PV_TEST_WORKER_METADATA_DELAY_MS=45` and `PV_TEST_WORKER_SEMANTIC_DELAY_MS=45` in `src/main/services/thumbnails/worker.ts`) to reliably observe simultaneous active metadata extraction and semantic embedding tasks during diagnostic polling across the shared image worker pool.
  - Bitwise source preservation confirmed across 66 immutable photos and 7 model files, noting OS read-only `atime` updates.

### Stage 6D - Natural-language photo search IPC, ranking, and Photos UI integration

**Complete; independently accepted at `1f07012`.**

- [x] **Offline Query Vector Generation & Dedicated Search Worker Lifecycle (`search-coordinator.ts`, `search-worker.ts`)**:
  - Dedicated background search worker (`search_worker.ts`) executing outside Electron main and renderer for tokenizer evaluation (`@huggingface/tokenizers@0.2.0`), ONNX text inference (`text_model_quantized.onnx`), candidate traversal, vector decoding, and ranking.
  - Strict aggregate resource bounds: $\le 1$ live search worker (`ensureWorker` waits for `terminatingWorkers` and `spawningWorkerPromise` so live workers never exceed 1), $\le 2$ image workers, and $\le 3$ total live workers across the application (counting terminating workers until process `'exit'`), plus bounded pending search capacity (`maxPendingRequests = 16`, throwing `SearchOverloadError` on saturation).
  - Pre-load model directory integrity revalidation (`verifyModelDirIntegrity`) off main before every load/search without a directory `mtimeMs` shortcut (verifying `realpathSync` containment, non-symlink `lstatSync`, and SHA-256 of all 7 artifacts, releasing cached ONNX text session/tokenizer via `releaseTextSession()` on failure or installation change); duplicate concurrent session loads prevented via retry-safe in-flight promise caching (`getOrEmbedQuery`).
  - Active worker cancellation, query supersession (checking `hadOlderActiveWork` before clearing old `activeRequests` so busy workers are terminated), execution timeouts (15,000 ms), shutdown cleanup, and capacity recovery.
  - Strict query input bounds ($\le 500$ characters, trimmed, non-empty) with honest 77-token truncation notice (`truncated: true`, `tokenCount: 77`).
  - Validation of query vectors at the ranking boundary (`validateQueryVector`): 512 dimensions, finite float32 values, non-zero L2 norm, unit normalization ($|\lVert v \rVert_2 - 1.0| \le 10^{-2}$).
  - Zero external query transmission or personal data upload; completely offline.
- [x] **Query Identity vs. Page-Request Generation (`search-coordinator.ts`, `usePhotos.ts`)**:
  - Distinguishes query identity (query text + filter parameters) from page requests. Multiple concurrent page requests for the same query generation (e.g. prefetching offset 0 and offset 50) proceed concurrently without cancelling each other.
  - Truly older queries are superseded and rejected with `SearchCancelledError` (never an empty `{ items: [] }` mask).
  - Deterministic coordinator and renderer tests covering delayed/out-of-order responses, query replacement, search clearing, filter changes, and returning to evicted pages.
- [x] **Complete Embedding Compatibility, Hydration Revalidation & Corrupt Candidate Isolation (`database.ts`, `search-worker.ts`, `search-coordinator.ts`, `vector.ts`)**:
  - Complete compatibility validation in candidate and coverage queries (`isSemanticEmbeddingRecordCompatible`): matches `model_id`, `model_commit`, `model_manifest_sha256`, `preprocessing_version`, `embedding_dimensions = 512`, `observed_byte_size = d.byte_size`, Stage 2B timestamp precision (`isObservationTimestampMatching`: exact equality for fractional `filesystem_mtime_ms`, `< 1.0 ms` for integer, conservative null check), exact canonical 5-part `content_revision` parsing (`^(semrev|rev):(\d+):(\d+):([^:]+):([0-9a-f]{64})$`), and active `hash_observations` `sha256` match (`h.sha256 IS NULL OR h.sha256 = se.content_sha256`). Tested each field independently without `LIKE` wildcards or loose tolerance.
  - Main-process hydration identity revalidation (`discoveryObservationId`, `observedByteSize`, `filesystemMtimeMs`, `activeHash`) with a single retry and count reconciliation when catalog state mutates between worker scoring and hydration.
  - Robust candidate error isolation (`tryDeserializeEmbeddingVector`): safely handles malformed lengths, NaN/Infinity, zero vectors, and non-unit vectors per candidate, skipping corrupt records without failing the search, excluding them from `eligibleCount`, and reporting `corruptCount`.
- [x] **Filter-Before-Ranking & Bounded Resource Bounds (`ranking.ts`, `TopKMinHeap`)**:
  - Filter-before-ranking: Prunes candidates using Stage 5B (rating, flag, collection) and Stage 6C (date range, camera, lens, resolution, file type) SQL filters BEFORE vector decoding and cosine score ranking. Non-matching photos are pruned at the database level and never occupy candidate heap space.
  - Incremental streaming candidate vector evaluation (`rankCandidatesWithBoundedPaging`): uses `TopKMinHeap` in JS memory for `offset + limit <= 1,000` ($O(\log K)$ sift operations, $O(1)$ rejection) and a private disk-backed temporary SQLite database (`new DatabaseSync('')` with `PRAGMA temp_store = FILE; PRAGMA cache_size = -2000;` — 2 MiB cache cap) for `offset + limit > 1,000` so all offsets remain reachable without whole-catalog JS index materialization or an unapproved collection/offset cap. Verified at scale with 50,001 synthetic embeddings and beyond offset 10,000.
  - Coverage counts report `eligibleCount` (compatible non-corrupt searchable embeddings), `unindexedCount`, `staleCount`, and `corruptCount`.
  - Deterministic tie-breaking: `score DESC, fileLocationId ASC`.
  - Pagination bounds: `offset: z.number().int().nonnegative()` (unbounded non-negative integer) and `limit: z.number().int().positive().max(100)`. Renderer `searchScores` map evicted alongside LRU page cache records.
- [x] **Typed IPC, Sandboxed Preload & Cancellation (`src/shared/`, `src/preload/`, `src/main/ipc/`)**:
  - Narrow typed IPC contracts: `SEMANTIC_SEARCH_PHOTOS` (`'semantic:search-photos'`), `SEMANTIC_SEARCH_CANCEL` (`'semantic:search-cancel'`).
  - Bidirectional runtime Zod schema validation and sender validation.
  - Sandboxed preload bundle verified to require only `electron`.
  - Active search cancellation promptly aborts in-flight worker searches and frees worker capacity.
- [x] **Photos UI Search Bar Integration (`PhotosSearchBar.tsx`, `usePhotos.ts`, `PhotosPanel.tsx`)**:
  - Compact search bar in Photos toolbar with input, clear button, loading spinner, match count badge, query latency and token count display, and unindexed/stale/corrupt coverage warnings (`data-testid="search-corrupt-warning"`).
  - Prominent disclaimer that matches are semantic AI inferences, not factual object labels.
  - Photo cards display percentage similarity match badges (`xx% match`).
  - Works seamlessly with all existing Stage 5B and Stage 6C filters.
  - Clearing search restores ordinary browsing without reload or state corruption.
  - Preserves selected-photo provenance, review actions, virtual-grid bounds, and scroll/pagination resets.
- [x] **Real-Electron Built & Unpacked Verification (`scripts/verify-electron-semantic-search.mjs`)**:
  - `verify:semantic-search` (25/25 checks passed in built mode).
  - `verify:semantic-search:unpacked` (26/26 checks passed in unpacked mode).
  - Exercises unprovisioned handling, off-main CLIP ViT-B/32 text embedding inference, natural-language query matches against real fixtures, filter-before-ranking candidate pruning, honest 77-token truncation, active search cancellation, Photos UI search bar integration, non-factual disclaimer display, card similarity badges, clearing search restoration of ordinary browsing, query latency, concurrent page requests, 10,200+ synthetic large-catalog deep pagination (`offset: 10050`, `corruptCount === 1`), main process heartbeat responsiveness (< 200 ms), and 100% source bitwise invariance.

### Pre-Stage-7 Modularity Maintenance (Planned)

Before implementing Stage 7 document extraction and unified search, execute a dedicated architecture maintenance pass to decompose oversized domain coordination surfaces into focused, single-responsibility modules:

- **Catalog Repository**: Split `database.ts` into cohesive repositories (`SourceRepository`, `ScanRepository`, `DuplicateRepository`, `VaultRepository`, `PhotoMetadataRepository`, `SemanticIndexRepository`, `SearchRepository`).
- **IPC Handlers**: Split monolithic IPC registration in `src/main/index.ts` and handler files into domain-scoped routers with isolated sender validation and channel subscriptions.
- **Preload Bridge & Schemas**: Modularize `src/preload/index.ts` and `src/shared/validation/ipc-schemas.ts` into domain contracts (`photos`, `metadata`, `semantic`, `vault`, `duplicates`, `scan`).
- **Photos UI**: Decompose `PhotosPanel.tsx` and `usePhotos.ts` into focused sub-components and domain hooks (toolbar, filter bar, search controls, virtual grid, provenance sidebar).

Planning only; no production refactoring was performed during Stage 6D.

### Stage 6 Checklist

- [x] Evaluate local embedding models and resource/packaging requirements (6A Complete; independently accepted at `155d7bd`).
- [x] Implement content-based photo search and a persistent search index (6B Complete; 6D Complete at `1f07012`; 6E Planned).
- [x] Filter by available date, camera, lens, resolution, and file-type metadata (6C Complete; independently accepted at `c8a766f`; 6D Complete at `1f07012`; 6E Planned).
- [x] Preserve unknown dates/locations and separate inferences from recorded facts (6B, 6C, and 6D Complete; 6E Planned).

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
