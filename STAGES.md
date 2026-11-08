# Personal Vault - Development and Public Release Tracker

Updated: November 7, 2026.

This tracker covers all development through public release. Detailed tasks belong in [TODO.md](TODO.md); verification evidence and limitations belong in [HANDOFF.md](HANDOFF.md).

## Current position

Stage 1, Stage 2, Stage 3, and Stage 4 are complete (independently accepted at `070e3cb`, `71e1af7`, `79bbf44`, and `1a1fb69`). Stages 5-8 are future work. Public release has not occurred and has no scheduled date.

## All stages

The project has **eight main stages**. Lettered substages divide the work; they do not add main stages.

| Stage | Deliverable                                                    | Status   | Acceptance |
| ----- | -------------------------------------------------------------- | -------- | ---------- |
| 1     | Engineering foundation and secure desktop shell                | Complete | `070e3cb`  |
| 2     | Discovery, hashing, SQLite catalog, and resumable scan jobs    | Complete | `71e1af7`  |
| 3     | Exact duplicate grouping and review                            | Complete | `79bbf44`  |
| 4     | Verified vault copying and portable metadata                   | Complete | `1a1fb69`  |
| 5     | Fast photo browsing, ratings, and similarity review            | Planned  | Pending    |
| 6     | Semantic photo search and metadata filters                     | Planned  | Pending    |
| 7     | Document extraction, classification, OCR, and unified search   | Planned  | Pending    |
| 8     | Export, recovery, release validation, beta, and public release | Planned  | Pending    |

Status meanings: **Planned** = future work; **Starting** = preparation underway; **In progress** = implementation underway or a parent stage partly complete; **Awaiting review** = submitted for independent review; **Complete** = independently accepted; **Blocked** = a named dependency prevents progress. A branch name alone does not establish implementation progress.

## Stage 1 - Foundation and desktop shell

**Complete; accepted at `070e3cb`.**

- [x] Electron, React, and TypeScript foundation and application shell.
- [x] Isolated renderer, sandboxed preload, validated IPC, and restricted navigation.
- [x] Honest loading, error, and empty states.
- [x] Behavioral tests, quality gates, packaging, and real-Electron smoke verification.

## Stage 2 - Discovery and resumable inventory

**Complete; accepted at `71e1af7`.**

| Substage | Deliverable                                                       | Status   | Accepted implementation | Documentation closeout |
| -------- | ----------------------------------------------------------------- | -------- | ----------------------- | ---------------------- |
| 2A       | Read-only discovery and filesystem inventory                      | Complete | `5dd6320`               | `000923e`              |
| 2B       | Read-only streaming SHA-256 hashing                               | Complete | `e4488a2`               | `ab2fd60`              |
| 2C       | SQLite schema, migrations, inventory, and observation persistence | Complete | `a674f9c`               | `d25ba50`              |
| 2D       | Resumable background scan jobs and IPC/UI integration             | Complete | `71e1af7`               | (this commit)          |

Stage 2D:

- [x] Connect existing discovery, hashing, and bounded persistence through background jobs.
- [x] Provide progress, pause/resume, cancellation, visible errors, and deterministic cleanup.
- [x] Persist checkpoints and recover interrupted jobs with source-file revalidation.
- [x] Add validated IPC and minimal controls within the existing UI design.
- [x] Verify actual scanning and recovery in Electron and applicable packaged execution.
- [x] Obtain independent acceptance and documentation closeout (`71e1af7`).

Exit: users can manage scans and recover interrupted work after restart without modifying originals or treating stale hashes as verified.

## Stage 3 - Exact duplicate review

**Complete; accepted at `79bbf44`.**

- [x] Group identical content by verified SHA-256 and byte size across filenames and locations.
- [x] Present duplicate groups with side-by-side recorded metadata, explicit unknown values, and observation provenance.
- [x] Support explicit review decisions (reviewed/unreviewed, optional preferred location) without mutating recorded facts or modifying sources.
- [x] Enforce decision invalidation policy: reset decision when group membership, content, or observations change; reject stale writes.
- [x] Truly bounded constant-memory SQL queries and deterministic signatures with O(1) auxiliary JS memory.
- [x] Async safety: list summaries and reloads guarded against stale save responses; pure state updaters.
- [x] Distinguish catalog-index removal, vault-copy deletion, and original-source deletion as distinct operations (none implemented).
- [x] Verify real Electron IPC duplicate review across scan, inspection, restart persistence, and rescan invalidation (implementation host: built and freshly rebuilt unpacked passed 18/18 checks; reviewer host: window connection timeout noted).

