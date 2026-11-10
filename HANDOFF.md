# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-6a-semantic-evaluation` (created from verified Stage 5 closeout commit `9b8faa741a5ec81cfbb45a5b61acff20be82d61e`, descending from accepted Stage 5C commit `543135a`)
- **Base Commit**: `9b8faa7`
- **Stage 1 status**: Complete (independently accepted at `070e3cb`).
- **Stage 2 status**: Complete (all substages 2A-2D independently accepted; Stage 2D accepted at `71e1af7`, documentation closeout committed at `eea7daa`).
- **Stage 3 status**: Complete (independently accepted at `79bbf44`, documentation closeout committed at `cf91653`).
- **Stage 4 status**: Complete (independently accepted at `1a1fb69`, closeout at `8a17bfe`).
- **Stage 5 status**: **Complete; Substage 5A independently accepted at `951fd25`, 5B at `4071948`, 5C at `543135a`** (Stage 5 closeout at `9b8faa7`).
- **Stage 6 status**: **In progress**:
  - **Stage 6A (Offline Semantic Search Feasibility & Technical Spike)**: **Complete** (independently accepted at `155d7bd` / `155d7bd222654e0bce79741d546046616f4f0815` on `feat/stage-6a-semantic-evaluation`).
  - **Substages 6B–6E**: **Planned** (not started).
- **Evidence source**: Stage 6A verification results (741 tests across 62 files, repository quality gates, cached model verification, `ELECTRON_RUN_AS_NODE=1` spike rerun, and synthetic vector benchmark) are as reported by the independent reviewer at `155d7bd`; they were not re-run during this documentation closeout.
- **Constraints**: Never implement on `main`; no push or merge authorized. Preserve source preservation invariance: source files strictly read-only. Source files and vault copies are never touched, altered, moved, or deleted.

---

## 1. Stage 5C Implementation Summary & Technical Evidence

Stage 5C delivers a complete, conservative visual similarity review workflow: local perceptual fingerprinting of catalog photos, partitioned candidate pair search, side-by-side candidate comparison with honest recorded facts and algorithmic similarity scores, and durable user decision persistence.

### 1.1 Inviolable Principles & Source Preservation

- **Source Preservation**: Source photographs and vault copies are strictly read-only during fingerprinting, similarity search, and review. Fingerprinting uses read-only file descriptors (`open(path, 'r')`) and verifies pre/post descriptor identity and content SHA-256 before accepting derived results. No source files are ever touched, modified, moved, or deleted.
- **Provenance & Separation of Facts vs. Inferences**: Recorded facts (exact filename, absolute path, filesystem timestamps, byte size, verified SHA-256 hash, pixel dimensions when known) remain immutable recorded facts. Missing capture dates and dimensions remain explicit `Unknown`.
- **Machine Inferences vs. User Decisions**: Algorithmic similarity score (`(64 - distance) / 64`) is an uncalibrated machine inference based on `dhash64_v1`, explicitly labeled as algorithmic similarity rather than calibrated probability. Exact byte duplicates remain strictly under the Stage 3 duplicate workflow and are excluded from similarity candidate pairs. User decisions (`edited_version`, `similar_scene`, `unrelated`, `unreviewed`) are explicit user determinations persisted with two-phase journal durability.

### 1.2 Deterministic Fingerprinting & Algorithm Limits

- **Algorithm (`dhash64_v1`)**: Computes 64-bit difference hash (dHash) on 9x8 grayscale raw pixels after `.rotate()` orientation normalization. Adjacent horizontal pixel gradients produce 64 binary bits formatted as 16 hexadecimal digits and partitioned into 4x16-bit bucket integers for indexed retrieval.
- **Documented Algorithm Limits**:
  - Recompression and resizing preserve gradients accurately (Hamming distance <= 5, algorithmic similarity >= 90%).
  - Crops shift pixel positions and may be missed or receive high distance scores.
  - Rotations without EXIF metadata alter horizontal adjacencies and may not match.
  - Burst scenes and identical compositions with different subjects may yield close distances, requiring explicit user discrimination.
  - Uniform color or noise images produce zero gradients and identical fingerprints.

