/**
 * Personal Vault — Stage 8B Sub-slice 1A-3: Cross-Drive Isolated Profile Restore
 *
 * Restores a verified `pv-backup-v1` recovery point into fresh, isolated
 * `targetProfileDir` and `targetVaultDir` directories using paired two-drive
 * `.pv-restore-in-progress.json` / `.pv-restore-complete.json` markers,
 * transactional vault-path rebinding, and scoped retry cleanup.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BACKUP_FORMAT_VERSION,
  BackupRepositoryIdentityV1Schema,
  BackupRestoreCompleteMarkerV1Schema,
  BackupRestoreInProgressMarkerV1Schema,
  BackupSnapshotCompleteMarkerV1Schema,
  BackupSnapshotManifestV1Schema,
  EMPTY_SHA256_HEX,
  type BackupFileEntry,
  type BackupRepositoryIdentityV1,
  type BackupRestoreCompleteMarkerV1,
  type BackupRestoreInProgressMarkerV1,
  type BackupSnapshotCompleteMarkerV1,
  type BackupSnapshotManifestV1
} from '../../../shared/validation/backup-schemas'
import type {
  BackupListRecoveryPointsResponse,
  BackupRecoveryPointSummary
} from '../../../shared/validation/backup-ipc-schemas'
import {
  AnnotationJournalEntrySchema,
  VaultIdentitySchema
} from '../../../shared/validation/ipc-schemas'
import { AnnotationJournal } from '../annotations/journal'
import { CatalogDatabase } from '../catalog/database'
import { CURRENT_SCHEMA_VERSION } from '../catalog/migrations'
import { normalizePathForLookup } from '../catalog/path-normalization'
import { assertPathContainedInVault } from '../vault/containment'
import { VaultManifestSchema } from '../vault/manifest-schema'
import { Aes256GcmObjectCodec, PlaintextObjectCodec, type BackupObjectCodec } from './codec'
import { validateRestoreTargetPaths } from './containment'
import { inspectRecoveryPointStatus } from './engine'
import { BackupRestoreError, BackupSnapshotError } from './errors'
import {
  BACKUP_OBJECTS_DIR,
  BACKUP_REPO_IDENTITY_FILE,
  BACKUP_SNAPSHOT_COMPLETE_FILE,
  BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE,
  BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
  BACKUP_SNAPSHOT_MANIFEST_FILE,
  BACKUP_SNAPSHOTS_DIR
} from './transport'

export const RESTORE_IN_PROGRESS_FILE = '.pv-restore-in-progress.json'
export const RESTORE_COMPLETE_FILE = '.pv-restore-complete.json'
export const RESTORE_TEMP_DIR = '.pv-restore-temp'

const JOB_TABLES_WITH_INTERRUPTED_STATUS = [
  'scan_jobs',
  'vault_imports',
  'similarity_jobs',
  'semantic_index_jobs',
  'photo_metadata_jobs',
  'document_extraction_jobs',
  'document_ocr_jobs',
  'document_semantic_jobs',
  'document_classification_jobs',
  'export_jobs',
  'backup_jobs'
] as const

export interface LocalRestoreTestHooks {
  readonly onDuringVaultStaging?: () => Promise<void> | void
  readonly onAfterVaultPublish?: () => Promise<void> | void
  readonly onAfterProfilePublish?: () => Promise<void> | void
  readonly onAfterProfileCompleteMarker?: () => Promise<void> | void
}

export interface VerifyRecoveryPointOptions {
  readonly backupRepoDir: string
  readonly snapshotId: string
  readonly codec?: BackupObjectCodec
  readonly recoverySecret?: string
  readonly signal?: AbortSignal
}

export interface VerifyRecoveryPointResult {
  readonly repositoryId: string
  readonly snapshotId: string
  readonly schemaVersion: number
  readonly verifiedObjectCount: number
  readonly verifiedFileCount: number
  readonly hasVault: boolean
  readonly hasAnnotations: boolean
}

export interface RestoreRecoveryPointOptions {
  readonly backupRepoDir: string
  readonly snapshotId: string
  readonly targetProfileDir: string
  readonly targetVaultDir: string | null
  readonly activeUserDataDir?: string
  readonly activeSourceRoots?: readonly string[]
  readonly activeVaultRoots?: readonly string[]
  readonly restoreJobId?: string
  readonly codec?: BackupObjectCodec
  readonly recoverySecret?: string
  readonly signal?: AbortSignal
  readonly hooks?: LocalRestoreTestHooks
}

export interface RestoreRecoveryPointResult {
  readonly restoreJobId: string
  readonly repositoryId: string
  readonly snapshotId: string
  readonly restoredProfilePath: string
  readonly restoredVaultPath: string | null
  readonly catalogSha256: string
  readonly verifiedFileCount: number
  readonly restoredAtMs: number
}

export type RestoredProfileStatus = 'complete' | 'interrupted' | 'not_restored' | 'corrupt'

export interface RestoredProfileInspectionResult {
  readonly status: RestoredProfileStatus
  readonly reason?: string
  readonly restoreJobId?: string
  readonly restoredVaultPath?: string | null
}

export interface CleanupInterruptedRestoreOptions {
  readonly targetProfileDir: string
  readonly targetVaultDir: string | null
  readonly expectedRestoreJobId?: string
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BackupRestoreError('restore_cancelled', 'Restore operation cancelled')
  }
}

function writeBufferSyncFsync(targetPath: string, data: Buffer, flag: 'wx' | 'w'): void {
  const fd = openSync(targetPath, flag)
  try {
    let offset = 0
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset)
      if (written <= 0) {
        throw new Error(`Zero bytes written to "${targetPath}"`)
      }
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncExistingFile(filePath: string): void {
  const fd = openSync(filePath, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

interface LoadedRecoveryPoint {
  readonly repository: BackupRepositoryIdentityV1
  readonly completeMarker: BackupSnapshotCompleteMarkerV1
  readonly manifest: BackupSnapshotManifestV1
  readonly codec: BackupObjectCodec
}

async function loadAndValidateRecoveryPointMetadata(
  backupRepoDir: string,
  snapshotId: string,
  options?: {
    readonly codec?: BackupObjectCodec
    readonly recoverySecret?: string
  }
): Promise<LoadedRecoveryPoint> {
  const repoPath = join(backupRepoDir, BACKUP_REPO_IDENTITY_FILE)
  if (!existsSync(repoPath)) {
    throw new BackupRestoreError(
      'repository_missing',
      `Backup repository identity missing at "${repoPath}"`
    )
  }

  let rawRepo: unknown
  try {
    rawRepo = JSON.parse(readFileSync(repoPath, 'utf8'))
  } catch (err) {
    throw new BackupRestoreError(
      'repository_invalid',
      `Backup repository identity unreadable: ${(err as Error).message}`
    )
  }

  if (
    typeof rawRepo === 'object' &&
    rawRepo !== null &&
    'formatVersion' in rawRepo &&
    (rawRepo as { formatVersion?: unknown }).formatVersion !== BACKUP_FORMAT_VERSION
  ) {
    throw new BackupRestoreError(
      'unsupported_format_version',
      `Unsupported backup repository formatVersion: ${String((rawRepo as { formatVersion?: unknown }).formatVersion)}`
    )
  }

  const repoParsed = BackupRepositoryIdentityV1Schema.safeParse(rawRepo)
  if (!repoParsed.success) {
    throw new BackupRestoreError(
      'repository_invalid',
      `Invalid repository.json: ${repoParsed.error.message}`
    )
  }
  const repository = repoParsed.data
  if (repository.encryptionMode !== 'none' && repository.encryptionMode !== 'aes-256-gcm-v1') {
    throw new BackupRestoreError(
      'unsupported_format_version',
      `Unsupported encryptionMode "${repository.encryptionMode}"`
    )
  }

  let codec: BackupObjectCodec
  if (repository.encryptionMode === 'aes-256-gcm-v1') {
    if (options?.codec) {
      if (
        !(options.codec instanceof Aes256GcmObjectCodec) ||
        !options.codec.matchesRepositoryEncryption(repository.repositoryId, repository.encryption)
      ) {
        throw new BackupRestoreError(
          'wrong_recovery_secret',
          `Provided codec is not bound to repository "${repository.repositoryId}"`
        )
      }
      codec = options.codec
    } else {
      codec = await Aes256GcmObjectCodec.unlockFromRepository({
        repositoryId: repository.repositoryId,
        encryption: repository.encryption,
        recoverySecret: options?.recoverySecret,
        errorDomain: 'restore'
      })
    }
  } else {
    codec = options?.codec ?? new PlaintextObjectCodec()
    if (codec.encryptionMode !== 'none') {
      throw new BackupRestoreError(
        'repository_invalid',
        `Provided codec encryptionMode "${codec.encryptionMode}" does not match repository "none"`
      )
    }
  }

  const snapDir = join(backupRepoDir, BACKUP_SNAPSHOTS_DIR, snapshotId)
  if (!existsSync(snapDir)) {
    throw new BackupRestoreError(
      'recovery_point_incomplete',
      `Recovery point directory "${snapshotId}" does not exist`
    )
  }
  if (existsSync(join(snapDir, BACKUP_SNAPSHOT_IN_PROGRESS_FILE))) {
    throw new BackupRestoreError(
      'recovery_point_incomplete',
      `Recovery point "${snapshotId}" is incomplete (.pv-snapshot-in-progress.json present)`
    )
  }

  const completePath = join(snapDir, BACKUP_SNAPSHOT_COMPLETE_FILE)
  if (!existsSync(completePath)) {
    throw new BackupRestoreError(
      'recovery_point_incomplete',
      `Recovery point "${snapshotId}" is incomplete (complete.json missing)`
    )
  }

  let completeMarker: BackupSnapshotCompleteMarkerV1
  try {
    completeMarker = BackupSnapshotCompleteMarkerV1Schema.parse(
      JSON.parse(readFileSync(completePath, 'utf8'))
    )
  } catch (err) {
    throw new BackupRestoreError(
      'recovery_point_incomplete',
      `Invalid complete.json for "${snapshotId}": ${(err as Error).message}`
    )
  }
  if (
    completeMarker.snapshotId !== snapshotId ||
    completeMarker.repositoryId !== repository.repositoryId ||
    completeMarker.encryptionMode !== repository.encryptionMode
  ) {
    throw new BackupRestoreError(
      'recovery_point_incomplete',
      `complete.json identity mismatch for "${snapshotId}"`
    )
  }

  const manifestFileName =
    repository.encryptionMode === 'aes-256-gcm-v1'
      ? BACKUP_SNAPSHOT_ENCRYPTED_MANIFEST_FILE
      : BACKUP_SNAPSHOT_MANIFEST_FILE
  const manifestPath = join(snapDir, manifestFileName)
  if (!existsSync(manifestPath)) {
    throw new BackupRestoreError(
      'manifest_missing',
      `${manifestFileName} missing for recovery point "${snapshotId}"`
    )
  }

  const storedManifestBytes = readFileSync(manifestPath)
  const actualManifestSha = sha256Hex(storedManifestBytes)
  if (actualManifestSha.toLowerCase() !== completeMarker.manifestSha256.toLowerCase()) {
    throw new BackupRestoreError(
      'manifest_hash_mismatch',
      `${manifestFileName} SHA-256 mismatch for "${snapshotId}"`
    )
  }

  let plaintextManifestBytes: Buffer
  try {
    plaintextManifestBytes = await codec.decodeManifest(storedManifestBytes, snapshotId)
  } catch (err) {
    throw new BackupRestoreError(
      'manifest_invalid',
      `Failed to decrypt ${manifestFileName} for "${snapshotId}": ${(err as Error).message}`
    )
  }

  let manifest: BackupSnapshotManifestV1
  try {
    manifest = BackupSnapshotManifestV1Schema.parse(
      JSON.parse(plaintextManifestBytes.toString('utf8'))
    )
  } catch (err) {
    throw new BackupRestoreError(
      'manifest_invalid',
      `Invalid ${manifestFileName} for "${snapshotId}": ${(err as Error).message}`
    )
  }
  if (manifest.snapshotId !== snapshotId || manifest.repositoryId !== repository.repositoryId) {
    throw new BackupRestoreError(
      'manifest_invalid',
      `${manifestFileName} identity mismatch for "${snapshotId}"`
    )
  }
  if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new BackupRestoreError(
      'unsupported_schema_version',
      `Snapshot schemaVersion ${manifest.schemaVersion} exceeds supported version ${CURRENT_SCHEMA_VERSION}`
    )
  }

  const status = inspectRecoveryPointStatus(backupRepoDir, snapshotId, { manifest })
  if (
    !status.isComplete ||
    status.integrityStatus !== 'structurally_complete' ||
    !status.checked.completionMarker ||
    !status.checked.manifestChecksum ||
    !status.checked.objectPresenceAndSizes
  ) {
    throw new BackupRestoreError(
      'recovery_point_incomplete',
      `Recovery point "${snapshotId}" failed structural preflight check: ${status.reasons.join(', ')}`
    )
  }

  return { repository, completeMarker, manifest, codec }
}

async function decodeVerifiedChunk(
  backupRepoDir: string,
  objectId: string,
  expectedStoredByteSize: number,
  expectedPlaintextByteSize: number,
  expectedPlaintextSha256: string,
  codec: BackupObjectCodec,
  signal?: AbortSignal
): Promise<Buffer> {
  checkCancelled(signal)
  const lower = objectId.toLowerCase()
  const objPath = join(backupRepoDir, BACKUP_OBJECTS_DIR, lower.slice(0, 2), `${lower}.pvchunk`)
  if (!existsSync(objPath)) {
    throw new BackupRestoreError('chunk_missing', `Missing backup chunk object ${lower}`)
  }
  const storedBytes = readFileSync(objPath)
  if (storedBytes.length !== expectedStoredByteSize) {
    throw new BackupRestoreError(
      'chunk_corrupt',
      `Chunk ${lower} stored size mismatch: expected ${expectedStoredByteSize}, got ${storedBytes.length}`
    )
  }
  try {
    const plaintext = await codec.decodeChunk(storedBytes, objectId, expectedPlaintextSha256)
    if (plaintext.length !== expectedPlaintextByteSize) {
      throw new BackupRestoreError(
        'chunk_corrupt',
        `Chunk ${lower} plaintext size mismatch: expected ${expectedPlaintextByteSize}, got ${plaintext.length}`
      )
    }
    return plaintext
  } catch (err) {
    if (err instanceof BackupRestoreError) throw err
    if (err instanceof BackupSnapshotError && err.code === 'destination_corrupt') {
      throw new BackupRestoreError('chunk_corrupt', err.message)
    }
    throw new BackupRestoreError(
      'chunk_corrupt',
      `Failed to decode chunk ${lower}: ${(err as Error).message}`
    )
  }
}

async function reassembleFileEntryToPath(
  backupRepoDir: string,
  entry: BackupFileEntry,
  destPath: string,
  codec: BackupObjectCodec,
  signal?: AbortSignal
): Promise<void> {
  checkCancelled(signal)
  mkdirSync(dirname(destPath), { recursive: true })

  if (entry.byteSize === 0) {
    if (entry.chunks.length !== 0 || entry.sha256.toLowerCase() !== EMPTY_SHA256_HEX) {
      throw new BackupRestoreError(
        'file_hash_mismatch',
        `Invalid empty file entry metadata for "${entry.logicalPath}"`
      )
    }
    writeBufferSyncFsync(destPath, Buffer.alloc(0), 'wx')
    return
  }

  const fd = openSync(destPath, 'wx')
  const fileHash = createHash('sha256')
  let totalWritten = 0
  try {
    for (let i = 0; i < entry.chunks.length; i++) {
      const chunk = entry.chunks[i]!
      if (chunk.index !== i) {
        throw new BackupRestoreError(
          'manifest_invalid',
          `Non-contiguous chunk index ${chunk.index} for "${entry.logicalPath}"`
        )
      }
      const plaintext = await decodeVerifiedChunk(
        backupRepoDir,
        chunk.objectId,
        chunk.storedByteSize,
        chunk.plaintextByteSize,
        chunk.plaintextSha256,
        codec,
        signal
      )
      fileHash.update(plaintext)
      let offset = 0
      while (offset < plaintext.length) {
        const written = writeSync(fd, plaintext, offset, plaintext.length - offset)
        if (written <= 0) {
          throw new Error(`Zero bytes written reconstructing "${entry.logicalPath}"`)
        }
        offset += written
      }
      totalWritten += plaintext.length
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  const actualSha = fileHash.digest('hex')
  if (totalWritten !== entry.byteSize || actualSha.toLowerCase() !== entry.sha256.toLowerCase()) {
    throw new BackupRestoreError(
      'file_hash_mismatch',
      `Reconstructed file "${entry.logicalPath}" failed integrity check`
    )
  }
}

async function reassembleFileEntryToBuffer(
  backupRepoDir: string,
  entry: BackupFileEntry,
  codec: BackupObjectCodec,
  signal?: AbortSignal
): Promise<Buffer> {
  checkCancelled(signal)
  if (entry.byteSize === 0) {
    if (entry.chunks.length !== 0 || entry.sha256.toLowerCase() !== EMPTY_SHA256_HEX) {
      throw new BackupRestoreError(
        'file_hash_mismatch',
        `Invalid empty file entry metadata for "${entry.logicalPath}"`
      )
    }
    return Buffer.alloc(0)
  }

  const parts: Buffer[] = []
  for (let i = 0; i < entry.chunks.length; i++) {
    const chunk = entry.chunks[i]!
    if (chunk.index !== i) {
      throw new BackupRestoreError(
        'manifest_invalid',
        `Non-contiguous chunk index ${chunk.index} for "${entry.logicalPath}"`
      )
    }
    parts.push(
      await decodeVerifiedChunk(
        backupRepoDir,
        chunk.objectId,
        chunk.storedByteSize,
        chunk.plaintextByteSize,
        chunk.plaintextSha256,
        codec,
        signal
      )
    )
  }
  const combined = Buffer.concat(parts)
  if (
    combined.length !== entry.byteSize ||
    sha256Hex(combined).toLowerCase() !== entry.sha256.toLowerCase()
  ) {
    throw new BackupRestoreError(
      'file_hash_mismatch',
      `Reconstructed buffer "${entry.logicalPath}" failed integrity check`
    )
  }
  return combined
}

function validateCatalogSqliteFile(dbPath: string): void {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check;').get() as
      { integrity_check?: string } | undefined
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new BackupRestoreError(
        'catalog_corrupt',
        `Restored SQLite catalog failed integrity_check: ${String(integrity?.integrity_check)}`
      )
    }
    const fkRows = db.prepare('PRAGMA foreign_key_check;').all()
    if (fkRows.length > 0) {
      throw new BackupRestoreError(
        'catalog_corrupt',
        `Restored SQLite catalog has ${fkRows.length} foreign key violation(s)`
      )
    }
    const migrationRow = db
      .prepare('SELECT MAX(version) AS max_version FROM schema_migrations;')
      .get() as { max_version?: number | null } | undefined
    const maxVersion = migrationRow?.max_version ?? 0
    if (maxVersion < 1) {
      throw new BackupRestoreError(
        'catalog_corrupt',
        'Restored SQLite catalog has no schema_migrations'
      )
    }
    if (maxVersion > CURRENT_SCHEMA_VERSION) {
      throw new BackupRestoreError(
        'unsupported_schema_version',
        `Restored SQLite catalog schema version ${maxVersion} exceeds supported version ${CURRENT_SCHEMA_VERSION}`
      )
    }
  } catch (err) {
    if (err instanceof BackupRestoreError) throw err
    throw new BackupRestoreError(
      'catalog_corrupt',
      `Failed to open or validate restored SQLite catalog: ${(err as Error).message}`
    )
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
  }
}

function validateAnnotationsContent(ownerBytes: Buffer, journalBytes: Buffer): void {
  let ownerJson: unknown
  try {
    ownerJson = JSON.parse(ownerBytes.toString('utf8'))
  } catch (err) {
    throw new BackupRestoreError(
      'journal_corrupt',
      `Invalid .pv_annotations_owner JSON: ${(err as Error).message}`
    )
  }
  if (
    typeof ownerJson !== 'object' ||
    ownerJson === null ||
    (ownerJson as Record<string, unknown>).app !== 'personal-vault' ||
    (ownerJson as Record<string, unknown>).format !== 'personal-vault-review-journal'
  ) {
    throw new BackupRestoreError('journal_corrupt', 'Invalid .pv_annotations_owner metadata')
  }

  const rawText = journalBytes.toString('utf8')
  const lines = rawText.split(/\r?\n/).filter((line) => line.length > 0)
  for (let i = 0; i < lines.length; i++) {
    let parsedObj: unknown
    try {
      parsedObj = JSON.parse(lines[i]!)
    } catch (err) {
      throw new BackupRestoreError(
        'journal_corrupt',
        `Corrupt JSONL at annotation journal line ${i + 1}: ${(err as Error).message}`
      )
    }
    const parsed = AnnotationJournalEntrySchema.safeParse(parsedObj)
    if (!parsed.success) {
      throw new BackupRestoreError(
        'journal_corrupt',
        `Schema-invalid annotation journal entry at line ${i + 1}: ${parsed.error.message}`
      )
    }
    if (parsed.data.entrySeq !== i + 1) {
      throw new BackupRestoreError(
        'journal_corrupt',
        `Annotation journal sequence gap at line ${i + 1}: expected ${i + 1}, got ${parsed.data.entrySeq}`
      )
    }
  }
}

function validateVaultIdentityBytes(bytes: Buffer, expectedVaultId: string): void {
  try {
    const parsed = VaultIdentitySchema.parse(JSON.parse(bytes.toString('utf8')))
    if (parsed.vaultId !== expectedVaultId) {
      throw new Error(`vaultId mismatch: expected ${expectedVaultId}, got ${parsed.vaultId}`)
    }
  } catch (err) {
    throw new BackupRestoreError(
      'vault_identity_invalid',
      `Invalid vault.json in backup: ${(err as Error).message}`
    )
  }
}

function validateVaultManifestBytes(
  bytes: Buffer,
  expectedVaultId: string,
  expectedSha256: string
): void {
  try {
    const parsed = VaultManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (parsed.vaultId !== expectedVaultId) {
      throw new Error(`vaultId mismatch: expected ${expectedVaultId}, got ${parsed.vaultId}`)
    }
    if (parsed.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${parsed.sha256}`)
    }
  } catch (err) {
    throw new BackupRestoreError(
      'vault_manifest_invalid',
      `Invalid vault manifest.json in backup: ${(err as Error).message}`
    )
  }
}

function rebindRestoredCatalogSqlite(
  stagedDbPath: string,
  canonicalTargetVaultDir: string | null,
  expectedVaultId: string | null
): void {
  const db = new DatabaseSync(stagedDbPath)
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA journal_mode = DELETE;')
    db.exec('BEGIN IMMEDIATE;')
    try {
      const now = Date.now()
      if (canonicalTargetVaultDir !== null && expectedVaultId !== null) {
        const res = db
          .prepare(
            `UPDATE vaults
             SET vault_path = ?, normalized_vault_path = ?, updated_at_ms = ?
             WHERE vault_id = ?`
          )
          .run(
            canonicalTargetVaultDir,
            normalizePathForLookup(canonicalTargetVaultDir),
            now,
            expectedVaultId
          )
        if (res.changes !== 1) {
          throw new BackupRestoreError(
            'catalog_corrupt',
            `Expected 1 vault row for vault_id "${expectedVaultId}", updated ${res.changes}`
          )
        }
      }

      const existingTables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table';").all() as Array<{
            name: string
          }>
        ).map((r) => r.name)
      )

      for (const table of JOB_TABLES_WITH_INTERRUPTED_STATUS) {
        if (existingTables.has(table)) {
          db.prepare(
            `UPDATE ${table} SET status = 'interrupted' WHERE status IN ('running', 'paused')`
          ).run()
        }
      }

      db.exec('COMMIT;')
    } catch (err) {
      db.exec('ROLLBACK;')
      throw err
    }

    const integrity = db.prepare('PRAGMA integrity_check;').get() as
      { integrity_check?: string } | undefined
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new BackupRestoreError(
        'catalog_corrupt',
        'Rebound SQLite catalog failed post-rebind integrity_check'
      )
    }
    const fkRows = db.prepare('PRAGMA foreign_key_check;').all()
    if (fkRows.length > 0) {
      throw new BackupRestoreError(
        'catalog_corrupt',
        'Rebound SQLite catalog failed post-rebind foreign_key_check'
      )
    }
  } finally {
    db.close()
  }
  fsyncExistingFile(stagedDbPath)
}

export async function verifyRecoveryPoint(
  options: VerifyRecoveryPointOptions
): Promise<VerifyRecoveryPointResult> {
  const { repository, manifest, codec } = await loadAndValidateRecoveryPointMetadata(
    options.backupRepoDir,
    options.snapshotId,
    { codec: options.codec, recoverySecret: options.recoverySecret }
  )

  const tempDir = mkdtempSync(join(tmpdir(), 'pv-8b-verify-'))
  try {
    // 1. Reassemble and validate SQLite catalog
    const tempDbPath = join(tempDir, 'vault-catalog.db')
    await reassembleFileEntryToPath(
      options.backupRepoDir,
      manifest.catalogFile,
      tempDbPath,
      codec,
      options.signal
    )
    validateCatalogSqliteFile(tempDbPath)

    let verifiedFileCount = 1

    // 2. Reassemble and validate annotations if present
    if (manifest.annotations) {
      const ownerBytes = await reassembleFileEntryToBuffer(
        options.backupRepoDir,
        manifest.annotations.ownerMarkerFile,
        codec,
        options.signal
      )
      const journalBytes = await reassembleFileEntryToBuffer(
        options.backupRepoDir,
        manifest.annotations.journalFile,
        codec,
        options.signal
      )
      validateAnnotationsContent(ownerBytes, journalBytes)
      verifiedFileCount += 2
    }

    // 3. Reassemble and validate vault identity, payload files, and manifest.json sidecars
    if (manifest.vault) {
      const identityBytes = await reassembleFileEntryToBuffer(
        options.backupRepoDir,
        manifest.vault.identityFile,
        codec,
        options.signal
      )
      validateVaultIdentityBytes(identityBytes, manifest.vault.vaultId)
      verifiedFileCount += 1

      for (const copy of manifest.vault.copies) {
        const payloadTempPath = join(tempDir, 'vault-payload', `${copy.sha256}.bin`)
        await reassembleFileEntryToPath(
          options.backupRepoDir,
          copy.payloadFile,
          payloadTempPath,
          codec,
          options.signal
        )
        unlinkSync(payloadTempPath)

        const manifestBytes = await reassembleFileEntryToBuffer(
          options.backupRepoDir,
          copy.manifestFile,
          codec,
          options.signal
        )
        validateVaultManifestBytes(manifestBytes, manifest.vault.vaultId, copy.sha256)
        verifiedFileCount += 2
      }
    }

    const seenObjects = new Set<string>()
    for (const chunk of manifest.catalogFile.chunks) seenObjects.add(chunk.objectId)
    if (manifest.annotations) {
      for (const c of manifest.annotations.ownerMarkerFile.chunks) seenObjects.add(c.objectId)
      for (const c of manifest.annotations.journalFile.chunks) seenObjects.add(c.objectId)
    }
    if (manifest.vault) {
      for (const c of manifest.vault.identityFile.chunks) seenObjects.add(c.objectId)
      for (const copy of manifest.vault.copies) {
        for (const c of copy.payloadFile.chunks) seenObjects.add(c.objectId)
        for (const c of copy.manifestFile.chunks) seenObjects.add(c.objectId)
      }
    }

    return {
      repositoryId: repository.repositoryId,
      snapshotId: manifest.snapshotId,
      schemaVersion: manifest.schemaVersion,
      verifiedObjectCount: seenObjects.size,
      verifiedFileCount,
      hasVault: manifest.vault !== null,
      hasAnnotations: manifest.annotations !== null
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function restoreRecoveryPointToIsolatedProfile(
  options: RestoreRecoveryPointOptions
): Promise<RestoreRecoveryPointResult> {
  checkCancelled(options.signal)

  // 1. Validate target paths (isolated, empty, symlink-free, disjoint)
  const validatedPaths = validateRestoreTargetPaths({
    targetProfileDir: options.targetProfileDir,
    targetVaultDir: options.targetVaultDir,
    backupRepoDir: options.backupRepoDir,
    activeUserDataDir: options.activeUserDataDir,
    activeSourceRoots: options.activeSourceRoots ?? [],
    activeVaultRoots: options.activeVaultRoots ?? []
  })

  // 2. Pre-flight recovery point validation (including key unwrap & manifest decryption)
  // Must fail closed before creating any target profile/vault directories.
  const { repository, manifest, codec } = await loadAndValidateRecoveryPointMetadata(
    validatedPaths.backupRepoDir,
    options.snapshotId,
    { codec: options.codec, recoverySecret: options.recoverySecret }
  )

  if (manifest.vault !== null && validatedPaths.targetVaultDir === null) {
    throw new BackupRestoreError(
      'restore_target_invalid',
      'targetVaultDir is required when restoring a recovery point that includes a vault'
    )
  }

  const restoreJobId = options.restoreJobId ?? randomUUID()
  const startedAtMs = Date.now()
  const targetProfileDir = validatedPaths.targetProfileDir
  const targetVaultDir = manifest.vault !== null ? validatedPaths.targetVaultDir : null

  mkdirSync(targetProfileDir, { recursive: true })
  if (targetVaultDir !== null) {
    mkdirSync(targetVaultDir, { recursive: true })
  }

  // Phase A — In-progress markers & staging directories
  const inProgressMarker: BackupRestoreInProgressMarkerV1 =
    BackupRestoreInProgressMarkerV1Schema.parse({
      formatVersion: BACKUP_FORMAT_VERSION,
      schema: 'pv_restore_in_progress_v1',
      restoreJobId,
      repositoryId: repository.repositoryId,
      snapshotId: manifest.snapshotId,
      targetProfileDir,
      targetVaultDir,
      startedAtMs
    })
  const inProgressBytes = Buffer.from(JSON.stringify(inProgressMarker, null, 2), 'utf8')
  writeBufferSyncFsync(join(targetProfileDir, RESTORE_IN_PROGRESS_FILE), inProgressBytes, 'wx')
  if (targetVaultDir !== null) {
    writeBufferSyncFsync(join(targetVaultDir, RESTORE_IN_PROGRESS_FILE), inProgressBytes, 'wx')
  }

  const profileTempDir = join(targetProfileDir, RESTORE_TEMP_DIR)
  mkdirSync(profileTempDir, { recursive: true })
  const vaultTempDir = targetVaultDir !== null ? join(targetVaultDir, RESTORE_TEMP_DIR) : null
  if (vaultTempDir !== null) {
    mkdirSync(vaultTempDir, { recursive: true })
  }

  let verifiedFileCount = 0

  // Phase B — Vault staging, verification & vault publish
  if (manifest.vault !== null && targetVaultDir !== null && vaultTempDir !== null) {
    const stagedVaultIdentityPath = join(vaultTempDir, 'vault.json')
    await reassembleFileEntryToPath(
      validatedPaths.backupRepoDir,
      manifest.vault.identityFile,
      stagedVaultIdentityPath,
      codec,
      options.signal
    )
    validateVaultIdentityBytes(readFileSync(stagedVaultIdentityPath), manifest.vault.vaultId)
    verifiedFileCount += 1

    const stagedCopies: Array<{
      stagedPayloadPath: string
      targetPayloadPath: string
      stagedManifestPath: string
      targetManifestPath: string
    }> = []

    for (const copy of manifest.vault.copies) {
      const targetPayloadPath = join(targetVaultDir, copy.payloadRelativePath)
      const targetManifestPath = join(targetVaultDir, copy.manifestRelativePath)
      assertPathContainedInVault(targetVaultDir, targetPayloadPath, 'restored vault payload')
      assertPathContainedInVault(targetVaultDir, targetManifestPath, 'restored vault manifest')

      const stagedPayloadPath = join(vaultTempDir, copy.payloadRelativePath)
      await reassembleFileEntryToPath(
        validatedPaths.backupRepoDir,
        copy.payloadFile,
        stagedPayloadPath,
        codec,
        options.signal
      )
      verifiedFileCount += 1

      const stagedManifestPath = join(vaultTempDir, copy.manifestRelativePath)
      await reassembleFileEntryToPath(
        validatedPaths.backupRepoDir,
        copy.manifestFile,
        stagedManifestPath,
        codec,
        options.signal
      )
      validateVaultManifestBytes(
        readFileSync(stagedManifestPath),
        manifest.vault.vaultId,
        copy.sha256
      )
      verifiedFileCount += 1

      stagedCopies.push({
        stagedPayloadPath,
        targetPayloadPath,
        stagedManifestPath,
        targetManifestPath
      })
    }

    await options.hooks?.onDuringVaultStaging?.()
    checkCancelled(options.signal)

    // Publish vault files into targetVaultDir (no overwrite)
    renameSync(stagedVaultIdentityPath, join(targetVaultDir, 'vault.json'))
    for (const item of stagedCopies) {
      mkdirSync(dirname(item.targetPayloadPath), { recursive: true })
      renameSync(item.stagedPayloadPath, item.targetPayloadPath)
      mkdirSync(dirname(item.targetManifestPath), { recursive: true })
      renameSync(item.stagedManifestPath, item.targetManifestPath)
    }

    await options.hooks?.onAfterVaultPublish?.()
    checkCancelled(options.signal)
  }

  // Phase C — Catalog & journal staging, rebinding & verification
  const stagedCatalogPath = join(profileTempDir, 'vault-catalog.db')
  await reassembleFileEntryToPath(
    validatedPaths.backupRepoDir,
    manifest.catalogFile,
    stagedCatalogPath,
    codec,
    options.signal
  )
  validateCatalogSqliteFile(stagedCatalogPath)
  rebindRestoredCatalogSqlite(stagedCatalogPath, targetVaultDir, manifest.vault?.vaultId ?? null)
  verifiedFileCount += 1

  let stagedAnnotationsDir: string | null = null
  if (manifest.annotations !== null) {
    stagedAnnotationsDir = join(profileTempDir, 'annotations')
    mkdirSync(stagedAnnotationsDir, { recursive: true })
    const stagedOwnerPath = join(stagedAnnotationsDir, '.pv_annotations_owner')
    const stagedJournalPath = join(stagedAnnotationsDir, 'review-journal.jsonl')

    await reassembleFileEntryToPath(
      validatedPaths.backupRepoDir,
      manifest.annotations.ownerMarkerFile,
      stagedOwnerPath,
      codec,
      options.signal
    )
    await reassembleFileEntryToPath(
      validatedPaths.backupRepoDir,
      manifest.annotations.journalFile,
      stagedJournalPath,
      codec,
      options.signal
    )
    validateAnnotationsContent(readFileSync(stagedOwnerPath), readFileSync(stagedJournalPath))
    verifiedFileCount += 2
  }

  // Phase D — Profile publish & post-restore runtime verification
  const publishedCatalogPath = join(targetProfileDir, 'vault-catalog.db')
  renameSync(stagedCatalogPath, publishedCatalogPath)

  const publishedAnnotationsDir = join(targetProfileDir, 'annotations')
  if (stagedAnnotationsDir !== null) {
    renameSync(stagedAnnotationsDir, publishedAnnotationsDir)
  }

  await options.hooks?.onAfterProfilePublish?.()
  checkCancelled(options.signal)

  let runtimeJournal: AnnotationJournal | undefined
  if (manifest.annotations !== null) {
    runtimeJournal = new AnnotationJournal({
      storageDir: publishedAnnotationsDir,
      sourceRoots: () => [],
      vaultPath: () => targetVaultDir
    })
    await runtimeJournal.initialize()
  }

  const runtimeCatalog = CatalogDatabase.open({
    catalogPath: publishedCatalogPath,
    journal: runtimeJournal
  })
  try {
    if (manifest.vault !== null && targetVaultDir !== null) {
      const activeVault = runtimeCatalog.getActiveVault()
      if (!activeVault || activeVault.vaultId !== manifest.vault.vaultId) {
        throw new BackupRestoreError(
          'catalog_corrupt',
          'Post-restore runtime verification failed: active vault identity mismatch'
        )
      }
      if (activeVault.normalizedVaultPath !== normalizePathForLookup(targetVaultDir)) {
        throw new BackupRestoreError(
          'catalog_corrupt',
          'Post-restore runtime verification failed: vault path rebinding mismatch'
        )
      }
      const copyCount = runtimeCatalog.getVaultCopiesForVault(manifest.vault.vaultId).length
      if (copyCount !== manifest.vault.copies.length) {
        throw new BackupRestoreError(
          'catalog_corrupt',
          `Post-restore vault_copies count mismatch: expected ${manifest.vault.copies.length}, got ${copyCount}`
        )
      }
    }
  } finally {
    runtimeCatalog.close()
  }

  const catalogSha256 = sha256Hex(readFileSync(publishedCatalogPath))
  const restoredAtMs = Date.now()

  // Phase E — Paired two-drive completion commit
  const completeMarker: BackupRestoreCompleteMarkerV1 = BackupRestoreCompleteMarkerV1Schema.parse({
    formatVersion: BACKUP_FORMAT_VERSION,
    schema: 'pv_restore_complete_v1',
    restoreJobId,
    repositoryId: repository.repositoryId,
    snapshotId: manifest.snapshotId,
    restoredProfilePath: targetProfileDir,
    restoredVaultPath: targetVaultDir,
    catalogSha256,
    verifiedFileCount,
    restoredAtMs
  })
  const completeBytes = Buffer.from(JSON.stringify(completeMarker, null, 2), 'utf8')

  writeBufferSyncFsync(join(targetProfileDir, RESTORE_COMPLETE_FILE), completeBytes, 'wx')
  await options.hooks?.onAfterProfileCompleteMarker?.()
  checkCancelled(options.signal)

  if (targetVaultDir !== null) {
    writeBufferSyncFsync(join(targetVaultDir, RESTORE_COMPLETE_FILE), completeBytes, 'wx')
    const vaultInProgPath = join(targetVaultDir, RESTORE_IN_PROGRESS_FILE)
    if (existsSync(vaultInProgPath)) {
      unlinkSync(vaultInProgPath)
    }
    if (vaultTempDir !== null && existsSync(vaultTempDir)) {
      rmSync(vaultTempDir, { recursive: true, force: true })
    }
  }

  const profileInProgPath = join(targetProfileDir, RESTORE_IN_PROGRESS_FILE)
  if (existsSync(profileInProgPath)) {
    unlinkSync(profileInProgPath)
  }
  if (existsSync(profileTempDir)) {
    rmSync(profileTempDir, { recursive: true, force: true })
  }

  return {
    restoreJobId,
    repositoryId: repository.repositoryId,
    snapshotId: manifest.snapshotId,
    restoredProfilePath: targetProfileDir,
    restoredVaultPath: targetVaultDir,
    catalogSha256,
    verifiedFileCount,
    restoredAtMs
  }
}

export function inspectRestoredProfileStatus(
  targetProfileDir: string,
  targetVaultDir?: string | null
): RestoredProfileInspectionResult {
  const profileInProgPath = join(targetProfileDir, RESTORE_IN_PROGRESS_FILE)
  const profileCompletePath = join(targetProfileDir, RESTORE_COMPLETE_FILE)

  if (existsSync(profileInProgPath)) {
    let restoreJobId: string | undefined
    try {
      const parsed = BackupRestoreInProgressMarkerV1Schema.parse(
        JSON.parse(readFileSync(profileInProgPath, 'utf8'))
      )
      restoreJobId = parsed.restoreJobId
    } catch {
      // ignore parse failure, still interrupted
    }
    return {
      status: 'interrupted',
      reason: 'Profile .pv-restore-in-progress.json is present',
      restoreJobId
    }
  }

  if (targetVaultDir && existsSync(join(targetVaultDir, RESTORE_IN_PROGRESS_FILE))) {
    return {
      status: 'interrupted',
      reason: 'Vault .pv-restore-in-progress.json is present'
    }
  }

  if (!existsSync(profileCompletePath)) {
    return { status: 'not_restored' }
  }

  let completeMarker: BackupRestoreCompleteMarkerV1
  try {
    completeMarker = BackupRestoreCompleteMarkerV1Schema.parse(
      JSON.parse(readFileSync(profileCompletePath, 'utf8'))
    )
  } catch (err) {
    return {
      status: 'corrupt',
      reason: `Invalid profile .pv-restore-complete.json: ${(err as Error).message}`
    }
  }

  const vaultToCheck = targetVaultDir ?? completeMarker.restoredVaultPath
  if (vaultToCheck !== null) {
    if (existsSync(join(vaultToCheck, RESTORE_IN_PROGRESS_FILE))) {
      return {
        status: 'interrupted',
        reason: 'Paired vault .pv-restore-in-progress.json is still present',
        restoreJobId: completeMarker.restoreJobId,
        restoredVaultPath: vaultToCheck
      }
    }
    const vaultCompletePath = join(vaultToCheck, RESTORE_COMPLETE_FILE)
    if (!existsSync(vaultCompletePath)) {
      return {
        status: 'interrupted',
        reason: 'Paired vault .pv-restore-complete.json is missing',
        restoreJobId: completeMarker.restoreJobId,
        restoredVaultPath: vaultToCheck
      }
    }
    try {
      const vaultMarker = BackupRestoreCompleteMarkerV1Schema.parse(
        JSON.parse(readFileSync(vaultCompletePath, 'utf8'))
      )
      if (vaultMarker.restoreJobId !== completeMarker.restoreJobId) {
        return {
          status: 'corrupt',
          reason: 'Paired vault .pv-restore-complete.json restoreJobId mismatch'
        }
      }
    } catch (err) {
      return {
        status: 'corrupt',
        reason: `Invalid vault .pv-restore-complete.json: ${(err as Error).message}`
      }
    }
  }

  return {
    status: 'complete',
    restoreJobId: completeMarker.restoreJobId,
    restoredVaultPath: completeMarker.restoredVaultPath
  }
}

function tryReadInProgressMarker(dir: string): BackupRestoreInProgressMarkerV1 | null {
  const markerPath = join(dir, RESTORE_IN_PROGRESS_FILE)
  if (!existsSync(markerPath)) return null
  try {
    return BackupRestoreInProgressMarkerV1Schema.parse(JSON.parse(readFileSync(markerPath, 'utf8')))
  } catch (err) {
    throw new BackupRestoreError(
      'restore_cleanup_refused',
      `Invalid .pv-restore-in-progress.json in "${dir}": ${(err as Error).message}`
    )
  }
}

export function cleanupInterruptedRestoreTarget(options: CleanupInterruptedRestoreOptions): void {
  const profileMarker = tryReadInProgressMarker(options.targetProfileDir)
  const vaultMarker = options.targetVaultDir
    ? tryReadInProgressMarker(options.targetVaultDir)
    : null

  const activeMarker = profileMarker ?? vaultMarker
  if (!activeMarker) {
    throw new BackupRestoreError(
      'restore_cleanup_refused',
      'Refusing restore cleanup: no .pv-restore-in-progress.json marker found'
    )
  }

  if (profileMarker && vaultMarker && profileMarker.restoreJobId !== vaultMarker.restoreJobId) {
    throw new BackupRestoreError(
      'restore_cleanup_refused',
      'Refusing restore cleanup: profile and vault in-progress markers have mismatched restoreJobId'
    )
  }

  if (options.expectedRestoreJobId && activeMarker.restoreJobId !== options.expectedRestoreJobId) {
    throw new BackupRestoreError(
      'restore_cleanup_refused',
      `Refusing restore cleanup: expected restoreJobId "${options.expectedRestoreJobId}", found "${activeMarker.restoreJobId}"`
    )
  }

  if (
    resolve(activeMarker.targetProfileDir) !== resolve(options.targetProfileDir) ||
    (options.targetVaultDir !== null &&
      activeMarker.targetVaultDir !== null &&
      resolve(activeMarker.targetVaultDir) !== resolve(options.targetVaultDir))
  ) {
    throw new BackupRestoreError(
      'restore_cleanup_refused',
      'Refusing restore cleanup: marker target paths do not match cleanup target directories'
    )
  }

  // Verify any .pv-restore-complete.json being removed belongs to this same restoreJobId
  for (const dir of [options.targetProfileDir, options.targetVaultDir]) {
    if (!dir) continue
    const completePath = join(dir, RESTORE_COMPLETE_FILE)
    if (existsSync(completePath)) {
      const parsed = BackupRestoreCompleteMarkerV1Schema.safeParse(
        JSON.parse(readFileSync(completePath, 'utf8'))
      )
      if (!parsed.success || parsed.data.restoreJobId !== activeMarker.restoreJobId) {
        throw new BackupRestoreError(
          'restore_cleanup_refused',
          `Refusing restore cleanup: .pv-restore-complete.json in "${dir}" does not match restoreJobId`
        )
      }
    }
  }

  // Scoped cleanup: remove ONLY restore-owned files/directories
  const profileOwnedEntries = [
    RESTORE_TEMP_DIR,
    RESTORE_IN_PROGRESS_FILE,
    RESTORE_COMPLETE_FILE,
    'vault-catalog.db',
    'vault-catalog.db-wal',
    'vault-catalog.db-shm',
    'annotations'
  ]
  for (const rel of profileOwnedEntries) {
    const p = join(options.targetProfileDir, rel)
    if (existsSync(p) || statSync(p, { throwIfNoEntry: false })) {
      rmSync(p, { recursive: true, force: true })
    }
  }

  if (options.targetVaultDir) {
    const vaultOwnedEntries = [
      RESTORE_TEMP_DIR,
      RESTORE_IN_PROGRESS_FILE,
      RESTORE_COMPLETE_FILE,
      'vault.json',
      'files'
    ]
    for (const rel of vaultOwnedEntries) {
      const p = join(options.targetVaultDir, rel)
      if (existsSync(p) || statSync(p, { throwIfNoEntry: false })) {
        rmSync(p, { recursive: true, force: true })
      }
    }
  }
}

export function listRecoveryPoints(backupRepoDir: string): BackupListRecoveryPointsResponse {
  const canonicalRepoDir = resolve(backupRepoDir)
  let repositoryId: string | null = null
  const repoPath = join(canonicalRepoDir, BACKUP_REPO_IDENTITY_FILE)
  if (existsSync(repoPath)) {
    try {
      const parsedRepo = BackupRepositoryIdentityV1Schema.parse(
        JSON.parse(readFileSync(repoPath, 'utf8'))
      )
      repositoryId = parsedRepo.repositoryId
    } catch {
      repositoryId = null
    }
  }

  const snapshotsDir = join(canonicalRepoDir, BACKUP_SNAPSHOTS_DIR)
  if (!existsSync(snapshotsDir)) {
    return { backupRepoDir: canonicalRepoDir, repositoryId, recoveryPoints: [] }
  }

  const entries = readdirSync(snapshotsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  const summaries: BackupRecoveryPointSummary[] = []

  for (const entry of entries) {
    const snapshotId = entry.name
    const inspection = inspectRecoveryPointStatus(canonicalRepoDir, snapshotId)
    const manifestPath = join(snapshotsDir, snapshotId, BACKUP_SNAPSHOT_MANIFEST_FILE)
    let createdAtMs: number | null = null
    let vaultName: string | null = null
    let vaultCopyCount: number | null = null
    if (existsSync(manifestPath)) {
      try {
        const manifest = BackupSnapshotManifestV1Schema.parse(
          JSON.parse(readFileSync(manifestPath, 'utf8'))
        )
        createdAtMs = manifest.createdAtMs
        vaultName = manifest.vault?.vaultName ?? null
        vaultCopyCount = manifest.vault ? manifest.vault.copies.length : 0
      } catch {
        // Leave manifest fields null when unreadable/corrupt
      }
    }

    summaries.push({
      snapshotId,
      isComplete: inspection.isComplete,
      integrityStatus: inspection.integrityStatus,
      reasons: [...inspection.reasons],
      repositoryId: inspection.completeMarker?.repositoryId ?? repositoryId,
      createdAtMs,
      completedAtMs: inspection.completeMarker?.completedAtMs ?? null,
      verificationScope: inspection.completeMarker?.verificationScope ?? null,
      totalObjectCount: inspection.completeMarker?.totalObjectCount ?? null,
      totalLogicalBytes: inspection.completeMarker?.totalLogicalBytes ?? null,
      totalStoredBytes: inspection.completeMarker?.totalStoredBytes ?? null,
      vaultName,
      vaultCopyCount
    })
  }

  summaries.sort((a, b) => {
    const timeA = a.completedAtMs ?? a.createdAtMs ?? 0
    const timeB = b.completedAtMs ?? b.createdAtMs ?? 0
    if (timeB !== timeA) return timeB - timeA
    return b.snapshotId.localeCompare(a.snapshotId)
  })

  return {
    backupRepoDir: canonicalRepoDir,
    repositoryId,
    recoveryPoints: summaries
  }
}
