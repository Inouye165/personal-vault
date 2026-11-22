# Personal Vault

Personal Vault is a privacy-first, offline desktop catalog and vault application designed to discover photographs and documents, support review and classification, and copy selected originals into a secured vault.

Personal Vault guarantees strict source file preservation: discovered originals are never modified, edited, or moved during discovery, indexing, or classification.

---

## Prerequisites

- **Node.js**: `v20.0.0` or higher (tested on Node `v22.18.0`)
- **npm**: `v10.0.0` or higher (tested on npm `v10.9.3`)
- **OS**: Windows, macOS, or Linux

---

## Setup & Installation

For the internal Windows installer, see the [Windows user guide](docs/windows-user-guide.md). For performance verification, see the [Stage 8C-2 benchmark](docs/stage-8c2-windows-baseline.md).

Clone or open the repository at `D:\organizer`, then install dependencies:

```bash
npm install
```

---

## Development

Run the Electron and React development environment with Hot Module Replacement (HMR):

```bash
npm run dev
```

---

## Verification & Quality Gates

Run the automated test suite and code quality gates:

```bash
# Run unit and behavioral tests (Vitest + jsdom)
npm test

# Run strict TypeScript type checking across Node and Web targets
npm run typecheck

# Check linting rules (ESLint)
npm run lint

# Check formatting compliance (Prettier)
npm run format:check

# Auto-format codebase
npm run format
```

### Runtime verification (real Electron)

A visible window is **not** proof that the app works: a broken preload still shows a window. The smoke check launches the real app on a temporary user-data directory, attaches over the DevTools protocol, and verifies that `window.api` exists, its methods return the expected values across IPC, the UI reaches the confirmed empty state, hostile navigation and popups are blocked, and no preload, renderer, or console errors occur. It exits non-zero with the reasons on failure, is bounded by a timeout, and terminates only the process tree it started.

```bash
npm run smoke:dev        # electron-vite dev server + Electron
npm run build && npm run smoke:built
npm run build:unpack && npm run smoke:unpacked
npm run verify:sqlite    # real Electron SQLite driver and catalog repository verification
npm run verify:scan      # real Electron end-to-end scan workflow and recovery verification
npm run verify:duplicates # real Electron end-to-end duplicate review and invalidation verification
npm run verify:vault     # real Electron verified vault copying and portable metadata verification
npm run verify:vault:unpacked # real Electron verified vault copying verification in unpacked desktop binary
npm run verify:photos    # real Electron photo browsing, thumbnail decoding, and cache verification
npm run verify:photos:unpacked # real Electron photo browsing verification in unpacked desktop binary
npm run verify:photo-review # real Electron photo ratings, flags, collections, and journal verification
npm run verify:photo-review:unpacked # real Electron photo review verification in unpacked desktop binary
npm run verify:similarity # real Electron visual similarity analysis and candidate review verification
npm run verify:similarity:unpacked # real Electron visual similarity verification in unpacked desktop binary
npm run verify:semantic-index # real Electron semantic model provisioning and resumable indexing verification
npm run verify:semantic-index:unpacked # real Electron semantic index verification in unpacked desktop binary
npm run verify:metadata  # real Electron photo EXIF metadata extraction and SQL filters verification
npm run verify:metadata:unpacked # real Electron photo metadata & SQL filters verification in unpacked desktop binary
npm run verify:semantic-search # real Electron natural-language photo search & ranking verification
npm run verify:semantic-search:unpacked # real Electron natural-language photo search verification in unpacked binary
npm run verify:documents # real Electron document browsing, local extraction & preview verification
npm run verify:documents:unpacked # real Electron document browsing & extraction verification in unpacked binary
npm run verify:ocr-foundation # real Electron Stage 7C Slice 1 offline OCR foundation verification
npm run verify:ocr-foundation:unpacked # real Electron OCR foundation verification in isolated unpacked binary
npm run verify:ocr-persistence # real Electron Stage 7C Slice 2 OCR persistence & resumable jobs verification
npm run verify:ocr-persistence:unpacked # real Electron OCR persistence verification in isolated unpacked binary
npm run verify:doc-semantic-foundation # real Electron Stage 7D Slice 1 document semantic foundation verification
npm run verify:doc-semantic-foundation:unpacked # real Electron document semantic foundation verification in isolated unpacked binary
npm run verify:doc-semantic-persistence # real Electron Stage 7D Slice 2 persistence & bounded ranking verification
npm run verify:doc-semantic-persistence:unpacked # real Electron document semantic persistence verification in isolated unpacked binary
npm run verify:doc-semantic-search # real Electron Stage 7D Slice 3 document semantic search & UI verification
npm run verify:doc-semantic-search:unpacked # real Electron document semantic search verification in isolated unpacked binary
npm run verify:doc-classify-foundation # real Electron Stage 7E Slice 1 document classification foundation verification
npm run verify:doc-classify-foundation:unpacked # real Electron document classification foundation verification in isolated unpacked binary
npm run verify:doc-classify-persistence # real Electron Stage 7E Slice 2 classification persistence & journal override verification
npm run verify:doc-classify-persistence:unpacked # real Electron classification persistence verification in isolated unpacked binary
npm run verify:doc-classify-ui # real Electron Stage 7E Slice 3 classification IPC & Documents UI verification
npm run verify:doc-classify-ui:unpacked # real Electron classification UI verification in isolated unpacked binary
npm run verify:unified-search # real Electron Stage 7F Slice 3 unified photo + document search verification
npm run verify:unified-search:unpacked # real Electron unified search verification in isolated unpacked binary
```

