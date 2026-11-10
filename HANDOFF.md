# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-6b-semantic-index` (created from verified Stage 6A closeout commit `ad796b4`, descending from accepted Stage 6A implementation `155d7bd` and Stage 5 closeout `9b8faa7`)
- **Base Commit**: `ad796b4`
- **Stage 1 status**: Complete (independently accepted at `070e3cb`).
- **Stage 2 status**: Complete (all substages 2A-2D independently accepted; Stage 2D accepted at `71e1af7`, documentation closeout committed at `eea7daa`).
- **Stage 3 status**: Complete (independently accepted at `79bbf44`, documentation closeout committed at `cf91653`).
- **Stage 4 status**: Complete (independently accepted at `1a1fb69`, closeout at `8a17bfe`).
- **Stage 5 status**: **Complete; Substage 5A independently accepted at `951fd25`, 5B at `4071948`, 5C at `543135a`** (Stage 5 closeout at `9b8faa7`).
- **Stage 6 status**: **In progress**:
  - **Stage 6A (Offline Semantic Search Feasibility & Technical Spike)**: **Complete** (independently accepted at `155d7bd` on `feat/stage-6a-semantic-evaluation`, closeout at `ad796b4`).
  - **Stage 6B (Model Provisioning, Resumable Semantic Indexing & Persistent SQLite Index)**: **Awaiting review** on `feat/stage-6b-semantic-index`.
  - **Substages 6C–6E**: **Planned** (not started).
- **Constraints**: Never implement on `main`; no push, merge, or publication is authorized. Preserve source preservation invariance: source files strictly read-only. Source files and vault copies are never touched, altered, moved, or deleted.

---

## 1. Stage 6B Implementation Summary & Technical Evidence

Stage 6B promotes the evaluated CLIP ViT-B/32 quantized ONNX approach from Stage 6A into modular production code (`src/main/services/semantic/`, `src/main/services/thumbnails/`, `src/main/services/catalog/`), without importing runtime code from `spikes/`. It enables explicit in-app model download or offline folder import, resumable background semantic indexing of catalog photographs with honest progress and coverage reporting, pause/resume/cancel, restart recovery, and persistent SQLite storage for Stage 6D search.

### 1.1 Inviolable Principles & Source Preservation

- **Source Preservation**: Source photographs are opened strictly read-only (`open(path, 'r')`) inside the worker thread. Pre/post descriptor checks (`fstat`), sub-millisecond `mtimeMs`/`birthtimeMs` verification, canonical `approvedRoots` containment (`realpathSync` + symlink/junction rejection), and streaming SHA-256 verification are enforced before accepting any embedding or reusing a content-addressed vector. Original source bytes, byte sizes, creation timestamps (`birthtimeMs`), and modification timestamps (`mtimeMs`) remain bitwise unchanged across all operations (noting that operating systems may update filesystem access time `atime` during read-only file opens depending on mount settings).
- **Provenance & Separation of Facts vs. Derived Embeddings**: Immutable recorded facts (`file_locations`, `discovery_observations`, `hash_observations`) remain untouched. Derived 512-dimensional embeddings live in `photo_semantic_embeddings`, explicitly bound to verified content identity (`content_sha256`, `content_revision`), observation/location (`file_location_id`, `discovery_observation_id`), model artifact identity (`model_id`, `model_commit`, `model_manifest_sha256`), preprocessing recipe (`preprocessing_version`), and dimensions (`vector_dimensions = 512`). Embeddings are rebuildable derived data (not journaled to `review-journal.jsonl`) and are never presented as factual labels.
- **Privacy & Offline First**: Model installation requires explicit user action (`Download Model` or `Import Local Folder`) after displaying the ~148.63 MiB size requirement. No automatic downloads occur on startup or inference. Downloads are restricted to HTTPS GET requests for the 7 pinned model artifacts from approved Hugging Face / XetHub CDN origins (`huggingface.co`, `cas-bridge.xethub.hf.co`, `cdn-lfs.hf.co`, `cdn-lfs-us-1.hf.co`, `cdn-lfs-eu-1.hf.co`); no personal images, filenames, metadata, or queries ever leave the device.

