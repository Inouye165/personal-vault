# Personal Vault — Stage 7F: Unified Multi-Modal Search Evaluation & Implementation Plan

- **Date**: November 19, 2026
- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-7b-document-extraction` (Stages 7A–7E complete and independently accepted; Stages 7B–7E preserved uncommitted in working tree)

**Stage Status**: **7F Complete — Plan & Slices 1–3 independently ACCEPTED (Stage 7 closed in the reviewed working tree on `feat/stage-7b-document-extraction` at HEAD `5af983939c1f3c0840539c993946fd2a35a0ac5b` with the Stage 7B–7F changes)** (no new models, downloads, dependencies, migrations, or Stage 8 work included).

> **Evidence & Claim Discipline**: This document separates **Existing Behavior** (observed directly in the workspace codebase), **Measured Evidence** (recorded in Stage 6E and Stage 7D/7E verification), **Architectural Inference** (consequences derived from existing contracts), and **Proposed Behavior** (Stage 7F design to be implemented and verified).

---

## 1. Executive Summary & Confirmed Defaults

Stage 7F connects Stage 6D/6E semantic photo search (`SemanticSearchCoordinator`) and Stage 7D/7E semantic document search (`DocumentSearchCoordinator`) behind an offline unified search experience in the `All Items` view (`currentTab === 'all'`).

### Confirmed Defaults

- **Grouped Results Default**: Two distinct sections (`Photos` and `Documents`), `20` results per modality by default (`limit = 20`, max `100`).
- **Compact Quick Filters**: Modality selector (`All` / `Photos` / `Documents`) plus explicitly scoped quick filters in `All Items`, with deeper EXIF/collection/classification filters remaining in the `Photos` and `Documents` tabs.
- **Zero New Models, Dependencies, or Migrations**: Reuses existing CLIP and BGE models, SQLite indexes (`CURRENT_SCHEMA_VERSION = 15`), `SemanticSearchCoordinator`, `DocumentSearchCoordinator`, and `AppWorkerBudget(3)`.
- **Stage 7E Follow-ups**: Retained Stage 7E `480x820` narrow-viewport and full multi-select `"Edit classification"` checkbox E2E checks are bundled into Stage 7F Slice 3.

---

## 2. User Experience, Entry Point & Score Non-Equivalence

### 2.1 Existing Behavior vs. Proposed `All Items` Entry Point

- **Existing Behavior**:
  - In [App.tsx](file:///D:/organizer/src/renderer/src/App.tsx#L97-L130) and [Header.tsx](file:///D:/organizer/src/renderer/src/components/Header.tsx#L38-L73), when `state.vaultStatus.sourceCount === 0`, `App.tsx` renders `<EmptyState />` and `Header.tsx` disables the global search input (`disabled={!searchAvailable}`).
  - When `sourceCount > 0` and `currentTab === 'all'`, `App.tsx` renders `<ScanJobsPanel />` and a `<div className="populated-summary-card"><h2>Catalog Inventory</h2>...</div>` summary card (connected sources and cataloged file count; **no** full inventory browser exists in `All Items`). `Header.tsx` renders the global `.search-box` input (currently wired only to local `searchQuery` state in `App.tsx`).
  - When `currentTab === 'photos'` or `currentTab === 'documents'`, `Header.tsx` hides the global search input so `PhotosSearchBar` and `DocumentsPanel` remain the single search input on those tabs.
- **Proposed Behavior**:
  - `All Items` (`currentTab === 'all'`, when `sourceCount > 0`) becomes the unified search workspace driven by the existing `Header.tsx` search input (preserving one visible search input per tab).
  - When `sourceCount === 0`, the global search input remains disabled and `<EmptyState />` remains unchanged.
  - Clearing the search (clicking the accessible Clear button) cancels any active `'unified'` search work (owner/generation-scoped) and restores the default `All Items` view (`ScanJobsPanel` + `Catalog Inventory`).
  - Navigating away from `All Items` cancels any in-flight `'unified'` search work (if active) via owner/generation-scoped cleanup so delayed cleanup cannot affect the destination tab.

### 2.2 Why Grouped `Photos` / `Documents` Results Are the Default

| Property                  | Photo Search (Stage 6D) — _Existing_                                   | Document Search (Stage 7D) — _Existing_                                                    |
| :------------------------ | :--------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **Model**                 | `Xenova/clip-vit-base-patch32` (INT8)                                  | `Xenova/bge-small-en-v1.5` (INT8)                                                          |
| **Vector Space**          | 512-d cross-modal image–text                                           | 384-d asymmetric passage–query text                                                        |
| **Max Query Length**      | 77 CLIP tokens                                                         | 512 WordPiece tokens (with BGE query prefix)                                               |
| **Measured Cosine Range** | Lower range (e.g., Stage 6E `sunset_beach.jpg` = `0.27` / `27% match`) | Higher range (e.g., Stage 7D synthetic top-1 hits with `0.1217`–`0.2865` mean margins)     |
| **Provenance & Unit**     | Whole image; recorded filesystem/EXIF/review facts (`PhotoItem`)       | Max-scoring chunk (`Native text` vs `OCR text (machine-recognized)` + UTF-16 char offsets) |

- **Architectural Inference Against Default Interleaving**:
  - Naive raw-score interleaving would systematically rank weakly related BGE document chunks above strong CLIP photo matches due to differing cosine distributions.
  - Per-page min-max/z-score normalization is unstable on small or skewed pages, and Reciprocal Rank Fusion (RRF) discards absolute match strength while breaking deterministic `LIMIT`/`OFFSET` pagination across independent rankers.
- **Proposed Presentation**: Render grouped `Photos` and `Documents` sections (side-by-side on wide viewports, stacked with section jump links on narrow viewports `<= 767px`), ordered within each group by its own native cosine ranking, with explicit per-modality uncalibrated similarity labels (`CLIP relative similarity` vs `BGE relative similarity` — never calibrated probabilities or cross-modal equivalents).

---

## 3. Incremental Delivery & Modality-Scoped IPC Contracts

### 3.1 Simplest Bounded Design: Separate Modality-Scoped Calls (No Push Events)

- **Architectural Inference on Single `Promise.allSettled` IPC**: A single `ipcRenderer.invoke('unified:search')` call backed by `Promise.allSettled` in main would block the fast modality until the slower modality finishes or times out (up to 15 s).
- **Proposed Mechanism**: Avoid adding new IPC push-event infrastructure. Instead, expose **separate modality-scoped request/response IPC calls** coordinated under one unified query identity in `useUnifiedSearch`:
  - `UNIFIED_SEARCH_PHOTOS: 'unified:search-photos'`
  - `UNIFIED_SEARCH_DOCUMENTS: 'unified:search-documents'`
  - `UNIFIED_SEARCH_CANCEL: 'unified:search-cancel'`
- **Independent Rendering**: When the user submits a unified query (with `modality === 'all'`), `useUnifiedSearch` generates a new `queryGen` and dispatches `unifiedSearchPhotos(...)` and `unifiedSearchDocuments(...)` concurrently. Each promise updates its own section state immediately upon resolution, so Photos or Documents appears as soon as it is ready without waiting for the other.

### 3.2 Exact Request & Response Contracts (Bidirectional Zod)

**`UnifiedSearchPhotosRequestSchema`** (strict):

- `query`: `z.string().trim().min(1).max(500)`
- `ownerSurface`: `z.literal('unified')`
- `ownerGen`: `z.number().int().nonnegative()`
- `offset`: `z.number().int().nonnegative().default(0)`
- `limit`: `z.number().int().min(1).max(100).default(20)`
- `photoFilters`: optional object matching `SemanticSearchRequestSchema` filter fields (`fileTypeBasis`, `fileTypeValue`, `onlyUnknownDetectedFormat`, `ratingFilter`, `flagFilter`, `collectionId`, `captureDateFrom`, `captureDateTo`, `includeUnknownCaptureDate`, `cameraNormalized`, `onlyUnknownCamera`, `lensNormalized`, `onlyUnknownLens`, `minWidthPx`, `minHeightPx`, `includeUnknownDimensions`, `minScore`).

**`UnifiedSearchDocumentsRequestSchema`** (strict):

- `query`: `z.string().trim().min(1).max(500)`
- `ownerSurface`: `z.literal('unified')`
- `ownerGen`: `z.number().int().nonnegative()`
- `offset`: `z.number().int().nonnegative().default(0)`
- `limit`: `z.number().int().min(1).max(100).default(20)`
- `documentFilters`: optional object matching `DocSemanticSearchRequestSchema` filter fields (`extensionFilter`, `filenameQuery`, `textSourceKindFilter`, `purposeFilter`, `originFilter`, `clutterFilter`).

**`UnifiedSearchCancelRequestSchema`** (strict):

- `ownerSurface`: `z.enum(['unified', 'photos-tab', 'documents-tab'])`
- `ownerGen`: `z.number().int().nonnegative()`
- `modality`: `z.enum(['all', 'photos', 'documents']).default('all')`

**Modality-Scoped Response Envelopes**:

- `UnifiedSearchPhotosResponseSchema`:
  - `status`: `'ready' | 'unprovisioned' | 'corrupt' | 'cancelled' | 'overloaded' | 'timed_out' | 'error'`
  - `modelId`: `'Xenova/clip-vit-base-patch32'`
  - `result`: `SemanticSearchResponseSchema.nullable()`
  - `errorMessage`: `z.string().nullable()`
- `UnifiedSearchDocumentsResponseSchema`:
  - `status`: `'ready' | 'unprovisioned' | 'corrupt' | 'cancelled' | 'overloaded' | 'timed_out' | 'error'`
  - `modelId`: `'Xenova/bge-small-en-v1.5'`
  - `result`: `DocSemanticSearchResponseSchema.nullable()`
  - `errorMessage`: `z.string().nullable()`
- `UnifiedSearchCancelResponseSchema`: `{ cancelled: z.boolean() }`

**Counts Rule**: Never sum `photos.result.totalMatched + documents.result.totalMatched` into a single combined match count when either modality is excluded (`modality !== 'all'`), loading, unprovisioned, corrupt, timed out, or errored. Always display explicit per-modality counts and status.

---

## 4. Explicit Search Ownership & Navigation Lifecycle

### 4.1 Existing Coordinator Contracts

- `SemanticSearchCoordinator` ([src/main/services/semantic/search-coordinator.ts](file:///D:/organizer/src/main/services/semantic/search-coordinator.ts#L366)) is a singleton in [src/main/index.ts](file:///D:/organizer/src/main/index.ts#L256) with `cancelActiveSearch(): void` and a single `currentQueryGeneration` / `activeQueryKey`.
- `DocumentSearchCoordinator` ([src/main/services/documents/semantic/search-coordinator.ts](file:///D:/organizer/src/main/services/documents/semantic/search-coordinator.ts#L392)) is a singleton in [src/main/index.ts](file:///D:/organizer/src/main/index.ts#L338) with `cancelSearch(reason?: string): Promise<void>` and `currentGeneration` / `currentQueryKey` / `spawnEpoch`.
- In [App.tsx](file:///D:/organizer/src/renderer/src/App.tsx#L100-L130), `PhotosPanel`, `DocumentsPanel`, and `All Items` are mutually exclusive views; only one tab is mounted at a time.

### 4.2 Single Active Visible Surface Ownership (Justified Smaller Change)

- **Design Choice**: **Only the currently visible surface owns active search work** (`'unified'` on `All Items`, `'photos-tab'` on `Photos`, `'documents-tab'` on `Documents`), rather than refactoring both coordinators to maintain per-owner worker sessions and multi-owner query states.
- **Justification**: Since the UI mounts only one tab at a time, supporting multiple concurrent owners across tabs would duplicate ONNX worker sessions and complicate `AppWorkerBudget(3)` without user benefit.
- **Owner & Generation-Scoped Cancellation**:
  - A thin main-process `UnifiedSearchCoordinator` (or ownership gate in `src/main/services/unified-search/`) tracks `{ activeOwnerSurface, activeOwnerGen }` per modality (`photos` and `documents`).
  - Starting a search from `'unified'` (or `'photos-tab'` / `'documents-tab'`) updates that modality's `{ activeOwnerSurface, activeOwnerGen }`.
  - `cancelSearch({ ownerSurface, ownerGen, modality })` **only** invokes `SemanticSearchCoordinator.cancelActiveSearch()` / `DocumentSearchCoordinator.cancelSearch()` if `(ownerSurface, ownerGen)` matches the currently active owner for that modality.
  - **Result**: If the user clears unified search or navigates from `All Items` (`gen 1`) to `Photos` (`gen 2`) and starts a photo search, any delayed cleanup/cancel from `('unified', 1)` is ignored as a no-op and **cannot** cancel `('photos-tab', 2)`.

---

## 5. Worker Admission, Idle Reclamation & `AppWorkerBudget(3)`

### 5.1 Full `AppWorkerBudget(3)` Contention Surface (Existing Behavior)

In [src/main/index.ts](file:///D:/organizer/src/main/index.ts#L199-L359), `AppWorkerBudget(3)` is shared across:

1. `ThumbnailCoordinator` (up to 2 workers, also executing `SimilarityCoordinator`, `PhotoMetadataCoordinator`, and `SemanticIndexCoordinator` tasks)
2. `DocumentExtractionCoordinator` (up to 1 worker)
3. `DocumentOcrCoordinator` (up to 1 worker)
4. `DocumentSemanticCoordinator` (up to 1 worker)
5. `DocumentClassificationCoordinator` (up to 1 worker)
6. `SemanticSearchCoordinator` (up to 1 worker)
7. `DocumentSearchCoordinator` (up to 1 worker)

Currently, `tryReleaseExternalIdleWorker` in `src/main/index.ts` **only** calls `thumbnailCoordinator?.releaseOneIdleWorker()`. `SemanticSearchCoordinator` has no `releaseIdleWorker()` method, and `DocumentSearchCoordinator.releaseIdleWorker()` is not wired into `tryReleaseExternalIdleWorker`.

### 5.2 Safe Idle Retirement & Bounded Admission (Proposed Behavior)

- **Idle Worker Reclamation**:
  1. Add `releaseIdleWorker(): Promise<boolean>` to `SemanticSearchCoordinator` (matching `DocumentSearchCoordinator.releaseIdleWorker()`: returns `false` if `activeRequests.size > 0` or `activeSearchCalls > 0`, otherwise terminates the idle worker and waits for confirmed `'exit'`).
  2. Wire a shared `tryReleaseExternalIdleWorker` in `src/main/index.ts` that attempts to release an idle worker from `ThumbnailCoordinator`, `SemanticSearchCoordinator`, or `DocumentSearchCoordinator` when `AppWorkerBudget(3)` is full.
  3. Add an explicit **idle retirement timer** (e.g., 30 s with no active requests) on both search workers so idle ONNX sessions do not indefinitely occupy 2 of 3 `AppWorkerBudget(3)` slots after a search finishes.
- **Bounded Admission, Cancellation & Accounting**:
  - `UnifiedSearchCoordinator` holds **zero** `AppWorkerBudget` slots of its own.
  - Both search coordinators retain `maxPendingRequests = 16`, `15,000 ms` admission/execution deadlines, cooperative cancellation during admission wait, and exit-confirmed `terminatingWorkers` accounting in `AppWorkerBudget(3)`.
  - Also align `SemanticSearchCoordinator` worker spawn cancellation with `DocumentSearchCoordinator`'s `activeSpawn` + `spawnEpoch` pattern (or guard `ensureWorker` against stale `spawningWorkerPromise` cancellation) if needed during Slice 1 testing.
- **Honest Fairness Expectation (No False Starvation-Freedom Claim)**:
  - Worker counts alone do **not** guarantee starvation freedom. If background indexing (`DocumentOcrCoordinator`, `DocumentSemanticCoordinator`, `DocumentClassificationCoordinator`, `DocumentExtractionCoordinator`) and active `ThumbnailCoordinator` decodes hold all 3 slots with non-idle work for > 15 s, a search request will hit its `15,000 ms` admission deadline and return `status: 'timed_out'` / `'overloaded'` cleanly without hanging or leaking reservations.

---

## 6. Pagination, Generation Guards & Retry Semantics

- **Dual-Level Renderer Generation Guards (`useUnifiedSearch`)**:
  - `queryGenRef`: Bumped on new query text, modality switch (`All` / `Photos` / `Documents`), filter change, Clear, or unmount. Discards any in-flight responses from prior queries for **both** modalities.
  - `photosPageGenRef` & `documentsPageGenRef`: Bumped independently when paging or retrying only that modality.
- **Preserving the Other Section**:
  - Paging `Photos` (e.g., `offset: 20`) or clicking Retry on a failed `Photos` banner bumps only `photosPageGenRef` and invokes only `UNIFIED_SEARCH_PHOTOS`, leaving `Documents` results, counts, and UI state completely untouched (and vice versa).
- **Same-Query Concurrent Requests & Cancellation**:
  - Both `SemanticSearchCoordinator` and `DocumentSearchCoordinator` compute `queryKey` from query text + filters (excluding `offset`/`limit`). Thus, concurrent page requests for the same query share the active query generation without superseding each other, while any change to query text or filters bumps `queryKey` and supersedes older in-flight queries.
- **Partial Availability & Per-Modality Retry**:
  - Missing/corrupt models (`unprovisioned` / `corrupt`), empty indexes (`eligibleCount === 0`), timeouts (`timed_out`), overload (`overloaded`), or errors (`error`) in one modality never block or clear the other modality, and never trigger automatic model downloads.
  - Retrying a failed modality retries **only** that modality.

---

## 7. Explicitly Scoped Quick Filters (No Misleading Global Mapping)

- **Existing Filter Semantics**:
  - **Photos** ([photo-filter-sql.ts](file:///D:/organizer/src/main/services/catalog/photo-filter-sql.ts#L96-L101)): `fileTypeBasis: 'detected_format' | 'filename_extension'` (`fileTypeValue`, `onlyUnknownDetectedFormat`), plus rating, flag, collection, EXIF date/camera/lens/resolution.
  - **Documents** ([document-schemas.ts](file:///D:/organizer/src/shared/validation/document-schemas.ts#L496-L512)): `extensionFilter` (filename extension only, e.g., `.pdf`, `.txt`, `.md`), plus `filenameQuery`, `textSourceKindFilter` (`native` / `ocr`), `purposeFilter`, `originFilter`, and `clutterFilter` (`show_all` default).
- **Proposed `All Items` Quick Filters**:
  - **No global `File type` mapping**: File-type controls remain explicitly scoped to their modality:
    - **Document Quick Filters** (labeled `Documents only`, disabled/hidden when `modality === 'photos'`): `Hide clutter` toggle (opt-in, default `show_all`), `Text source` (`All` / `Native` / `OCR`), and `Doc extension` (`.pdf`, `.docx`, `.txt`, `.md`, etc.).
    - **Photo Quick Filters** (labeled `Photos only`, disabled/hidden when `modality === 'documents'`): `Photo format` (`detected_format` vs `filename_extension`).
    - Deeper filters (EXIF camera/lens/date/resolution, ratings/flags/collections, and document purpose/origin) link cleanly to the `Photos` and `Documents` tabs.
  - **Explicit Scope Disclosure**: Whenever `modality === 'all'` and any modality-specific quick filter is active, the UI displays an explicit `aria-live="polite"` scope notice (e.g., _"Document-only filters (Hide clutter, Doc extension) apply to Documents only; Photos results are not filtered by document criteria."_).

---

## 8. Bounded Retention, Synthetic Evaluation & Acceptance Criteria

### 8.1 Bounded Retention

- `limit = 20` default per modality (`<= 100` max); renderer retains **only the active page** per modality (`<= 100` items each).
- Bounded document snippets (`winningSnippet` in inert `<pre>`) and bounded photo thumbnails (`photos:get-thumbnail` with cancellation on page change, clear, or tab leave).

### 8.2 Synthetic Mixed-Media Evaluation (Slice 3 — Independently Accepted)

- **Fixtures**: 47 synthetic mixed-media fixtures in `scripts/verify-electron-unified-search.mjs` (`22` indexed JPEG/PNG/WebP photos + `1` unindexed photo; `23` indexed documents including native `.txt`/`.md`, scanned image-only OCR PDF `scanned_ocr_receipt.pdf` [`OCR text (machine-recognized)`], `>500k`-char `oversized_mountain_ledger.txt` [`Partially indexed:`], clutter `repos/pkg-0/README.md`, and `1` unindexed document track `unindexed_late_note.txt`) covering shared concepts (`"mountain"`, `"bicycle"`, `"receipt"`).
- **Accepted Limits**: Synthetic fixtures verify pipeline wiring, partial availability (`missing` CLIP with `ready` BGE, plus `corrupt` BGE/CLIP in Electron), provenance, filter scoping, concurrency, and responsive `480x820` / `360x480` UI layout; they do **not** measure real-world cross-modal retrieval or classification accuracy, and CLIP vs BGE scores remain uncalibrated. `timed_out`, missing BGE with CLIP ready, and catalog/classification mutation during scoring were covered in Vitest rather than Electron.

### 8.3 Acceptance Criteria

- **IPC & Security**: Bidirectional Zod validation on `unified:search-photos`, `unified:search-documents`, and `unified:search-cancel`; top-frame trusted sender validation; `sandbox: true` preload with zero external `require`s.
- **Offline & Source Preservation**: `0` outbound network attempts; 100% bitwise invariance (`size`, `sha256`, `birthtimeMs`, `mtimeMs`) across all source and model files.
- **Stale-Data & Concurrency Races**:
  - Rapid query/filter replacement supersedes older queries without crashing or leaking stale results.
  - Concurrent paging on one modality preserves the other section.
  - Catalog/classification mutations during scoring/revalidation trigger `SemanticSearchCoordinator` 1x re-score and `DocumentSearchCoordinator` `maxStaleRetries = 2` / `DocSearchStaleError` + Stage 7E override currency checks.
  - Delayed cleanup from an unmounted/previous owner cannot cancel a newer surface's search.
- **Keyboard Access & Accessibility**:
  - Logical tab order across search input, Clear button, modality selector, quick filters, result items, and per-modality pagination/retry buttons.
  - `Enter` submits search; accessible Clear button (`aria-label="Clear search"`) cancels active unified work and restores focus cleanly to the `All Items` search input / view.
  - `aria-live="polite"` announcements for independent modality arrival, partial-availability/missing-model notices, filter scope disclosures, and per-modality errors.
- **Responsive Narrow Layouts**:
  - Unified search verified at `480x820` and `360x480` with zero horizontal overflow, readable stacked sections, and accessible controls.
- **Restart & Built/Unpacked Execution**:
  - Fresh `verify:unified-search` (built) and `verify:unified-search:unpacked` from neutral `$env:TEMP` against isolated `win-unpacked\Personal Vault.exe`, plus restart persistence with zero re-indexing.

---

## 9. Reviewable Implementation Slices & Scope Boundaries

1. **Slice 1 — Coordinator Lifecycle, `UnifiedSearchCoordinator` & Modality-Scoped IPC/Preload**:
   - Add `releaseIdleWorker()` + idle retirement to `SemanticSearchCoordinator` (and idle retirement + `tryReleaseExternalIdleWorker` wiring for both search coordinators in `src/main/index.ts`).
   - Add `UnifiedSearchCoordinator` with owner/generation-scoped cancellation (`ownerSurface`, `ownerGen`), `UNIFIED_SEARCH_PHOTOS` / `UNIFIED_SEARCH_DOCUMENTS` / `UNIFIED_SEARCH_CANCEL` channels, strict bidirectional Zod schemas, IPC handlers, and preload bridge.
   - Unit/integration tests for independent modality resolution, partial availability, owner-scoped cancellation, `AppWorkerBudget(3)` idle reclamation, and Zod validation.
2. **Slice 2 — `All Items` Unified Search UI, Scoped Quick Filters & Keyboard/Narrow-Viewport Polish**:
   - Wire `Header.tsx` + `App.tsx` (`All Items` when `sourceCount > 0`) to `useUnifiedSearch` (dual `queryGenRef` + `photosPageGenRef` / `documentsPageGenRef`) and `UnifiedSearchPanel`.
   - Grouped `Photos` / `Documents` sections (`limit = 20`), independent pagination & per-modality retry, explicitly scoped quick filters with `aria-live` disclosures, keyboard/focus handling, and clear/navigation restoration.
   - Renderer behavioral tests including `480x820` / `360x480` narrow-viewport and keyboard-access checks.
3. **Slice 3 — Real-Electron Mixed-Media Verification, Retained 7E Follow-ups & Stage 7 Closeout (`Independently ACCEPTED` in the reviewed working tree on `feat/stage-7b-document-extraction` at HEAD `5af983939c1f3c0840539c993946fd2a35a0ac5b`)**:
   - Added `scripts/verify-electron-unified-search.mjs` (`verify:unified-search`, `verify:unified-search:unpacked`) and `src/main/services/search-test-barrier.ts` (`PV_TEST_SEARCH_BARRIER_DIR`, strictly inactive in normal launches) covering mixed-media fixtures, incremental arrival, partial availability, scoped filter disclosures, rapid replacement, Escape/Clear/navigation races, concurrent paging, restart persistence, `480x820` & `360x480` narrow layouts + keyboard/focus flows, and source preservation.
   - Completed retained Stage 7E nonblocking E2E follow-ups (`480x820` narrow-viewport and full multi-select `"Edit classification"` checkbox E2E checks + restart persistence in `scripts/verify-electron-doc-classify-ui.mjs`), and reconciled `scripts/smoke.mjs` exact 119-method bridge allowlist.
   - Independent reviewer's own verification (separate from implementation runs): **103/103** focused tests (`13` files), **1,456/1,456** full `npm test` (`114` files), `typecheck`, `lint`, `format:check`, `git diff --check`, `build:unpack`, fresh `verify:unified-search` (built) + `verify:unified-search:unpacked -- --rebuild`, `smoke:built` + `smoke:unpacked` (`dist\win-unpacked` and `dist-stage-7f-verify\win-unpacked`), and **12/12** built + unpacked `verify:doc-classify-ui` (`dist\win-unpacked\Personal Vault.exe`).
   - Updated `STAGES.md`, `TODO.md`, `HANDOFF.md`, `ARCHITECTURE.md`, `README.md`, and this plan for Stage 7 closeout; Stage 8 remains **Planned** per `STAGES.md`.

### Explicitly Out of Scope

- Original-layout document viewing, automatic model downloads, startup auto-indexing, calibrated cross-modal score fusion/interleaving, and Stage 8 work.