Add `-- --screenshot=name.png` after the script name (for example `npm run smoke:built -- --screenshot=shell.png`) to also save a screenshot; `smoke-*.png` files are git-ignored, other names are not.

---

## Production Build & Packaging

Build the production bundles for Electron main, preload, and the React renderer:

```bash
npm run build
```

Package an unpacked desktop application directory:

```bash
npm run build:unpack
```

The output executable is generated at:

- `dist/win-unpacked/Personal Vault.exe` (on Windows)

---

## Architecture at a Glance

- **Process Isolation**: Electron main process handles OS APIs; preload uses `contextBridge` to expose a narrowly-scoped `window.api`; renderer runs sandboxed React with zero Node.js access.
- **Runtime Validation**: All IPC channels and payloads crossing process boundaries are verified using Zod schemas.
- **Content Security Policy**: Scripts are limited to `'self'` (no remote code); the development server additionally allows its own inline preamble by hash.

---

## Supported Offline Photo-Search Workflow & Known Limitations

### End-to-End Offline User Workflow

1. **Discover & Hash Originals (`Sources & Scan`)**: Select one or more read-only source folders and run a scan job to catalog original filenames, paths, byte sizes, filesystem timestamps, and verified SHA-256 digests.
2. **Provision Offline Semantic Model (`Photos` -> `Semantic Index`)**: Explicitly import a local model folder (`semantic:import-model-folder`) or run an explicit one-time checksum-verified download (`semantic:download-model`) of the pinned `Xenova/clip-vit-base-patch32` INT8 ONNX model (`6b7c523703ae26e39be4b03774966f8571c7f523`, 7 files, `155,851,918` bytes / `148.63 MiB`) into `<userData>/models/`. No automatic startup or inference-time downloads ever occur.
3. **Extract Technical Metadata & Build Semantic Index (`Photos`)**:
   - Run **Extract Metadata** (works without a semantic model) to parse read-only EXIF/header capture dates (`DateTimeOriginal`, or `DateTimeDigitized` fallback when absent), camera/lens names, orientation-adjusted display dimensions, and container formats.
   - Run **Index Photos** to compute 512-dimensional L2-normalized CLIP image embeddings (`clip_vit_b32_224_bicubic_center_rgb_v1`) in background worker threads. Jobs support pause, cancel, resume, and crash-restart recovery with exact snapshotted scope.
4. **Search & Filter (`Photos` Toolbar)**:
   - Enter a natural-language query ($\le 500$ characters) in the Photos search bar and optionally combine it with rating, flag, collection, capture date range, camera, lens, minimum display resolution, file-type (`detected_format` or `filename_extension`), and `Unknown` filters.
   - SQL filters prune candidates before cosine similarity ranking (`TopKMinHeap` for `offset + limit <= 1,000`; bounded disk-backed temporary SQLite ranker for `offset + limit > 1,000`).
   - Clear the search bar at any time to restore ordinary browsing.

### Known Limitations & Honesty Disclosures

- **Machine Inferences vs. Recorded Facts**: Semantic similarity badges (`xx% match`) are uncalibrated cosine similarity inferences from CLIP embeddings, not factual object labels or ground-truth classifications. Absent capture dates, cameras, lenses, or dimensions remain explicit `Unknown` (`null`) and are never fabricated from filesystem timestamps or filenames.
- **77-Token CLIP Context Window**: Queries exceeding 77 BPE tokens are truncated at 77 tokens and explicitly disclosed in the UI (`truncated: true`, `tokenCount: 77`).
- **Supported Image Formats**: JPEG, PNG, WebP, GIF (frame 0), AVIF, TIFF, and Apple HEIC/HEIF (via bundled `libheif-js` WASM) are supported for thumbnail decoding, EXIF/header extraction, and CLIP indexing. Camera RAW formats (`.cr2`, `.nef`, `.arw`, `.dng`, `.orf`, `.rw2`, `.raf`) and SVG/BMP are reported honestly as `unsupported`.
- **OS Read-Access Timestamps (`atime`)**: Source files are opened strictly read-only (`open(path, 'r')`), preserving exact bytes, SHA-256 digests, sizes, creation times (`birthtimeMs`), and modification times (`mtimeMs`). Depending on OS/mount settings, read-only opens may update the filesystem access timestamp (`atime`).
- **Stage 6 Scope Boundaries**: Face recognition, GPS map views/reverse geocoding, video indexing, document OCR/unified search (Stage 7), and cloud sync are outside Stage 6 scope.