### 1.3 Database Architecture & Migration 8

Catalog database schema updated via Migration 8 (`CURRENT_SCHEMA_VERSION = 8`):

- `photo_perceptual_hashes`: stores `file_location_id`, `discovery_observation_id`, `content_sha256`, `content_revision`, `algorithm_version`, `fingerprint`, `bucket_0`..`bucket_3`, `width`, `height`, and `is_current`.
- `similarity_candidate_pairs`: records candidate pairs with canonical ordering `file_location_id_a < file_location_id_b`, `distance` (0..64), `similarity_score` (0.0..1.0), and `algorithm_version`.
- `similarity_decisions`: stores user review decisions (`edited_version`, `similar_scene`, `unrelated`, `unreviewed`) with canonical ordering `locA < locB`, revision tracking (`expectedRevisionA`, `expectedRevisionB`), monotonic versioning, and partial unique index `idx_sim_decision_pair_curr ON similarity_decisions(file_location_id_a, file_location_id_b) WHERE is_current = 1`.
- `similarity_jobs` & `similarity_job_items`: records analysis jobs with snapshot scope, progress counters, cancellation/interruption states, and per-item status tracking.

### 1.4 Partitioned Candidate Search & Numerical Bounds

- **Bucket-Indexed Search**: Queries potential matches across 4x16-bit buckets using SQLite index, eliminating unrestricted $O(N^2)$ all-pairs comparisons.
- **Exact Duplicate Exclusion**: Excludes pairs where `sha256_a === sha256_b` (handled by Stage 3 exact duplicate workflow).
- **Dense Candidate Caps**: Enforces max 50 candidates per photo and max 10,000 total candidate pairs persisted per run to prevent memory and database explosion.
- **Aggregate Concurrency Limits**: Shared decode worker pool strictly bounds concurrency to <= 2 live workers (including terminating workers), <= 64 queued jobs, and 15-second per-job timeout. Interactive browsing decodes take high priority, similarity background tasks take low priority.
- **Memory Retention Bounds**: Renderer virtual window bounded to <= 200 mounted DOM cells, LRU browsing cache bounded to <= 2,000 items, and candidate pair pagination bounded to 10 pairs per page.

### 1.5 Resumable Coordinator & Crash Consistency

- **Resumable Execution**: `SimilarityCoordinator` snapshots authorized photo IDs into `similarity_job_items`. Resume processes only pending items from the original job scope without including newly discovered files.
- **Cancellation & Crash Recovery**: Cooperative cancellation via `AbortSignal` updates status truthfully without appearing completed. Application startup marks running jobs as `interrupted`.
- **Content Revision Invalidation**: Perceptual hashes and decisions verify content revision (`rev:<discoveryId>:<byteSize>:<mtime>:<hash>`). Rescanning unchanged verified files reuses fingerprints; modified content invalidates prior active records and rejects stale writes with `REVISION_MISMATCH`.

### 1.6 Portable Decision Persistence & Two-Phase Commit

- **Annotation Journal Integration**: Decisions append `similarity_decision` records to `review-journal.jsonl` with `fsync` before committing to SQLite.
- **Post-Commit Persistence Pending**: If SQLite commits but journal flush fails, the operation returns `persistencePending: true`, displaying an honest pending banner with retry reconciliation without repeating database mutations.
- **Startup Reconciliation**: `reconcileJournalWithDatabase` iterates journal entries and reconciles pending operations via `op_committed` or `op_aborted`.

### 1.7 Renderer UI & Presentation Safety

- **Photos Tab Mode Toggle**: Switch between `#photos-mode-grid` and `#photos-mode-similarity`.
- **Side-by-Side Comparison**: Candidate cards display Photo A and Photo B side by side with thumbnails, filenames, source paths, dimensions, byte sizes, and timestamps.
- **Explicit Review Controls**: Buttons for `Edited Version`, `Similar Scene`, `Dismiss (Unrelated)`, and `Clear Decision` (returns to unreviewed).
- **Decision Filters & Bounded Pagination**: Filter candidate pairs by `All`, `Unreviewed`, `Edited Versions`, `Similar Scenes`, and `Dismissed`. Deterministic pagination with Prev/Next controls and page indicators.
- **Asynchronous Response Safety**: Monotonic request tokens and pure render state updaters prevent racing queries or delayed completions from corrupting presentation.

