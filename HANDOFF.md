# Personal Vault — Handoff

## Current state

- **Workspace**: `D:\organizer`
- **Branch**: `feat/stage-2b-streaming-hashing` (branched from verified Stage 2A closeout commit `000923e` / `5dd6320`)
- **Stage 1 status**: complete (`db43f2c`).
- **Stage 2 status**: **incomplete** — **Stage 2A complete (accepted at `5dd6320`); Stage 2B complete; independent review accepted at `e4488a2`; Stages 2C and 2D not started**.

---

## 1. Stage 2B Module Responsibilities (`src/main/services/hashing/`)

Modular backend hashing service, independent of Electron IPC and React:

- [`src/main/services/hashing/fs-adapter.ts`](file:///d:/organizer/src/main/services/hashing/fs-adapter.ts):
  - Strictly read-only filesystem boundary (`ReadOnlyHashingFsAdapter` and `createNodeReadOnlyHashingFsAdapter()`) exposing only `lstat`, `realpath`, and `open` (with `'r'` read-only flag) returning a `ReadOnlyFileHandle` (`stat`, `read`, `close`).
  - Both adapter and handle objects are frozen (`Object.freeze`) with zero mutation capabilities (`writeFile`, `unlink`, `rm`, `truncate`, `chmod`, etc.).
- [`src/main/services/hashing/limits.ts`](file:///d:/organizer/src/main/services/hashing/limits.ts):
  - Hashing resource-limit validation (`resolveHashingLimits`).
  - Requires finite positive safe integers for `chunkSizeBytes` between 1 KiB (1,024) and 16 MiB (16,777,216), defaulting to 64 KiB (65,536).
  - Validates `maxFileSizeBytes` as a non-negative safe integer when supplied.
  - Rejects `NaN`, `Infinity`, `<= 0`, fractions, and out-of-range integers with `RangeError` before opening files or making filesystem calls.
- [`src/main/services/hashing/path-security.ts`](file:///d:/organizer/src/main/services/hashing/path-security.ts):
  - Approved-root containment verification (`isPathContainedInRoot`) and path normalization (`normalizePathForComparison`).
  - Verifies that the candidate file's canonical realpath resides inside at least one approved canonical root directory, rejecting outside paths and path traversal escapes.
- [`src/main/services/hashing/hasher.ts`](file:///d:/organizer/src/main/services/hashing/hasher.ts):
  - Mandatory, validated approved roots (`validateApprovedRoots`): rejects missing, empty, or blank root arrays eagerly with `RangeError` before filesystem work. Verifies each supplied root exists and is a regular directory.
  - Bounded streaming SHA-256 calculation (`hashFile`) using Node's `node:crypto` (`createHash('sha256')`). Reuses a single pre-allocated chunk buffer, never loading full files into memory.
  - Rejects symlinks and non-regular files before opening.
  - Descriptor pre-stat and post-stat inspections (`fstat` via `handle.stat()`): detects observable file replacements (`dev`/`ino`), size changes, and modification timestamp changes during read, preserving full sub-millisecond precision for live comparisons without flooring.
  - Discovery expectation comparisons (`isTimestampConsistentWithExpectation`): tolerates sub-millisecond precision loss when discovery recorded integer timestamps, while strictly detecting shifts >= 1 ms.
  - Post-read pathname revalidation: re-checks `lstat` and `realpath` on the target pathname on disk after reading, detecting observable replacement, disappearance, symlink substitution, canonical target changes, or dev/ino descriptor discrepancies.
  - Handle-close failure reporting: otherwise-successful hashing surfaces handle-close failures as typed errors without a digest; when both processing and cleanup fail, primary failure information is preserved without masking.
  - Cooperative `AbortSignal` cancellation: checked before opening and during chunk iteration, releasing open handles deterministically in `finally` blocks.
- [`src/main/services/hashing/types.ts`](file:///d:/organizer/src/main/services/hashing/types.ts) & [`src/main/services/hashing/index.ts`](file:///d:/organizer/src/main/services/hashing/index.ts):
  - Public TypeScript contracts and discriminated union outcome (`status: 'success' | 'cancelled' | 'file_changed' | 'rejected' | 'error'`).
  - `approvedRoots` is required as a non-empty array (`readonly [string, ...string[]] | readonly string[]`).
  - Partial digests are strictly excluded from non-success outcomes.

---

## 2. Test-Driven Development (Red / Green / Refactor) Evidence

1. **Initial Stage 2B Implementation (`a767a39`)**:
   - Authored 28 behavioral tests in [`tests/main/hashing.test.ts`](file:///d:/organizer/tests/main/hashing.test.ts) covering limits, empty/binary digests, chunk invariance, source preservation, symlink/directory rejection, expectations, cancellation, and deterministic cleanup.
2. **Review Findings Correction Pass (`e4488a2`)**:
   - **Red phase**: Added 7 new failing tests (total 35 tests in `tests/main/hashing.test.ts`, 124 tests repository-wide) targeting:
     1. Eager rejection of missing/empty/blank `approvedRoots` before filesystem calls, and rejection of non-directory roots.
     2. Fractional-millisecond mtime preservation and detection for `lstat` vs `preStat` and `preStat` vs `postStat`.
     3. Tolerance of integer discovery expectations with live fractional ms, while detecting changes >= 1 ms.
     4. Post-read pathname revalidation detecting post-read disappearance, symlink substitution, and descriptor dev/ino replacement (where pathname points to a different file while descriptor remains open).
     5. Surfacing handle-close failures as typed errors without digests on otherwise-successful reads, while preserving primary failures when both processing and cleanup fail.
     - Ran `npm test`: Demonstrated **8 failing tests** across the review findings.
   - **Green & Refactor phase**:
     - Updated `types.ts` making `approvedRoots` required.
     - Extracted `processFileDescriptor` in `hasher.ts` to modularize handle processing and prevent `no-unsafe-finally` linter errors.
     - Implemented `validateApprovedRoots`, root directory verification, exact sub-ms comparisons, `isTimestampConsistentWithExpectation`, post-read pathname revalidation, and handle-close error handling.
     - Ran `npm test`: **All 35 hashing tests passed; 124 tests passed repository-wide (0 skipped)**.
     - Verified `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build` all pass with 0 errors.

---

## 3. Verification Results

The implementation host verified **124 tests passed, 0 skipped**. The independent reviewer verified **123 tests passed, 1 real-junction test skipped** because sandbox permissions deny junction creation, and separately passed type checking, linting, formatting, and build. These are separate execution results for accepted implementation `e4488a2`; application checks were not rerun for this documentation-only closeout.

| Command                | Result   | Details                                                                                                                    |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | **PASS** | 7 test files: 124 passed on host (123 passed, 1 junction test skipped under sandbox permissions during independent review) |
| `npm run typecheck`    | **PASS** | Strict TypeScript check across `tsconfig.node.json` and `tsconfig.web.json` (0 errors)                                     |
| `npm run lint`         | **PASS** | Active ESLint rules across all project files (0 errors, 0 warnings)                                                        |
| `npm run format:check` | **PASS** | Prettier 100% compliant across entire repository                                                                           |
| `npm run build`        | **PASS** | `electron-vite` builds main, preload, and renderer cleanly                                                                 |

---

## 4. Known Limitations & Boundaries

- **User-Space Path Revalidation vs. Kernel Descriptor Sandboxing (TOCTOU)**: Pre-open validation (`lstat`, `realpath`, approved root containment check), descriptor-level `fstat` before and after reading, and post-read pathname revalidation (`lstat`, `realpath`, and `postPathStat.ino !== postStat.ino`) drastically narrow the time-of-check-to-time-of-use window and detect observable replacements, disappearances, or modifications. However, Node's standard user-space filesystem APIs do not provide a race-free kernel-level `openat(..., O_NOFOLLOW)` descriptor sandbox.
- **OS Access Time (`atime`)**: The hashing adapter performs strictly read-only operations (`lstat`, `realpath`, `open` in read mode, and chunked `read`). File bytes, creation time (`birthtime`), and modification time (`mtime`) are never altered. However, the host operating system/filesystem may update access timestamps (`atime`) depending on mount options (e.g. `relatime` on POSIX or NTFS `NtfsDisableLastAccessUpdate`).
- **Timestamp Precision & Discovery Expectations**: Live file inspections compare modification timestamps with exact sub-millisecond floating-point precision without flooring. For external discovery expectations with integer millisecond precision, comparisons tolerate sub-millisecond truncation within a 1 ms tolerance (`|live - expected| < 1.0 ms`) while detecting shifts >= 1 ms.
- **Cleanup Behavior & Handle Close Failures**: Handle closure failures on otherwise-successful reads surface as typed `io_error` outcomes without returning a digest. When both processing and cleanup fail, primary failure details are preserved without masking. Native close operations are never blindly retried.
- **Stage 2 Scope Isolation**: Stage 2B provides streaming SHA-256 calculation only. SQLite catalog persistence belongs to Stage 2C; resumable scan jobs and UI/IPC integration belong to Stage 2D.

---

## 5. Immediate Recommended Next Task

**Stage 2C: SQLite catalog schema and inventory persistence**, beginning with database initialization, schema migration, recorded file facts storage, and transactional batch persistence. Resumable background scan-job orchestration and IPC/UI integration follow in Stage 2D.
