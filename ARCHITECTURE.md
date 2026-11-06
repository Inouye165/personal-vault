# Personal Vault — Architecture Document

## 1. System Overview

Personal Vault (`personal-vault`) is a high-integrity desktop photo and document discovery, cataloging, classification, and vault copying system. It prioritizes source preservation, explicit data provenance, exact and content-based duplicate identification, and resilient local-first cataloging.

---

## 2. Process Boundaries & Isolation

The system enforces strict multi-process isolation:

```
┌────────────────────────────────────────────────────────┐
│                   Main Process                         │
│ - Window lifecycle management                          │
│ - IPC request router & handler                         │
│ - Security headers and webRequest policies             │
│ - (Future Stages) SQLite engine, worker controller     │
└──────────────────────────┬─────────────────────────────┘
                           │ IPC invoke / handle
                           ▼
┌────────────────────────────────────────────────────────┐
│                   Preload Facade                       │
│ - Runs in isolated context with contextBridge          │
│ - Runtime payload validation (Zod)                     │
│ - Strictly typed `window.api` boundary                 │
└──────────────────────────┬─────────────────────────────┘
                           │ contextBridge
                           ▼
┌────────────────────────────────────────────────────────┐
│                   Renderer Process                     │
│ - React 19 UI component hierarchy                      │
│ - Design token styling & accessible UI controls        │
│ - State management for active view & local search      │
│ - NO Node.js APIs (`nodeIntegration: false`)           │
│ - Sandboxed execution (`sandbox: true`)                │
└────────────────────────────────────────────────────────┘
```

### 2.1 IPC Communication Contract

- Channels are defined as immutable string constants in `src/shared/contracts/channels.ts`.
- Every channel payload crossing between processes is validated via Zod schemas defined in `src/shared/validation/ipc-schemas.ts`.
- If an invalid payload is sent or received, the validation helper returns an explicit failure, preventing runtime type drift or malformed data propagation.

---

## 3. Module Responsibilities & Directory Layout

```
src/
├── main/
│   ├── index.ts           # App lifecycle, single-instance lock, window setup
│   ├── navigation.ts      # Trusted-location policy, navigation guards, popup denial
│   ├── security.ts        # CSP response headers, permission denial
│   ├── ipc/
│   │   ├── sender.ts      # Validates the sending WebContents, frame, and URL
│   │   └── handlers.ts    # Sender-checked handlers: app info, vault status, tab ack
│   └── services/
│       └── discovery/     # Stage 2A: read-only traversal, policy, and metadata inventory
│           ├── fs-adapter.ts # Narrow read-only adapter (lstat, realpath, opendir)
│           ├── policy.ts     # Candidate extension & exclusion/software-clutter rules
│           ├── scanner.ts    # Incremental bounded scanner with AbortSignal cleanup
│           ├── types.ts      # Candidate, skip, error, and result contracts
│           └── index.ts      # Public discovery exports
├── preload/
│   ├── index.ts           # Exposes window.api via contextBridge; validates every response
│   └── index.d.ts         # TypeScript declaration for window.api
├── shared/
│   ├── contracts/         # IPC channel definitions
│   ├── types/             # Domain definitions (Item, Facts, Inferred, Source)
│   ├── validation/        # Zod schemas & runtime validation logic
│   └── index.ts           # Shared exports
└── renderer/
    ├── index.html         # HTML root with Content Security Policy meta
    └── src/
        ├── main.tsx       # React 19 root bootstrap
        ├── App.tsx        # Application shell container
        ├── index.css      # Design tokens, typography, dark theme layout
        ├── hooks/         # Custom hooks (e.g. useVaultApi)
        └── components/    # Layout, Sidebar, Header, and EmptyState views
```

---

## 4. Data Ownership & Fact vs. Inference Separation

### 4.1 Recorded Facts (Immutable)

- Stored as factual properties of discovered files.
- Original path, original filename, byte size, filesystem creation timestamp, filesystem modification timestamp, SHA-256 hash.
- Cannot be edited, guessed, or modified by classification engines.

### 4.2 Inferred Values (Derived & Mutable)

- Extracted or inferred by heuristics, OCR, or local AI classification models.
- Inferred capture date (from EXIF or filename heuristic), inferred location, document category (e.g. `receipts`, `legal`, `instructions`).
- Always recorded alongside a confidence score and provenance marker.
- When capture dates or GPS coordinates are not present, they remain explicit `null` / `undefined`.

---

## 5. Technology Decisions & Rationale

1. **Electron + React + TypeScript**:
   - Electron follows a three-major-version support window; the project pins an exact supported major (see HANDOFF.md for the installed version) and must be re-checked against electronjs.org/docs/latest/tutorial/electron-timelines when upgrading.
2. **electron-vite (v3.1) + Vite (v6)**:
   - Separate build configurations for main (Node target), preload (sandbox target), and renderer (browser ESM target).
   - A sandboxed preload can only `require` `electron` and a few built-ins, so every other import (including Zod) must be bundled into `out/preload/index.js`. Main keeps its dependencies external.
   - Development only: the Vite dev server injects an inline React Refresh preamble. A dev-only Vite plugin allows exactly those inline scripts by SHA-256 hash in the `<meta>` CSP; `unsafe-inline` is never added to `script-src`. Production output has no inline scripts and keeps the strict policy.

