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
│   ├── security.ts        # CSP headers, navigation guards, permission deny
│   └── ipc/
│       └── handlers.ts    # Handlers for app info, vault status, tab navigation
├── preload/
│   ├── index.ts           # Exposes window.api via contextBridge with validation
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

1. **Electron (v34) + React (v19) + TypeScript**:
   - Modern, supported foundation offering native desktop integration, memory-safe cross-process communication, and strict type checking.
2. **electron-vite (v3.1) + Vite (v6)**:
   - Separate build configurations for main (Node target), preload (sandbox/node target), and renderer (browser ESM target).
   - Fast hot reload during development and deterministic tree-shaken production bundles.
3. **Zod Runtime Validation**:
   - TypeScript types guarantee compile-time correctness, but IPC payloads cross process serialization boundaries. Zod ensures runtime defense-in-depth against corrupt or unexpected data.
4. **Vitest + @testing-library/react**:
   - Fast execution, jsdom support for DOM and component behavior testing, and full compatibility with Vite TypeScript paths.
5. **No AI / Embedding / OCR / Python tooling in Stage 1**:
   - Deferred to subsequent stages to evaluate memory, packaging, and offline performance trade-offs without bloat.
