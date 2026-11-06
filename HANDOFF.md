# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-2a-read-only-discovery` (branched from verified Stage 1 closeout commit `db43f2c`)
- **Stage 1 status**: complete (`db43f2c`).
- **Stage 2 status**: **in progress** — **Stage 2A (read-only discovery service, safe traversal, bounded streaming/backpressure, source-root exclusions, pre-open directory revalidation, and filesystem metadata inventory) is complete**; overall Stage 2 remains incomplete pending Stage 2B (hashing + SQLite catalog persistence) and Stage 2C (resumable scan jobs + IPC/UI integration).

---

## 1. Stage 2A Implementation & Correction Pass Summary

Implemented under `src/main/services/discovery/`, isolated from React components and Electron IPC, and never invoked automatically at application startup:

- [`src/main/services/discovery/fs-adapter.ts`](file:///d:/organizer/src/main/services/discovery/fs-adapter.ts):
  - Defines `ReadOnlyFsAdapter` and `createNodeReadOnlyFsAdapter()` exposing only `lstat`, `realpath`, and `opendir` on a frozen object (`Object.freeze`).
  - Exposes zero mutation operations (`writeFile`, `unlink`, `rm`, `rename`, `utimes`, `chmod`, `chown`, `truncate`, `copyFile`, `mkdir`, and `open` are absent).
  - Documents the distinction between preserved file contents, creation times (`birthtime`), and modification times (`mtime`) versus operating-system-managed access timestamps (`atime`).
- [`src/main/services/discovery/policy.ts`](file:///d:/organizer/src/main/services/discovery/policy.ts):
  - Configurable candidate photo and document extension sets (`DEFAULT_PHOTO_EXTENSIONS`, `DEFAULT_DOCUMENT_EXTENSIONS`), treating matches as extension-based candidates (`candidateKind: 'photo' | 'document'`) without claiming content verification.
  - Explicitly includes `.md`, `.markdown`, and `.txt` documents while filtering known software-clutter filenames (`CMakeLists.txt`, `requirements.txt`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, lockfiles, etc.) and software-clutter directories (`node_modules`, `.git`, `dist`, `build`, `out`, `.venv`, `__pycache__`, `target`, `vendor`, etc.).
  - Enforces documented exclusion precedence on both explicitly supplied source roots and nested directories:
    1. `excludedPaths` via `isPathOrAncestorExcluded` (exact path or nested under an excluded ancestor) -> `excluded_directory`
    2. `excludedDirectoryNames` on directory basename -> `excluded_directory`
    3. `softwareClutterDirectoryNames` on directory basename -> `software_clutter_directory`
    4. `hiddenAndSystemNames` / dot-prefixed basename when `excludeHiddenEntries` is enabled -> `hidden_or_system_entry`
       Ancestor directory names above an explicitly supplied source root do not trigger name-based exclusions (2–4), whereas explicit path exclusions (1) apply to both roots and roots nested under an excluded ancestor.
- [`src/main/services/discovery/scanner.ts`](file:///d:/organizer/src/main/services/discovery/scanner.ts):
  - **Streaming with Backpressure (`scanSourceRoots`)**: `AsyncGenerator<DiscoveryEvent, DiscoverySummary, void>` that yields `{ kind: 'candidate', candidate }`, `{ kind: 'skip', skip }`, and `{ kind: 'error', error }` directly without retaining emitted records in memory, while tracking summary counters (`DiscoveryStats`) independently and awaiting optional `onCandidate`/`onEvent` consumers.
  - **Bounded O(1) Queue & Resource Limits (`BoundedFifoQueue`)**: Linked-list FIFO queue ($O(1)$ `enqueue`/`dequeue`, no `Array.prototype.shift()`) bounding pending directories (`maxPendingDirectories`, default `10,000`) and visited directories (`maxVisitedDirectories`, default `100,000`). `discoverFiles(options)` is implemented on top of `scanSourceRoots` as an explicitly bounded convenience collector (`maxCollectedRecords`, default `50,000`). Exceeding any configured limit closes the active directory handle deterministically and returns `status: 'resource_limit_reached'` with structured `limitReached` metadata.
  - **Source-Root Exclusion Before Opening**: Evaluates source roots against `evaluateDirectoryEntry` before calling `lstat` or `opendir` (and re-evaluates canonical `realpath` if different), ensuring excluded roots are never opened.
  - **Pre-`opendir` Queued Directory Revalidation**: Immediately before calling `opendir` on each queued directory, rechecks `signal.aborted`, policy rules, `lstat` (rejecting entries that disappeared, became symlinks/junctions, or ceased to be directories), and `realpath` (rejecting paths resolving outside the canonical approved root, changed canonical targets, or excluded canonical paths).
  - Maintains at most one open directory handle at any time (`O(1)` file descriptors) and guarantees `await dirHandle.close()` inside a `finally` block on normal completion, recoverable error, resource limit, early consumer termination (`stream.return()`), or `AbortSignal` cancellation.
- [`src/main/services/discovery/types.ts`](file:///d:/organizer/src/main/services/discovery/types.ts) & [`src/main/services/discovery/index.ts`](file:///d:/organizer/src/main/services/discovery/index.ts):
  - Public TypeScript contracts (`DiscoveryEvent`, `DiscoverySummary`, `DiscoveryResourceLimits`, `DiscoveryLimitReached`, `DiscoveryStatus`, etc.) and module exports.

---

## 2. Test-Driven Development (Red / Green) Evidence

1. **Initial Stage 2A Red / Green (`ed2f411`)**:
   - Authored 11 behavioral tests in [`tests/main/discovery.test.ts`](file:///d:/organizer/tests/main/discovery.test.ts), verified Red failure before implementation, and implemented initial Stage 2A module (`79` total tests passing).
2. **Stage 2A Correction Pass Red Phase**:
   - Added 8 new failing behavioral tests in [`tests/main/discovery.test.ts`](file:///d:/organizer/tests/main/discovery.test.ts) covering:
     - Explicit path exclusions on source roots and roots nested under an excluded ancestor (`opendir` never called).
     - Precedence for name-based/default exclusions on source roots while allowing hidden/clutter ancestors above an explicit root.
     - Pre-`opendir` revalidation of queued directories mutated after parent handle closure (`became-link`, `retargeted-outside`, `became-file`, `vanished-dir`).
     - Incremental streaming (`scanSourceRoots`) with consumer backpressure preventing read-ahead.
     - Resource limit outcomes (`maxPendingDirectories`, `maxVisitedDirectories`, `maxCollectedRecords`) returning `status: 'resource_limit_reached'` and closing handles.
     - Unit verification of `BoundedFifoQueue` $O(1)$ operations and capacity enforcement.
   - Ran `npm test`: **failed as expected (8 failed | 79 passed, 87 total)**.
3. **Stage 2A Correction Pass Green & Refactor Phase**:
   - Implemented streaming `scanSourceRoots`, `BoundedFifoQueue`, resource limit enforcement, root exclusion precedence, and pre-open queued directory revalidation across `types.ts`, `policy.ts`, `scanner.ts`, and `index.ts`.
   - Ran `npm test`: **6 test files, 87 tests passing (including 19 Stage 2A discovery tests)**.

---

## 3. Verification Results

| Command                | Result   | Details                                                                                |
| ---------------------- | -------- | -------------------------------------------------------------------------------------- |
| `npm test`             | **PASS** | 6 test files, 87 tests passing (including 19 Stage 2A discovery behavioral tests)      |
| `npm run typecheck`    | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors) |
| `npm run lint`         | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                    |
| `npm run format:check` | **PASS** | Prettier 100% compliant                                                                |
| `npm run build`        | **PASS** | `electron-vite` builds main, preload, and renderer cleanly                             |

---

## 4. Known Limitations & Boundaries

- **User-Space Path Revalidation vs. Kernel Descriptor Sandboxing (TOCTOU)**: Revalidating queued directories (`lstat` + `realpath` + containment check) immediately before `opendir` narrows the time-of-check-to-time-of-use window between parent directory enumeration and subdirectory opening, but Node's path-based filesystem APIs do not provide a race-proof kernel-level `openat`/`O_NOFOLLOW` directory-descriptor sandbox.
- **Windows File Symlink & Sandbox Junction Privilege (`EPERM`)**: On Windows without Developer Mode or `SeCreateSymbolicLinkPrivilege`, file symlinks (`symlink(target, path, 'file')`) fail with `EPERM`, and restricted execution sandboxes may also block directory junction creation (`symlink(target, path, 'junction')`) with `EPERM`. `tests/main/discovery.test.ts` probes real junction creation once in `os.tmpdir()` (`probeRealJunctionSupport()`) and uses `it.runIf(canCreateRealJunction)` so restricted sandboxes report the real-junction test as explicitly skipped in Vitest while deterministic `ReadOnlyFsAdapter` symlink/junction tests run in every environment.
- **Metadata-Only Discovery (Stage 2A Scope)**: Stage 2A records filesystem metadata and extension-based candidate kinds only. It does not compute SHA-256 content hashes, parse EXIF/document contents, write to SQLite, or expose IPC/UI controls.
- **OS Access Time (`atime`)**: While discovery uses strictly read-only system calls (`lstat`, `realpath`, `opendir`), the host OS/filesystem may update access timestamps (`atime`) during directory reads depending on mount settings. File contents, creation times (`birthtime`), and modification times (`mtime`) remain untouched.

---

## 5. Immediate Recommended Next Task

**Stage 2B: Streaming SHA-256 Content Hashing & SQLite Catalog Inventory Schema**

- Implement read-only streaming SHA-256 hashing and the SQLite catalog schema to persist discovered file facts and source inventory records, beginning with failing behavioral tests.
