# Personal Vault - Development and Public Release Tracker

Updated: November 7, 2026.

This tracker covers all development through public release. Detailed tasks belong in [TODO.md](TODO.md); verification evidence and limitations belong in [HANDOFF.md](HANDOFF.md).

## Current position

Stage 1 and Stage 2 (substages 2A-2D) are complete. Stage 2 independently accepted at `71e1af7`. Stage 3 is next; Stages 3-8 are future work. Public release has not occurred and has no scheduled date.

## All stages

The project has **eight main stages**. Lettered substages divide the work; they do not add main stages.

| Stage | Deliverable                                                    | Status   | Acceptance |
| ----- | -------------------------------------------------------------- | -------- | ---------- |
| 1     | Engineering foundation and secure desktop shell                | Complete | `070e3cb`  |
| 2     | Discovery, hashing, SQLite catalog, and resumable scan jobs    | Complete | `71e1af7`  |
| 3     | Exact duplicate grouping and review                            | Planned  | Pending    |
| 4     | Verified vault copying and portable metadata                   | Planned  | Pending    |
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

**Planned.**

- [ ] Group identical content by SHA-256 across filenames and locations.
- [ ] Present duplicate groups with side-by-side recorded metadata.
- [ ] Support explicit review and selection without automatic source deletion.
- [ ] Distinguish catalog removal, vault-copy deletion, and original-source deletion.

Exit: users can understand and review duplicate groups without losing locations or differing metadata. Existing catalog queries alone do not complete this stage.

## Stage 4 - Verified vault copying

**Planned.**

- [ ] Initialize vault storage and copy selected originals without moving sources.
- [ ] Verify hashes before acknowledging success; handle failed/interrupted copies safely.
- [ ] Preserve provenance and portable metadata through manifests or sidecars.
- [ ] Record import results and an audit trail.

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