### 1.8 Independent Review Corrections & Evidence Distinctions from Candidate 3ea3454

The independent review of initial candidate `3ea3454` reported four actionable TypeScript findings under strict checking (`npm run typecheck` failed on `3ea3454` with 5 TS errors):

1. **`src/main/services/thumbnails/coordinator.ts:491`**: `ThumbnailResult`-only resolver assigned to a union-result callback.
   - _Correction_: Refactored `QueuedItem` into a discriminated union (`QueuedThumbnailItem | QueuedFingerprintItem`). Direct typed resolver assignment without unchecked casts (`resolve: (res: ThumbnailResult) => void` vs. `resolve: (res: FingerprintJobResult) => void`), guaranteeing compile-time discriminated routing.
2. **`tests/main/similarity-acceptance.test.ts:254`**: Conditional pagination assertion skipped under `noUncheckedIndexedAccess`.
   - _Correction_: Explicitly asserted page array lengths (`expect(page1.pairs.length).toBe(2)` and `expect(page2.pairs.length).toBeGreaterThan(0)`) and validated element definedness before comparing unique IDs across pages.
3. **`tests/main/similarity-ipc.test.ts:16`**: Nonexistent `SimilarityDecisionResult` import.
   - _Correction_: Imported correct schema type `SimilaritySetDecisionResponse` and updated test response assertions.
4. **`tests/main/similarity-ipc.test.ts:57`**: Sender validator mock contract mismatch with `IpcSenderEvent` (especially nullable `senderFrame`).
   - _Correction_: Typed mock events as `IpcSenderEvent` with optional-chaining sender-frame check; added test coverage verifying rejection of both untrusted origins and null sender frames.

**Distinction of Evidence**:

- `3ea3454`: Failed `npm run typecheck` with TS2322, TS2532, TS2724 across coordinator and test files.
- **Corrected Candidate**: Fully passes `npm run typecheck` (0 errors across Node and Web projects), passes all 733 tests across 61 test files, passes both built and unpacked real Electron similarity verifications, passes all prior-stage regressions, and strictly maintains all inviolable principles.

---

## 2. Real Electron Verification Suite

Real Electron automated verifications passed in both built and unpacked modes:

- `npm run verify:similarity`: Built mode verification (`scripts/verify-electron-similarity.mjs`) — 8/8 phases passed (scan, navigation, similarity analysis, progress, pair cards, explicit decisions, clear decision, filters, restart persistence, and bitwise source preservation).
- `npm run verify:similarity:unpacked`: Unpacked Windows desktop binary verification (`dist/win-unpacked/Personal Vault.exe`) — 8/8 phases passed.

---

## 3. Verification Quality Gates Matrix

All verification commands executed from `D:\organizer`:

