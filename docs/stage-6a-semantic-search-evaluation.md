# Personal Vault — Stage 6A: Offline Semantic Search Feasibility & Technical Spike

**Date**: November 9, 2026  
**Workspace**: `D:\organizer`  
**Branch**: `feat/stage-6a-semantic-evaluation` (branched from `9b8faa7`, descending from accepted `543135a`)  
**Stage Status**: Stage 6 In progress — Stage 6A Awaiting review

---

## 1. Executive Summary & Recommendation

This document presents the bounded technical evaluation and real-Electron executable spike for **Stage 6A: Offline Semantic Photo Search Feasibility**.

### Recommended Architecture for Stage 6B+

- **Model**: **OpenAI CLIP ViT-B/32** (`openai/clip-vit-base-patch32`, 8-bit dynamic quantized ONNX export via `Xenova/clip-vit-base-patch32`, commit `6b7c523703ae26e39be4b03774966f8571c7f523`).
- **Runtime**: **`onnxruntime-node` (`1.31.1`)** + **`@huggingface/tokenizers` (`0.2.0`)** + existing **`sharp` (`0.35.5`)** inside a bounded background Node `worker_threads.Worker`.
- **Vector Representation**: **512-dimensional `Float32Array`** ($2,048\text{ bytes}$ per photo), unit $L_2$-normalized ($\|\mathbf{v}\|_2 = 1.0$).
- **Similarity Index**: **Exact linear cosine scan (dot product) over `Float32Array` vectors stored in SQLite (`node:sqlite`)** with a declared cap of **$50,000$ indexed photos** ($97.66\text{ MiB}$ raw vector payload; measured **$26.78\text{ ms}$ median / $32.32\text{ ms}$ p95** in-memory scan and **$202.15\text{ ms}$** zero-retention SQLite streaming scan at $50,000$ synthetic vectors). No external vector database dependency (`sqlite-vec`, `hnswlib-node`, `lancedb`) is needed or recommended.
- **Model Provisioning**: Explicit, user-consented offline model provisioning ($148.63\text{ MiB}$ total for quantized vision + text ONNX + tokenizer) verified by exact byte size and SHA-256 checksums before activation, or offline local bundle import. **Zero silent runtime downloads; zero uploads of personal content.**

---

## 2. Model & Runtime Options Comparison

Three realistic local multimodal (image + text) embedding options were evaluated:

| Criterion                     | Option 1 (Recommended & Executed): CLIP ViT-B/32 (`onnxruntime-node` + `@huggingface/tokenizers` + `sharp`)                            | Option 2: SigLIP Base Patch16-224 (`Xenova/siglip-base-patch16-224` via `onnxruntime-node`)                           | Option 3: `@huggingface/transformers` v4 + `onnxruntime-web` (WASM)                                          |
| :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| **Model Weights**             | `Xenova/clip-vit-base-patch32` (`vision_model_quantized.onnx` + `text_model_quantized.onnx`)                                           | `Xenova/siglip-base-patch16-224` (`vision_model_quantized.onnx` + `text_model_quantized.onnx`)                        | Same ONNX weights executed through `transformers.js` pipeline abstraction                                    |
| **Vector Dimensions**         | **512** (`Float32`, $2,048\text{ B}$/vector)                                                                                           | **768** (`Float32`, $3,072\text{ B}$/vector; $1.5\times$ larger index)                                                | 512 or 768                                                                                                   |
| **Quantized Model Disk Size** | **$148.63\text{ MiB}$** total ($84.99\text{ MiB}$ vision + $61.52\text{ MiB}$ text + $2.12\text{ MiB}$ tokenizer)                      | **$203.49\text{ MiB}$** total ($94.89\text{ MiB}$ vision + $106.31\text{ MiB}$ text + $2.29\text{ MiB}$ tokenizer)    | $148.63\text{ MiB}$ – $203.49\text{ MiB}$                                                                    |
| **Vision Backbone Cost**      | ViT-B/32 ($7\times 7 = 49$ patches + CLS = **50 tokens**). Fast CPU inference (**$25.52\text{ ms}$** mean on host).                    | ViT-B/16 ($14\times 14 = 196$ patches). $\sim 4\times$ sequence length, $\sim 3.5\times$ slower CPU vision inference. | WASM SIMD is $2.5\times$–$4\times$ slower than native `onnxruntime-node` CPU AVX2/VNNI.                      |
| **Network & Hub Isolation**   | **Strict**: Direct `ort.InferenceSession.create(localPath)` + pure-JS `@huggingface/tokenizers` have **zero remote-fetch code paths**. | **Strict** when called directly via `onnxruntime-node`.                                                               | Requires `env.allowRemoteModels = false` configuration guards to suppress implicit Hugging Face Hub fetches. |
| **Electron / Node ABI**       | **N-API v6** (`onnxruntime_binding.node`); works across Node 22 and Electron 45 (Node 24) without `@electron/rebuild`.                 | Same (`onnxruntime-node` N-API v6).                                                                                   | Pure WASM (no native `.node` addon), but higher memory copy overhead and slower CPU throughput.              |