### 5.1 Trust and navigation

- Exactly one application location is trusted: the built `renderer/index.html` when packaged, or one explicitly configured http(s) dev origin when not packaged. `ELECTRON_RENDERER_URL` is ignored by packaged builds.
- `will-navigate`, `will-redirect`, and `will-frame-navigate` block everything else. Popups are denied in one place (`secureWebContents`) and URLs are never passed to `shell.openExternal`.
- Every IPC handler accepts a call only from the top-level frame of the application window while it shows the trusted location; other senders are rejected.
- The renderer distinguishes **loading**, **error** (missing bridge, rejected request, or unacknowledged request), and **confirmed empty** states. It never substitutes default data for a missing bridge.

### 5.2 Other decisions

3. **Zod Runtime Validation**:
   - TypeScript types guarantee compile-time correctness, but IPC payloads cross process serialization boundaries. Zod ensures runtime defense-in-depth against corrupt or unexpected data.
4. **Vitest + @testing-library/react**:
   - Fast execution, jsdom support for DOM and component behavior testing, and full compatibility with Vite TypeScript paths.
5. **No AI / Embedding / OCR / Python tooling in Stage 1**:
   - Deferred to subsequent stages to evaluate memory, packaging, and offline performance trade-offs without bloat.
6. **Read-Only Discovery & Exclusion Policy (Stage 2A)**:
   - Informed by digiKam collection root/ignore-directory rules and PhotoPrism indexing conventions:
     - **Explicit Approved Roots & Boundary Enforcement**: Only caller-supplied root directories are scanned. Symbolic links and Windows directory junctions are skipped by default (including roots that are links) and reported as structured skips, avoiding cyclic traversal, duplicate references, and escapes. Every visited path is checked with `realpath` against the canonical approved root.
     - **Source-Root & Subdirectory Exclusion Precedence**: Exclusion rules apply to explicitly supplied source roots before `lstat`/`opendir` (so excluded roots are never opened) as well as to descendant directories, in strict precedence order:
       1. `excludedPaths` (matching the target path itself or any ancestor path via `isPathOrAncestorExcluded`) -> `excluded_directory`
       2. `excludedDirectoryNames` (matched against the directory's own basename) -> `excluded_directory`
       3. `softwareClutterDirectoryNames` (matched against the directory's own basename) -> `software_clutter_directory`
       4. `hiddenAndSystemNames` / `excludeHiddenEntries` dot-prefix rule (matched against the directory's own basename) -> `hidden_or_system_entry`
          Ancestor directory names above an explicitly supplied root do not trigger name-based exclusions (2–4), whereas explicit path exclusions (1) apply to both roots and roots nested under an excluded ancestor.
     - **Configurable Extension & Clutter Policy**: Candidate photos and documents are identified by extension policy (including `.md`, `.markdown`, and `.txt` documents). Boilerplate clutter files (`CMakeLists.txt`, `requirements.txt`, `CHANGELOG.md`, lockfiles) are skipped with explicit, testable reasons while preserving user `.md` and `.txt` files.
     - **Streaming Backpressure, O(1) Queue, & Resource Bounds**: `scanSourceRoots` is an `AsyncGenerator` yielding structured `DiscoveryEvent` items (`candidate`, `skip`, `error`) directly to its consumer without retaining emitted records in arrays, while tracking summary counters (`DiscoveryStats`) independently. Pending subdirectories are held in a linked-list `BoundedFifoQueue` ($O(1)$ enqueue/dequeue, no `Array.prototype.shift()`). Configurable resource bounds (`maxPendingDirectories`, `maxVisitedDirectories`, and `maxCollectedRecords` on the bounded `discoverFiles` collector) return `status: 'resource_limit_reached'` with `limitReached` metadata and close open handles deterministically rather than dropping directories or reporting a false completion.
     - **Pre-Open Directory Revalidation & TOCTOU Boundaries**: Each queued subdirectory is revalidated (`signal.aborted`, policy, `lstat`, `realpath`, and canonical root containment) immediately before `opendir` is called, rejecting directories that were replaced by links, files, or outside-root targets while queued. Note: user-space path revalidation narrows the TOCTOU window between queuing and opening, though Node's path-based filesystem APIs do not provide a race-proof kernel-level `openat` descriptor sandbox.
     - **Preservation & Provenance Honesty**: `ReadOnlyFsAdapter` exposes only `lstat`, `realpath`, and `opendir` (frozen, no mutation methods). File contents, `birthtime`, and `mtime` are never altered (note: operating systems may update `atime` during read-only directory reads depending on mount/filesystem settings). Missing or unreliable timestamps (such as `0` or non-finite values) are recorded as `null` rather than fabricated from `mtime`. Stage 2A records extension-based candidates and filesystem metadata only; SHA-256 content hashing and embedded metadata extraction belong to subsequent Stage 2 tasks.
