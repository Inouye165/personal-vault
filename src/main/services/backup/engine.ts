/**
 * Personal Vault — Stage 8B Sub-slice 1A-2: Verified Local Backup Engine
 *
 * Reuses `captureConsistentBackupSnapshot` (1A-1) and publishes 4 MiB
 * content-addressed chunks, self-contained `snapshot.json`, and `complete.json`
 * via `BackupObjectCodec` and `BackupTransport` with read-back verification.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BACKUP_CHUNK_SIZE_BYTES,
  BACKUP_FORMAT_VERSION,
  BackupRepositoryIdentityV1Schema,
  BackupSnapshotCompleteMarkerV1Schema,
  BackupSnapshotManifestV1Schema,
  BackupStagingManifestV1Schema,
  EMPTY_SHA256_HEX,
  type BackupChunkRef,
  type BackupFileEntry,
  type BackupRepositoryIdentityV1,
  type BackupSnapshotCompleteMarkerV1,
  type BackupSnapshotInProgressMarkerV1,
  type BackupSnapshotManifestV1,
  type BackupStagingManifestV1,
  type BackupVerificationScope
} from '../../../shared/validation/backup-schemas'
import { PlaintextObjectCodec, type BackupObjectCodec } from './codec'
import { validateBackupDestinationPath, validateBackupStagingDir } from './containment'
import { BackupSnapshotError } from './errors'
import { TransferRateLimiter } from './rate-limiter'
import {
  captureConsistentBackupSnapshot,
  type CaptureConsistentBackupSnapshotResult
} from './snapshot-capture'
import {
  BACKUP_OBJECTS_DIR,
  BACKUP_REPO_IDENTITY_FILE,
  BACKUP_SNAPSHOT_COMPLETE_FILE,
  BACKUP_SNAPSHOT_IN_PROGRESS_FILE,
  BACKUP_SNAPSHOT_MANIFEST_FILE,
  BACKUP_SNAPSHOTS_DIR,
  LocalFsTransport,
  type LocalBackupTestHooks
} from './transport'

export interface RunLocalBackupOptions {
  readonly jobId: string
  readonly snapshotId: string
  readonly backupRepoDir: string
  readonly catalogPath: string
  readonly annotationsDir: string
  readonly userDataDir: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
  readonly appVersion: string
  readonly verifyAllChunks?: boolean
  readonly rateLimiter?: TransferRateLimiter
  readonly codec?: BackupObjectCodec
  readonly signal?: AbortSignal
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly onRepositoryResolved?: (repositoryId: string) => void
  readonly onChunkVerified?: (chunk: BackupChunkRef, action: 'written' | 'reused') => void
}

export interface RunLocalBackupResult {
  readonly repositoryId: string
  readonly snapshotId: string
  readonly verificationScope: BackupVerificationScope
  readonly writtenChunkCount: number
  readonly reusedChunkCount: number
  readonly totalObjectCount: number
  readonly totalLogicalBytes: number
  readonly totalStoredBytes: number
  readonly manifestSha256: string
}

export type RecoveryPointIncompleteReason =
  | 'repository_missing'
  | 'repository_invalid'
  | 'snapshot_dir_missing'
  | 'in_progress_marker_present'
  | 'completion_marker_missing'
  | 'completion_marker_invalid'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_hash_mismatch'
  | 'missing_object'
  | 'object_size_mismatch'

export interface RecoveryPointInspectionResult {
  readonly isComplete: boolean
  readonly reasons: readonly RecoveryPointIncompleteReason[]
  readonly completeMarker: BackupSnapshotCompleteMarkerV1 | null
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function collectManifestChunks(manifest: BackupSnapshotManifestV1): BackupChunkRef[] {
  const refs: BackupChunkRef[] = [...manifest.catalogFile.chunks]
  if (manifest.annotations) {
    refs.push(...manifest.annotations.ownerMarkerFile.chunks)
    refs.push(...manifest.annotations.journalFile.chunks)
  }
  if (manifest.vault) {
    refs.push(...manifest.vault.identityFile.chunks)
    for (const copy of manifest.vault.copies) {
      refs.push(...copy.payloadFile.chunks)
      refs.push(...copy.manifestFile.chunks)
    }
  }
  return refs
}

export function inspectRecoveryPointStatus(
  backupRepoDir: string,
  snapshotId: string
): RecoveryPointInspectionResult {
  const reasons: RecoveryPointIncompleteReason[] = []

  const repoPath = join(backupRepoDir, BACKUP_REPO_IDENTITY_FILE)
  let repoIdentity: BackupRepositoryIdentityV1 | null = null
  if (!existsSync(repoPath)) {
    reasons.push('repository_missing')
  } else {
    try {
      repoIdentity = BackupRepositoryIdentityV1Schema.parse(
        JSON.parse(readFileSync(repoPath, 'utf8'))
      )
    } catch {
      reasons.push('repository_invalid')
    }
  }

  const snapDir = join(backupRepoDir, BACKUP_SNAPSHOTS_DIR, snapshotId)
  if (!existsSync(snapDir)) {
    reasons.push('snapshot_dir_missing')
    return { isComplete: false, reasons, completeMarker: null }
  }

  if (existsSync(join(snapDir, BACKUP_SNAPSHOT_IN_PROGRESS_FILE))) {
    reasons.push('in_progress_marker_present')
  }

  const completePath = join(snapDir, BACKUP_SNAPSHOT_COMPLETE_FILE)
  let completeMarker: BackupSnapshotCompleteMarkerV1 | null = null
  if (!existsSync(completePath)) {
    reasons.push('completion_marker_missing')
  } else {
    try {
      completeMarker = BackupSnapshotCompleteMarkerV1Schema.parse(
        JSON.parse(readFileSync(completePath, 'utf8'))
      )
      if (completeMarker.snapshotId !== snapshotId) {
        reasons.push('completion_marker_invalid')
      }
      if (repoIdentity && completeMarker.repositoryId !== repoIdentity.repositoryId) {
        reasons.push('completion_marker_invalid')
      }
    } catch {
      reasons.push('completion_marker_invalid')
    }
  }

  const manifestPath = join(snapDir, BACKUP_SNAPSHOT_MANIFEST_FILE)
  let manifest: BackupSnapshotManifestV1 | null = null
  if (!existsSync(manifestPath)) {
    reasons.push('manifest_missing')
  } else {
    try {
      const rawBytes = readFileSync(manifestPath)
      const actualSha = sha256Hex(rawBytes)
      manifest = BackupSnapshotManifestV1Schema.parse(JSON.parse(rawBytes.toString('utf8')))
      if (manifest.snapshotId !== snapshotId) {
        reasons.push('manifest_invalid')
      }
      if (
        completeMarker &&
        actualSha.toLowerCase() !== completeMarker.manifestSha256.toLowerCase()
      ) {
        reasons.push('manifest_hash_mismatch')
      }
    } catch {
      reasons.push('manifest_invalid')
    }
  }

  if (manifest) {
    const seenObjectIds = new Set<string>()
    for (const chunk of collectManifestChunks(manifest)) {
      const lower = chunk.objectId.toLowerCase()
      if (seenObjectIds.has(lower)) continue
      seenObjectIds.add(lower)
      const objPath = join(backupRepoDir, BACKUP_OBJECTS_DIR, lower.slice(0, 2), `${lower}.pvchunk`)
      if (!existsSync(objPath)) {
        if (!reasons.includes('missing_object')) {
          reasons.push('missing_object')
        }
      } else if (statSync(objPath).size !== chunk.storedByteSize) {
        if (!reasons.includes('object_size_mismatch')) {
          reasons.push('object_size_mismatch')
        }
      }
    }
  }

  return {
    isComplete: reasons.length === 0,
    reasons,
    completeMarker
  }
}

interface TransferChunkContext {
  readonly jobId: string
  readonly transport: LocalFsTransport
  readonly codec: BackupObjectCodec
  readonly signal?: AbortSignal
  readonly uploadedInThisRun: Map<string, BackupChunkRef>
  readonly onChunkVerified?: (chunk: BackupChunkRef, action: 'written' | 'reused') => void
  writtenChunkCount: number
  reusedChunkCount: number
}

async function writeAndVerifyChunkWithRetry(
  ctx: TransferChunkContext,
  objectId: string,
  storedBytes: Buffer,
  plaintextSha256: string,
  replaceIfCorrupt: boolean
): Promise<void> {
  const maxAttempts = 2
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ctx.transport.writeObjectAtomic(objectId, storedBytes, ctx.jobId, {
        replaceIfCorrupt: replaceIfCorrupt || attempt > 1,
        signal: ctx.signal
      })
      const readBack = await ctx.transport.readObject(objectId, ctx.signal)
      await ctx.codec.decodeChunk(readBack, objectId, plaintextSha256)
      return
    } catch (err) {
      lastErr = err
      if (ctx.signal?.aborted) throw err
      if (
        err instanceof BackupSnapshotError &&
        err.code !== 'destination_unavailable' &&
        err.code !== 'destination_write_failed'
      ) {
        throw err
      }
    }
  }
  throw lastErr
}

async function processFileInChunks(
  ctx: TransferChunkContext,
  sourceAbsPath: string,
  logicalPath: string,
  expectedByteSize: number,
  expectedSha256: string,
  isVaultPayload = false
): Promise<BackupFileEntry> {
  const integrityErrorCode = isVaultPayload
    ? 'source_vault_integrity_error'
    : 'backup_staging_error'
  if (expectedByteSize === 0) {
    return {
      logicalPath,
      byteSize: 0,
      sha256: EMPTY_SHA256_HEX,
      chunks: []
    }
  }

  const chunks: BackupChunkRef[] = []
  const fileHash = createHash('sha256')
  let handle
  try {
    handle = await open(sourceAbsPath, 'r')
  } catch (err) {
    throw new BackupSnapshotError(
      integrityErrorCode,
      `Failed to open "${logicalPath}": ${(err as Error).message}`
    )
  }
  try {
    let offset = 0
    let chunkIndex = 0
    while (offset < expectedByteSize) {
      if (ctx.signal?.aborted) {
        throw new BackupSnapshotError('backup_cancelled', 'Backup cancelled')
      }
      const chunkLen = Math.min(BACKUP_CHUNK_SIZE_BYTES, expectedByteSize - offset)
      const buf = Buffer.allocUnsafe(chunkLen)
      let readTotal = 0
      while (readTotal < chunkLen) {
        const { bytesRead } = await handle.read(
          buf,
          readTotal,
          chunkLen - readTotal,
          offset + readTotal
        )
        if (bytesRead <= 0) break
        readTotal += bytesRead
      }
      if (readTotal !== chunkLen) {
        throw new BackupSnapshotError(
          integrityErrorCode,
          `Unexpected EOF reading "${sourceAbsPath}" at offset ${offset}`
        )
      }

      fileHash.update(buf)
      const plaintextSha256 = sha256Hex(buf)
      if (
        expectedByteSize <= BACKUP_CHUNK_SIZE_BYTES &&
        plaintextSha256.toLowerCase() !== expectedSha256.toLowerCase()
      ) {
        throw new BackupSnapshotError(
          integrityErrorCode,
          `File "${logicalPath}" changed after snapshot capture`
        )
      }
      const encoded = await ctx.codec.encodeChunk(buf, plaintextSha256)
      const objectId = encoded.objectId.toLowerCase()

      const cachedInRun = ctx.uploadedInThisRun.get(objectId)
      if (cachedInRun) {
        chunks.push({ ...cachedInRun, index: chunkIndex })
        offset += chunkLen
        chunkIndex++
        continue
      }

      const existing = await ctx.transport.statObject(objectId)
      let reused = false
      let replaceCorrupt = false

      if (existing.exists && existing.byteSize === encoded.storedBytes.length) {
        try {
          const readBack = await ctx.transport.readObject(objectId, ctx.signal)
          await ctx.codec.decodeChunk(readBack, objectId, plaintextSha256)
          reused = true
          ctx.reusedChunkCount++
        } catch (err) {
          if (
            ctx.signal?.aborted ||
            (err instanceof BackupSnapshotError && err.code === 'backup_cancelled')
          ) {
            throw err
          }
          replaceCorrupt = true
        }
      } else if (existing.exists) {
        replaceCorrupt = true
      }

      if (!reused) {
        await writeAndVerifyChunkWithRetry(
          ctx,
          objectId,
          encoded.storedBytes,
          plaintextSha256,
          replaceCorrupt
        )
        ctx.writtenChunkCount++
      }

      const ref: BackupChunkRef = {
        objectId,
        index: chunkIndex,
        plaintextByteSize: chunkLen,
        storedByteSize: encoded.storedBytes.length,
        plaintextSha256
      }
      ctx.uploadedInThisRun.set(objectId, ref)
      ctx.onChunkVerified?.(ref, reused ? 'reused' : 'written')
      chunks.push(ref)
      offset += chunkLen
      chunkIndex++
    }
  } finally {
    await handle.close()
  }

  const actualFileSha = fileHash.digest('hex')
  if (actualFileSha.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new BackupSnapshotError(
      integrityErrorCode,
      `File SHA-256 mismatch while chunking "${logicalPath}": expected ${expectedSha256}, got ${actualFileSha}`
    )
  }

  return {
    logicalPath,
    byteSize: expectedByteSize,
    sha256: expectedSha256.toLowerCase(),
    chunks
  }
}

async function sha256StreamFile(filePath: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256')
  const handle = await open(filePath, 'r')
  let total = 0
  try {
    const buf = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead <= 0) break
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
      total += bytesRead
    }
  } finally {
    await handle.close()
  }
  return { sha256: hash.digest('hex'), byteSize: total }
}

async function assertStagedFileMatches(
  filePath: string,
  expectedByteSize: number,
  expectedSha256: string,
  label: string
): Promise<void> {
  if (!existsSync(filePath)) {
    throw new BackupSnapshotError(
      'backup_staging_error',
      `Staged ${label} is missing: "${filePath}"`
    )
  }
  const st = statSync(filePath)
  if (st.size !== expectedByteSize) {
    throw new BackupSnapshotError(
      'backup_staging_error',
      `Staged ${label} size mismatch: expected ${expectedByteSize}, got ${st.size}`
    )
  }
  const actual = await sha256StreamFile(filePath)
  if (actual.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new BackupSnapshotError('backup_staging_error', `Staged ${label} SHA-256 mismatch`)
  }
}

export interface VerifyCapturedStagingOptions {
  readonly jobId: string
  readonly snapshotId: string
  readonly stagingDir: string
  readonly userDataDir: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
}

export async function verifyCapturedStagingIntegrity(
  options: VerifyCapturedStagingOptions
): Promise<CaptureConsistentBackupSnapshotResult> {
  const canonicalStagingDir = validateBackupStagingDir({
    stagingDir: options.stagingDir,
    userDataDir: options.userDataDir,
    sourceRoots: options.sourceRoots,
    vaultRoots: options.vaultRoots
  })

  const stagingManifestPath = join(canonicalStagingDir, 'staging-manifest.json')
  if (!existsSync(stagingManifestPath)) {
    throw new BackupSnapshotError(
      'backup_staging_error',
      `Missing staging-manifest.json in "${canonicalStagingDir}"`
    )
  }

  let sm: BackupStagingManifestV1
  try {
    sm = BackupStagingManifestV1Schema.parse(JSON.parse(readFileSync(stagingManifestPath, 'utf8')))
  } catch (err) {
    throw new BackupSnapshotError(
      'backup_staging_error',
      `Invalid staging-manifest.json: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (sm.jobId !== options.jobId || sm.snapshotId !== options.snapshotId) {
    throw new BackupSnapshotError(
      'backup_staging_error',
      `Staging manifest identity mismatch: expected (${options.jobId}, ${options.snapshotId}), got (${sm.jobId}, ${sm.snapshotId})`
    )
  }

  const stagedCatalogPath = join(canonicalStagingDir, sm.catalog.stagedRelativePath)
  await assertStagedFileMatches(
    stagedCatalogPath,
    sm.catalog.byteSize,
    sm.catalog.sha256,
    'vault-catalog.sqlite'
  )

  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(stagedCatalogPath, { readOnly: true, timeout: 5000 })
    const integrity = db.prepare('PRAGMA integrity_check;').get() as
      { integrity_check?: string } | undefined
    if (integrity?.integrity_check !== 'ok') {
      throw new BackupSnapshotError(
        'backup_staging_error',
        `Staged SQLite PRAGMA integrity_check failed: ${integrity?.integrity_check ?? 'unknown'}`
      )
    }
    const fkRows = db.prepare('PRAGMA foreign_key_check;').all()
    if (fkRows.length > 0) {
      throw new BackupSnapshotError(
        'backup_staging_error',
        `Staged SQLite PRAGMA foreign_key_check failed with ${fkRows.length} violation(s)`
      )
    }
  } catch (err) {
    if (err instanceof BackupSnapshotError) throw err
    throw new BackupSnapshotError(
      'backup_staging_error',
      `Failed to verify staged SQLite database: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }

  if (sm.annotations) {
    await assertStagedFileMatches(
      join(canonicalStagingDir, sm.annotations.ownerMarkerRelativePath),
      sm.annotations.ownerMarkerByteSize,
      sm.annotations.ownerMarkerSha256,
      '.pv_annotations_owner'
    )
    await assertStagedFileMatches(
      join(canonicalStagingDir, sm.annotations.journalRelativePath),
      sm.annotations.journalByteSize,
      sm.annotations.journalSha256,
      'review-journal.jsonl'
    )
  }

  if (sm.vault) {
    await assertStagedFileMatches(
      join(canonicalStagingDir, sm.vault.identityRelativePath),
      sm.vault.identityByteSize,
      sm.vault.identitySha256,
      'vault.json'
    )
    for (const copy of sm.vault.copies) {
      await assertStagedFileMatches(
        join(canonicalStagingDir, copy.stagedManifestRelativePath),
        copy.manifestByteSize,
        copy.manifestSha256,
        `staged manifest (${copy.sourceManifestRelativePath})`
      )
      await assertStagedFileMatches(
        join(sm.vault.sourceVaultPath, copy.sourcePayloadRelativePath),
        copy.byteSize,
        copy.sha256,
        `source vault payload (${copy.sourcePayloadRelativePath})`
      )
    }
  }

  return {
    canonicalStagingDir,
    stagingManifestPath,
    stagingManifest: sm
  }
}

export async function runLocalBackup(
  options: RunLocalBackupOptions,
  hooks?: LocalBackupTestHooks
): Promise<RunLocalBackupResult> {
  const canonicalDest = validateBackupDestinationPath({
    destinationDir: options.backupRepoDir,
    sourceRoots: options.sourceRoots,
    vaultRoots: options.vaultRoots,
    userDataDir: options.userDataDir
  })

  const stagingDir = join(options.userDataDir, '.backup-staging', options.jobId)
  const captured = await captureConsistentBackupSnapshot({
    jobId: options.jobId,
    snapshotId: options.snapshotId,
    catalogPath: options.catalogPath,
    annotationsDir: options.annotationsDir,
    stagingDir,
    userDataDir: options.userDataDir,
    sourceRoots: options.sourceRoots,
    vaultRoots: options.vaultRoots,
    workerScriptPath: options.workerScriptPath,
    appPath: options.appPath,
    isPackaged: options.isPackaged
  })

  await hooks?.onAfterSnapshotCapture?.(options.snapshotId)

  return executeTransferFromStaging(options, canonicalDest, captured, false, hooks)
}

export async function resumeLocalBackupFromStaging(
  options: RunLocalBackupOptions,
  captured: CaptureConsistentBackupSnapshotResult,
  hooks?: LocalBackupTestHooks
): Promise<RunLocalBackupResult> {
  const canonicalDest = validateBackupDestinationPath({
    destinationDir: options.backupRepoDir,
    sourceRoots: options.sourceRoots,
    vaultRoots: options.vaultRoots,
    userDataDir: options.userDataDir
  })

  return executeTransferFromStaging(options, canonicalDest, captured, true, hooks)
}

async function executeTransferFromStaging(
  options: RunLocalBackupOptions,
  canonicalDest: string,
  captured: CaptureConsistentBackupSnapshotResult,
  isResume: boolean,
  hooks?: LocalBackupTestHooks
): Promise<RunLocalBackupResult> {
  const codec = options.codec ?? new PlaintextObjectCodec()
  const transport = new LocalFsTransport({
    repositoryDir: canonicalDest,
    rateLimiter: options.rateLimiter,
    hooks
  })

  await transport.ensureRepositoryLayout()
  let repoIdentity = await transport.readRepositoryIdentity()
  if (!repoIdentity) {
    repoIdentity = {
      formatVersion: BACKUP_FORMAT_VERSION,
      repositoryId: randomUUID(),
      createdAtMs: Date.now(),
      appVersion: options.appVersion,
      chunkSizeBytes: BACKUP_CHUNK_SIZE_BYTES,
      encryptionMode: codec.encryptionMode,
      encryption: null
    }
    await transport.writeRepositoryIdentity(repoIdentity, options.signal)
  } else if (repoIdentity.encryptionMode !== codec.encryptionMode) {
    throw new BackupSnapshotError(
      'destination_corrupt',
      `Repository encryptionMode "${repoIdentity.encryptionMode}" does not match codec "${codec.encryptionMode}"`
    )
  }

  options.onRepositoryResolved?.(repoIdentity.repositoryId)

  const marker: BackupSnapshotInProgressMarkerV1 = {
    formatVersion: BACKUP_FORMAT_VERSION,
    schema: 'pv_backup_in_progress_v1',
    jobId: options.jobId,
    snapshotId: options.snapshotId,
    repositoryId: repoIdentity.repositoryId,
    startedAtMs: Date.now()
  }

  if (isResume) {
    await transport.claimOrResumeSnapshotInProgress(options.snapshotId, marker, options.signal)
  } else {
    await transport.writeSnapshotInProgress(options.snapshotId, marker, options.signal)
  }

  const ctx: TransferChunkContext = {
    jobId: options.jobId,
    transport,
    codec,
    signal: options.signal,
    uploadedInThisRun: new Map(),
    onChunkVerified: options.onChunkVerified,
    writtenChunkCount: 0,
    reusedChunkCount: 0
  }

  const sm = captured.stagingManifest
  const catalogFile = await processFileInChunks(
    ctx,
    join(captured.canonicalStagingDir, sm.catalog.stagedRelativePath),
    'catalog/vault-catalog.sqlite',
    sm.catalog.byteSize,
    sm.catalog.sha256
  )

  let annotations: BackupSnapshotManifestV1['annotations'] = null
  if (sm.annotations) {
    const ownerMarkerFile = await processFileInChunks(
      ctx,
      join(captured.canonicalStagingDir, sm.annotations.ownerMarkerRelativePath),
      'annotations/.pv_annotations_owner',
      sm.annotations.ownerMarkerByteSize,
      sm.annotations.ownerMarkerSha256
    )
    const journalFile = await processFileInChunks(
      ctx,
      join(captured.canonicalStagingDir, sm.annotations.journalRelativePath),
      'annotations/review-journal.jsonl',
      sm.annotations.journalByteSize,
      sm.annotations.journalSha256
    )
    annotations = {
      ownerMarkerFile,
      journalFile,
      cutSeq: sm.annotations.cutSeq,
      requiredJournalSeq: sm.annotations.requiredJournalSeq
    }
  }

  let vault: BackupSnapshotManifestV1['vault'] = null
  if (sm.vault) {
    const identityFile = await processFileInChunks(
      ctx,
      join(captured.canonicalStagingDir, sm.vault.identityRelativePath),
      'vault/vault.json',
      sm.vault.identityByteSize,
      sm.vault.identitySha256
    )
    const copies: NonNullable<BackupSnapshotManifestV1['vault']>['copies'] = []
    for (const copy of sm.vault.copies) {
      const payloadFile = await processFileInChunks(
        ctx,
        join(sm.vault.sourceVaultPath, copy.sourcePayloadRelativePath),
        `vault/${copy.sourcePayloadRelativePath}`,
        copy.byteSize,
        copy.sha256,
        true
      )
      const manifestFile = await processFileInChunks(
        ctx,
        join(captured.canonicalStagingDir, copy.stagedManifestRelativePath),
        `vault/${copy.sourceManifestRelativePath}`,
        copy.manifestByteSize,
        copy.manifestSha256
      )
      copies.push({
        sha256: copy.sha256,
        byteSize: copy.byteSize,
        payloadRelativePath: copy.sourcePayloadRelativePath,
        manifestRelativePath: copy.sourceManifestRelativePath,
        payloadFile,
        manifestFile
      })
    }
    vault = {
      vaultId: sm.vault.vaultId,
      vaultName: sm.vault.vaultName,
      identityFile,
      copies
    }
  }

  const snapshotManifest: BackupSnapshotManifestV1 = BackupSnapshotManifestV1Schema.parse({
    formatVersion: BACKUP_FORMAT_VERSION,
    snapshotId: options.snapshotId,
    repositoryId: repoIdentity.repositoryId,
    createdAtMs: sm.capturedAtMs,
    appVersion: options.appVersion,
    schemaVersion: sm.schemaVersion,
    excludesUnimportedOriginals: true,
    catalogFile,
    annotations,
    vault
  })

  const manifestBytes = Buffer.from(JSON.stringify(snapshotManifest, null, 2), 'utf8')
  const manifestSha256 = sha256Hex(manifestBytes)

  await transport.writeSnapshotManifest(
    options.snapshotId,
    manifestBytes,
    options.jobId,
    options.signal
  )

  const readBackManifest = await transport.readSnapshotManifest(options.snapshotId, options.signal)
  if (!readBackManifest || sha256Hex(readBackManifest) !== manifestSha256) {
    throw new BackupSnapshotError(
      'destination_corrupt',
      'Snapshot manifest read-back SHA-256 verification failed'
    )
  }

  let totalLogicalBytes = 0
  let totalStoredBytes = 0
  for (const chunk of ctx.uploadedInThisRun.values()) {
    totalLogicalBytes += chunk.plaintextByteSize
    totalStoredBytes += chunk.storedByteSize
  }

  const verificationScope: BackupVerificationScope = 'full_readback'

  await transport.writeSnapshotCompleteMarker(
    options.snapshotId,
    {
      formatVersion: BACKUP_FORMAT_VERSION,
      schema: 'pv_backup_complete_v1',
      snapshotId: options.snapshotId,
      repositoryId: repoIdentity.repositoryId,
      encryptionMode: codec.encryptionMode,
      manifestObjectId: null,
      manifestSha256,
      totalObjectCount: ctx.uploadedInThisRun.size,
      totalLogicalBytes,
      totalStoredBytes,
      verificationScope,
      completedAtMs: Date.now()
    },
    options.signal
  )

  await transport.removeSnapshotInProgress(options.snapshotId)
  await transport.cleanupTempDir()

  // Clean up local staging only after terminal completion
  try {
    rmSync(captured.canonicalStagingDir, { recursive: true, force: true })
  } catch {
    // best-effort staging cleanup
  }

  return {
    repositoryId: repoIdentity.repositoryId,
    snapshotId: options.snapshotId,
    verificationScope,
    writtenChunkCount: ctx.writtenChunkCount,
    reusedChunkCount: ctx.reusedChunkCount,
    totalObjectCount: ctx.uploadedInThisRun.size,
    totalLogicalBytes,
    totalStoredBytes,
    manifestSha256
  }
}