### 1.2 Pinned Model Provenance & Safe Provisioning (`src/main/services/semantic/manifest.ts`, `model-manager.ts`)

- **Pinned Model Identity**:
  - Model ID: `Xenova/clip-vit-base-patch32`
  - Commit Revision: `6b7c523703ae26e39be4b03774966f8571c7f523`
  - Artifact Set: 7 required files (`config.json`, `preprocessor_config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `onnx/vision_model_quantized.onnx`, `onnx/text_model_quantized.onnx`), exact total size `155,851,918` bytes (`148.63 MiB`), each verified against its pinned SHA-256 digest and combined `MODEL_MANIFEST_SHA256`.
  - Preprocessing Recipe: `clip_vit_b32_224_bicubic_center_rgb_v1` (actual bicubic `sharp.kernel.cubic` 224x224 center-crop RGB, normalized with CLIP means `[0.48145466, 0.4578275, 0.40821073]` and stds `[0.26862954, 0.26130258, 0.27577711]`).
  - Vector Dimensions: `512` (`Float32Array`, `2,048` bytes per L2-normalized vector).
- **Storage Containment & Staging**:
  - Managed model storage resides in `<userData>/models/`, validated via `canonicalizeWithAncestorPolicySync` to reject any overlap or symlink/junction redirection with registered source roots (`catalog.getAllSourceRoots()`) or active vault storage.
  - Provisioning stages files inside an exclusive directory `.pv_model_staging_<pid>_<uuid>`, verifies exact byte sizes and SHA-256 digests off main (`validate_files` worker task), publishes files into the managed install directory, and writes `model_manifest.json` last so interrupted installations never appear `ready`.
  - Startup cleans up any abandoned `.pv_model_staging_*` directories while preserving unrelated files.
  - Failed or cancelled replacement downloads/imports preserve any existing verified installation so it remains usable.
  - Offline folder import uses a main-process native folder picker (`dialog.showOpenDialog`) and copies verified artifacts into `<userData>/models/` while leaving the user's selected source directory completely untouched.
  - Before starting or resuming any semantic index job, `revalidateForLoading()` re-verifies all 7 installed model files off main.

### 1.3 Persistent SQLite Index & Migration 9 (`src/main/services/catalog/migrations.ts`, `database.ts`)

- **Schema Migration 9 (`CURRENT_SCHEMA_VERSION = 9`)**:
  - `photo_semantic_embeddings`: stores `file_location_id`, `discovery_observation_id`, `content_sha256`, `content_revision`, `model_id`, `model_commit`, `model_manifest_sha256`, `preprocessing_version`, `vector_dimensions`, `embedding_blob` (`BLOB`), `created_at_ms`, and `is_current` (`0` or `1`), with partial unique index `idx_sem_emb_curr ON photo_semantic_embeddings(file_location_id, model_id, model_commit, model_manifest_sha256, preprocessing_version) WHERE is_current = 1` and content-reuse index `idx_sem_emb_sha256_curr`.
  - `semantic_index_jobs`: tracks `id`, `status` (`running`, `paused`, `cancelled`, `interrupted`, `failed`, `completed`), model/recipe identity, `total_photos`, `processed_photos`, `indexed_photos`, `reused_photos`, `unsupported_photos`, `failed_photos`, `started_at_ms`, `updated_at_ms`, `completed_at_ms`, and `last_error`.
  - `semantic_index_job_items`: snapshots authorized photo items (`job_id`, `file_location_id`, `expected_revision`, `status`, `error_code`, `error_message`, `updated_at_ms`).
- **Disk-Backed Job Scope & Bounded Pagination**:
  - No permanent 50,000-photo catalog cap is imposed. `createSemanticIndexJob` snapshots only active photo locations that do not already have a current embedding for the target `(modelId, modelCommit, modelManifestSha256, preprocessingVersion)`.
  - Verified at **50,001 photos** in `tests/main/catalog-semantic-index.test.ts` with bounded 500-item batch pagination (`getSemanticJobPendingItems(jobId, 500)`).
  - Resuming an interrupted or paused job processes strictly the remaining `pending` items from the original `semantic_index_job_items` snapshot without silently including photos discovered after the job was created.
- **Vector Validation, Live-Source Reuse & Revision Invalidation**:
  - `validateEmbeddingVector` / `validateEmbeddingBlob` (`src/main/services/semantic/vector.ts`) enforce exact 512 dimensions (`2,048` bytes), finite float32 values (rejecting `NaN`/`Infinity`), and L2 unit norm ($|\lVert v \rVert_2 - 1.0| \le 10^{-3}$).
  - Content-addressed vector reuse (`findReusableSemanticEmbedding`) is accepted only after the worker verifies the live source file on disk (`verify_source` action checking `approvedRoots` containment, byte size, sub-millisecond `mtimeMs`/`birthtimeMs`, and streaming SHA-256).
  - Pre-commit transaction check (`recordSemanticEmbeddingAndCompleteItem`): verifies the photo's current catalog `content_revision` inside a SQLite transaction; if the source changed during processing, the item is recorded as `failed` with `REVISION_MISMATCH` and no stale vector is marked current.
  - Model or recipe version changes invalidate non-matching embeddings via `invalidateEmbeddingsForModelOrRecipe`.

### 1.4 Shared Worker Pool & Numerical Resource Bounds (`ThumbnailCoordinator` + `SemanticIndexCoordinator`)

| Resource / Parameter             | Enforced Production Bound                                                                | Implementation Mechanism                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aggregate Live Image Workers** | $\le 2$ live workers (including terminating workers until `'exit'`)                      | Shared `ThumbnailCoordinator` pool across thumbnails, `dhash64_v1`, and `semantic_embed`                                                                                   |
| **Active Semantic Tasks**        | $\le 1$ concurrent `semantic_embed` task                                                 | `activeSemanticCount < 1` gate in `ThumbnailCoordinator.processQueue()`                                                                                                    |
| **Loaded ONNX Model Sessions**   | $\le 1$ worker holding a loaded vision session                                           | Bound to `semanticSessionWorkerId`; released on job completion/pause/cancel/shutdown via `release_semantic_session`                                                        |
| **ONNX CPU Threads**             | `intraOpNumThreads: 2`, `interOpNumThreads: 1`, `cpuMemArena: false`                     | Configured in `worker.ts` `ensureSemanticSession`                                                                                                                          |
| **Aggregate Worker Queue**       | $\le 64$ total queued requests ($\ge 32$ reserved for interactive thumbnails)            | Low-priority jobs rejected when `queue.length >= 32`; `SemanticIndexCoordinator` yields while high-priority thumbnail decodes are queued/active                            |
| **Per-Task Execution Timeout**   | $15,000\text{ ms}$                                                                       | Worker terminated on timeout or active cancellation (`cancelSemanticRequests`); capacity recovered upon `'exit'`                                                           |
| **Source File Limits**           | $\le 128\text{ MiB}$ (`MAX_SOURCE_SIZE_BYTES`), $\le 100\text{ MP}$ (`MAX_INPUT_PIXELS`) | Enforced before/during read and header inspection in `decoder.ts`                                                                                                          |
| **Single-Pass Preprocessing**    | 1 `sharp` pipeline per photo                                                             | `decodeAndPreprocessForClip` reads header + `.rotate().resize(224, 224, { fit: 'cover', position: 'centre', kernel: sharp.kernel.cubic }).removeAlpha().raw()` in one pass |
| **Renderer Virtual Grid Bounds** | $\le 200$ mounted DOM cells, $\le 2,000$ retained metadata records                       | Preserved in `PhotosPanel.tsx` and `usePhotos.ts`; verified during active indexing + scrolling                                                                             |

### 1.5 IPC, Renderer UI & Stale-Response Safety

- **Narrow Typed IPC Channels (`semantic:*`)**:
  - `semantic:get-model-status`, `semantic:download-model`, `semantic:import-model-folder`, `semantic:cancel-model-setup`, `semantic:model-status-event`
  - `semantic:start-index`, `semantic:pause-index`, `semantic:resume-index`, `semantic:cancel-index`, `semantic:get-index-progress`, `semantic:index-progress-event`
  - All requests, responses, and push events are validated bidirectionally with Zod schemas (`src/shared/validation/ipc-schemas.ts`), and every main-process handler enforces top-level trusted-frame sender checks (`validateSender`). Event-only channels also register sender-checked handlers rejecting direct invocation.
- **Photos View UI (`SemanticIndexPanel.tsx` & `useSemanticIndex.ts`)**:
  - Compact panel integrated into the Photos view displaying model status (`Missing`, `Installing`, `Ready`, `Cancelled`, `Error`), the ~148.63 MiB model size requirement before setup, explicit `Download Model (~149 MiB)` and `Import Local Folder` buttons, and indexing controls (`Start Semantic Indexing`, `Pause`, `Resume`, `Cancel`) with coverage and job counters (`Indexed`, `Processed`, `Reused`, `Unsupported`, `Failed`, `Pending`).
  - Plainly explains that indexing prepares offline semantic search for Stage 6D and does not assign factual labels. Header search remains disabled (`Semantic photo search (Stage 6D)`).
  - Monotonic request generation counters (`modelReqGenRef`, `indexReqGenRef`, `mountedRef`) guard against stale asynchronous responses across jobs, model changes, view switches, restart refreshes, and unmount.

---

## 2. Verification Scope Distinctions & Real Electron Measurements

### 2.1 Large-Scale Repository Tests vs. Real-Electron Decodable Fixture Suites

- **Repository Scale Test (`tests/main/catalog-semantic-index.test.ts`)**:
  - Exercises SQLite Migration 9, job scope snapshotting, and bounded batch pagination (`getSemanticJobPendingItems` in 500-item pages) across **50,001 cataloged photo rows** without loading the whole index into memory. This verifies SQLite repository scalability and proves there is no 50,000-photo permanent catalog cap; synthetic database rows are **not** used to claim ONNX inference throughput.
- **Real-Electron Built & Unpacked Suites (`scripts/verify-electron-semantic-index.mjs` via `npm run verify:semantic-index` and `npm run verify:semantic-index:unpacked`)**:
  - Launches the real Electron `BrowserWindow` (built bundle and packaged `dist/win-unpacked/Personal Vault.exe`), attaches via Chrome DevTools Protocol (CDP), and exercises real decodable image fixtures (JPEGs, duplicate content for live-source reuse verification, unsupported `.heic`, and corrupt `.jpg`) plus a local HTTP fixture server testing corrupt-digest download rejection (`DIGEST_MISMATCH`):
    1. Preload bridge exposure (`window.api` 11 semantic methods) and initial `missing` model state with ~148.63 MiB size notice.
    2. Local HTTP download failure rejection (`DIGEST_MISMATCH`) leaving model status truthful (`error`, never `ready`) and cleaning staging files.
    3. Offline model folder import (`importSemanticModelFromPath`) verifying all 7 artifacts off main, transitioning to `ready`, and leaving the source model folder untouched.
    4. Source photo scan, semantic index start, pause/resume, completion with accurate counts (`indexed`, `reused`, `unsupported`, `failed`), and out-of-band changed-source rejection (`FILE_CHANGED`).
    5. Restart persistence of indexed coverage (`12/14` current embeddings), mid-job active cancellation (`cancelled`), and deterministic mid-job `SIGKILL` crash recovery (`interrupted` on restart -> newly scanned photo excluded from resumed job scope -> exact-scope resume to `completed`).
    6. Interactive photo grid scrolling + concurrent perceptual similarity analysis + active semantic indexing over 60 decodable JPEG fixtures, measuring continuous `requestAnimationFrame` frame intervals, main-process event-loop delay (`monitorEventLoopDelay`), renderer-to-main IPC round-trip latency, worker/queue bounds, and sampled memory.

### 2.2 Real-Electron Performance, Resource & Sampled Memory Summary

_(Note: Memory figures below are periodic point samples collected every ~60 ms during active indexing + scrolling via `process.memoryUsage().rss` in Electron main, `process.memoryUsage().heapUsed` inside the worker V8 isolate, and `performance.memory.usedJSHeapSize` in the renderer; they represent sampled maxima across the test workload, not continuous OS kernel high-water marks.)_

| Metric                                              | Built Mode (`npm run verify:semantic-index`)   | Unpacked Mode (`npm run verify:semantic-index:unpacked`) | Enforced Bound / Target           |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| **Verification Phases Passed**                      | **10 / 10** (exit 0)                           | **11 / 11** (exit 0, incl. `app.asar.unpacked` check)    | 100% pass                         |
| **Renderer rAF Frame Interval p95**                 | `4.30 ms`                                      | `4.30 ms`                                                | $\le 33\text{ ms}$                |
| **Main Process Event-Loop Delay p95**               | `16.15 ms`                                     | `16.11 ms`                                               | $\le 100\text{ ms}$               |
| **Renderer-to-Main IPC Round-Trip p95**             | `2.09 ms`                                      | `2.25 ms`                                                | $\le 100\text{ ms}$               |
| **Peak Live Image Workers (incl. terminating)**     | `2`                                            | `2`                                                      | $\le 2$                           |
| **Peak Active Semantic Tasks**                      | `1`                                            | `1`                                                      | $\le 1$                           |
| **Peak Workers Holding Loaded ONNX Session**        | `1`                                            | `1`                                                      | $\le 1$                           |
| **Peak Queued Worker Jobs**                         | `13`                                           | `13`                                                     | $\le 64$                          |
| **Peak Mounted DOM Photo Cells**                    | `20`                                           | `20`                                                     | $\le 200$                         |
| **Sampled Main Process RSS Max (`rss`)**            | `320.09 MiB`                                   | `336.56 MiB`                                             | Point-sampled process-wide RSS    |
| **Sampled Worker Isolate V8 Heap Max (`heapUsed`)** | `7.56 MiB`                                     | `9.26 MiB`                                               | Point-sampled worker isolate heap |
| **Sampled Renderer JS Heap Max**                    | `10.68 MiB`                                    | `10.68 MiB`                                              | Point-sampled renderer V8 heap    |
| **Source Preservation Invariance**                  | **Confirmed** (`0` byte/mtime/birthtime diffs) | **Confirmed** (`0` byte/mtime/birthtime diffs)           | Bitwise & timestamp invariant     |

---

## 3. Verification Quality Gates Matrix

All 21 required verification commands executed from `D:\organizer` on `feat/stage-6b-semantic-index`:

| Verification Gate / Suite                   | Command                                  | Result                         | Exit Code | Notes                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------- | ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit & Behavioral Tests**                 | `npm test`                               | **827 passed across 67 files** | 0         | Includes `semantic-model-manager.test.ts` (17), `catalog-semantic-index.test.ts` (20, incl. 50,001-photo scale test), `semantic-index-coordinator.test.ts` (14), `semantic-ipc.test.ts` (23), `SemanticIndexPanel.test.tsx` (12), plus all prior suites |
| **Strict Typecheck**                        | `npm run typecheck`                      | **Clean pass**                 | 0         | TypeScript strict checking across Node and Web targets (0 errors)                                                                                                                                                                                       |
| **ESLint**                                  | `npm run lint`                           | **Clean pass**                 | 0         | 0 errors, 0 warnings                                                                                                                                                                                                                                    |
| **Formatting Compliance**                   | `npm run format:check`                   | **Clean pass**                 | 0         | 100% Prettier compliant                                                                                                                                                                                                                                 |
| **Production Bundle Build**                 | `npm run build`                          | **Clean pass**                 | 0         | Main, preload, worker, and renderer bundles built cleanly                                                                                                                                                                                               |
| **Desktop Unpacked Build**                  | `npm run build:unpack`                   | **Clean pass**                 | 0         | `dist/win-unpacked/Personal Vault.exe` built with `sharp` and `onnxruntime-node` in `app.asar.unpacked`, `THIRD_PARTY_NOTICES.md` included, and no `spikes/` bundled                                                                                    |
| **Real Electron Semantic Index (Built)**    | `npm run verify:semantic-index`          | **10/10 passed**               | 0         | Stage 6B real Electron: download failure rejection, local model import, start/pause/resume, active cancel, `SIGKILL` crash + exact-scope resume, changed-source rejection, browsing + similarity competition, source invariance                         |
| **Real Electron Semantic Index (Unpacked)** | `npm run verify:semantic-index:unpacked` | **11/11 passed**               | 0         | Packaged Windows binary verification including `app.asar.unpacked` `onnxruntime_binding.node` check and `spikes/` exclusion check                                                                                                                       |
| **Real Electron Similarity (Built)**        | `npm run verify:similarity`              | **8/8 passed**                 | 0         | Stage 5C regression check                                                                                                                                                                                                                               |
| **Real Electron Similarity (Unpacked)**     | `npm run verify:similarity:unpacked`     | **8/8 passed**                 | 0         | Stage 5C unpacked regression check                                                                                                                                                                                                                      |
| **Real Electron Photo Review (Built)**      | `npm run verify:photo-review`            | **12/12 passed**               | 0         | Stage 5B regression check                                                                                                                                                                                                                               |
| **Real Electron Photo Review (Unpacked)**   | `npm run verify:photo-review:unpacked`   | **12/12 passed**               | 0         | Stage 5B unpacked regression check                                                                                                                                                                                                                      |
| **Real Electron Photos (Built)**            | `npm run verify:photos`                  | **19/19 passed**               | 0         | Stage 5A 10k-photo regression check                                                                                                                                                                                                                     |
| **Real Electron Photos (Unpacked)**         | `npm run verify:photos:unpacked`         | **19/19 passed**               | 0         | Stage 5A unpacked 10k-photo regression check                                                                                                                                                                                                            |
| **Real Electron Duplicate Review**          | `npm run verify:duplicates`              | **18/18 passed**               | 0         | Stage 3 regression check                                                                                                                                                                                                                                |
| **Real Electron Scan & Recovery**           | `npm run verify:scan`                    | **14/14 passed**               | 0         | Stage 2 regression check                                                                                                                                                                                                                                |
| **Real Electron SQLite Repository**         | `npm run verify:sqlite`                  | **8/8 passed**                 | 0         | Electron `node:sqlite` driver verification                                                                                                                                                                                                              |
| **Real Electron Vault Import (Built)**      | `npm run verify:vault`                   | **11/11 passed**               | 0         | Stage 4 regression check                                                                                                                                                                                                                                |
| **Real Electron Vault Import (Unpacked)**   | `npm run verify:vault:unpacked`          | **11/11 passed**               | 0         | Stage 4 unpacked regression check                                                                                                                                                                                                                       |
| **Real Electron Smoke (Built)**             | `npm run smoke:built`                    | **Passed**                     | 0         | Preload bridge surface (including all 11 Stage 6B semantic methods), navigation guards, CSP                                                                                                                                                             |
| **Real Electron Smoke (Unpacked)**          | `npm run smoke:unpacked`                 | **Passed**                     | 0         | Packaged binary smoke check                                                                                                                                                                                                                             |

---

## 4. Preserved Unrelated Files & Working Tree

The following unrelated files remain intact and untouched:

- `.codex/` directory
- `scripts/launch-desktop.ps1`
- `scripts/verify-bridge-and-dialog.mjs`
- `scripts/verify-desktop-window.ps1`