| Verification Gate / Suite                 | Command                                | Result                         | Exit Code | Notes                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------- | ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit & Behavioral Tests**               | `npm test`                             | **733 passed across 61 files** | 0         | Full coverage: fingerprinting, candidate search, similarity catalog queries, coordinator lifecycle, IPC validation & handlers, renderer UI, acceptance suite with derivatives/distinct/exact duplicates/corrupt/ordering/pagination/revisions/journal/cancellation/10k dense fixtures/source preservation |
| **Strict Typecheck**                      | `npm run typecheck`                    | **Clean pass**                 | 0         | TypeScript strict checking across Node and Web targets (0 errors)                                                                                                                                                                                                                                         |
| **ESLint**                                | `npm run lint`                         | **Clean pass**                 | 0         | Codebase compliant (0 errors, 0 warnings)                                                                                                                                                                                                                                                                 |
| **Formatting Compliance**                 | `npm run format:check`                 | **Clean pass**                 | 0         | 100% Prettier compliant                                                                                                                                                                                                                                                                                   |
| **Production Bundle Build**               | `npm run build`                        | **Clean pass**                 | 0         | Main, preload, worker, and renderer bundles built cleanly                                                                                                                                                                                                                                                 |
| **Desktop Unpacked Build**                | `npm run build:unpack`                 | **Clean pass**                 | 0         | `dist/win-unpacked/Personal Vault.exe` built with native Sharp binaries in `app.asar.unpacked`                                                                                                                                                                                                            |
| **Real Electron Similarity (Built)**      | `npm run verify:similarity`            | **8/8 passed**                 | 0         | Stage 5C real Electron: scan, navigate to similarity, trigger analysis, verify progress, candidate pair cards, all 4 review decisions, clear decision, filters, restart persistence, source preservation invariance                                                                                       |
| **Real Electron Similarity (Unpacked)**   | `npm run verify:similarity:unpacked`   | **8/8 passed**                 | 0         | Complete 8-step visual similarity verification on packaged Windows executable                                                                                                                                                                                                                             |
| **Real Electron Photo Review (Built)**    | `npm run verify:photo-review`          | **12/12 passed**               | 0         | Stage 5B regression check: ratings, flags, collections, combined SQL filters, restart reconciliation, 3k scale browsing, source preservation                                                                                                                                                              |
| **Real Electron Photo Review (Unpacked)** | `npm run verify:photo-review:unpacked` | **12/12 passed**               | 0         | Complete 12-check photo review verification on packaged Windows executable                                                                                                                                                                                                                                |
| **Real Electron Photos (Built)**          | `npm run verify:photos`                | **19/19 passed**               | 0         | Stage 5A regression check: thumbnail decoding, orientation, format support, cache reuse, publication interruption, 10k scale checkpoints, resource bounds, source preservation                                                                                                                            |
| **Real Electron Photos (Unpacked)**       | `npm run verify:photos:unpacked`       | **19/19 passed**               | 0         | Complete 19-step photo browsing verification on packaged Windows executable                                                                                                                                                                                                                               |
| **Real Electron Vault Import (Built)**    | `npm run verify:vault`                 | **11/11 passed**               | 0         | Stage 4 regression check: vault init, overlap reject, verified copying, manifests, duplicate merging, cancel, restart recovery, source preservation                                                                                                                                                       |
| **Real Electron Vault Import (Unpacked)** | `npm run verify:vault:unpacked`        | **11/11 passed**               | 0         | Complete 11-check vault import verification on packaged Windows executable                                                                                                                                                                                                                                |
| **Real Electron Duplicate Review**        | `npm run verify:duplicates`            | **18/18 passed**               | 0         | Stage 3 regression check: duplicate grouping, review persistence, out-of-band invalidation, stale rejection, source preservation                                                                                                                                                                          |
| **Real Electron Scan & Recovery**         | `npm run verify:scan`                  | **14/14 passed**               | 0         | Stage 2 regression check: scan, pause/resume, mid-flight process kill recovery, restart revalidation, source preservation                                                                                                                                                                                 |
| **Real Electron SQLite Repository**       | `npm run verify:sqlite`                | **8/8 passed**                 | 0         | Electron `node:sqlite` driver verification                                                                                                                                                                                                                                                                |
| **Real Electron Smoke (Built)**           | `npm run smoke:built`                  | **Passed**                     | 0         | Preload bridge surface (including all 7 Stage 5C similarity methods), navigation guards, CSP                                                                                                                                                                                                              |
| **Real Electron Smoke (Unpacked)**        | `npm run smoke:unpacked`               | **Passed**                     | 0         | Packaged binary smoke check                                                                                                                                                                                                                                                                               |
| **Source Preservation Invariance**        | Across all suites                      | **Confirmed**                  | 0         | Byte-for-byte identical, untouched source originals across all workflows                                                                                                                                                                                                                                  |

---

## 4. Preserved Unrelated Files & Working Tree

The following unrelated files remain intact and untouched:

- `.codex/` directory
- `scripts/launch-desktop.ps1`
- `scripts/verify-bridge-and-dialog.mjs`
- `scripts/verify-desktop-window.ps1`

