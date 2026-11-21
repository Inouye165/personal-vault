# Stage 8B — Backup, restore, and catalog recovery

Status: planning (Slice 1 design revised for independent re-review). Stage 8A baseline: `ba4785a0fd5f0e0948b429198a0c7a679f54b399` (`ba4785a`).

## Destinations

- **Home storage.** Back up to an external drive or a NAS folder accessible to Windows. Leave the job queued if the drive or share is disconnected. Offer a transfer-rate limit for NAS backups.
- **Google Drive.** Make off-site backup opt-in. Encrypt backup contents and private metadata locally before transfer. Plan an app-managed transfer so Personal Vault can enforce its own upload limits and confirm cloud completion. Document how the user keeps the recovery secret separately and prove recovery on a fresh profile.
- **Drive for desktop fallback.** Allow the user to place a verified encrypted copy in a synced folder. Drive for desktop can throttle its upload rate. In this mode Personal Vault verifies local staging only and reports cloud completion as unverified. The app cannot enforce a daily internet budget for transfers made by the sync client.

## Metered background backup

Create an initial recoverable snapshot, then transfer only new or changed backup data. Keep versioned recovery points so a deletion or bad edit does not erase the prior recoverable copy. Persist the upload queue and progress across restarts. A local backup can finish while its off-site copy is still queued.

- Provide separate settings for upload speed and a rolling 24-hour upload-data budget. Reserve budget before sending each transfer unit and count retry bytes. Pause before exceeding the budget and resume as capacity becomes available. The budget covers Personal Vault upload payloads. Other apps and network overhead add to household data usage.
- Use small, resumable transfer units, low concurrency, bounded backoff for transient provider errors, and a clear paused status for provider quota or storage-full conditions. Offer pause and resume, an optional upload window, and default to pausing cloud transfers on Windows connections marked metered unless the user opts in.
- Show local and off-site progress separately, including queued bytes, pause reason, and the last verified recovery point. Mark an app-managed cloud backup complete only after Drive confirms the manifest and all required backup data.

## Proposed slices and acceptance

1. **Local backup and restore.** Define what the consistent SQLite snapshot and vault backup preserve, what can be rebuilt, and what is excluded. Restore from a separate drive or NAS into a fresh, isolated profile. Compare file hashes, catalog entries, and the user metadata promised by the backup. Exercise corrupt or incomplete backup data, a disconnected destination, and an interrupted restore. Keep active vault and original source files untouched during validation.
2. **Catalog recovery from vault manifests.** Rebuild into an isolated profile with the catalog missing. Verify rebuilt records against the source vault and document what requires a catalog backup.
3. **Metered Google Drive backup and restore.** Verify upload pacing and budget enforcement, including retries and restarts. Exercise pause, resume, metered connections, provider limits, and partial uploads. Retrieve an encrypted backup from Drive and restore it into a fresh profile. Verify that an incorrect recovery secret fails safely and that a partial upload never appears as a completed recovery point.

---

## Independent Review Findings Mapping (addressed in this revision)