---

## Supported Offline Document Browsing, Text Extraction, OCR, Semantic Search, Classification & Unified Search (Stages 7A–7F)

- **Browse Without Rescanning (`Documents`)**: Cataloged documents (`category = 'document'`) from existing scans appear immediately with pagination, filename and extension filters, recorded filesystem facts, SHA-256 provenance, and explicit `Unknown` values.
- **Explicit Off-Main Text Extraction (`doc_extract_v1`)**: Extraction runs only when explicitly triggered (`Extract Text` / `Extract All Text` / `Extract Filtered Text`) inside bounded background worker threads (`<= 1` document worker under the shared `<= 3` app worker budget), supporting `.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, `.rtf`, text-bearing `.pdf` (`pdfjs-dist`, scripts/fonts/network disabled), and `.docx` (`fflate` + `fast-xml-parser` with entity expansion disabled).
- **Explicit Offline OCR (`doc_ocr_v1`)**: Scanned PDFs and explicitly selected raster document images can be OCR'd offline (`tesseract.js-core` WASM SIMD + SHA-256-verified `tessdata_fast` `eng.traineddata` + `pdfjs-dist`/`@napi-rs/canvas` page rasterization) under the shared `<= 3` app worker budget (`64 MiB` OCR source limit, conservative mixed-PDF page policy, dual-track persistence without overwriting native text, and never bulk-OCRing `category = 'photo'`).
- **Explicit Offline Document Semantic Search (`Stage 7D`)**: Semantic indexing and search over extracted (`Native text`) and OCR'd (`OCR text (machine-recognized)`) document tracks use a separate, explicitly provisioned offline text-embedding model (`Xenova/bge-small-en-v1.5`, 384-d, 512-token window, zero automatic downloads) inside bounded worker threads under the shared `<= 3` app worker budget, returning inert `<pre>` winning-chunk excerpts with provenance badges and explicit partial-index/coverage disclosures. Evaluation used synthetic fixtures; real-world semantic search quality across diverse document collections has not been evaluated, and original-layout document viewing remains out of scope.
- **Explicit Offline Document Classification & Reversible Clutter Filtering (`Stage 7E`)**: Pure deterministic rules (`doc_classify_rules_v1`, zero downloads, zero network calls) classify cataloged documents across purpose (`legal`, `lists`, `instructions`, `receipts`, `recipes`, distinct `Other / No structured match` vs `Unclassified / Needs text extraction or OCR`) and origin (`personal`, `software_project`, `application_system`, `unknown`). Browsing defaults to `Show all` with opt-in `Hide clutter`, scoped hidden counts + `Inspect hidden`, explicit provenance/uncertainty disclosures, durable two-phase `AnnotationJournal` user overrides, and pre-ranking SQL filtering in Stage 7D semantic search. Evaluation used synthetic corpora; real-world accuracy across diverse archives has not been evaluated.
- **Unified Multi-Modal Search (`Stage 7F`, `All Items`)**: When sources are connected (`sourceCount > 0`), the `All Items` header search dispatches modality-scoped offline searches (`unified:search-photos` with CLIP and `unified:search-documents` with BGE) independently without waiting for the slower modality, rendering grouped `Photos` and `Documents` sections (`limit = 20` per page, isolated pagination and per-modality retry, `All` / `Photos` / `Documents` modality toggle, explicitly scoped quick filters with `aria-live="polite"` scope/clutter disclosures, `Enter` submit, Clear/`Escape` cancellation & focus restoration). Photo (CLIP) and document (BGE) similarity scores are uncalibrated and never merged or summed into combined counts; missing/corrupt models in one modality do not block the other or trigger automatic downloads. Stage 7 verification used synthetic mixed-media fixtures rather than real-world retrieval/classification accuracy benchmarks; Stage 8 (export, recovery, and release validation) remains planned (see `STAGES.md`).
- **Inert Text Previews & Honest Statuses**: Previews render strictly as inert plain text (`<pre>`) with separate `"Extracted text"` and `"OCR text (machine-recognized)"` sections and no original-layout document viewer or File Explorer actions. Encrypted files report `Password protected`, and unsupported formats (e.g. `.doc`, `.odt`, `.xlsx`, `.pptx`, `.epub`) report `Unsupported`.