---

## 5. Stage 6A Summary, Independent Review Evidence, Scope Boundaries & Next Steps

### 5.1 Deliverable & Recommendation

- **Stage 6A Status**: **Complete; independently accepted at `155d7bd` (`155d7bd222654e0bce79741d546046616f4f0815`)**.
- **Stage 6A Deliverable**: Bounded offline semantic search evaluation (`docs/stage-6a-semantic-search-evaluation.md`), isolated executable Electron spike (`spikes/semantic-eval/`), and unit tests for pure vector/revision logic (`tests/main/semantic-spike-core.test.ts`).
- **Recommendation**: CLIP ViT-B/32 quantized ONNX (`Xenova/clip-vit-base-patch32` @ `6b7c523703ae26e39be4b03774966f8571c7f523`, MIT license, $148.63\text{ MiB}$) executed in a worker thread via `onnxruntime-node@1.31.1` (MIT) + `@huggingface/tokenizers@0.2.0` (Apache-2.0) + `sharp@0.35.5` (Apache-2.0), paired with an exact linear scan over 512-d `Float32Array` vectors in `node:sqlite`.
- **Proposed Product Choices (Not User-Approved)**: The **$50,000$-photo** semantic index cap ($97.66\text{ MiB}$ raw vector payload / $\sim 198.35\text{ MiB}$ SQLite table) and model provisioning choices ($148.63\text{ MiB}$ explicit checksum-verified download and/or local bundle import) are **proposed** engineering/product bounds, not user-approved decisions.

### 5.2 Implementation-Host vs. Independent Reviewer Rerun Measurements (`155d7bd`)

All verification results at `155d7bd` below were executed and reported by the independent reviewer (not re-run during this closeout):

- **Repository Quality Gates (Independent Reviewer at `155d7bd`)**:
  - `npm test`: **741 passed across 62 test files** (exit 0), including `tests/main/semantic-spike-core.test.ts` (8 tests).
  - `npm run typecheck`: **Clean pass** (exit 0).
  - `npm run lint`: **Clean pass** (exit 0).
  - `npm run format:check`: **Clean pass** (exit 0).
  - `npm run build`: **Clean pass** (exit 0).
  - `node spikes/semantic-eval/fetch-model.mjs`: **Clean pass** (exit 0; verified all 7 cached files / $148.63\text{ MiB}$ against pinned SHA-256 digests with 0 network downloads).
- **Electron Spike (`node spikes/semantic-eval/run-electron-spike.mjs` via `ELECTRON_RUN_AS_NODE=1`, exit 0)** & **Vector Benchmark (`node spikes/semantic-eval/benchmark-index.mjs`, exit 0)**:

