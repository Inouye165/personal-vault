# Personal Vault — Standing Engineering Instructions (AGENTS.md)

Project Slug: `personal-vault`  
Workspace: Repository checkout root (closeout baseline in `D:\workspace\personal-vault`; keep `D:\organizer` separate/read-only)

## 1. Core Mission & Inviolable Principles

Personal Vault discovers photographs and documents, supports review and classification, and copies selected originals into a vault. All engineering work must adhere to the following principles:

1. **Source Preservation**:
   - Source files are strictly read-only during discovery, classification, and import.
   - Never alter, overwrite, touch, or move source files.
   - Deletion of source files is never performed automatically or as part of deduplication.

2. **Provenance & Separation of Facts vs Inferences**:
   - Record exact original filenames, absolute paths, filesystem timestamps (creation, modification), byte size, and SHA-256 hashes as immutable recorded facts.
   - Separate inferred metadata (derived capture dates, reverse geolocations, AI document classifications, tags) from recorded facts.
   - Allow capture dates and locations to remain unknown when metadata is absent. Never fabricate or force fallback dates into recorded fact fields.

3. **Distinction of Operations**:
   - Explicitly distinguish:
     1. Removal from catalog index.
     2. Deletion of a vault-managed copy.
     3. Deletion of an original source file (requires explicit, guarded user confirmation, never automated).

4. **Verified Import**:
   - Vault copying must verify hashes before acknowledging success.
   - Metadata must remain portable (sidecars/catalog backups) so SQLite is not its single fragile repository.

5. **Privacy & Offline First**:
   - No uploading of personal files, metadata, or extracted document contents to external network endpoints without explicit user-enabled features.

---

## 2. Process Boundaries & Architecture

```
┌────────────────────────────────────────────────────────┐
│                   Electron Main                        │
│ - App lifecycle & window management                    │
│ - Security policies (CSP, navigation guards)           │
│ - IPC handlers with Zod schema validation              │
│ - Future: SQLite catalog & background worker runner    │
└──────────────────────────┬─────────────────────────────┘
                           │ IPC (Structured Cloning)
┌──────────────────────────▼─────────────────────────────┐
│                   Preload Script                       │
│ - contextIsolation: true, nodeIntegration: false       │
│ - sandbox: true                                        │
│ - Narrow typed API (`window.api`) with runtime parse   │
└──────────────────────────┬─────────────────────────────┘
                           │ contextBridge
┌──────────────────────────▼─────────────────────────────┐
│                 React Renderer                         │
│ - React 19 + TypeScript (Strict checking)             │
│ - Pure presentation, navigation, & responsive views    │
│ - No direct Node.js or filesystem access               │
└────────────────────────────────────────────────────────┘
```

- **Main Process (`src/main`)**: Native window management, IPC handlers, filesystem adapters, background jobs.
- **Preload (`src/preload`)**: Minimal contextBridge surface exposing typed `window.api`. Validates data crossing the boundary.
- **Shared Contracts (`src/shared`)**: IPC channels, Zod schemas, domain interfaces, and validation functions.
- **Renderer (`src/renderer`)**: React UI components, styling, accessible controls, local UI state.

---

## 3. Standard Development & Verification Commands

All commands run from the active repository root (e.g., `D:\workspace\personal-vault`):

- **Development server**: `npm run dev`
- **Full bundle build**: `npm run build` (run before `npm test` on a clean checkout so `out/main/document_classify_worker.js` exists)
- **Unit & behavioral tests**: `npm test`
- **Test watcher**: `npm run test:watch`
- **Strict type checking**: `npm run typecheck`
- **Linting**: `npm run lint`
- **Formatting check**: `npm run format:check` (on Windows `core.autocrlf=true` checkouts, `npx prettier --end-of-line auto --check .` and `npx prettier --check <changed-files>` avoid CRLF false positives)
- **Format codebase**: `npm run format`
- **Unpacked desktop binary build**: `npm run build:unpack`
- **Pinned VC++ Redistributable download/verify**: `npm run fetch:vcredist` and `npm run verify:vcredist`
- **Windows x64 NSIS candidate build**: `npm run build:installer`
- **Isolated Windows candidate E2E & lifecycle check**: `npm run verify:windows-candidate`
- **Real Electron bridge smoke checks**: `npm run smoke:dev`, `npm run smoke:built`, `npm run smoke:unpacked` (the unpacked check requires `npm run build:unpack` or `npm run build:installer` first)
- **Electron SQLite driver check**: `npm run verify:sqlite`

---

## 4. Test-Driven Development (TDD) Workflow

1. **Write failing behavior test**: Specify user-visible or boundary behavior before writing business code.
2. **Implement minimal solution**: Write clean, cohesive code satisfying the test.
3. **Refactor**: Remove duplication, isolate domain models from presentation, refine interfaces.
4. **Verify quality gates**:
   - `npm test`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run format:check`
   - `npm run build`

---

## 5. Security Requirements

- **Context Isolation**: Must remain `true` in all BrowserWindow configurations.
- **Node Integration**: Must remain `false` in renderer environments.
- **Sandboxing**: Renderer must run with `sandbox: true`.
- **Content Security Policy (CSP)**: Enforced via HTTP response headers and `<meta>` tag:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self';`
- **Navigation Restrictions**: External URLs cannot be loaded inside the Electron window; `will-navigate` blocks unexpected redirects and `setWindowOpenHandler` denies popup creations.
- **Process Boundary Validation**: All incoming and outgoing IPC payloads, including acknowledgements, must be validated with Zod schemas.
- **IPC Sender Validation**: Every IPC handler must verify the sending WebContents, that the frame is the top-level frame, and that its URL is the trusted application location.
- **Navigation**: Only the trusted application location may be navigated to (the built document when packaged; one explicit dev origin when unpackaged). No broad `localhost` or `file:` exceptions. Popups are denied; never pass arbitrary URLs to `shell.openExternal`.
- **Sandboxed Preload**: Anything the preload imports other than `electron` must be bundled into it; `out/preload/index.js` must not `require` other packages.

---

## 6. Stage Completion Criteria

- All stage deliverables completed according to specification.
- No untested code or unvalidated IPC boundaries.
- Runtime success means a real Electron smoke check passes (`window.api` methods return correct values across IPC, no preload or renderer errors). A visible window or a startup log alone is not evidence.
- No implementation beyond the current assigned stage (e.g. do not implement Stage 2 file scanning during Stage 1).
- `AGENTS.md`, `ARCHITECTURE.md`, `TODO.md`, `HANDOFF.md`, and `README.md` kept up to date and verified against real execution.
