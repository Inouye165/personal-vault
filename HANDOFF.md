# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-2a-read-only-discovery` (branched from verified Stage 1 closeout commit `db43f2c`)
- **Stage 1 status**: complete (`db43f2c`).
- **Stage 2 status**: **in progress** — **Stage 2A (read-only discovery service, safe traversal, and filesystem metadata inventory) is complete**; overall Stage 2 remains incomplete pending Stage 2B (hashing + SQLite catalog persistence) and Stage 2C (resumable scan jobs + IPC/UI integration).

---

## 1. Stage 2A Implementation & Module Boundaries

Implemented under `src/main/services/discovery/`, isolated from React components and Electron IPC, and never invoked automatically at application startup:

- [`src/main/services/discovery/fs-adapter.ts`](file:///d:/organizer/src/main/services/discovery/fs-adapter.ts):
  - Defines `ReadOnlyFsAdapter` and `createNodeReadOnlyFsAdapter()` exposing only `lstat`, `realpath`, and `opendir` on a frozen object (`Object.freeze`).
  - Exposes zero mutation operations (`writeFile`, `unlink`, `rm`, `rename`, `utimes`, `chmod`, `chown`, `truncate`, `copyFile`, `mkdir`, and `open` are absent).
  - Documents the distinction between preserved file contents, creation times (`birthtime`), and modification times (`mtime`) versus operating-system-managed access timestamps (`atime`).
- [`src/main/services/discovery/policy.ts`](file:///d:/organizer/src/main/services/discovery/policy.ts):
  - Configurable candidate photo and document extension sets (`DEFAULT_PHOTO_EXTENSIONS`, `DEFAULT_DOCUMENT_EXTENSIONS`), treating matches as extension-based candidates (`candidateKind: 'photo' | 'document'`) without claiming content verification.
  - Explicitly includes `.md`, `.markdown`, and `.txt` documents while filtering known software-clutter filenames (`CMakeLists.txt`, `requirements.txt`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, lockfiles, etc.) and software-clutter directories (`node_modules`, `.git`, `dist`, `build`, `out`, `.venv`, `__pycache__`, `target`, `vendor`, etc.).
  - Supports explicit directory exclusions by path (`excludedPaths`) and directory name (`excludedDirectoryNames`), plus hidden/system metadata filtering (`.DS_Store`, `Thumbs.db`, `@eaDir`, `__MACOSX`, `$RECYCLE.BIN`, `System Volume Information`, and dot-entries). Every exclusion decision returns a structured, testable `DiscoverySkipReason` and `detail`.
- [`src/main/services/discovery/scanner.ts`](file:///d:/organizer/src/main/services/discovery/scanner.ts):
  - `discoverFiles(options)` traverses caller-supplied roots incrementally using an explicit breadth-first queue and `dirHandle.read()`.
  - Maintains at most one open directory handle at any time (`O(1)` file descriptors) and guarantees `await dirHandle.close()` inside a `finally` block on normal completion, recoverable error, or `AbortSignal` cancellation.
  - Skips symbolic links and Windows directory junctions by default (both when a source root itself is a link/junction and when encountered inside a directory) and verifies every visited path via `realpath` and `isInsideApprovedRoot` so traversal never escapes the canonical approved root.
  - Records original `absolutePath`, `fileName`, normalized `extension`, `candidateKind`, `byteSize`, `filesystemCreatedAt`, and `filesystemModifiedAt`. Represents missing or unreliable timestamps (`<= 0`, `NaN`, or non-finite) as `null` rather than fabricating fallback values from `mtime`.
  - Handles missing roots, non-directory roots, unreadable directories (`EACCES`/`EPERM`), disappearing entries (`ENOENT`), and unreadable files as structured `DiscoveryError` items without failing the overall scan.
- [`src/main/services/discovery/types.ts`](file:///d:/organizer/src/main/services/discovery/types.ts) & [`src/main/services/discovery/index.ts`](file:///d:/organizer/src/main/services/discovery/index.ts):
  - Public TypeScript contracts and module exports. Documents that SHA-256 content hashing and embedded metadata extraction belong to subsequent tasks.

---

## 2. Test-Driven Development (Red / Green) Evidence

1. **Red phase**:
   - Authored behavioral test suite in [`tests/main/discovery.test.ts`](file:///d:/organizer/tests/main/discovery.test.ts) covering nested photo/document candidate discovery, `.md`/`.txt` inclusion, explicit and software-clutter exclusions, source byte/timestamp preservation, honest `null` timestamps, real Windows directory junctions and root boundary checks, recoverable errors, and `AbortSignal` handle cleanup.
   - Ran `npm test` before creating `src/main/services/discovery/`: failed with `Error: Cannot find module '../../src/main/services/discovery'`.
2. **Green & Refactor phase**:
   - Implemented `fs-adapter.ts`, `policy.ts`, `scanner.ts`, `types.ts`, and `index.ts`.
   - Fixed a Windows path resolution mismatch in the synthetic timestamp test (`resolve('/synthetic/root')` vs `join(fixtureRoot, 'synthetic-root')`) and expanded coverage to 11 behavioral tests in `tests/main/discovery.test.ts` (79 total tests across 6 test files).
   - Ran `npm test`: **6 test files, 79 tests passing**.

---

## 3. Verification Results

| Command                | Result   | Details                                                                                |
| ---------------------- | -------- | -------------------------------------------------------------------------------------- |
| `npm test`             | **PASS** | 6 test files, 79 tests passing (including 11 Stage 2A discovery behavioral tests)      |
| `npm run typecheck`    | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors) |
| `npm run lint`         | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                    |
| `npm run format:check` | **PASS** | Prettier 100% compliant                                                                |
| `npm run build`        | **PASS** | `electron-vite` builds main, preload, and renderer cleanly                             |

---

## 4. Known Limitations & Boundaries

- **Windows File Symlink Privilege (`EPERM`)**: On Windows without Developer Mode or elevated `SeCreateSymbolicLinkPrivilege`, creating file symlinks (`symlink(target, path, 'file')`) returns `EPERM`, whereas directory junctions (`symlink(target, path, 'junction')`) work unprivileged. Integration tests exercise real filesystem directory junctions (both nested and as a source root) in temporary fixtures and verify file symlinks and `realpath` root escapes via `ReadOnlyFsAdapter`.
- **Metadata-Only Discovery (Stage 2A Scope)**: Stage 2A records filesystem metadata and extension-based candidate kinds only. It does not compute SHA-256 content hashes, parse EXIF/document contents, write to SQLite, or expose IPC/UI controls.
- **OS Access Time (`atime`)**: While discovery uses strictly read-only system calls (`lstat`, `realpath`, `opendir`), the host OS/filesystem may update access timestamps (`atime`) during directory reads depending on mount settings. File contents, creation times (`birthtime`), and modification times (`mtime`) remain untouched.

---

## 5. Immediate Recommended Next Task

**Stage 2B: Streaming SHA-256 Content Hashing & SQLite Catalog Inventory Schema**

- Implement read-only streaming SHA-256 hashing and the SQLite catalog schema to persist discovered file facts and source inventory records, beginning with failing behavioral tests.
