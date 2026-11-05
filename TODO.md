# Personal Vault — Roadmap & Staged Status (TODO.md)

This roadmap documents the staged implementation plan for Personal Vault (`personal-vault`).

---

## Stage 1: Engineering Foundation and Desktop Shell

Status: **implemented; correction pass verified; pending independent re-review** (see HANDOFF.md for evidence).

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
- [ ] Independent re-review of the correction pass.
- [ ] ESLint rules configured (currently ignores-only; `npm run lint` is not yet a meaningful gate). Tracked here; not part of the correction pass.

---

## Stage 2: Read-Only Discovery, Metadata Inventory, and Resumable Scan Jobs

- [ ] Read-only filesystem scanning adapter for user-selected folders.
- [ ] Safe traversal respecting directory junctions, symlinks, and file system boundaries.
- [ ] Extraction of factual metadata: original path, filename, byte size, filesystem timestamps, and SHA-256 hash.
- [ ] Preservation assurance: verify zero file modifications or timestamp touches on scanned sources.
- [ ] SQLite catalog schema for recorded file facts and inventory tracking.
- [ ] Background worker job controller with progress reporting, pause, cancel, and resumability.

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