| Metric                                                                        | Implementation Run Value                                              | Independent Reviewer Rerun Value (`155d7bd`)                            | Evidence Scope / Notes                                                                                                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cold ONNX Session + Tokenizer Load**                                        | $367.36\text{ ms}$                                                    | $467.56\text{ ms}$                                                      | Vision + Text INT8 ONNX + `CLIPTokenizer`                                                                                                                                    |
| **Warm Per-Image Embedding Mean**                                             | $28.37\text{ ms}$ ($2.85\text{ ms}$ decode + $25.52\text{ ms}$ infer) | $46.70\text{ ms}$ ($4.86\text{ ms}$ decode + $41.84\text{ ms}$ infer)   | $35.24\text{ img/s}$ (impl.) / $21.41\text{ img/s}$ (reviewer rerun)                                                                                                         |
| **Warm Text Query Embedding Mean**                                            | $3.39\text{ ms}$                                                      | $5.32\text{ ms}$                                                        | 7/7 synthetic nonpersonal queries passed relevance rubric ($\text{margin} \ge +0.0901$)                                                                                      |
| **Sampled Process-Wide RSS (`process.memoryUsage().rss`)**                    | $453.98\text{ MiB}$ (end: $449.91\text{ MiB}$)                        | $455.34\text{ MiB}$ (end: $451.64\text{ MiB}$)                          | Sampled post-inference max across entire OS process (main + worker + shared native DLLs); **not** worker-exclusive or continuous peak                                        |
| **Sampled Worker-Isolate V8 Heap (`heapUsed`)**                               | $16.94\text{ MiB}$                                                    | $19.99\text{ MiB}$                                                      | Sampled post-inference max of worker V8 isolate heap                                                                                                                         |
| **Headless Parent Event-Loop Delay Probe (`ELECTRON_RUN_AS_NODE=1`)**         | p95 = $16.49\text{ ms}$, max = $24.40\text{ ms}$                      | p95 = $16.28\text{ ms}$, max = $24.13\text{ ms}$                        | Headless parent Node loop probe only; does **not** establish `BrowserWindow`/IPC/renderer UI responsiveness                                                                  |
| **Synthetic 512-d `Float32Array` Exact Scan (10,000 vectors)**                | $4.95\text{ ms}$ in-mem / $42.15\text{ ms}$ SQLite                    | $5.79\text{ ms}$ in-mem / $55.09\text{ ms}$ SQLite                      | Synthetic L2-normalized vectors                                                                                                                                              |
| **Synthetic 512-d `Float32Array` Exact Scan (50,000 vectors — proposed cap)** | $26.78\text{ ms}$ in-mem / $202.15\text{ ms}$ SQLite                  | $34.21\text{ ms}$ in-mem / $300.06\text{ ms}$–$340.32\text{ ms}$ SQLite | Proposed $50,000$-photo cap (not yet user-approved)                                                                                                                          |
| **Failure Modes, Cancellation & Source Preservation**                         | Verified                                                              | Verified                                                                | Missing model (`MISSING_MODEL`), HEIC (`unsupported`), corrupt JPEG (`DECODE_FAILED`), active cancellation (`CANCELLED` + worker recovery), 100% bitwise source preservation |

### 5.3 Verification Scope Limitations & Retained Stage 6B+ Production Follow-Ups

- **`ELECTRON_RUN_AS_NODE=1` Verification Boundary**: Executing under `electron.exe` with `ELECTRON_RUN_AS_NODE=1` proves N-API v6 native addon loading (`onnxruntime-node`), `sharp`, `@huggingface/tokenizers`, `worker_threads`, and `node:sqlite` inside the Electron 45.2.3 runtime binary. **It does not establish `BrowserWindow`/IPC responsiveness or packaged-app (`app.asar` / `app.asar.unpacked`) compatibility.**
- **Retained Stage 6B+ Production Follow-Ups**:
  1. **Correct Preprocessing Recipe Naming & Single-Pass Decode**: Rename the preprocessing version constant to reflect the actual bicubic kernel (`clip_vit_b32_224_bicubic_center_rgb_v1` matching `sharp.kernel.cubic` / CLIP `resample: 3`) and avoid double `sharp(buffer)` instantiation.
  2. **Approved-Root Enforcement**: Enforce canonical `realpathSync` containment against registered catalog `approvedRoots` directly inside the production semantic worker alongside pre/post `stat` and stream-hash verification.
  3. **Aggregate Worker & Resource Accounting**: Count terminating workers against the aggregate $\le 2$ live decode/inference worker cap until process `'exit'` and yield/pause background semantic indexing when interactive viewport thumbnail decodes are active.
  4. **Real Unpacked Native-Runtime & Windowed Verification**: Exercise `onnxruntime-node` native binary resolution from `app.asar.unpacked` in a real `npm run build:unpack` smoke/verification script and verify `BrowserWindow`/IPC responsiveness in Stage 6B–6E.
- **Scope Exclusions**: No production search UI, IPC, or catalog schema changes implemented in Stage 6A; header search placeholder untouched; model cache and spike `node_modules` gitignored and isolated from app bundles.
- **Stage 6 Status**: In progress — Stage 6A Complete (independently accepted at `155d7bd`); Substages 6B–6E Planned.
- **Git State**: Committed locally on `feat/stage-6a-semantic-evaluation` branched from `9b8faa7`. Do NOT push or merge.