### Why Option 1 Was Selected

1. **Speed on CPU**: ViT-B/32 divides a $224\times 224$ image into $32\times 32$ patches ($49$ patches total), achieving **$28.37\text{ ms}$** end-to-end per image ($35.24\text{ images/sec}$ on a single worker thread) and **$3.39\text{ ms}$** per text query on CPU without GPU dependence.
2. **Compact Footprint**: $148.63\text{ MiB}$ total model disk size and 512-dimensional embeddings ($50\%$ smaller index than 768-d SigLIP).
3. **Zero Implicit Hub Networking**: Using `onnxruntime-node` and `@huggingface/tokenizers` directly with `sharp` (already installed and audited in Stage 5A) avoids the `transformers.js` Hub downloader layer entirely.

---

## 3. Primary Documentation & Licensing Verification

Code and model weight licenses were verified against primary upstream repositories and model cards, explicitly distinguishing software runtime licenses from model weight licenses and redistribution rights:

| Component                                                                                                        | Kind                                       | License                                     | Primary Source & Documentation                                                                                                                                                                                                                                                                       | Redistribution Rights & Obligations                                                                                                                                                                                                                                                 |
| :--------------------------------------------------------------------------------------------------------------- | :----------------------------------------- | :------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`onnxruntime-node` (`1.31.1`)**                                                                                | Runtime Code & Native Binaries             | **MIT License**                             | [github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) (`LICENSE`)                                                                                                                                                                                                             | Permissive commercial and non-commercial redistribution permitted; preserve copyright and MIT license notice in packaged third-party notices.                                                                                                                                       |
| **`@huggingface/tokenizers` (`0.2.0`)**                                                                          | Tokenizer Runtime Code (Pure JS)           | **Apache-2.0**                              | [github.com/huggingface/transformers.js](https://github.com/huggingface/transformers.js)                                                                                                                                                                                                             | Permissive redistribution permitted; preserve Apache-2.0 license text and notices.                                                                                                                                                                                                  |
| **`@huggingface/transformers` (`4.3.2`)**                                                                        | Alternative Pipeline Library (Evaluated)   | **Apache-2.0**                              | [github.com/huggingface/transformers.js](https://github.com/huggingface/transformers.js) (`LICENSE`)                                                                                                                                                                                                 | Permissive redistribution permitted under Apache-2.0.                                                                                                                                                                                                                               |
| **`sharp` (`0.35.5`)**                                                                                           | Image Decoder Runtime                      | **Apache-2.0** (LGPL-3.0 dynamic `libvips`) | [github.com/lovell/sharp](https://github.com/lovell/sharp)                                                                                                                                                                                                                                           | Already approved and packaged in Stage 5A (`app.asar.unpacked`).                                                                                                                                                                                                                    |
| **OpenAI CLIP ViT-B/32 Weights** (`openai/clip-vit-base-patch32` & `Xenova/clip-vit-base-patch32`)               | Pretrained Model Weights & Tokenizer Vocab | **MIT License**                             | [huggingface.co/openai/clip-vit-base-patch32](https://huggingface.co/openai/clip-vit-base-patch32), [github.com/openai/CLIP/blob/main/LICENSE](https://github.com/openai/CLIP/blob/main/LICENSE), [huggingface.co/Xenova/clip-vit-base-patch32](https://huggingface.co/Xenova/clip-vit-base-patch32) | OpenAI released both the CLIP code and pretrained weights under the **MIT License**. `Xenova/clip-vit-base-patch32` is a format conversion to ONNX explicitly declared as `license: mit`. Redistribution or on-demand download is unrestricted provided the MIT notice is retained. |
| **Google SigLIP Base Patch16-224 Weights** (`google/siglip-base-patch16-224` & `Xenova/siglip-base-patch16-224`) | Alternative Model Weights (Evaluated)      | **Apache-2.0**                              | [huggingface.co/google/siglip-base-patch16-224](https://huggingface.co/google/siglip-base-patch16-224), [github.com/google-research/big_vision](https://github.com/google-research/big_vision)                                                                                                       | Released by Google under **Apache-2.0**. Commercial and open-source redistribution allowed with Apache-2.0 attribution.                                                                                                                                                             |

---

## 4. Windows/Electron Compatibility, Native Dependencies & Packaging Implications

### 4.1 Native ABI & Electron Compatibility

- `onnxruntime-node@1.31.1` uses **Node-API (N-API v6)** (`bin/napi-v6/win32/x64/onnxruntime_binding.node`).
- Because N-API v6 is ABI-stable across Node versions, the exact same prebuilt binary loads without `@electron/rebuild` or C++ compilation in both **Node `v22.18.0`** (Vitest runner) and **Electron `45.2.3`** (embedded Node `v24.22.2`).
- Verified by running `spikes/semantic-eval/run-electron-spike.mjs` under `electron.exe` with `ELECTRON_RUN_AS_NODE=1`.

### 4.2 Native DLL Footprint on Windows x64

Inspecting `node_modules/onnxruntime-node/bin/napi-v6/win32/x64/`:

- `onnxruntime_binding.node`: **$358,200\text{ bytes}$ ($0.34\text{ MiB}$)**
- `onnxruntime.dll`: **$31,736,672\text{ bytes}$ ($30.27\text{ MiB}$)**
- `DirectML.dll`: **$18,527,544\text{ bytes}$ ($17.67\text{ MiB}$)**
- `dxcompiler.dll`: **$17,986,400\text{ bytes}$ ($17.15\text{ MiB}$)**
- Total `win32/x64` native runtime directory: **$65.43\text{ MiB}$** (Note: `onnxruntime-node` also ships `win32/arm64`, `darwin/arm64`, `linux/x64`, `linux/arm64` in `bin/napi-v6/`, which should be filtered via `electron-builder` file patterns so Windows x64 builds only package `win32/x64`).

### 4.3 `asar` / `asarUnpack` Packaging Implications

- Operating system dynamic linkers (`LoadLibraryExW` on Windows) cannot load `.node` addons or companion `.dll` files (`onnxruntime.dll`, `DirectML.dll`) directly from inside an `app.asar` archive.
- When `onnxruntime-node` is promoted to production dependencies in Stage 6B, `electron-builder.json5` **must** configure:
  ```json5
  asarUnpack: [
    "node_modules/sharp/**/*",
    "node_modules/@img/**/*",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**/*"
  ]
  ```
- Additionally, the worker bundle entry (`out/main/semantic_worker.js` or shared `thumbnail_worker.js`) must keep `onnxruntime-node` external (matching `sharp` in `electron.vite.config.ts`).
- _Note on Stage 6A Scope_: In this Stage 6A spike, `onnxruntime-node` is strictly isolated inside `spikes/semantic-eval/node_modules/` so main app startup, production bundles, and `dist/win-unpacked` remain completely untouched. Packaged `asarUnpack` execution of `onnxruntime-node` is therefore documented as a Stage 6B deliverable and not claimed as already packaged in `dist/win-unpacked`.

### 4.4 CPU Baseline vs. Optional Acceleration (DirectML / CUDA)

- **CPU Baseline (Mandatory Default)**: Configured via `executionProviders: ['cpu']`, `intraOpNumThreads: 2`, `interOpNumThreads: 1`. Runs deterministically on every x64/ARM64 Windows machine with zero GPU driver dependency.
- **Optional Acceleration (DirectML)**: `onnxruntime-node` on Windows includes `DirectML.dll` (`executionProviders: ['dml', 'cpu']`), which can offload matmul operations to DirectX 12 capable GPUs. However, DirectML introduces driver-specific variance, higher VRAM/RSS allocation, and occasional int8 operator fallbacks. **Recommendation**: Keep Stage 6B strictly on the `['cpu']` execution provider by default; do not depend on any GPU or CUDA installation.

---

## 5. Preprocessing, Vector Contract, Isolation & Browsing Bounds

### 5.1 Input Limits & Read-Only Verification

Every image processed for semantic embedding enforces the same inviolable read-only security and resource boundaries as Stage 5A/5C:

- **Approved Root Containment**: Canonical `realpathSync` verification against registered catalog source roots.
- **Read-Only Descriptor & Stability**: Opened with `open(path, 'r')`, pre/post `fstat` size and `mtimeMs` verification, streaming 64 KiB chunked SHA-256 verification, and post-read pathname/inode revalidation.
- **Input Size Caps**: `MAX_SOURCE_SIZE_BYTES = 128 MiB`, `MAX_INPUT_PIXELS = 100,000,000` (100 MP).
- **Supported Formats**: `.jpg`, `.jpeg`, `.jpe`, `.jfif`, `.png`, `.webp`, `.gif` (frame 0), `.avif`, `.tif`, `.tiff`.
- **Unsupported Formats**: `.heic`/`.heif`, camera RAW (`.cr2`, `.cr3`, `.nef`, `.arw`, `.dng`, etc.), and `.svg` return honest `status: 'unsupported'` without crashing or invoking external toolchains.

### 5.2 Preprocessing & Vector Normalization Specification

- **Image Preprocessing (`clip_vit_b32_224_bilinear_center_rgb_v1`)**:
  1. EXIF orientation auto-rotation (`sharp(buffer).rotate()`).
  2. Colorspace conversion to 3-channel sRGB (`toColorspace('srgb').removeAlpha()`).
  3. Resize shortest edge to $224\text{ px}$ and center-crop to $224\times 224\text{ px}$ (`resize(224, 224, { fit: 'cover', position: 'centre', kernel: 'cubic' })`).
  4. Rescale uint8 $[0, 255] \to [0.0, 1.0]$ and normalize per channel into planar CHW `Float32Array(3 * 224 * 224)`:
     - $\mu_{RGB} = [0.48145466, 0.4578275, 0.40821073]$
     - $\sigma_{RGB} = [0.26862954, 0.26130258, 0.27577711]$
- **Text Preprocessing**:
  1. Trim whitespace; reject empty queries (`EMPTY_QUERY`).
  2. BPE tokenization via `CLIPTokenizer` (`tokenizer.json`, lowercased, max length **77 tokens** including `<|startoftext|>` ID `49406` and `<|endoftext|>` ID `49407`). Queries exceeding 77 tokens are truncated to 76 tokens + `<|endoftext|>` (`49407`) with `truncated: true` metadata reported.
- **Vector Output & Normalization**:
  - Output tensor (`image_embeds` / `text_embeds`) is a **512-dimensional `Float32Array`**.
  - Explicitly $L_2$-normalized: $\hat{\mathbf{v}} = \frac{\mathbf{v}}{\|\mathbf{v}\|_2}$. Non-finite or zero-norm vectors throw `RangeError` and are never persisted.

### 5.3 Execution Isolation & Coexistence with Stage 5A/5C Browsing Bounds

To respect Personal Vault's strict browsing bounds (**$\le 2$ live image decode workers including terminating ones**, **$\le 64$ queued decode jobs**, **$\le 200$ mounted DOM cells**, **$\le 2,000$ retained metadata items**):

- **Shared Worker Pool Integration**: Image decoding and ONNX vision embedding run inside the existing `ThumbnailCoordinator` worker pool (or a dedicated action `'embed_image'` on the shared 2-worker pool) at **`priority: 'low'`**, while interactive thumbnail requests run at **`priority: 'high'`**.
- **Aggregate Worker Cap**: Total live image/embedding workers (active + terminating) never exceed **2**.
- **Backpressure**: Semantic indexing dispatches at most `BATCH_SIZE = 8` low-priority requests at a time, leaving at least 56 of the 64 queue slots free for interactive photo scrolling.
- **Cancellation & Timeout**: Per-job timeout of 15 seconds (`JOB_TIMEOUT_MS`). Cancelling an indexing job aborts queued items immediately and awaits worker termination before freeing concurrency capacity. Incomplete or cancelled jobs transition to `status: 'cancelled'` and never claim completion.

---

## 6. Executable Spike Measurements (Real Electron on Host)

### 6.1 Host & Runtime Environment

- **CPU**: 13th Gen Intel Core i9-13900K (32 logical threads)
- **RAM**: 34.1 GB
- **OS**: Windows (`win32` `x64`)
- **Electron Runtime**: Electron `45.2.3` (Node `24.22.2`, V8 `15.6.75.27-electron.0`)
- **Command Executed**: `node spikes/semantic-eval/run-electron-spike.mjs` (exit code `0`)

### 6.2 Pinned Model Artifacts & Verified SHA-256 Checksums

Cached under gitignored `spikes/semantic-eval/.model-cache/Xenova--clip-vit-base-patch32/` (commit `6b7c523703ae26e39be4b03774966f8571c7f523`):

| File                               |       Byte Size |        MiB | Verified SHA-256 Checksum                                          |
| :--------------------------------- | --------------: | ---------: | :----------------------------------------------------------------- |
| `onnx/vision_model_quantized.onnx` |      89,117,001 |      84.99 | `583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299` |
| `onnx/text_model_quantized.onnx`   |      64,504,507 |      61.52 | `73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a` |
| `tokenizer.json`                   |       2,224,119 |       2.12 | `f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd` |
| `config.json`                      |           4,524 |      <0.01 | `493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495` |
| `tokenizer_config.json`            |             775 |      <0.01 | `60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967` |
| `preprocessor_config.json`         |             520 |      <0.01 | `6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f` |
| `special_tokens_map.json`          |             472 |      <0.01 | `c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac` |
| **Total Provisioned Footprint**    | **155,851,918** | **148.63** | —                                                                  |

### 6.3 Measured Latency, Throughput, Memory & UI Responsiveness

| Metric                                                                      | Measured Value                                       | Target / Bound                         |
| :-------------------------------------------------------------------------- | :--------------------------------------------------- | :------------------------------------- |
| **Cold Model Load Latency** (Vision + Text ONNX + Tokenizer init)           | **$367.36\text{ ms}$**                               | $< 2,000\text{ ms}$                    |
| **Warm Image Decode + Preprocess Mean** (`sharp` 224x224 RGB)               | **$2.85\text{ ms}$**                                 | —                                      |
| **Warm Image ONNX Inference Mean** (`vision_model_quantized.onnx`)          | **$25.52\text{ ms}$**                                | —                                      |
| **Warm End-to-End Image Embedding Mean**                                    | **$28.37\text{ ms}$**                                | $< 15,000\text{ ms}$ timeout           |
| **Warm Single-Worker Throughput**                                           | **$35.24\text{ images/sec}$**                        | ($\sim 2,114\text{ images/min}$)       |
| **Warm Text Query Embedding Mean** (Tokenize + `text_model_quantized.onnx`) | **$3.39\text{ ms}$**                                 | $< 50\text{ ms}$ interactive           |
| **Worker Thread Peak RSS** (with both Vision & Text sessions loaded)        | **$453.98\text{ MiB}$**                              | Bounded in isolated worker             |
| **Worker Thread Peak V8 Heap Used**                                         | **$16.94\text{ MiB}$**                               | —                                      |
| **Main Process Event-Loop Delay during Worker Inference**                   | **p95 = $16.49\text{ ms}$, max = $24.40\text{ ms}$** | $\le 100\text{ ms}$ main-thread budget |

### 6.4 Ranked Retrieval Results on Synthetic Nonpersonal Fixtures

_Disclaimer_: The 10 synthetic raster fixtures (`generate-fixtures.mjs`) verify end-to-end multimodal alignment between the vision and text encoders and validate the ranking pipeline. **This small synthetic fixture run is not presented as production search quality on real-world photography or large-library performance evidence.**

**Declared Relevance Rubric**: For each query, the #1 ranked result (`top1File`) must belong to the query's declared `positiveIds`, and every positive fixture must score strictly higher than every declared negative fixture (`minPositiveScore > maxNegativeScore`).

| Query ID       | Natural-Language Query Text                             |    Query Latency | Top-1 Ranked Fixture         | Top-1 Score | Min Positive Score | Max Negative Score | Positive–Negative Margin | Rubric Result |
| :------------- | :------------------------------------------------------ | ---------------: | :--------------------------- | ----------: | -----------------: | -----------------: | -----------------------: | :------------ |
| `q_sunset`     | `"a warm orange sunset over the ocean horizon"`         | $4.50\text{ ms}$ | `sunset_beach.jpg`           |    `0.2947` |           `0.2800` |           `0.1804` |                `+0.1144` | **PASS**      |
| `q_forest`     | `"green pine trees in an evergreen forest"`             | $3.23\text{ ms}$ | `pine_woods.webp`            |    `0.3196` |           `0.3150` |           `0.2078` |                `+0.1118` | **PASS**      |
| `q_car`        | `"a bright red car with black wheels on a road"`        | $3.28\text{ ms}$ | `crimson_sedan.png`          |    `0.3009` |           `0.2896` |           `0.2108` |                `+0.0901` | **PASS**      |
| `q_mountain`   | `"snowy mountain peaks under a blue sky"`               | $2.79\text{ ms}$ | `snowy_mountain_peaks.jpg`   |    `0.2982` |           `0.2982` |           `0.1939` |                `+0.1043` | **PASS**      |
| `q_sailboat`   | `"a white sailboat sailing on blue water"`              | $3.03\text{ ms}$ | `white_sailboat_sea.jpg`     |    `0.3032` |           `0.3032` |           `0.1882` |                `+0.1150` | **PASS**      |
| `q_night_city` | `"city skyscraper buildings lit up at night with moon"` | $3.57\text{ ms}$ | `night_city_skyline.jpg`     |    `0.3177` |           `0.3177` |           `0.2158` |                `+0.1019` | **PASS**      |
| `q_receipt`    | `"a paper receipt invoice with a barcode"`              | $3.35\text{ ms}$ | `paper_receipt_document.png` |    `0.3370` |           `0.3370` |           `0.2087` |                `+0.1283` | **PASS**      |

### 6.5 Failure Modes & Cancellation Verification

Exercised in `run-electron-spike.mjs` steps 3, 4, and 7:

1. **Missing Model (`MISSING_MODEL`)**: When `modelDir` is absent or incomplete, the worker immediately returns `{ status: 'error', code: 'MISSING_MODEL' }` without attempting any network connection.
2. **Unsupported Image Format (`status: 'unsupported'`)**: `.heic` fixture returns `{ status: 'unsupported', reason: 'HEIC/HEIF format requires unsupported external codecs' }`.
3. **Corrupt Image (`DECODE_FAILED`)**: Truncated/corrupt `.jpg` fixture returns `{ status: 'error', code: 'DECODE_FAILED' }`.
4. **Active Cancellation (`CANCELLED`)**: Cancelling an in-flight embedding job terminates the worker, resolves the pending promise with `{ status: 'error', code: 'CANCELLED' }` (never claiming success), and cleanly spawns a fresh worker on subsequent requests.

---

## 7. Vector Similarity Index Evaluation (Simple Bounded Scan vs. Dedicated Vector Dependency)

### 7.1 Comparison

| Approach                                                                            | Added Dependencies & Native Surface                                                                  | Memory & Storage Overhead                                                                              | Query Latency at 10k / 50k Photos                                                                                                                              | Filter Composability (Stage 6C/6D SQL Filters)                                                                                                            | Recommendation                                                                              |
| :---------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **Bounded Exact Scan over SQLite BLOBs / `Float32Array`** (Cap $\le 50,000$ photos) | **Zero** new dependencies (uses built-in `node:sqlite` + JS `Float32Array`)                          | $2\text{ KiB}$/photo ($19.53\text{ MiB}$ raw vectors at 10k; $97.66\text{ MiB}$ at 50k)                | **$4.95\text{ ms}$** (10k in-RAM) / **$26.78\text{ ms}$** (50k in-RAM); **$42.15\text{ ms}$** (10k SQLite stream) / **$202.15\text{ ms}$** (50k SQLite stream) | **Exact**: SQL `WHERE` clauses filter candidate `file_location_id`s before or during scan with $100\%$ recall.                                            | **Recommended** (Least complex, zero native risk, exact results).                           |
| **Dedicated Vector Extension / DB** (`sqlite-vec`, `hnswlib-node`, `lancedb`)       | Requires C++/Rust native addon or custom SQLite loadable extension (`db.enableLoadExtension(true)`). | HNSW graph adds $1.5\times$–$2.5\times$ RAM/disk overhead and requires index rebuilds on invalidation. | $1\text{ ms}$–$5\text{ ms}$ approximate nearest neighbor (ANN).                                                                                                | **Poor**: HNSW pre-filtering or post-filtering suffers from recall drop when combined with selective metadata filters (rating, collection, camera, date). | **Not Recommended** (Unnecessary complexity and security/ABI risk for $\le 50,000$ photos). |

### 7.2 Synthetic Vector Scan Benchmark (`spikes/semantic-eval/benchmark-index.mjs`)

_Note: Measured under Electron `45.2.3` using synthetic L2-normalized 512-dimensional `Float32` vectors._

| Declared Library Size (Synthetic Vectors) | Raw Vector Payload (`512 * 4 B`) | SQLite Table Size on Disk (with index) | In-Memory `Float32Array` Exact Scan (Median / p95) | Zero-RAM-Retention `node:sqlite` `stmt.iterate()` Streaming Scan |
| ----------------------------------------: | -------------------------------: | -------------------------------------: | -------------------------------------------------: | ---------------------------------------------------------------: |
|                                 **1,000** |                $1.95\text{ MiB}$ |                      $3.98\text{ MiB}$ |            **$0.68\text{ ms}$** / $0.82\text{ ms}$ |                                             **$4.40\text{ ms}$** |
|                                **10,000** |               $19.53\text{ MiB}$ |                     $39.67\text{ MiB}$ |            **$4.95\text{ ms}$** / $8.36\text{ ms}$ |                                            **$42.15\text{ ms}$** |
|                                **25,000** |               $48.83\text{ MiB}$ |                     $99.17\text{ MiB}$ |          **$12.63\text{ ms}$** / $14.86\text{ ms}$ |                                           **$111.65\text{ ms}$** |
|                 **50,000** (Declared Cap) |               $97.66\text{ MiB}$ |                    $198.35\text{ MiB}$ |          **$26.78\text{ ms}$** / $32.32\text{ ms}$ |                                           **$202.15\text{ ms}$** |

Even without keeping vectors cached in memory, streaming $50,000$ `BLOB` rows from `node:sqlite` via `stmt.iterate()` and computing 512-d dot products takes **$202.15\text{ ms}$** with $O(K)$ auxiliary JS heap memory. Combined with text query embedding ($3.39\text{ ms}$), total query latency is $\sim 45\text{ ms}$ at $10,000$ photos and $\sim 205\text{ ms}$ at $50,000$ photos.

---

## 8. Proposed Stage 6B Implementation Contract

### 8.1 Model Provisioning & Storage Contract

- **Storage Path**: `<userData>/models/clip-vit-base-patch32-q8/` (canonical separation validated against source roots and vault storage; symlinks/junctions rejected).
- **Explicit Provisioning States**:
  - `unprovisioned`: Model files are not present on disk. Search UI displays an honest "Offline Semantic Model Not Installed ($148.6\text{ MiB}$)" state.
  - `downloading` / `verifying`: Only initiated after explicit user action ("Download Offline Search Model" or "Import Model Bundle from Disk"). Streams files to `.model_staging_<pid>/`, verifies exact byte lengths and pinned SHA-256 digests (`REQUIRED_MODEL_FILES`), and atomically renames into place.
  - `ready`: All 7 files verified against pinned SHA-256 manifest.
  - `corrupt` / `error`: Checksum mismatch unlinks staged files and surfaces a clear error.

### 8.2 Database Schema Expansion (Migration 9)

```sql
CREATE TABLE IF NOT EXISTS photo_semantic_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
  discovery_observation_id INTEGER NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_revision TEXT NOT NULL,
  model_id TEXT NOT NULL,
  preprocessing_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions = 512),
  embedding_blob BLOB NOT NULL CHECK (length(embedding_blob) = 2048),
  created_at_ms INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sem_emb_loc_model_curr
  ON photo_semantic_embeddings(file_location_id, model_id, preprocessing_version)
  WHERE is_current = 1;

CREATE INDEX IF NOT EXISTS idx_sem_emb_sha256_model
  ON photo_semantic_embeddings(content_sha256, byte_size, model_id, preprocessing_version, is_current);

CREATE TABLE IF NOT EXISTS semantic_index_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'paused', 'cancelled', 'interrupted', 'completed', 'failed')),
  model_id TEXT NOT NULL,
  preprocessing_version TEXT NOT NULL,
  total_photos INTEGER NOT NULL DEFAULT 0,
  processed_photos INTEGER NOT NULL DEFAULT 0,
  reused_photos INTEGER NOT NULL DEFAULT 0,
  unsupported_photos INTEGER NOT NULL DEFAULT 0,
  error_photos INTEGER NOT NULL DEFAULT 0,
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS semantic_index_job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES semantic_index_jobs(job_id) ON DELETE CASCADE,
  file_location_id INTEGER NOT NULL REFERENCES file_locations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'reused', 'unsupported', 'error')),
  error_message TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sem_job_items_status
  ON semantic_index_job_items(job_id, status);
```

### 8.3 Resumable Indexing & Revision Invalidation Contract

- **Exact Scope Snapshot**: Starting an indexing job snapshots up to `MAX_SEMANTIC_INDEX_ITEMS = 50,000` current photo location IDs into `semantic_index_job_items`.
- **Content-Addressed Reuse**: If another location already has an active embedding with identical `(content_sha256, byte_size, model_id, preprocessing_version)` and current source stability is verified, the embedding vector is reused without re-running ONNX vision inference.
- **Revision Invalidation**: Every record stores `content_revision = rev:<discoveryId>:<byteSize>:<mtimeMs>:<sha256>`. When a rescan observes modified content, prior embeddings for that location are marked `is_current = 0`. Changing `model_id` or `preprocessing_version` in a future release cleanly ignores older embeddings.
- **Startup Interruption Recovery**: On app startup, any `running` or `paused` `semantic_index_jobs` transition to `interrupted` (`markRunningSemanticJobsAsInterrupted()`) and can be explicitly resumed or cancelled.

### 8.4 Bounded Resource & Concurrency Contract

- **Worker Concurrency**: Shares the aggregate $\le 2$ worker cap with `ThumbnailCoordinator` (or runs 1 low-priority embedding job at a time while reserving worker 2 for high-priority interactive thumbnails).
- **Queue Cap**: Never queues more than 8 concurrent embedding items into the shared 64-slot queue (`THUMBNAIL_LIMITS.MAX_QUEUED_JOBS = 64`), guaranteeing interactive browsing never hits `QUEUE_FULL`.
- **Memory Bounds**:
  - Streaming SQLite scan via `stmt.iterate()` maintains only a bounded top-$K$ min-heap / array ($\le 200$ items) in main-process memory.
  - Renderer retains $\le 2,000$ metadata items and $\le 200$ mounted DOM cells.

### 8.5 Typed IPC Channels & Zod Schemas

New channels in `src/shared/contracts/channels.ts` validated bidirectionally in `src/shared/validation/ipc-schemas.ts` with top-level sender authorization (`validateSender`):

- `semantic:get-model-status` $\to$ `{ status: 'unprovisioned' | 'provisioning' | 'ready' | 'error', modelId, diskBytes, error? }`
- `semantic:provision-model` $\to$ `{ mode: 'download' | 'import_directory', sourceDirectory?: string }`
- `semantic:start-indexing` / `semantic:pause-indexing` / `semantic:resume-indexing` / `semantic:cancel-indexing`
- `semantic:get-index-progress` & event `semantic:index-progress-event`
- `semantic:search-photos` $\to$ Request: `{ queryText: string, offset: number, limit: number, minScore?: number, ratingFilter?, flagFilter?, collectionId? }`; Response: `{ items: PhotoSearchResultItem[], totalMatched: number, indexedCount: number, unindexedCount: number, queryLatencyMs: number }`

### 8.6 Search Ranking & UI Contract

- **Machine Inference Labeling**: Semantic similarity scores (cosine similarity, typically $0.20$–$0.40$ for CLIP ViT-B/32) must be labeled as **"Semantic Relevance Score (Machine Inference)"**, never as calibrated probability or factual truth.
- **Thresholding & Ordering**: Default minimum cosine score cutoff `minScore = 0.22` (configurable/toggleable to view all ranked items), ordered deterministically by `score DESC, file_location_id ASC`.
- **Coverage Honesty**: Search results banner explicitly displays how many catalog photos are currently indexed vs. unindexed/unsupported (e.g., `"Searching 4,820 indexed photos (180 not yet indexed; 12 unsupported)"`) so incomplete indexing never masquerades as exhaustive search.

---

## 9. Where Metadata Filters Fit in Later Stage 6 Work (Stage 6C/6D Note)

_Not implemented in Stage 6A._ In later Stage 6 substages (Stage 6C/6D), metadata filters for **capture date range, camera make/model, lens model, pixel resolution (`width`, `height`), and file extension/type** will integrate as follows while strictly preserving Personal Vault's provenance rules:

1. **Strict Separation of Recorded Facts vs. Derived/Embedded Metadata**:
   - **Recorded Facts** (already in `file_locations` / `discovery_observations`): `extension` (file type), `byte_size`, `filesystem_birthtime_ms`, and `filesystem_mtime_ms`.
   - **Extracted EXIF / Technical Metadata** (new table `photo_technical_metadata` in Stage 6C, keyed by `file_location_id`, `discovery_observation_id`, `content_sha256`):
     - `width_px INTEGER`, `height_px INTEGER` (from decoded image header)
     - `inferred_capture_time_ms INTEGER` (from EXIF `DateTimeOriginal` / `CreateDate`, with explicit `capture_time_source = 'exif_datetime_original' | 'exif_create_date' | null`)
     - `camera_make TEXT`, `camera_model TEXT`, `lens_model TEXT` (from EXIF IFD0 / ExifIFD)
     - `inferred_gps_lat REAL`, `inferred_gps_lon REAL` (nullable)
2. **Unknown Dates and Locations Remain Explicitly `NULL` ("Unknown")**:
   - When EXIF capture date, camera, lens, or GPS metadata is absent or unparsable, those columns **must remain `NULL`**.
   - Filesystem timestamps (`filesystem_mtime_ms`, `filesystem_birthtime_ms`) **must never be copied into `inferred_capture_time_ms`**.
   - Every filter control must include an explicit **"Unknown / No capture date"** (or **"Unknown Camera"**, **"Unknown Lens"**) filter option so photos lacking EXIF metadata remain first-class citizens and are never silently lost or falsified.
3. **Filter + Semantic Search Execution Order**:
   - Metadata filters execute as parameterized SQL predicates in `node:sqlite` (`JOIN photo_technical_metadata`, `photo_annotations`, `collection_memberships`) _during_ the `stmt.iterate()` candidate query.
   - Only rows satisfying all active SQL filters have their `embedding_blob` dot-product scored against the query vector. Because linear scan is exact ($O(N_{\text{filtered}})$), filtering **accelerates** semantic search and guarantees $100\%$ filter accuracy with zero ANN post-filtering recall loss.

---

## 10. Limitations & Open Product Decisions for Review

### 10.1 Known Technical Limitations

1. **CLIP Score Calibration**: Cosine similarities in CLIP ViT-B/32 occupy a narrow cone (relevant matches typically score `0.24`–`0.38`, while unrelated images score `0.12`–`0.21`). Raw cosine numbers look low to end users if displayed as percentages; the UI should display raw scores (`0.31`) or rank tiers rather than misleading percentages.
2. **Negation & Complex Spatial Queries**: CLIP-class bag-of-words text encoders struggle with negation (e.g., `"beach without people"` may still match people on a beach) and fine-grained counting.
3. **English-Centric Tokenizer**: `openai/clip-vit-base-patch32` is primarily trained on English text queries.
4. **Format Boundaries**: Apple HEIC/HEIF and camera RAW files remain unsupported for embedding (matching Stage 5A/5C) and are reported honestly in `unsupported_photos`.

### 10.2 Open Product Decisions Requiring User / Reviewer Alignment Before Stage 6B

1. **Model Provisioning Mode**: Should Stage 6B support:
   - **(A)** Both explicit in-app checksum-verified download from pinned URL **and** offline local directory import ("Select downloaded model folder from disk"), or
   - **(B)** Strictly offline local directory import only (zero network code in main even when user clicks download)?
2. **Disk & Index Cap Budget**: Is the proposed **$148.63\text{ MiB}$** model disk budget and **$50,000$-photo** semantic index cap ($97.66\text{ MiB}$ raw vectors / $\sim 198\text{ MiB}$ SQLite table) approved for Stage 6B?
3. **Search Input Placement**: Should Stage 6B enable the existing top-bar `Header.tsx` search input when the `Photos` tab is active (replacing the `"Search photos (Stage 6)"` disabled state), or place semantic search controls inside the `PhotosPanel` toolbar alongside a dedicated indexing status panel?
4. **Minimum Score Cutoff vs. Ranked Browsing**: Should semantic search apply a default relevance threshold (e.g., cosine similarity $\ge 0.23$) to hide non-matching photos, or return top-$K$ ranked results with a user-adjustable threshold slider/toggle?

---

## 11. Reproducible Spike Commands

All spike artifacts live in `spikes/semantic-eval/` (throwaway spike scripts clearly separated from `src/`; pure math/versioning helper unit-tested in `tests/main/semantic-spike-core.test.ts`):

```powershell
# 1. Install isolated spike dependencies (does not modify root package.json or node_modules)
cd D:\organizer\spikes\semantic-eval
npm install

# 2. Fetch and SHA-256 verify the pinned quantized CLIP ONNX model into .model-cache/
npm run fetch-model

# 3. Execute the full 8-phase evaluation spike inside the real Electron runtime
npm run evaluate

# 4. Run the standalone synthetic vector scan benchmark (1k, 10k, 25k, 50k vectors)
npm run benchmark-scan
```
