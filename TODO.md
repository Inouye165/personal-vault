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

Status: **incomplete — Stage 2A and Stage 2B complete (accepted at `e4488a2`); Stage 2C corrections complete awaiting independent re-review; Stage 2D not started** (see HANDOFF.md).

Verification: implementation host **168 passed, 0 skipped** across all 8 test files, with strict typecheck, lint, formatting, production build, real Electron smoke checks (built, unpacked), Electron SQLite repository verification (`verify:sqlite`), and unpacked ASAR package verification (`verify:sqlite:unpacked`) passed.

- [x] **Stage 2A**: Read-only filesystem scanning adapter (`ReadOnlyFsAdapter` exposing only `lstat`, `realpath`, `opendir`) for explicit caller-supplied roots.
- [x] **Stage 2A**: Incremental streaming (`scanSourceRoots`) with consumer backpressure, $O(1)$ `BoundedFifoQueue`, validated resource limits (`resolveDiscoveryLimits` enforcing positive safe integers for `maxPendingDirectories`, `maxVisitedDirectories`, and collector-only `maxCollectedRecords`), `O(1)` open directory handles, and `AbortSignal` cancellation with deterministic handle cleanup.
- [x] **Stage 2A**: Shared root, child, and pre-`opendir` queued directory validation (`inspectDirectoryTarget`) and file-candidate inspection (`inspectFileEntry`), plus symlink/junction skipping (with sandbox-aware real junction probing and deterministic adapter tests).
- [x] **Stage 2A**: Configurable candidate photo/document extension policy (including `.md` and `.txt`) with documented source-root and subdirectory exclusion precedence (`excludedPaths` including ancestor exclusions > `excludedDirectoryNames` > `softwareClutterDirectoryNames` > `hiddenAndSystemNames` / dot-entries).
- [x] **Stage 2A**: Factual filesystem metadata inventory (original path, filename, extension, byte size, honest nullable creation and modification times) and verified source preservation.
- [x] **Stage 2A**: Independent review accepted at `5dd6320`.
- [x] **Stage 2B**: Read-only streaming SHA-256 content hashing (`hashFile`, bounded chunked reads, mandatory non-empty approved roots, sub-ms timestamp preservation, post-read pathname revalidation, handle close failure reporting, AbortSignal cancellation, and deterministic cleanup).
- [x] **Stage 2B**: Independent review accepted at `e4488a2`.
- [x] **Stage 2C**: SQLite catalog schema for recorded file facts and inventory persistence (`CatalogDatabase`, `node:sqlite` driver, explicit caller-supplied paths, versioned migrations, foreign key cascades, normalized lookup keys vs. verbatim original paths, honest nullable timestamps, immutable discovery observations with changed-file history preservation and hash invalidation, bounded paginated reads, deterministic connection cleanup; corrections pass complete). Awaiting independent re-review.
- [ ] **Stage 2D (next)**: Background worker job controller with progress reporting, pause, cancel, and resumable scan recovery; IPC/UI integration.

---

## Stage 3: Exact Duplicate Grouping and Review Workflow

- [ ] SHA-256 exact duplicate detection independent of filename or location.
- [ ] Grouping interface to present duplicate clusters for user inspection.
- [ ] Distinction between catalog removal, vault copy deletion, and source deletion.
- [ ] Side-by-side comparison view showing metadata differences across duplicate instances.

---

## Stage 4: Verified Vault Copying and Portable Metadata

- [ ] Vault storage directory initialization and structure.
- [ ] Verified copy pipeline with pre- and post-copy SHA-256 hash verification.
- [ ] Portable metadata manifest generation (JSON/sidecar) ensuring resilience beyond local SQLite catalog.
- [ ] Audit log of all copied assets.

---

## Stage 5: Cached, Virtualized Photo Browsing; Ratings and Similarity Review

- [ ] Virtualized grid browsing capable of rendering large collections smoothly.
- [ ] Thumbnail generation and secure local disk cache.
- [ ] User review tools: flags, 1–5 star ratings, and custom collections.
- [ ] Perceptual hashing and visual similarity review (distinguishing edited copies from similar photos).

---

## Stage 6: Semantic Photo Search and Metadata Filters

- [ ] Local offline embedding model evaluation and selection.
- [ ] Semantic query vector generation and search indexing.
- [ ] Metadata filter controls (capture date range, camera model, lens, resolution, file type).

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
