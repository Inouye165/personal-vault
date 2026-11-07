# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-2a-read-only-discovery` (branched from verified Stage 1 closeout commit `db43f2c`)
- **Stage 1 status**: complete (`db43f2c`).
- **Stage 2 status**: **incomplete** - **Stage 2A is complete; independent review accepted at `5dd6320`**. Stage 2B (read-only streaming SHA-256 hashing), Stage 2C (SQLite catalog persistence), and Stage 2D (resumable scan jobs + IPC/UI integration) have not started.

---

## 1. Stage 2A Module Responsibilities (`src/main/services/discovery/`)

Isolated from React components and Electron IPC, and never invoked automatically at application startup:

- [`src/main/services/discovery/fs-adapter.ts`](file:///d:/organizer/src/main/services/discovery/fs-adapter.ts):
  - Read-only filesystem boundary (`ReadOnlyFsAdapter` and `createNodeReadOnlyFsAdapter()`) exposing only `lstat`, `realpath`, and `opendir` on a frozen object (`Object.freeze`) with zero mutation methods.
- [`src/main/services/discovery/policy.ts`](file:///d:/organizer/src/main/services/discovery/policy.ts):
  - Candidate photo/document extension policy (including `.md`, `.markdown`, and `.txt`) and directory/file exclusion evaluation (`resolveDiscoveryPolicy`, `evaluateDirectoryEntry`, `evaluateFileEntry`, `isPathOrAncestorExcluded`).
  - Enforces documented directory exclusion precedence on both source roots and nested directories: `excludedPaths` (including ancestor matches) > `excludedDirectoryNames` > `softwareClutterDirectoryNames` > `hiddenAndSystemNames` / dot-entries (while ignoring ancestor directory names above an explicit root).
- [`src/main/services/discovery/limits.ts`](file:///d:/organizer/src/main/services/discovery/limits.ts):
  - Resource-limit defaults (`DEFAULT_MAX_PENDING_DIRECTORIES = 10,000`, `DEFAULT_MAX_VISITED_DIRECTORIES = 100,000`, `DEFAULT_MAX_COLLECTED_RECORDS = 50,000`), validation (`resolveDiscoveryLimits`, `validatePositiveSafeInteger`), and the linked-list $O(1)$ `BoundedFifoQueue<T>`.
  - Rejects `NaN`, `Infinity`, `-Infinity`, `<= 0`, fractions, and unsafe integers (`> Number.MAX_SAFE_INTEGER`) with `RangeError` before any filesystem operations or callbacks execute.
- [`src/main/services/discovery/inspection.ts`](file:///d:/organizer/src/main/services/discovery/inspection.ts):
  - Shared directory validation (`inspectDirectoryTarget` for source roots, child directories, and queued pre-`opendir` revalidation), file-candidate inspection (`inspectFileEntry`), canonical root containment (`isInsideApprovedRoot`), honest nullable timestamp formatting (`toHonestIsoTimestamp`), and error classification (`classifyFsError`).
- [`src/main/services/discovery/scanner.ts`](file:///d:/organizer/src/main/services/discovery/scanner.ts):
  - Streaming traversal orchestration (`scanSourceRoots`) and bounded convenience collection (`discoverFiles`).
  - `discoverFiles` validates `options.limits` eagerly on invocation; `scanSourceRoots` validates `options.limits` lazily when generator iteration starts (`next()` / `for await`). `maxCollectedRecords` applies only to `discoverFiles` (though invalid values supplied in `options.limits` are still rejected).
- [`src/main/services/discovery/types.ts`](file:///d:/organizer/src/main/services/discovery/types.ts) & [`src/main/services/discovery/index.ts`](file:///d:/organizer/src/main/services/discovery/index.ts):
  - Public TypeScript contracts and module exports.

---

## 2. Test-Driven Development (Red / Green) Evidence

1. **Initial Stage 2A (`ed2f411`) & First Correction Pass (`5f7bd61`)**:
   - Authored and verified 19 behavioral tests in [`tests/main/discovery.test.ts`](file:///d:/organizer/tests/main/discovery.test.ts) covering nested candidate discovery, root/child exclusions, source preservation, symlinks/junctions, pre-`opendir` queued directory revalidation, streaming backpressure, `BoundedFifoQueue`, and resource-limit outcomes.
2. **Resource-Limit Validation & Modularity Pass (Current)**:
   - **Red phase**: Added failing tests in [`tests/main/discovery.test.ts`](file:///d:/organizer/tests/main/discovery.test.ts) for `BoundedFifoQueue` invalid capacities (`Number.MAX_SAFE_INTEGER + 1`, `NaN`, `Infinity`, `0`, `-1`, `1.5`), `discoverFiles` invalid limits (including `{ maxCollectedRecords: NaN, maxVisitedDirectories: NaN }`), and `scanSourceRoots` lazy limit validation at iteration start, asserting zero filesystem or callback invocations. Ran `npm test`: **3 failed | 86 passed (89 total)**.
   - **Green & Refactor phase**: Extracted `limits.ts` and `inspection.ts`, refactored `scanner.ts` to share directory/file inspection logic and validate limits via `resolveDiscoveryLimits`, and verified `scanSourceRoots` does not enforce collector-only `maxCollectedRecords` when valid. Ran `npm test`: **89 passed, 0 skipped on unrestricted host** (in sandboxes that block `symlink(..., 'junction')` with `EPERM`, `it.runIf(canCreateRealJunction)` runs **88 passed, 1 skipped**).

---

## 3. Verification Results

The implementation host verified **89 tests passed, 0 skipped**. The independent reviewer verified **88 tests passed, 1 real-junction test skipped** because sandbox permissions deny junction creation, and separately passed type checking, linting, formatting, and build. These are separate execution results for accepted implementation `5dd6320`; application checks were not rerun for this documentation-only closeout.

| Command                | Result   | Details                                                                                                      |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `npm test`             | **PASS** | 6 test files: 89 passed, 0 skipped on host (88 passed, 1 skipped when sandbox blocks real junction creation) |
| `npm run typecheck`    | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors)                       |
| `npm run lint`         | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                                          |
| `npm run format:check` | **PASS** | Prettier 100% compliant                                                                                      |
| `npm run build`        | **PASS** | `electron-vite` builds main, preload, and renderer cleanly                                                   |

---

## 4. Known Limitations & Boundaries

- **User-Space Path Revalidation vs. Kernel Descriptor Sandboxing (TOCTOU)**: Revalidating queued directories (`lstat` + `realpath` + containment check) immediately before `opendir` narrows the time-of-check-to-time-of-use window between parent directory enumeration and subdirectory opening, but Node's path-based filesystem APIs do not provide a race-proof kernel-level `openat`/`O_NOFOLLOW` directory-descriptor sandbox.
- **Windows File Symlink & Sandbox Junction Privilege (`EPERM`)**: `tests/main/discovery.test.ts` probes real junction creation once in `os.tmpdir()` (`probeRealJunctionSupport()`) and uses `it.runIf(canCreateRealJunction)` so restricted sandboxes report the real-junction test as explicitly skipped in Vitest while deterministic `ReadOnlyFsAdapter` symlink/junction tests run in every environment.
- **Metadata-Only Discovery (Stage 2A Scope)**: Stage 2A records filesystem metadata and extension-based candidate kinds only. It does not compute SHA-256 content hashes, parse EXIF/document contents, write to SQLite, or expose IPC/UI controls.
- **OS Access Time (`atime`)**: While discovery uses strictly read-only system calls (`lstat`, `realpath`, `opendir`), the host OS/filesystem may update access timestamps (`atime`) during directory reads depending on mount settings. File contents, creation times (`birthtime`), and modification times (`mtime`) remain untouched.

---

## 5. Immediate Recommended Next Task

**Stage 2B: Read-only streaming SHA-256 hashing**, beginning with failing behavioral tests for content identity, bounded reads, cancellation, and source preservation. SQLite catalog persistence is a separate Stage 2C task; resumable scan jobs and IPC/UI integration follow in Stage 2D.