| Review finding                                                                                         | Resolution in this plan                                                                                                                                                                                    | Revised sections                                         |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **F1 — Snapshot consistency**: missing/under-length journal acceptance & concurrent `manifest.json`    | Derive `requiredJournalSeq` from staged SQLite; fail closed on missing owner/journal, gaps, or `actualSeq < requiredJournalSeq`; single-read `manifest.json` + T0 import skew detection & capture lock     | §2.2 (Steps 2–4), §5 (#3, #4), §6 (**T2, T10**)          |
| **F2 — Cross-drive restore safety**: crash between two-drive marker/file writes & app/vault open guard | Stage both drives before profile publish; two-drive `.pv-restore-complete.json` before removing `.pv-restore-in-progress.json`; fail-closed checks in `index.ts` & `identity.ts`; scoped retry cleanup     | §3.2, §3.3, §5 (#5), §6 (**T9a–T9e**), §7 (1A-3, 1C)     |
| **F3 — Disconnect & restart staging lifecycle**: what is retained vs. cleaned up on resume/restart     | Retain `<userData>/.backup-staging/<jobId>/` (`staging-manifest.json` + DB/journal) for `paused`/`interrupted` jobs; re-verify on resume; abandon & recapture under new ID if missing/corrupt              | §2.2 (Step 1), §2.4, §5 (#8), §6 (**T5b, T5c**), §7 (1B) |
| **F4 — First coding task scope**: Sub-slice 1A too broad & UI exclusion notice                         | Split Sub-slice 1A into **1A-1** (schemas, capture-only containment, snapshot worker/capture, tests), **1A-2** (codec, transport, rate-limiter, backup engine), and **1A-3** (isolated restore); UI notice | §6, §7 (**1A-1, 1A-2, 1A-3, 1C**)                        |

---

## Codebase baseline inspected

The Slice 1 design below is grounded directly in the Stage 8A codebase (`ba4785a`):

- **App-owned profile storage (`src/main/index.ts`)**:
  - `<userData>/vault-catalog.db` (plus transient `-wal`/`-shm` sidecars in WAL mode; `CURRENT_SCHEMA_VERSION = 16` in `src/main/services/catalog/migrations.ts`, opened via `node:sqlite` `DatabaseSync` with `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`).
  - `<userData>/annotations/.pv_annotations_owner` and `<userData>/annotations/review-journal.jsonl` (`AnnotationJournal` in `src/main/services/annotations/journal.ts`: append-only JSONL with strict contiguous `1..N` `entrySeq`, two-phase `journal_operations` / `journal_checkpoints` reconciliation via `CatalogDatabase.reconcileJournalWithDatabase()`).
  - Disposable/re-downloadable directories in `<userData>`: `thumbnails/`, `semantic-models/`, `models/ocr/`, `models/doc-semantic/`, `startup.log`, and transient `.doc_*_snapshots/` staging files.
- **Vault storage (`src/main/services/vault/`)**:
  - `<vaultPath>/vault.json` (`VaultIdentitySchema`: `formatVersion`, `vaultId`, `vaultName`, `createdAtMs`, `appVersion`).
  - `<vaultPath>/files/<2-hex-prefix>/<sha256>/<safeName>` (immutable content-addressed verified vault copies).
  - `<vaultPath>/files/<2-hex-prefix>/<sha256>/manifest.json` (`VaultManifestSchema`: multi-source provenance, recorded facts, `inferredCaptureTimeMs`, import-time `isPreferred` / `duplicateReviewStatus`, `importResult`).
  - `<vaultPath>/.vault-temp/` (ephemeral staging files and `.pv_in_progress_*` markers).
- **SQLite live snapshot capability (verified in Electron 45.2.3 / Node `24.22.2`)**:
  - Opening a separate `DatabaseSync(catalogPath, { readOnly: true, timeout: 5000 })` connection against an active WAL-mode database and running `VACUUM INTO ?` produces a consistent, compacted, single-file SQLite database in `delete` journal mode passing `PRAGMA integrity_check = 'ok'` without blocking active WAL writers or restarting on concurrent writes.
- **Existing containment & completion conventions**:
  - Stage 4 `assertPathContainedInVault` (`src/main/services/vault/containment.ts`) and Stage 8A `validateExportParentAndBundlePath` / `inspectExportBundleStatus` (`src/main/services/export/containment.ts`, `bundle.ts`) establish strict symlink/junction rejection, overlap prevention, and explicit single-completion-rule markers.

---

## 1. Backup contents, rebuildable data, and exclusions

### 1.1 Exact contents of a Slice 1 recovery point

Every complete recovery point captures a consistent point-in-time snapshot of **three data sets**:

1. **Consistent SQLite catalog snapshot (`vault-catalog.db`)**:
   - Schema version recorded in the snapshot manifest (v16 at baseline; v17 once Stage 8B backup tables are added).
   - **Recorded immutable facts & provenance**: `sources`, `file_locations`, `discovery_observations`, `hash_observations` (including historical observations and explicit `null`s).
   - **Vault registry & verified copy inventory**: `vaults`, `vault_copies`, `vault_imports`, `vault_import_items`.
   - **Irreplaceable user metadata**:
     - `duplicate_reviews` (Stage 3 review status, preferred location, group signature).
     - `photo_annotations` (Stage 5B ratings `1..5` / `null`, `none` / `pick` / `reject` flags, version history).
     - `collections`, `collection_memberships` (Stage 5B custom collections and memberships).
     - `similarity_decisions` (Stage 5C `edited_version` / `similar_scene` / `unrelated` decisions).
     - `document_classification_overrides` (Stage 7E `purpose_labels_json`, `origin_labels_json`, `clutter_override`, `override_version`).
     - `journal_operations`, `journal_checkpoints` (two-phase journal reconciliation state).
   - **Derived/inferred indexes (preserved for immediate usability after restore, though rebuildable)**: `photo_perceptual_hashes`, `similarity_candidate_pairs`, `photo_semantic_embeddings`, `photo_technical_metadata`, `document_extractions`, `document_ocr_extractions`, `document_semantic_tracks`, `document_semantic_chunks`, `document_classifications`, `document_classification_labels`.
   - **Job audit history**: `scan_jobs`, `scan_job_errors`, `scan_job_files`, `similarity_jobs`, `similarity_job_items`, `semantic_index_jobs`, `semantic_index_job_items`, `photo_metadata_jobs`, `photo_metadata_job_items`, `document_extraction_jobs`, `document_extraction_job_items`, `document_ocr_jobs`, `document_ocr_job_items`, `document_semantic_jobs`, `document_semantic_job_items`, `document_classification_jobs`, `document_classification_job_items`, `export_jobs`, `export_job_items`.
2. **Portable user metadata journal (`<userData>/annotations/`)**:
   - `.pv_annotations_owner` (required ownership marker for `AnnotationJournal`).
   - `review-journal.jsonl` (captured strictly at the contiguous `1..cutSeq` watermark consistent with the SQLite snapshot; contains `photo_annotation`, `collection_created`, `collection_renamed`, `membership_added`, `membership_removed`, `similarity_decision`, `document_classification_override`, `op_committed`, and `op_aborted`).
3. **Active vault contents (`<vaultPath>/`, when an active vault is registered)**:
   - `vault.json` (vault identity manifest).
   - Every verified vault-managed file referenced by `vault_copies` for the active `vault_id`: `files/<prefix>/<sha256>/<safeName>`.
   - Every portable per-content manifest sidecar: `files/<prefix>/<sha256>/manifest.json`.
   - If no active vault is initialized yet, the backup may still run for catalog + annotations and explicitly records `vault: null` in the snapshot manifest. If an active vault _is_ registered, backing up all its `vault_copies` files, `manifest.json` sidecars, and `vault.json` is mandatory; missing or corrupt vault files fail closed. Inactive historical rows in `vaults` are not backed up in Slice 1, and that scope is recorded explicitly in the snapshot manifest.

### 1.2 Original files outside the vault

- **Original source files outside the vault are NEVER included in the backup.**
- Personal Vault preserves strict separation between read-only discovery of external folders and explicit vault import. Backing up arbitrary external source folders would silently copy uncurated files outside the user's vault boundary.
- The catalog snapshot preserves the recorded provenance (`sources`, `file_locations`, `discovery_observations`, `hash_observations`) and user annotations for all cataloged items, while the backup's stored file bytes cover **vault-managed copies only**. The Backup & Restore UI and snapshot manifest report this boundary explicitly so users know unimported originals are excluded.

### 1.3 What can be rebuilt vs. what requires a catalog/journal backup

| Data category                                                                                                              | Included in Slice 1 backup? | Can be rebuilt without catalog backup? | Rebuild source & caveats                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault files (`files/<prefix>/<sha256>/<safeName>`) & `vault.json`                                                          | Yes (active vault)          | No                                     | Primary preserved asset; must be backed up.                                                                                                       |
| Vault `manifest.json` sidecars                                                                                             | Yes (active vault)          | Partially from catalog                 | Needed for Slice 2 catalogless recovery; preserves multi-source recorded facts, `inferredCaptureTimeMs`, and import-time review snapshot.         |
| Imported file catalog records (`sources`, `file_locations`, `discovery_observations`, `hash_observations`, `vault_copies`) | Yes                         | Yes (Slice 2)                          | Reconstructible from `vault.json` + `manifest.json` + vault file hashes; historical non-imported observations are lost without catalog backup.    |
| Photo ratings & Pick/Reject flags (`photo_annotations`)                                                                    | Yes (catalog + journal)     | **No**                                 | Not stored in `manifest.json`; requires catalog or `review-journal.jsonl`.                                                                        |
| Custom collections & memberships (`collections`, `collection_memberships`)                                                 | Yes (catalog + journal)     | **No**                                 | Not stored in `manifest.json`; requires catalog or `review-journal.jsonl`.                                                                        |
| Visual similarity user decisions (`similarity_decisions`)                                                                  | Yes (catalog + journal)     | **No**                                 | Not stored in `manifest.json`; requires catalog or `review-journal.jsonl`.                                                                        |
| Document classification overrides (`document_classification_overrides`)                                                    | Yes (catalog + journal)     | **No**                                 | Not stored in `manifest.json`; requires catalog or `review-journal.jsonl`.                                                                        |
| Up-to-date duplicate reviews (`duplicate_reviews`)                                                                         | Yes (catalog)               | **No**                                 | `manifest.json` holds only an import-time snapshot for imported files; later edits and non-imported groups require catalog backup.                |
| Catalog provenance of discovered-but-unimported files                                                                      | Yes (catalog)               | **No**                                 | Originals are not in the vault; requires catalog backup or rescanning original drives.                                                            |
| Derived indexes (EXIF, perceptual hashes, native text, OCR text, CLIP/BGE embeddings, rule classifications)                | Yes (inside catalog)        | Yes                                    | Rebuildable from vault files (and re-installed offline models for OCR/CLIP/BGE); preserved in catalog snapshot to avoid costly recomputation.     |
| Thumbnails (`<userData>/thumbnails/`)                                                                                      | **No**                      | Yes                                    | Disposable cache regenerated on demand.                                                                                                           |
| Local AI/OCR models (`semantic-models/`, `models/ocr/`, `models/doc-semantic/`)                                            | **No**                      | Yes                                    | ~187 MiB pinned checksum-verified third-party downloads or offline imports; excluded to keep backups lean and avoid redistributing model weights. |
| Ephemeral staging/WAL/logs (`.vault-temp/`, `.doc_*_snapshots/`, `.backup-staging/`, `-wal`, `-shm`, `startup.log`)        | **No**                      | N/A                                    | Transient operational artifacts.                                                                                                                  |
| Secrets / recovery passphrases / OAuth tokens                                                                              | **No**                      | N/A                                    | Never placed inside backup data.                                                                                                                  |

---

## 2. Slice 1 design: live snapshot, repository format, verification, disconnect handling & NAS rate cap

### 2.1 Unified backup repository layout (`pv-backup-v1`)

Both Slice 1 (USB/NAS) and Slice 3 (Google Drive / Drive for desktop) use one versioned, content-addressed, chunked repository format so local backups get incremental transfers and versioned recovery points immediately and Slice 3 needs no format redesign:

```text
<backupRepoRoot>/
  repository.json                              # Repo identity, formatVersion: 1, encryptionMode, chunkSizeBytes
  .pv-backup-temp/                             # Ephemeral staging area for in-flight destination writes
    chunk_<jobId>_<objectId>_<uuid>.tmp
    snap_<jobId>_<snapshotId>_<uuid>.tmp
  objects/
    <2-hex-prefix>/
      <objectId>.pvchunk                       # Immutable content-addressed chunk (<= 4 MiB plaintext)
  snapshots/
    <snapshotId>/                              # e.g. 2026-11-20T14-05-12Z_<uuid8>
      .pv-snapshot-in-progress.json            # Written before transfer starts; removed only after complete.json fsync
      snapshot.json                            # (Slice 3 encrypted: snapshot.pvenc) Full self-contained recovery manifest
      complete.json                            # Final atomic commit marker (manifestSha256 + counts + verificationScope)
```

- **Chunking (`CHUNK_SIZE_BYTES = 4 * 1024 * 1024`, 4 MiB)**:
  - Every backed-up file (SQLite snapshot, `review-journal.jsonl`, `.pv_annotations_owner`, `vault.json`, every `manifest.json`, and every vault file) is logically split into ordered chunks of at most 4 MiB.
  - Zero-byte files are represented cleanly with `byteSize: 0`, `sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, and `chunks: []`.
  - Short fixed-length object paths (`objects/<ab>/<64-hex>.pvchunk`) eliminate Windows `MAX_PATH` and illegal-character issues on SMB/NAS and eliminate the 4 GiB single-file limit on FAT32 USB drives.
  - **In Slice 1 (`encryptionMode: 'none'`)**, `objectId` is the lowercase 64-hex plaintext SHA-256 of the chunk bytes and `.pvchunk` stores the raw chunk bytes.
- **No delta chains**: Each `snapshots/<snapshotId>/snapshot.json` lists every file in that recovery point and its complete ordered chunk list. Prior recovery points are never mutated by newer backups and remain independently restorable.

### 2.2 Consistent snapshot while the catalog is in use

All heavy snapshot, hashing, and transfer work executes off the main Electron event loop (dedicated snapshot worker thread + async streaming I/O; bounded to `<= 1` active backup worker).

1. **Local staging first (`<userData>/.backup-staging/<jobId>/`)**:
   - Create an isolated app-owned staging folder `<userData>/.backup-staging/<jobId>/` (verified free of symlinks/junctions and disjoint from source roots and vaults). Never run `VACUUM INTO` directly over USB or SMB/NAS.
   - Staging retains the exact T0 captured artifacts (`vault-catalog.sqlite`, `annotations/.pv_annotations_owner`, `annotations/review-journal.jsonl`, `vault.json`, captured `manifest.json` bytes in `manifests/`, and `staging-manifest.json` recording `snapshotId`, `vaultId`, T0 `vault_copies` list, and expected SHA-256/byte sizes for every staged artifact) until the backup job reaches a terminal state (`completed`, `cancelled`, `failed`, or `abandoned`).
   - Optionally, when `BackupCoordinator` runs in the live app, it acquires a brief in-process snapshot-capture guard around Steps 2–4 so `VaultImportCoordinator` does not publish a newer `manifest.json` mid-capture; Step 4 also detects any concurrent import skew independently even without the coordinator guard.
2. **SQLite consistent snapshot (`snapshot-worker.ts`)**:
   - Open a separate read-only `DatabaseSync(catalogPath, { readOnly: true, timeout: 5000 })` connection in the worker thread.
   - Execute `VACUUM INTO ?` targeting `<stagingDir>/vault-catalog.sqlite`. Because the live catalog runs in WAL mode, `VACUUM INTO` captures an atomic point-in-time read snapshot without blocking concurrent writers, without restarting under concurrent writes, and without `-wal`/`-shm` sidecars.
   - Verify the staged SQLite file immediately:
     - `PRAGMA integrity_check;` must return `'ok'`.
     - `PRAGMA foreign_key_check;` must return `0` rows.
     - `SELECT MAX(version) FROM schema_migrations;` must be `1..CURRENT_SCHEMA_VERSION`.
   - Stream-hash `<stagingDir>/vault-catalog.sqlite` (`catalogSha256`, `catalogByteSize`).
   - Query the staged SQLite snapshot (not the moving live DB) for the exact T0 backup scope:
     - Active vault record (`vaults WHERE is_active = 1`).
     - All `vault_copies` rows for that `vault_id`, plus completed `vault_import_items` `(import_id, file_location_id, discovery_observation_id, hash_observation_id)` for `vault_id` (used to detect concurrent `manifest.json` skew in Step 4).
     - Journal consistency watermark derived **exclusively from the staged SQLite snapshot**:
       - `maxJournalOpSeq = COALESCE(MAX(entry_seq), 0)` from `journal_operations`.
       - `checkpointSeq = COALESCE(last_applied_seq, 0)` from `journal_checkpoints`.
       - `requiredJournalSeq = max(maxJournalOpSeq, checkpointSeq)` and `snapshotJournalOpIds` = set of `op_id`s in `journal_operations`.
3. **Mutually consistent `AnnotationJournal` capture (fail-closed completeness)**:
   - Immediately after `VACUUM INTO` completes, check `<userData>/annotations/.pv_annotations_owner` and `<userData>/annotations/review-journal.jsonl`:
     - If `requiredJournalSeq > 0` (or `journal_operations` has any rows) and either `.pv_annotations_owner` or `review-journal.jsonl` is missing or unreadable, **fail closed** (`journal_corruption_error`).
     - If `.pv_annotations_owner` is present, validate its JSON format (`app: 'personal-vault'`, `format: 'personal-vault-review-journal'`); if invalid, fail closed. If neither file exists and `requiredJournalSeq === 0`, record `annotations: null` (uninitialized journal).
   - Copy `.pv_annotations_owner` and `review-journal.jsonl` into `<stagingDir>/annotations/`.
   - Stream-validate the staged `review-journal.jsonl` in 64 KiB chunks (`AnnotationJournalEntrySchema`, strict `1..N` contiguous `entrySeq` continuity):
     - Fail closed (`journal_corruption_error`) if interior corruption, schema failure, or any `entrySeq` gap/disorder is found.
     - Drop only an incomplete trailing partial EOF line if a concurrent append was mid-write.
     - Advance from sequence `1` through the highest contiguous sequence `<= requiredJournalSeq`, and continue past any immediately following `op_committed`/`op_aborted` whose `opId` is in `snapshotJournalOpIds` (or whose `targetSeq <= requiredJournalSeq`), stopping strictly before the first post-snapshot prepare entry (`entrySeq > requiredJournalSeq` that is not a terminal commit/abort for `snapshotJournalOpIds`). Never delete interior lines.
     - **Fail-closed completeness check**: After scanning, if `highestContiguousSeq < requiredJournalSeq` (i.e. the journal ended before the sequence expected by the staged SQLite snapshot), **fail closed** (`journal_corruption_error`).
   - Result: contiguous `1..cutSeq` covering every SQLite-committed mutation, zero leaked post-snapshot mutations, and deterministic closure of any boundary prepare operation by `reconcileJournalWithDatabase()` on restore.
4. **Active vault snapshot, single-read manifest capture & T0 skew detection**:
   - If the staged catalog has an active vault, validate `<vaultPath>` containment (`assertPathContainedInVault`) and `vault.json` (`loadVaultIdentity`, confirming `vaultId` matches the catalog). Read `vault.json` once into a `Buffer`, validate, and hash/chunk from that exact `Buffer`.
   - For every T0 `vault_copies` entry:
     - Open `files/<prefix>/<sha256>/<safeName>` strictly read-only, verify no symlink/junction escape, stream-hash while chunking, and assert `actualSha256 === expectedSha256` and `actualByteSize === expectedByteSize`.
     - Read `files/<prefix>/<sha256>/manifest.json` **once** into a `Buffer` (storing that exact validated `Buffer` in `<stagingDir>/manifests/`), parse and validate strictly with `VaultManifestSchema` (confirming `manifest.sha256` and `manifest.vaultId`), and hash/chunk from that exact `Buffer` so validation, hashing, and chunking always operate on identical bytes.
     - **Concurrent import skew detection**: Because `VaultImportCoordinator` (`src/main/services/vault/coordinator.ts`) writes `manifest.json` _before_ `recordVaultCopy` / `updateVaultImportItem(..., 'completed')` commits in SQLite, a concurrent duplicate-content import can overwrite `manifest.json` with a newer `sources[]` entry after `VACUUM INTO` captured T0. Verify every `src` in `manifest.sources` against the staged T0 `vault_import_items`: if any `src` has `(src.importResult.importJobId, src.fileLocationId)` missing or not `status = 'completed'` in the staged T0 `vault_import_items` (or has `src.importResult.importedAtMs > stagedVaultCopy.updatedAtMs` when `vault_import_items` is absent), reject capture as `source_vault_concurrent_modification` (so the backup retries capture cleanly or fails closed rather than pairing a T1 `manifest.json` with a T0 SQLite catalog).
     - If any registered vault file or `manifest.json` is missing, unreadable, hash-mismatched, or schema-invalid, **fail the backup closed** (`source_vault_integrity_error`) without publishing `complete.json`.

### 2.3 Verification & single atomic completion rule

- **Per-chunk write and verify**:
  - New chunks are written to `.pv-backup-temp/chunk_<jobId>_<objectId>_<uuid>.tmp`, `fsync`ed, atomically published to `objects/<prefix>/<objectId>.pvchunk` (strictly non-overwriting), and **read back from the destination to verify SHA-256 and byte size** before marking the chunk verified.
  - Existing chunks on the destination:
    - If already recorded in a previously verified recovery point for this repository and `stat.size === expectedStoredSize`, reuse without rewriting (unless `verifyAllChunks: true` is selected).
    - If present on disk as an **unreferenced/leftover** chunk from an interrupted run, **always read-back SHA-256 verify** before reusing; if corrupt or size-mismatched, replace safely via staging.
  - Record `verificationScope` truthfully in `complete.json`: `'full_readback'` (always true for initial backups and full-verify runs) vs. `'incremental_new_chunks_verified'`.
- **Single atomic completion rule (`inspectRecoveryPointStatus`)**:
  - Before writing any snapshot data, create `snapshots/<snapshotId>/.pv-snapshot-in-progress.json` (`wx`, `fsync`).
  - Only after **every** referenced chunk is verified at the destination: stage, `fsync`, publish, and read-back SHA-256 verify `snapshots/<snapshotId>/snapshot.json`.
  - Only after `snapshot.json` read-back verification succeeds: write and `fsync` `snapshots/<snapshotId>/complete.json` containing `snapshotId`, `repositoryId`, `manifestSha256`, `totalObjectCount`, `totalLogicalBytes`, `totalStoredBytes`, `verificationScope`, and `completedAtMs`.
  - Finally remove `.pv-snapshot-in-progress.json` and clean up empty `.pv-backup-temp/`.
  - A recovery point is **complete** if and only if: (1) `repository.json` is valid, (2) `.pv-snapshot-in-progress.json` is absent, (3) `snapshot.json` passes `BackupSnapshotManifestV1Schema`, (4) `complete.json` passes `BackupSnapshotCompleteMarkerV1Schema` with matching `snapshotId`, `manifestSha256`, and counts, and (5) every referenced chunk exists at `objects/<prefix>/<objectId>.pvchunk` with expected stored byte size (and passes full SHA-256 read-back during `verifyRecoveryPoint` and during restore).
  - Any interrupted backup lacks `complete.json` and/or retains `.pv-snapshot-in-progress.json`, is flagged `incomplete` by `listRecoveryPoints()`, is refused by restore, and leaves all prior completed recovery points untouched.

### 2.4 Destination containment, disconnected drive/NAS, restart staging lifecycle & NAS rate cap

- **Windows USB and UNC/SMB NAS containment (`validateBackupDestinationPath`)**:
  - Accepts both local/removable drive paths (`E:\PersonalVaultBackup`) and Windows UNC NAS shares (`\\NAS\Backups\PersonalVault`) or mapped network drives (`Z:\Backups`).
  - Explicitly handles UNC share roots (`dirname('\\\\NAS\\Share') === '\\\\NAS\\Share'`) during ancestor symlink/junction checks without looping or false-rejecting valid shares.
  - Rejects any overlap with registered source roots (`catalog.getAllSourceRoots()`), registered vaults (`vaults`), or `<userData>`.
  - Refuses to initialize inside a non-empty directory that does not already contain a valid `repository.json` (prevents clobbering unrelated user folders).
- **Disconnected drive or offline NAS & restart staging lifecycle**:
  - Classifies offline/transport failures (`ENOENT`, `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`, `ECONNRESET`, `ETIMEDOUT`, `EIO`, `EBUSY`, and Windows SMB/device codes such as `ERROR_BAD_NETPATH` / `ERROR_NETNAME_DELETED` / `ERROR_NOT_READY`) as `destination_unavailable` (distinct from `destination_disk_full`, `destination_read_only`, and `destination_access_denied`).
  - **Pre-flight disconnect**: If the configured destination is unreachable before snapshot capture/transfer begins, persist the job as `queued_destination_unavailable` without creating `<userData>/.backup-staging/<jobId>/`; capture a fresh consistent snapshot when the destination reconnects.
  - **Mid-transfer disconnect / pause / app restart**:
    - Abort the in-flight chunk cleanly, leave `.pv-snapshot-in-progress.json` in `snapshots/<snapshotId>/` (never write `complete.json` and never touch prior completed recovery points), persist chunk progress in SQLite, and transition the job to `paused` with `pauseReason: 'destination_unavailable'` (or `interrupted` on abrupt crash/shutdown).
    - **Staging retention**: Retain `<userData>/.backup-staging/<jobId>/` (`staging-manifest.json`, `vault-catalog.sqlite`, `annotations/.pv_annotations_owner`, `annotations/review-journal.jsonl`, `vault.json`, and captured `manifests/`) across pause and app restarts for as long as the job in `backup_jobs` is `paused` or `interrupted`.
    - **Startup cleanup boundary**: `BackupCoordinator.initialize()` must **preserve** `<userData>/.backup-staging/<jobId>/` for every `backup_jobs` row in `paused` or `interrupted` state, and delete staging directories **only** for terminal jobs (`completed`, `cancelled`, `failed`, `abandoned`) or orphaned directories with no matching `backup_jobs` row.
    - **Resume re-verification & fallback**: Before resuming the same `snapshotId`, re-verify `staging-manifest.json` (SHA-256 and byte size of `vault-catalog.sqlite`, `annotations/*`, `vault.json`, and `manifests/*`), verify `vault-catalog.sqlite` `PRAGMA integrity_check = 'ok'`, and confirm any un-uploaded vault files still exist on disk with matching `(sha256, byteSize)`. If staging is missing, corrupt, or cannot supply the original captured bytes:
      1. Mark the old `snapshotId` job `abandoned` (leaving prior complete recovery points and already-verified `.pvchunk` objects in `objects/` intact and reusable),
      2. Clean up the broken `<userData>/.backup-staging/<jobId>/`, and
      3. Start a fresh snapshot under a **new `snapshotId`** (reusing already-verified `.pvchunk` objects on the destination).
- **Configurable NAS transfer-rate cap (`TransferRateLimiter`)**:
  - Per-destination `maxBytesPerSecond: number | null` (`null` = unlimited for direct USB; configurable cap for NAS, minimum `64 KiB/s` = `65_536 B/s`).
  - Implemented as an injectable-clock, `AbortSignal`-aware token bucket applied at `64 KiB` I/O slices with bounded burst (`max(64 KiB, min(256 KiB, maxBytesPerSecond))`).
  - Accounts for **all destination transfer traffic**: chunk writes, retries, manifest writes, and read-back verification reads across the NAS link, so a configured NAS cap genuinely bounds link saturation.
  - Cancelling, pausing, or shutting down wakes waiting limiter timers immediately.

---

## 3. Slice 1 design: isolated profile restore & verification

### 3.1 Strict profile isolation & target safety

- Restore **always** targets freshly created or strictly empty directories:
  - `targetProfileDir` (isolated `<userData>`: receives `vault-catalog.db` and `annotations/`).
  - `targetVaultDir` (isolated vault directory: receives `vault.json` and `files/<prefix>/<sha256>/...`; required when `snapshot.vault !== null`).
- `validateRestoreTargetPaths` rejects any symlink/junction and any overlap among `targetProfileDir`, `targetVaultDir`, `backupRepoDir`, active `<userData>`, all registered vaults, and all registered source roots.
- The backup repository is accessed **strictly read-only** during restore. Original source files, the active vault, and the active `<userData>` profile are never opened for write.

### 3.2 Atomic cross-drive restore protocol & profile rebinding

Because `targetProfileDir` and `targetVaultDir` may reside on separate drives, restore stages all data on both targets before publishing profile files and uses paired `.pv-restore-in-progress.json` / `.pv-restore-complete.json` markers:

1. **Pre-flight validation**: Run `inspectRecoveryPointStatus(backupRepoDir, snapshotId)`. Refuse immediately if the recovery point is incomplete, corrupt, or has an unsupported `formatVersion`.
2. **Phase A — In-progress markers & staging**:
   - Create `<targetProfileDir>/.pv-restore-in-progress.json` (and `<targetVaultDir>/.pv-restore-in-progress.json` when `snapshot.vault !== null`) with `wx` + `fsync`, recording `{ formatVersion: 1, restoreJobId, repositoryId, snapshotId, targetProfileDir, targetVaultDir, startedAtMs }`.
   - Create `<targetProfileDir>/.pv-restore-temp/` and (when restoring a vault) `<targetVaultDir>/.pv-restore-temp/`.
3. **Phase B — Vault staging, verification & vault publish** (when `snapshot.vault !== null`):
   - Reassemble `vault.json`, every vault payload file (`files/<prefix>/<sha256>/<safeName>`), and every `manifest.json` into `<targetVaultDir>/.pv-restore-temp/`, verifying every chunk SHA-256, full file SHA-256 & byte size, `VaultIdentitySchema` (`vaultId` matching snapshot), `VaultManifestSchema`, and `assertPathContainedInVault(targetVaultDir, ...)`.
   - `fsync` and publish vault files into `<targetVaultDir>/` (no overwrite). Note: `<targetVaultDir>/.pv-restore-in-progress.json` remains present throughout, so no vault opener can treat `targetVaultDir` as ready yet.
4. **Phase C — Catalog & journal staging, rebinding & verification** (all inside `<targetProfileDir>/.pv-restore-temp/`):
   - Reassemble `vault-catalog.db` in `<targetProfileDir>/.pv-restore-temp/` -> verify every chunk SHA-256 + full file SHA-256 & byte size.
   - Open staged DB and verify `PRAGMA integrity_check = 'ok'`, `PRAGMA foreign_key_check` empty, and `schema_migrations <= CURRENT_SCHEMA_VERSION`.
   - **Transactional profile rebinding** (on the staged restored copy only):
     - If a vault was restored, update `vaults` for `snapshot.vault.vaultId` so `vault_path = canonicalTargetVaultDir` and `normalized_vault_path = normalizePathForLookup(canonicalTargetVaultDir)`.
     - Transition any `running` or `paused` job rows across job tables to `interrupted` and pause/disable any restored backup schedules so the restored profile cannot collide with live backups.
     - Preserve `sources` and `file_locations.original_path` **verbatim** as immutable recorded provenance facts (never rewritten or fabricated).
   - Re-verify `PRAGMA integrity_check = 'ok'` and `PRAGMA foreign_key_check` empty, close cleanly, and `fsync`.
   - When annotations are present in the snapshot: reassemble `.pv_annotations_owner` and `review-journal.jsonl` into `<targetProfileDir>/.pv-restore-temp/annotations/`, verify chunk & file SHA-256s, validate the ownership marker and every JSONL line (`AnnotationJournalEntrySchema`, strict contiguous `1..N` `entrySeq`), and `fsync`.
5. **Phase D — Profile publish & post-restore runtime verification**:
   - Publish staged `annotations/` and `vault-catalog.db` into `<targetProfileDir>/`.
   - Open `<targetProfileDir>/vault-catalog.db` through the real `CatalogDatabase.open({ catalogPath })` + `AnnotationJournal.initialize()` + `catalog.setJournal(journal)` (exercising real startup reconciliation), verify active vault identity and restored `vault_copies` counts, then close cleanly.
6. **Phase E — Paired two-drive completion commit**:
   - Write and `fsync` `<targetProfileDir>/.pv-restore-complete.json` (recording `restoreJobId`, `repositoryId`, `snapshotId`, `restoredAtMs`, `restoredVaultPath`, `catalogSha256`, `verifiedFileCount`).
   - When `snapshot.vault !== null`: write and `fsync` `<targetVaultDir>/.pv-restore-complete.json` (recording `restoreJobId`, `repositoryId`, `snapshotId`, `restoredProfilePath`, `restoredAtMs`), then remove `<targetVaultDir>/.pv-restore-in-progress.json` and empty `<targetVaultDir>/.pv-restore-temp/`.
   - Remove `<targetProfileDir>/.pv-restore-in-progress.json` and empty `<targetProfileDir>/.pv-restore-temp/`.

### 3.3 Startup / vault-open rejection, corrupt backups & interrupted restore retry

- **Normal app startup & vault opening rejection (fail-closed)**:
  - **App startup (`src/main/index.ts`)**: Before opening `vault-catalog.db` or initializing `AnnotationJournal`, check `<userData>`:
    1. If `.pv-restore-in-progress.json` exists -> **refuse startup** (`RestoreIncompleteError`: never open `vault-catalog.db` or create/touch `review-journal.jsonl`).
    2. If `.pv-restore-complete.json` exists and specifies a non-null `restoredVaultPath` -> check `restoredVaultPath`: if `.pv-restore-in-progress.json` is still present there or `.pv-restore-complete.json` is absent there (crash between Phase E.1 and Phase E.2), **refuse startup** as an incomplete cross-drive restore.
  - **Vault opening (`loadVaultIdentity` / `isVaultDirectory` in `src/main/services/vault/identity.ts`)**:
    - If `<vaultPath>/.pv-restore-in-progress.json` exists -> `isVaultDirectory` returns `false` and `loadVaultIdentity` throws `VaultInitializationError` / `RestoreIncompleteError`, preventing any workflow from opening a half-restored vault on another drive.
- **Corrupt backups**:
  - Missing/invalid `repository.json`, missing `complete.json`, present `.pv-snapshot-in-progress.json`, `manifestSha256` mismatch, schema-invalid `snapshot.json`, missing `.pvchunk`, bit-flipped `.pvchunk`, corrupt SQLite bytes, corrupt `manifest.json`/`vault.json`, or unsupported future version all **fail closed** with typed error codes before `.pv-restore-complete.json` is written.
- **Interrupted restore retry & scoped cleanup**:
  - If power loss, crash, disk-full, or `AbortSignal` interrupts restore at any boundary, `inspectRestoredProfileStatus(targetProfileDir, targetVaultDir)` reports `interrupted`.
  - A retry **never** merges into a partial target. Instead, `cleanupInterruptedRestoreTarget({ targetProfileDir, targetVaultDir, expectedRestoreJobId })`:
    1. Refuses to delete anything if `.pv-restore-in-progress.json` is absent or belongs to a different/unknown directory without a matching restore marker (never touches active `<userData>`, active vault, or unrelated user files).
    2. Discards **only** that interrupted restore's `.pv-restore-temp/`, `.pv-restore-in-progress.json`, partially published `.pv-restore-complete.json`, and staged/restored files inside `targetProfileDir` and `targetVaultDir` created for that restore.
    3. Leaves the target directories clean/empty so a fresh restore from the read-only backup repository can proceed safely.

---

## 4. Format readiness for Slice 3 (metered encrypted Google Drive & Drive for desktop)

Slice 1 implements `encryptionMode: 'none'` and `LocalFsTransport` only, while locking in the exact format and seam boundaries required by Slice 3 so no breaking repository migration is needed later:

1. **Client-side encryption envelope (`BackupObjectCodec`)**:
   - `repository.json` reserves `encryptionMode: 'none' | 'aes-256-gcm-v1'` and an optional `encryption` block for Slice 3 (`kdf: 'scrypt'` via built-in `node:crypto`, zero native dependencies; `saltBase64`, KDF cost params, AEAD-wrapped random 256-bit repository master key + key-check verification tag, `keyId`).
   - Wrong recovery secret fails closed immediately when unwrapping the repository master key, before any restore data is written.
   - In `aes-256-gcm-v1` mode:
     - `objectId = HMAC-SHA256(dedupSubkey, plaintextChunk)` so identical chunks still deduplicate across incremental backups without leaking plaintext SHA-256 hashes to Google Drive.
     - Each chunk is AES-256-GCM encrypted with a fresh 96-bit nonce and AAD binding `(repositoryId, objectId, plaintextByteSize)`.
     - The recovery point manifest is stored encrypted (`snapshot.pvenc`) so filenames, paths, vault names, ratings, collections, and document metadata never appear in plaintext on Google Drive.
     - `complete.json` carries only non-sensitive commit metadata (`snapshotId`, `repositoryId`, `encryptionMode`, `manifestObjectId`, `manifestSha256`, `totalObjectCount`, `totalStoredBytes`, `completedAtMs`).
2. **Slow initial copy, incremental transfers & resumable progress (`BackupTransport` + SQLite Migration 17)**:
   - Pluggable `BackupTransport` (`LocalFsTransport` in Slice 1; `GoogleDriveTransport` in Slice 3).
   - 4 MiB chunks are an exact multiple of Google Drive's 256 KiB resumable upload alignment (`16 × 256 KiB`), allowing small resumable transfer units with low concurrency (`1` active upload unit) and bounded exponential backoff.
   - Migration 17 persists `backup_destinations`, `backup_jobs`, `backup_job_units` (storing `unitKind`, `objectId`, `storedByteSize`, `status`, `retryCount`, and nullable `resumeSessionUri` + `uploadedOffsetBytes`), `backup_destination_objects` (destination-confirmed object index so incremental runs skip already-confirmed chunks without full remote listings), and `backup_bandwidth_ledger`.
   - Local and off-site backup jobs are tracked independently per destination so a local USB/NAS backup can complete while an off-site Google Drive job remains queued or paused.
3. **Upload-rate cap & rolling 24-hour data budget**:
   - Reuses the exact `TransferRateLimiter` token bucket on wire ciphertext bytes (including retries).
   - `backup_bandwidth_ledger(id, destination_id, job_id, unit_id, bytes_reserved, recorded_at_ms)` tracks rolling 24-hour usage (`recorded_at_ms > now - 86_400_000`).
   - Slice 3 enforces reserve-before-send: before sending each transfer unit (`<= 4 MiB` + envelope overhead), verify `used24h + unitWireBytes <= dailyBudgetBytes` (enforcing minimum configurable budget `>= 16 MiB` so a 4 MiB unit can never starve); record a new ledger entry on every retry attempt; pause with `pauseReason: 'daily_budget_exhausted'` and compute `nextAvailableAtMs` before exceeding the cap.
   - Drive for desktop fallback reuses `Aes256GcmObjectCodec` + `LocalFsTransport` into a synced folder and explicitly reports `localStagingVerified: true`, `cloudCompletionVerified: false`, and `dailyBudgetEnforced: false`.
4. **Independent per-recovery-point restorability**:
   - Every recovery point's `snapshot.json`/`snapshot.pvenc` directly references all `objectId`s needed to reconstruct that point in time (no delta chains).
   - A partial or in-progress cloud upload never publishes `complete.json` and can never appear as a completed recovery point or corrupt any earlier recovery point.

---

## 5. Decisions materially affecting recovery (for independent review)

1. **Chunked content-addressed repository (`pv-backup-v1`, 4 MiB) instead of mirrored raw vault directories**: Gives Slice 1 incremental backups, versioned recovery points, mid-file resumability, FAT32/SMB path safety, and seamless Slice 3 encryption/budget compatibility without delta chains. Tradeoff: backup folders are not directly browsable as raw photos/documents without running Restore (raw human-browsable export is already covered by Stage 8A).
2. **Worker-thread `VACUUM INTO` on a separate read-only WAL connection into local staging**: Avoids main-loop blocking, avoids SQLite online-backup restarts under continuous writes, eliminates `-wal`/`-shm` coupling, and prevents a USB/NAS disconnect from stalling SQLite.
3. **Fail-closed journal watermark derived from staged SQLite**: Preserves `AnnotationJournal`'s strict `1..N` sequence invariant, guarantees zero missing SQLite-committed user edits (`actualContiguousSeq >= requiredJournalSeq`), and prevents leaked post-snapshot edits.
4. **Single-read `manifest.json` + T0 `vault_import_items` skew detection**: Ensures validation, hashing, and chunking operate on identical bytes and detects a newer `manifest.json` written by a concurrent duplicate-content import before pairing it with an older T0 SQLite snapshot.
5. **Two-drive atomic restore markers & startup/vault fail-closed guards**: Keeps `targetProfileDir` and `targetVaultDir` gated behind `.pv-restore-in-progress.json` until both drives have verified `.pv-restore-complete.json` markers, and blocks `index.ts` / `identity.ts` from opening an incomplete restore even after a crash between marker updates.
6. **Honest incremental verification scope**: Initial backups and explicit `verifyRecoveryPoint` runs always perform full read-back SHA-256 verification (`full_readback`); fast incremental runs always read-back verify new and unreferenced chunks while size-checking previously verified chunks (`incremental_new_chunks_verified`).
7. **NAS rate cap covers all destination link I/O**: Rate limiting applies to writes, retries, manifest writes, and read-back verification reads so NAS network links are not saturated during verification.
8. **Staging retention on mid-transfer pause/restart vs. pre-flight queue**: Pre-flight disconnects queue without staging; mid-transfer pauses/interruptions retain `<userData>/.backup-staging/<jobId>/` and re-verify it before resuming the same `snapshotId`, abandoning to a new `snapshotId` (while preserving verified `.pvchunk` objects and prior complete recovery points) if staging is missing or corrupt.

---

## 6. Slice 1 acceptance criteria & acceptance test matrix

Slice 1 is accepted only when all automated Vitest tests, quality gates (`typecheck`, `lint`, `format:check`, `build`, `build:unpack`), smoke checks (`smoke:built`, `smoke:unpacked`), and built + unpacked real-Electron backup/restore verification pass, covering every scenario below with isolated test fixtures:

| ID          | Acceptance scenario                                                    | Required verification assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1**      | **Initial verified local backup & exact scope**                        | Populated fixture profile (active vault with photos + documents including duplicate multi-source `manifest.json`, non-imported cataloged originals, thumbnails, dummy model dirs, `.vault-temp` scratch files) backs up to a clean local destination. Verify `repository.json`, `snapshot.json`, `complete.json`, `verificationScope === 'full_readback'`, zero `.pv-snapshot-in-progress.json`, zero `.pv-backup-temp/` leftovers, active vault + catalog + journal included, and **0** unimported source files / thumbnails / model files / `.vault-temp` files present in the backup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **T2**      | **Consistent live snapshot under concurrent catalog & journal writes** | While `VACUUM INTO` snapshot capture runs (synchronized deterministically via test barrier): (a) perform concurrent WAL writes and `AnnotationJournal` mutations (new rating, collection, document override) on the active catalog, verifying staged `vault-catalog.sqlite` passes `PRAGMA integrity_check` / `PRAGMA foreign_key_check` and staged `review-journal.jsonl` has contiguous `1..cutSeq` entries; (b) test missing `.pv_annotations_owner`, missing `review-journal.jsonl`, sequence gap, and truncated journal (`actualContiguousSeq < requiredJournalSeq`) when `requiredJournalSeq > 0`, verifying fail-closed `journal_corruption_error`; (c) simulate concurrent duplicate-content import updating `manifest.json` after `VACUUM INTO`, verifying single-read byte consistency and `source_vault_concurrent_modification` skew detection.                                                                                                                                                                                                                                                                                   |
| **T3**      | **Incremental backup & versioned recovery points**                     | Create Recovery Point 1, then import one new vault file and change a photo rating + collection + document override, then create Recovery Point 2 to the same repository. Verify unchanged vault chunks are reused (`reusedChunkCount > 0`, existing chunk files not rewritten), Recovery Point 2 restores the updated state, and Recovery Point 1 remains independently restorable to the earlier state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **T4**      | **Interrupted backup vs. complete backup (single completion rule)**    | Inject deterministic abort/crash at three boundaries: (a) mid-chunk write, (b) after all chunks published but before `snapshot.json`, and (c) after `snapshot.json` but before `complete.json`. Verify `inspectRecoveryPointStatus` reports `incomplete` in all 3 cases, restore refuses them, any prior completed recovery point remains restorable, and a subsequent backup hash-verifies and safely reuses valid leftover chunks (while replacing any corrupted leftover chunk).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **T5**      | **Disconnected USB drive / offline NAS & restart staging recovery**    | (a) Pre-flight unreachable destination queues job as `queued_destination_unavailable` with zero `<userData>/.backup-staging/<jobId>/` created and runs cleanly when destination becomes available. (b) Mid-transfer simulated `ENOENT` / `ECONNRESET` / `ERROR_NETNAME_DELETED` pauses job cleanly with `pauseReason: 'destination_unavailable'`, retains `<userData>/.backup-staging/<jobId>/` across restart, re-verifies staging on reconnect, and finishes the same `snapshotId` without touching prior complete recovery points. (c) If retained staging is missing or corrupted on restart/resume, job marks old `snapshotId` `abandoned`, preserves already-verified `.pvchunk` objects and prior complete recovery points, and completes a fresh backup under a new `snapshotId`.                                                                                                                                                                                                                                                                                                                                                     |
| **T6**      | **Configurable NAS transfer-rate cap**                                 | Run backup over a multi-chunk fixture with `maxBytesPerSecond` configured: (a) deterministic injectable-clock unit test proves exact token-bucket pacing across writes, retries, manifest writes, and read-back verification reads plus immediate wakeup on `AbortSignal`; (b) real-clock integration test confirms observed transfer rate stays within cap bounds without stalling completion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **T7**      | **Verified restore into a fresh, isolated profile**                    | Restore Recovery Point into fresh `targetProfileDir` + `targetVaultDir` (exercising distinct root directories simulating separate drives). Verify: (1) every restored vault file matches known fixture SHA-256 and byte size; (2) `vault.json` and every `manifest.json` pass strict Zod validation and preserve multi-source provenance; (3) catalog records (`sources`, `file_locations`, `discovery_observations`, `hash_observations`, `vault_copies`, EXIF, extractions, classifications) match source baseline; (4) all user metadata matches (photo ratings/flags, collections/memberships, duplicate reviews, similarity decisions, document classification overrides, `review-journal.jsonl`); (5) `vaults.vault_path` is rebound to `targetVaultDir` and snapshotted active jobs are neutralized; (6) writing a new post-restore annotation succeeds cleanly; (7) real Electron (built & unpacked) launches cleanly against `--user-data-dir=<targetProfileDir>` showing restored data; and (8) active vault, active `<userData>`, and original source files are **100% bitwise untouched** (SHA-256 + byte size + mtime verified). |
| **T8**      | **Corrupt backup rejection matrix**                                    | Mutate copies of a verified backup to inject each fault independently: missing `repository.json`, missing `complete.json`, leftover `.pv-snapshot-in-progress.json`, tampered `snapshot.json` (`manifestSha256` mismatch), missing `.pvchunk`, single-bit flip in `.pvchunk`, corrupt SQLite catalog payload, invalid `manifest.json` inside backup, and future `formatVersion`/`schema_migrations`. Verify `verifyRecoveryPoint` and `restoreRecoveryPointToIsolatedProfile` both fail closed with explicit error codes and never create `.pv-restore-complete.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **T9a–T9e** | **Cross-drive interrupted restore crash-point matrix & scoped retry**  | Inject deterministic abort/crash at every publish boundary across `targetProfileDir` and `targetVaultDir`: (**T9a**) during vault staging/publish (before profile publish); (**T9b**) after `targetVaultDir` files are written but before `targetProfileDir` DB/journal publish; (**T9c**) after `targetProfileDir` DB/journal publish but before `targetProfileDir/.pv-restore-complete.json`; (**T9d**) between `targetProfileDir/.pv-restore-complete.json` and `targetVaultDir/.pv-restore-complete.json` / marker removal; (**T9e**) scoped retry via `cleanupInterruptedRestoreTarget`. Verify `inspectRestoredProfileStatus`, `src/main/index.ts` startup, and `loadVaultIdentity` / `isVaultDirectory` reject every incomplete state, `cleanupInterruptedRestoreTarget` removes only that restore's staging/partial data before clean retry succeeds, and the backup repository, active vault, active `<userData>`, and original source files remain 100% untouched.                                                                                                                                                                  |
| **T10**     | **Source vault integrity fail-closed during backup**                   | Corrupt or delete a registered `vault_copies` file or `manifest.json` in a test fixture's source vault before backup. Verify backup fails closed with `source_vault_integrity_error` and does not publish `complete.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **T11**     | **Containment, UNC/NAS path safety & symlink/junction rejection**      | Verify capture containment (`1A-1`) rejects staging overlap/symlinks/junctions, and destination/restore containment (`1A-2`/`1A-3`) accepts valid local paths and UNC (`\\server\share\sub`) paths, rejects overlaps with source roots / vaults / `<userData>` / active backup repo, rejects non-empty unrelated directories, and rejects symlinks/junctions along destination, backup repo, and restore target chains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **T12**     | **Slice 3 format readiness contract**                                  | Unit tests verify `BackupRepositoryIdentityV1Schema`, `BackupSnapshotCompleteMarkerV1Schema`, and `BackupObjectCodec` / `BackupTransport` interfaces accept valid `aes-256-gcm-v1` repository metadata, reject malformed KDF/key-wrap fields, and ensure `complete.json` contains zero private filenames or paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## 7. Slice 1 implementation breakdown & smallest first task

Slice 1 is divided into bounded, independently reviewable sub-slices:

### Sub-slice 1A-1 — Smallest first implementation task (start here)

**Goal**: Implement and verify only the backup schemas, staging/capture containment, and consistent off-main snapshot capture & validation — with **no** transport/rate-limiter, **no** backup publication engine, **no** restore engine, **no** SQLite migration, and **no** IPC/UI changes.

**Deliverables**:

- `src/shared/validation/backup-schemas.ts` — Zod schemas for `repository.json`, `snapshot.json`, `complete.json`, `staging-manifest.json`, `.pv-snapshot-in-progress.json`, `.pv-restore-in-progress.json`, `.pv-restore-complete.json`, and Slice 3 `aes-256-gcm-v1` schema readiness.
- `src/main/services/backup/errors.ts` — Typed snapshot/validation/containment domain errors.
- `src/main/services/backup/containment.ts` — Staging/source/vault containment, overlap, and symlink/junction guards needed for snapshot capture (destination UNC/USB and restore-target guards are added in 1A-2 / 1A-3).
- `src/main/services/backup/snapshot-worker.ts` & `src/main/services/backup/snapshot-capture.ts` (plus worker bundle entry in `electron.vite.config.ts`) — Worker-thread `VACUUM INTO` read-only SQLite snapshot, integrity/FK validation, fail-closed `requiredJournalSeq` `review-journal.jsonl` watermark capture, single-read `manifest.json` validation/hashing, T0 `vault_import_items` concurrent-import skew detection, and `staging-manifest.json` emission.
- `tests/main/backup-snapshot.test.ts` — Focused Vitest suite covering **T2** (live WAL + journal concurrency, missing/truncated journal rejection, concurrent `manifest.json` skew detection), **T10** (source vault integrity fail-closed), **T11-capture** (staging containment & symlink/junction rejection), and **T12** (Slice 3 schema readiness).

**What 1A-1 acceptance actually proves**:

- Proves that an active WAL-mode `CatalogDatabase`, `AnnotationJournal`, and Stage 4 vault can be captured off the main Electron event loop into local staging at a mutually consistent T0 point while concurrent writes occur, without missing committed mutations (`actualContiguousSeq >= requiredJournalSeq`), without leaking post-snapshot edits, and without pairing a newer `manifest.json` with an older catalog snapshot.
- Proves fail-closed handling of missing/corrupt journals, missing/corrupt vault files or manifests, staging containment escapes, and Slice 3 schema contracts.
- **Explicitly deferred**: Chunked destination transport, `TransferRateLimiter`, incremental chunk reuse, disconnect/resume, backup publication (`complete.json`), and isolated profile restore are **not** proven by 1A-1 and belong to 1A-2 and 1A-3.

### Sub-slice 1A-2 — Transport, rate limiting & verified local backup engine

- `src/main/services/backup/rate-limiter.ts` (`TransferRateLimiter`), `codec.ts` (`BackupObjectCodec` / `PlaintextObjectCodec`), `transport.ts` (`BackupTransport` / `LocalFsTransport`), destination UNC/USB containment in `containment.ts`, and `engine.ts` (4 MiB chunking, incremental chunk reuse, read-back verification, single atomic completion rule).
- `tests/main/backup-engine.test.ts` covering **T1, T3, T4, T6, T11-destination**.

### Sub-slice 1A-3 — Cross-drive isolated profile restore & crash-boundary verification

- `src/main/services/backup/restore.ts` (`inspectRecoveryPointStatus`, `verifyRecoveryPoint`, `restoreRecoveryPointToIsolatedProfile`, `inspectRestoredProfileStatus`, `cleanupInterruptedRestoreTarget`) and fail-closed `.pv-restore-in-progress.json` guards in `src/main/services/vault/identity.ts` (with `src/main/index.ts` startup guard wired in 1C).
- `tests/main/backup-restore.test.ts` covering **T7, T8, T9a–T9e, T11-restore**.

### Sub-slice 1B — SQLite Migration 17 (`BackupRepository`) & resumable `BackupCoordinator`

- Migration 17 (`CURRENT_SCHEMA_VERSION = 17`): `backup_destinations`, `backup_jobs`, `backup_job_units`, `backup_destination_objects`, and `backup_bandwidth_ledger` (ledger populated in Slice 3).
- `BackupRepository` (`src/main/services/catalog/backup-repository.ts`) and `BackupCoordinator` (`src/main/services/backup/coordinator.ts`): destination CRUD, queued-on-disconnect (`queued_destination_unavailable`), pause/resume/cancel, startup `interrupted` recovery, staging retention & re-verification across restarts, `abandoned` fallback to new `snapshotId`, and capture-window serialization with `VaultImportCoordinator`.
- Focused persistence & coordinator Vitest suite (`tests/main/backup-coordinator.test.ts` covering **T5a–T5c**).

### Sub-slice 1C — Sender-validated IPC, sandboxed preload, Backup & Restore UI & real-Electron verification

- Narrow typed `backup:*` IPC channels (`src/shared/contracts/channels.ts`, `src/main/ipc/backup-handlers.ts`, `src/main/ipc/handlers.ts`, `src/main/index.ts` including fail-closed `.pv-restore-in-progress.json` startup guard).
- Sandboxed preload methods (`src/preload/index.ts`, `src/preload/index.d.ts`) and exact `window.api` allowlist reconciliation in `scripts/smoke.mjs` and `tests/preload/bridge.test.ts`.
- Minimal accessible Backup & Restore UI panel (configure USB/NAS destination + optional NAS rate cap, **explicitly display notice that original files outside the vault are excluded**, run/pause/resume/cancel/verify backup, view recovery points and pause reasons, restore a verified recovery point into an isolated folder).
- Real-Electron built & unpacked end-to-end verification script (`scripts/verify-electron-backup-restore.mjs`, `verify:backup`, `verify:backup:unpacked`) proving live backup, incremental backup, disconnect/corrupt/cross-drive-interrupted-restore handling, launching Electron against the restored `--user-data-dir`, and 100% bitwise preservation of active vault and original source files.

---

References: [Drive for desktop bandwidth settings](https://support.google.com/drive/answer/13470231?hl=en), [Drive API resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), and [Drive API limits and backoff](https://developers.google.com/workspace/drive/api/guides/limits).