Exit: users can understand and review duplicate groups without losing locations or differing metadata.

## Stage 4 - Verified vault copying

**Complete; independently accepted at 1a1fb69.**

- [x] Initialize vault storage directory with versioned identity manifest (`vault.json`) and validate separation from source roots. Conflicting or invalid existing identity files are rejected without modification (`VaultInitializationError`).
- [x] Strict source preservation: source files are strictly read-only; originals are never moved, renamed, touched, overwritten, or deleted.
- [x] Verified copy pipeline (`copyAndVerifyFileToVault`): pre/post `fstat` source descriptor checks, bounded 64 KiB chunk streaming SHA-256 calculation on every path (including shortcuts), post-read live path revalidation, and independent post-write destination staging SHA-256 verification before atomic publication.
- [x] Internal vault containment (`assertPathContainedInVault`): canonical realpath containment and iterative segment-by-segment `lstat` traversal checking rejecting symlinks and Windows directory junctions in `files/`, content directories, `.vault-temp/`, identity files, manifests, and destinations.
- [x] Content-addressed vault storage (`files/<prefix>/<sha256>/<safeName>`) with safe collision handling; duplicate content shares a verified copy while preserving multi-source provenance.
- [x] Portable metadata manifests (`manifest.json` sidecars) strictly validated with Zod (`VaultManifestSchema`), recording original paths, filesystem timestamps, byte size, verified hashes, observation provenance, and audit results; preserving explicit `null`s for missing capture dates/locations without SQLite dependency.
- [x] Safe publication and crash recovery: atomic directory publication using `.pv_in_progress_${vaultId}_${jobId}.json` markers, strictly non-overwriting collision checks with `COPYFILE_EXCL` fallback, and deterministic in-progress marker recovery for interrupted jobs.
- [x] Resumable import coordinator (`VaultImportCoordinator`) with exact job-scope preservation via `getVaultImportItems`, observation currency revalidation (`isDiscoveryCurrent`, `isHashActive`), bounded queries without 1,000-candidate cutoffs, concurrency locking on start and resume, pause, resume, cooperative cancellation via `AbortSignal`, restart recovery (`interrupted` status), truthful completion status (`failed` when all items fail), and prompt IPC acknowledgment.
- [x] SQLite catalog schema expansion (Migration 6) adding `vaults`, `vault_copies`, `vault_imports`, and `vault_import_items` tables with audit trail.
- [x] Narrow typed IPC channels (`VAULT_*`) with strict bidirectional Zod validation (`ResumeImportRequestSchema`, `CancelImportRequestSchema`, `PauseImportRequestSchema`) and top-level sender authorization.
- [x] Accessible renderer UI (`VaultImportPanel`) with functional "Change Vault", candidate pagination beyond 100 items with monotonic request token protection, real-time progress bar, pause/resume/cancel controls, interrupted job recovery alert, truth-aligned banners (no "Verified Success" for failures), and operations distinction notice.
- [x] Isolated-fixture verification script (`scripts/verify-electron-vault-import.mjs`) exercising vault initialization, overlap rejection, candidate queries, verified copying, duplicate content manifest merging, idempotency, modified source rejection, active cancellation during copying, restart recovery & resume, and source preservation invariance across real Electron built and unpacked modes.
- [x] Independent review verification passed at `1a1fb69`: 421 tests passed across 23 test files (exit 0); typecheck, lint, formatting, production build, and unpacked build clean pass (exit 0); real-Electron verified vault import (built & unpacked) 11/11 passed each (exit 0); duplicate review 18/18 passed (exit 0); scan workflow 14/14 passed (exit 0); SQLite 8/8 passed (exit 0); smoke checks (built & unpacked) passed (exit 0); source preservation invariance confirmed.

