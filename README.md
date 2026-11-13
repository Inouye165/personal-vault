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
- **Supported Image Formats**: JPEG, PNG, WebP, GIF (frame 0), AVIF, and TIFF are supported for thumbnail decoding, EXIF/header extraction, and CLIP indexing. Apple HEIC/HEIF (which require patent-encumbered HEVC codecs not bundled in prebuilt `libvips`) and camera RAW formats (`.cr2`, `.nef`, `.arw`, `.dng`, `.orf`, `.rw2`, `.raf`) are reported honestly as `unsupported`.
- **OS Read-Access Timestamps (`atime`)**: Source files are opened strictly read-only (`open(path, 'r')`), preserving exact bytes, SHA-256 digests, sizes, creation times (`birthtimeMs`), and modification times (`mtimeMs`). Depending on OS/mount settings, read-only opens may update the filesystem access timestamp (`atime`).
- **Stage 6 Scope Boundaries**: Face recognition, GPS map views/reverse geocoding, video indexing, document OCR/unified search (Stage 7), and cloud sync are outside Stage 6 scope.
