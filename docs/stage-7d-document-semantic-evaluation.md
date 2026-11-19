# Personal Vault — Stage 7D: Document Semantic Search Evaluation & Implementation Plan

- **Date**: November 15, 2026
- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-7b-document-extraction`

**Stage Status**: **Complete — Stage 7D Evaluation & Planning Slice, Slice 1, Slice 2, and Slice 3 (incl. F1/F4 fixes) all independently accepted** — no original-document viewer or Stages 7E/7F work is implemented.

---

## 1. Executive Summary & Provisional Model Selection

Stage 7D adds offline semantic search over cataloged documents (`category = 'document'`) using text produced by **Stage 7B native extraction (`doc_extract_v1`)** and **Stage 7C machine OCR (`doc_ocr_v1`)**, while preserving source files, existing profiles, Stage 6 photo search, Electron security boundaries, bidirectional Zod validation, and the shared `AppWorkerBudget(3)`.

### Provisional Model & Runtime

- **Provisional Primary Model**: **`Xenova/bge-small-en-v1.5`** (ONNX INT8 quantized `onnx/model_quantized.onnx`, pinned at commit `ea104dacec62c0de699686887e3f920caeb4f3e3`).
  - **Provisional Status**: Both `Xenova/bge-small-en-v1.5` and `Xenova/all-MiniLM-L6-v2` scored **8/8 (MRR 1.0000)** on the expanded synthetic feasibility check. Current synthetic results do **not** demonstrate superior retrieval quality for `bge-small-en-v1.5` over `all-MiniLM-L6-v2` (and `all-MiniLM-L6-v2` had a wider cosine margin `0.2865` vs `0.1217` and lower chunk latency `14.50 ms` vs `62.49 ms`). `bge-small-en-v1.5` is selected **provisionally** for its **512-token** context window (vs 256 tokens, halving chunk count on dense documents) and **MIT** license, subject to confirmation in Slice 1/3 or swap before production index commitment.
  - **Footprint**: **34,726,996 bytes (~33.12 MiB)** total across 5 SHA-256-verified files (external user-provisioned model directory `<userData>/models/doc-semantic/...`, zero automatic startup/inference downloads).
  - **Vector Size**: L2-normalized **384-dimensional `Float32Array`** (**1,536 bytes/chunk**).
  - **Query Prompt**: Prepends `"Represent this sentence for searching relevant passages: "` to search queries (per BGE v1.5 specification) while indexing raw document chunks without prefix.
- **Runtime**: Reuses already-installed **`onnxruntime-node@1.31.1`** (MIT, N-API v6) and **`@huggingface/tokenizers@0.2.0`** (Apache-2.0) inside Node `worker_threads.Worker`. **Zero new npm dependencies** are required.
- **Why CLIP (`Xenova/clip-vit-base-patch32`) Is Excluded**: CLIP has a **77-token** context window and image-caption pretraining, making it unsuitable for multi-paragraph documents. Photo search remains exclusively on CLIP.

---

## 2. Candidate Model Comparison & Measured Electron Spike Results

An isolated spike (`spikes/doc-semantic-eval/`) ran under **Electron `45.2.3`** (`ELECTRON_RUN_AS_NODE=1`, Node `24.22.2`, ABI `150`, `win32/x64`) with outbound networking monkey-patched to fail closed (`fetch`, `http`, `https`, `net`, `tls`).

### 2.1 Pinned Candidate Artifacts

| Model                                          | Commit                                     | License    | Total Disk Size               | Context Window                 | Pooling           | Vector Dims       |
| :--------------------------------------------- | :----------------------------------------- | :--------- | :---------------------------- | :----------------------------- | :---------------- | :---------------- |
| **`Xenova/bge-small-en-v1.5`** _(Provisional)_ | `ea104dacec62c0de699686887e3f920caeb4f3e3` | **MIT**    | **34,726,996 B** (~33.12 MiB) | **512 tokens** (`510` content) | CLS (`[:, 0, :]`) | **384** (1,536 B) |
| `Xenova/all-MiniLM-L6-v2` _(Alternative)_      | `751bff37182d3f1213fa05d7196b954e230abad9` | Apache-2.0 | 23,685,172 B (~22.59 MiB)     | 256 tokens (`254` content)     | Mean (masked)     | 384 (1,536 B)     |

Exact `Xenova/bge-small-en-v1.5` (`ea104dacec62c0de699686887e3f920caeb4f3e3`) file digests measured by `spikes/doc-semantic-eval/fetch-models.mjs`:

| File                        |      Bytes | SHA-256                                                            |
| :-------------------------- | ---------: | :----------------------------------------------------------------- |
| `config.json`               |        683 | `fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350` |
| `tokenizer.json`            |    711,396 | `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66` |
| `tokenizer_config.json`     |        366 | `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3` |
| `special_tokens_map.json`   |        125 | `b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3` |
| `onnx/model_quantized.onnx` | 34,014,426 | `6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4` |

### 2.2 Measured Electron Runtime Performance & Cancellation Evidence

| Metric                                        | `bge-small-en-v1.5` (with query prefix) |          `all-MiniLM-L6-v2` |
| :-------------------------------------------- | --------------------------------------: | --------------------------: |
| Cold model + tokenizer load                   |                             `184.87 ms` |                  `74.74 ms` |
| Tokenizer-aware chunk count (expanded corpus) |             `28` (`0` truncated chunks) | `49` (`0` truncated chunks) |
| Warm chunk embed mean / p95                   |                `62.49 ms` / `145.05 ms` |     `14.50 ms` / `27.34 ms` |
| Warm query embed mean                         |                               `3.78 ms` |                   `1.41 ms` |
| Sampled process-wide RSS¹                     |                            `152.34 MiB` |                `140.15 MiB` |
| Sampled worker-isolate V8 heap                |                             `13.71 MiB` |                 `13.78 MiB` |
| Outbound network attempts                     |                                     `0` |                         `0` |
| Synthetic feasibility check Top-1 / MRR       |                    **8/8** / **1.0000** |        **8/8** / **1.0000** |
| Mean margin over best distractor              |                                `0.1217` |                    `0.2865` |

- **Parent Event-Loop Delay** (`monitorEventLoopDelay`): `p50 = 15.49 ms`, `p95 = 17.53 ms`, `max = 23.82 ms` (`< 100 ms` p95 bound).
- **Cancellation Evidence (Observed Behavior vs. Guarantees)**:
  1. **Pre-inference delay cancel** (`delayMs = 2000`, terminating before `loadedSession.run` starts): rejected with `WORKER_TERMINATED` in **`61.03 ms`**.
  2. **In-flight ONNX inference cancel** (`seqLen = 411`, `repeatCount = 25`, worker emits `{ type: 'inference_started' }` handshake immediately before `loadedSession.run(feeds)`, parent calls `worker.terminate()` after receiving handshake): rejected with `WORKER_TERMINATED` in **`9.21 ms`** (`255.12 ms` total elapsed); fresh worker reload + recovery embed completed in **`236.73 ms`** (`384` dims).
  3. **Honest boundary between observation and guarantee**: On this host, `worker.terminate()` terminated the V8 isolate and released the worker cleanly in `< 65 ms`; however, Node `worker.terminate()` is asynchronous and native ONNX Runtime C++ threads only guarantee completion once the `terminate()` promise resolves and the worker `'exit'` event fires. Production `AppWorkerBudget` accounting **must** retain the slot until `'exit'` is confirmed.

> ¹ `process.memoryUsage().rss` inside a Node `worker_thread` is a point-in-time sample of the entire Electron process resident set, not a worker-exclusive peak.

---

## 3. Expanded Synthetic Feasibility Check (Native + Noisy OCR + Distractors + Tail)

The expanded synthetic suite (`spikes/doc-semantic-eval/chunker.mjs`, `13` document tracks across `12` files, `8` queries) is a **small-corpus feasibility check**, not a production retrieval benchmark:

- **Near-topic distractors**: Expired 2022 auto insurance (`monthly premium`) vs 2025 apartment lease (`monthly rent`); refrigerator filter guide vs noisy OCR dishwasher warranty; solar tax credit clip vs home battery transfer switch notes.
- **Noisy OCR**: `0`/`O` and `1`/`l` substitutions (`B0SCH`, `C0-PAY: $45.00`, `RE1MBURSEMENT`).
- **Long / token-dense ledger (`> 2,000` tokens)**: `annual-checking-ledger-2025.txt` with `220` pipe-delimited transaction lines before the target `CASCADE ROOFING LLC $14,250.00` wire transfer in the tail (`chunk 15` on BGE, `chunk 36` on MiniLM).
- **Dual native + OCR tracks on the same `fileLocationId` (`112`)**: Native electronic cover sheet + OCR scanned property tax assessment body; document-level max-chunk aggregation selected and attributed `ocr`.

---

## 4. Architecture & Policy Specification for Stage 7D

### 4.1 Explicit Indexing Limits, Tokenizer-Aware Chunking & UI Disclosure (`doc_tok_chunk_v1`)

Character-only chunking with a silent `128`-chunk cap previously stopped silently at `~107,680` characters out of `500,000` and risked dropping token-overflow tails on dense text. Stage 7D replaces it with **tokenizer-aware splitting**:

- **Canonical Normalization**: `normalizedText = text.replace(/\r\n?/g, '\n').trim()`.
- **Exact Normalized-Text Offsets**: Every chunk records UTF-16 code-unit offsets `[charOffsetStart, charOffsetEnd)` into `normalizedText`, strictly preserving `normalizedText.slice(charOffsetStart, charOffsetEnd) === chunk.text`. (Tested in `spikes/doc-semantic-eval/run-electron-spike.mjs` and required in Slice 1 unit tests.)
- **Tokenizer-Aware Packing**: Uses the active model's `@huggingface/tokenizers` instance to pack whitespace-delimited spans (binary-splitting any oversized unspaced token run) up to `maxContentTokensPerChunk = 510` (leaving `[CLS]`/`[SEP]`), with `overlapTokens = 64`, verifying the combined chunk token count never exceeds `510` — **zero dropped token-overflow tails**.
- **Explicit Bounds & Coverage/Truncation Metadata**:
  - `maxTextCharsForIndexing = 500_000` (matching Stage 7B/7C extraction caps).
  - `maxChunksPerDocument = 128` (or explicit `maxChunksPerDocument = 256` if needed; never silent).
  - Chunker and persisted track metadata return `{ normalizedCharCount, indexedCharCount, coverageRatio, truncated, truncationReason: null | 'max_chars_exceeded' | 'max_chunks_reached' | 'both', totalTokenCount, indexedTokenCount }`.
- **UI Disclosure**: Any document with `truncated === true` displays an explicit badge/notice (e.g., `"Partially indexed: first X of Y chars (Z%)"`) in the Documents detail panel and search coverage summary.

### 4.2 Strengthened Embedding Compatibility & Reuse Identity

Every chunk row in `document_semantic_chunks` and every reuse check binds to **all** of:

1. **Source & Catalog Identity**: `file_location_id`, `discovery_observation_id`, `observed_byte_size`, Stage 2B `isObservationTimestampMatching`, canonical `content_revision`, active `hash_observations.sha256`.
2. **Source-Track Extraction Identity & Exact Normalized-Text Digest**:
   - `text_source_kind` (`'native' | 'ocr'`), `source_extraction_id`, `source_recipe_version` (`'doc_extract_v1' | 'doc_ocr_v1'`).
   - **`normalized_text_sha256`**: SHA-256 of the exact UTF-8 `normalizedText` fed to the chunker. **Rule**: Re-extracting identical original bytes (e.g., after a parser/OCR improvement or different extraction output) **must not** reuse existing vectors if `normalized_text_sha256` or extraction/OCR provenance changed.
   - When `text_source_kind === 'ocr'`: `source_ocr_model_id`, `source_ocr_model_manifest_sha256`, and `source_ocr_language` must all match.
3. **Embedding Model & Chunk/Tokenizer Recipe**:
   - `doc_model_id`, `doc_model_commit`, `doc_model_manifest_sha256` (covering `tokenizer.json` + `model_quantized.onnx`), `vector_dimensions = 384`.
   - `chunking_recipe_version = 'doc_tok_chunk_v1'`, `max_content_tokens_per_chunk`, `overlap_tokens`, `max_chunks_per_document`, `max_text_chars_for_indexing`.

- **Stale-Index Exclusion & Corrupt Isolation**: Incompatible or `is_current = 0` chunks are excluded in SQL and re-checked during hydration; `tryDeserializeDocEmbeddingVector` (384-d, `1,536` bytes, finite float32, $|\lVert v \rVert_2 - 1.0| \le 10^{-3}$) skips corrupt blobs per chunk and reports `corruptCount` alongside `eligibleCount`, `unindexedCount`, and `staleCount`.

### 4.3 Exact Bounded Document-Level Max-Chunk Ranking (No Unbounded Document Map)

To avoid both unbounded JS document `Map` retention and chunk-ranking-then-deduplication bugs:

1. **SQLite WAL Read Snapshot & Cleanup**: Wrap candidate chunk streaming in `BEGIN DEFERRED;` ... `ROLLBACK;` inside `try / finally`, and close/drop any temporary SQLite ranking database (`new DatabaseSync('')`) in `finally`.
2. **$O(1)$ Contiguous Document Max-Chunk Aggregation**:
   - Index `document_semantic_chunks` on `(is_current, doc_model_manifest_sha256, chunking_recipe_version, file_location_id, id)` so the SQLite `stmt.iterate()` scan visits all eligible chunks for each `file_location_id` **contiguously** (`ORDER BY c.file_location_id ASC, c.id ASC`).
   - Maintain a **single** `currentDoc` accumulator in JS ($O(1)$ memory — **no `Map` of all documents**), computing the max cosine score across all eligible tracks (`native` and `ocr`) and chunks for that `file_location_id`, retaining only the winning `{ fileLocationId, score, winningChunkId, winningChunkIndex, textSourceKind, charOffsetStart, charOffsetEnd }`.
3. **Bounded Top-$K$ / Disk-Backed Document Pagination**:
   - When `file_location_id` advances (or at EOF), feed that single document's winning record into:
     - **`TopKMinHeap`** (capacity `offset + limit`, ordered by `score DESC, fileLocationId ASC`) when `offset + limit <= 1,000`.
     - **Private disk-backed temporary SQLite** (`new DatabaseSync('')` with `PRAGMA temp_store = FILE; PRAGMA cache_size = -2000;`, 2 MiB cache cap, `ORDER BY score DESC, file_location_id ASC LIMIT ? OFFSET ?`) when `offset + limit > 1,000`.
4. **Reference-Ranker Differential Testing**: Slice 2/3 must test this streaming ranker against an **exhaustive in-memory reference ranker** over multi-chunk documents, dual native+OCR tracks on the same `file_location_id`, tied scores (`fileLocationId ASC` tie-break), `offset + limit <= 1,000` vs `> 1,000`, and `finally` snapshot/temp-DB cleanup.

### 4.4 Resource Bounds, Shared `AppWorkerBudget(3)` & Restart Recovery

- Shares `AppWorkerBudget(3)` (`<= 1` doc-embed worker, `<= 1` doc-search worker, `maxPendingRequests = 16`, `15,000 ms` timeout, CPU ONNX `intraOpNumThreads: 2`, `interOpNumThreads: 1`, `cpuMemArena: false`).
- Snapshots authorized scope via `document_snapshot_worker` (`snapshot_complete = 0 -> 1` in 250-row batches, startup cleanup of incomplete scopes) and calls `markRunningDocumentSemanticJobsAsInterrupted()` on startup.

---

## 5. Proposed Reviewable Implementation Slices & Acceptance Criteria

### Slice 1 (Independently Accepted): Model Manager, Tokenizer-Aware Chunker, Vector & Worker Foundation

- **Scope**:
  - `src/main/services/documents/semantic/manifest.ts` & `model-manager.ts`: Pinned model manifest, explicit user-initiated download (`PV_TEST_DOC_MODEL_BASE_URL` test override) and offline import into `<userData>/models/doc-semantic/`, canonical source/vault separation, exclusive staging, off-main SHA-256 verification, atomic publication, zero auto-downloads.
  - `src/main/services/documents/semantic/chunker.ts` & `vector.ts`: `doc_tok_chunk_v1` tokenizer-aware chunker (exact `normalizedText` offsets, coverage/truncation metadata, `normalized_text_sha256`) and 384-d `Float32Array` L2-normalization / corruption isolation.
  - `src/main/services/documents/semantic/embed-worker.ts` & `worker-runner.ts`: Isolated `worker_threads.Worker` under `AppWorkerBudget(3)` with `inference_started` test handshake, timeout termination, and exit-confirmed retirement.
- **Acceptance Criteria**:
  - Unit tests proving `normalizedText.slice(start, end) === chunk.text`, zero dropped token-overflow tails, honest `truncated`/`truncationReason`/`coverageRatio`, 384-d vector validation/corruption isolation, model staging/tamper/overlap rejection, and `AppWorkerBudget(3)` exit-confirmed accounting.
  - Real-Electron built & unpacked foundation verification (`verify:doc-semantic-foundation[:unpacked]`) exercising offline model import, tampered-model rejection, native + OCR chunk embedding, in-flight cancellation + recovery, and 100% source preservation. No catalog migration, IPC, or UI changes yet.

### Slice 2: SQLite Migration 14, `DocumentSemanticRepository`, Bounded Max-Chunk Ranker & Resumable Coordinator

- **Scope**: Migration 14 (`document_semantic_chunks`, `document_semantic_jobs`, `document_semantic_job_items`), `DocumentSemanticRepository` (strict `normalized_text_sha256` + full provenance compatibility), $O(1)$-doc-accumulator streaming max-chunk ranker (`TopKMinHeap` + disk-backed SQLite fallback), and `DocumentSemanticCoordinator`.
- **Acceptance Criteria**: Differential tests against exhaustive reference ranker, re-extraction `normalized_text_sha256` non-reuse tests, stale-index exclusion, pause/cancel/restart recovery, and `verify:doc-semantic-persistence[:unpacked]`.

### Slice 3: Bounded Document Search Worker, Narrow Bidirectional Zod IPC, Preload & `Documents` Search UI

- **Scope**: `doc_search_worker.ts`, `DocumentSearchCoordinator`, bidirectional Zod IPC (`document-schemas.ts`, `document-handlers.ts`, `preload/index.ts`), and `DocumentsPanel.tsx` / `useDocuments.ts` search UI with partial-index truncation disclosure, winning-chunk inert snippet preview, `Native text` vs `OCR text (machine-recognized)` provenance badge, and non-factual disclaimer.
- **Acceptance Criteria**: IPC/preload/UI tests + `verify:doc-semantic-search[:unpacked]` with 100% bitwise source preservation.