Exit: originals can be copied with verified integrity and recoverable metadata outside SQLite.

## Stage 5 - Photo browsing and review

**Planned.**

- [ ] Add bounded thumbnail generation and a secure cache.
- [ ] Provide smooth, virtualized browsing for large collections.
- [ ] Add ratings, flags, and collections.
- [ ] Add similarity review that distinguishes edited copies from similar photographs.

Exit: realistic collections remain responsive; similarity suggestions stay separate from exact-duplicate facts.

## Stage 6 - Semantic photo search

**Planned.**

- [ ] Evaluate local embedding models and resource/packaging requirements.
- [ ] Implement content-based photo search and a persistent search index.
- [ ] Filter by available date, camera, lens, resolution, and file-type metadata.
- [ ] Preserve unknown dates/locations and separate inferences from recorded facts.

Exit: users can find photos by content and available metadata using the supported offline workflow.

## Stage 7 - Documents and unified search

**Planned.**

- [ ] Extract text from supported document formats.
- [ ] Add local OCR for scanned documents and document images.
- [ ] Classify documents with explicit inference provenance.
- [ ] Filter software clutter without excluding valuable personal notes.
- [ ] Provide unified search across photos and documents.

Exit: supported documents can be found and reviewed alongside photos without uploading private content by default.

## Stage 8 - Release preparation through public availability

**Planned.** These substages expand the existing final stage into explicit release checkpoints. They are future planning, not completed work or authorization to publish.

| Substage | Deliverable                                                         | Status  | Acceptance/release reference |
| -------- | ------------------------------------------------------------------- | ------- | ---------------------------- |
| 8A       | Selective export and portable metadata bundles                      | Planned | Pending                      |
| 8B       | Backup, restore, and catalog recovery from vault manifests          | Planned | Pending                      |
| 8C       | Release scope, security, performance, installers, and documentation | Planned | Pending                      |
| 8D       | Beta testing, defect resolution, and release candidate              | Planned | Pending                      |
| 8E       | Approved public release and verified distribution                   | Planned | Pending                      |

Public release checklist:

- [ ] Agree the release feature scope and supported operating systems; explicitly record any roadmap deferrals.
- [ ] Verify export, backup, restore, migration, and recovery with realistic data.
- [ ] Verify source preservation, import integrity, and destructive-action safeguards.
- [ ] Review IPC, navigation, local data handling, dependency security, and privacy behavior.
- [ ] Validate large-library performance, resource bounds, cancellation, and restart recovery.
- [ ] Test installers on clean machines for every advertised platform, including upgrades, uninstall behavior, and retention of user data.
- [ ] Set the distribution/signing approach and verify release artifacts.
- [ ] Review dependency/model redistribution licenses and third-party notices.
- [ ] Provide installation, usage, privacy, backup/recovery, known-limitations, and support documentation.
- [ ] Complete beta acceptance; resolve release-blocking defects and document accepted limitations.
- [ ] Independently accept the release candidate and record its version, commit, and tested artifacts.
- [ ] Obtain explicit user authorization to publish.
- [ ] Publish approved downloads and release notes; verify public installation and the issue-reporting route.
- [ ] Record the release date and distribution links below.

| Public release record               | Value                       |
| ----------------------------------- | --------------------------- |
| Version / accepted commit           | Pending                     |
| Supported platforms                 | To be confirmed before beta |
| Release candidate acceptance        | Pending                     |
| Publication approval                | Pending                     |
| Public release date                 | Not scheduled               |
| Downloads / release notes / support | Pending                     |

Exit: the approved release is publicly available, the advertised installation path works, and users have documentation and a route to report problems.

## Maintenance rules

Update this tracker at stage start, review submission, acceptance, blockage, and closeout. Record accepted implementation and documentation commits separately. Record release versions and links when available. Keep TODO.md and HANDOFF.md consistent when their status changes; keep detailed logs in the handoff.

Stage acceptance, pushing, merging, and public publication are separate actions. Completion does not imply that a branch is pushed or merged, or that publication is authorized.
