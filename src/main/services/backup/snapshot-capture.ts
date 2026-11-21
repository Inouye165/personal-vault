/**
 * Personal Vault — Stage 8B Sub-slice 1A-1: Consistent Backup Snapshot Capture
 *
 * Orchestrates off-main SQLite `VACUUM INTO` snapshot capture, fail-closed
 * `AnnotationJournal` watermark truncation, and single-read active vault
 * manifest/file verification with concurrent-import skew detection.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  BackupStagingManifestV1Schema,
  type BackupStagedVaultCopy,
  type BackupStagingManifestV1
} from '../../../shared/validation/backup-schemas'
import {
  AnnotationJournalEntrySchema,
  VaultIdentitySchema
} from '../../../shared/validation/ipc-schemas'
import { MAX_JOURNAL_RECORD_BYTES } from '../annotations/journal'
import { assertPathContainedInVault } from '../vault/containment'
import { VaultManifestSchema } from '../vault/manifest-schema'
import { resolveMainWorkerScriptPath } from '../worker-path'
import { validateBackupStagingDir } from './containment'
import { BackupSnapshotError } from './errors'
import type {
  BackupSnapshotWorkerData,
  BackupSnapshotWorkerMessage,
  BackupSnapshotWorkerSuccessResult
} from './snapshot-worker'

export interface CaptureConsistentBackupSnapshotOptions {
  readonly jobId: string
  readonly snapshotId: string
  readonly catalogPath: string
  readonly annotationsDir: string
  readonly stagingDir: string
  readonly userDataDir: string
  readonly sourceRoots: readonly string[]
  readonly vaultRoots: readonly string[]
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
}

export interface BackupSnapshotTestHooks {
  readonly onAfterSqliteSnapshot?: () => Promise<void> | void
  readonly onBeforeManifestRead?: (sha256: string) => Promise<void> | void
}

export interface CaptureConsistentBackupSnapshotResult {
  readonly canonicalStagingDir: string
  readonly stagingManifestPath: string
  readonly stagingManifest: BackupStagingManifestV1
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function writeBufferSyncFsync(targetPath: string, data: Buffer): void {
  const fd = openSync(targetPath, 'wx')
  try {
    let offset = 0
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset)
      if (written <= 0) break
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeStagingManifestAtomically(
  stagingDir: string,
  manifest: BackupStagingManifestV1
): string {
  const validated = BackupStagingManifestV1Schema.parse(manifest)
  const targetPath = join(stagingDir, 'staging-manifest.json')
  const tempPath = join(stagingDir, `.staging-manifest.${randomUUID()}.tmp`)
  const bytes = Buffer.from(JSON.stringify(validated, null, 2), 'utf8')
  try {
    writeBufferSyncFsync(tempPath, bytes)
    renameSync(tempPath, targetPath)
    return targetPath
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // ignore cleanup
    }
    throw err
  }
}

function runSnapshotWorker(
  workerScriptPath: string,
  data: BackupSnapshotWorkerData
): Promise<BackupSnapshotWorkerSuccessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const worker = new Worker(workerScriptPath, { workerData: data })

    worker.on('message', (msg: BackupSnapshotWorkerMessage) => {
      if (settled) return
      settled = true
      if (msg.ok) {
        resolvePromise(msg.result)
      } else {
        rejectPromise(new BackupSnapshotError('snapshot_sqlite_error', msg.errorMessage))
      }
    })

    worker.on('error', (err) => {
      if (settled) return
      settled = true
      rejectPromise(
        new BackupSnapshotError(
          'snapshot_sqlite_error',
          `Snapshot worker error: ${err instanceof Error ? err.message : String(err)}`
        )
      )
    })

    worker.on('exit', (code) => {
      if (settled) return
      settled = true
      rejectPromise(
        new BackupSnapshotError(
          'snapshot_sqlite_error',
          `Snapshot worker exited unexpectedly with code ${code}`
        )
      )
    })
  })
}

async function captureAndVerifyJournal(options: {
  readonly annotationsDir: string
  readonly stagedAnnotationsDir: string
  readonly requiredJournalSeq: number
  readonly snapshotJournalOpIds: readonly string[]
}): Promise<BackupStagingManifestV1['annotations']> {
  const ownerMarkerSrc = join(options.annotationsDir, '.pv_annotations_owner')
  const journalSrc = join(options.annotationsDir, 'review-journal.jsonl')

  const ownerExists = existsSync(ownerMarkerSrc)
  const journalExists = existsSync(journalSrc)
  const expectsEntries = options.requiredJournalSeq > 0 || options.snapshotJournalOpIds.length > 0

  if (expectsEntries && (!ownerExists || !journalExists)) {
    throw new BackupSnapshotError(
      'journal_corruption_error',
      'Annotation journal or ownership marker is missing while SQLite catalog expects committed journal entries'
    )
  }

  if (!ownerExists && !journalExists) {
    return null
  }

  if (!ownerExists && journalExists) {
    throw new BackupSnapshotError(
      'journal_corruption_error',
      'Annotation journal exists without .pv_annotations_owner marker'
    )
  }

  if (lstatSync(ownerMarkerSrc).isSymbolicLink()) {
    throw new BackupSnapshotError(
      'journal_corruption_error',
      'Annotation ownership marker cannot be a symbolic link'
    )
  }

  let ownerBuf: Buffer
  try {
    ownerBuf = readFileSync(ownerMarkerSrc)
    const parsed = JSON.parse(ownerBuf.toString('utf8')) as {
      app?: unknown
      format?: unknown
    }
    if (parsed?.app !== 'personal-vault' || parsed?.format !== 'personal-vault-review-journal') {
      throw new Error('Unexpected ownership marker contents')
    }
  } catch (err) {
    throw new BackupSnapshotError(
      'journal_corruption_error',
      `Invalid annotation ownership marker: ${(err as Error).message}`
    )
  }

  if (!journalExists) {
    throw new BackupSnapshotError(
      'journal_corruption_error',
      'Annotation ownership marker exists without review-journal.jsonl'
    )
  }

  if (lstatSync(journalSrc).isSymbolicLink()) {
    throw new BackupSnapshotError(
      'journal_corruption_error',
      'Annotation journal cannot be a symbolic link'
    )
  }

  mkdirSync(options.stagedAnnotationsDir, { recursive: true })
  const stagedOwnerPath = join(options.stagedAnnotationsDir, '.pv_annotations_owner')
  writeBufferSyncFsync(stagedOwnerPath, ownerBuf)

  const snapshotOpSet = new Set(options.snapshotJournalOpIds)
  const retainedLines: string[] = []
  let expectedSeq = 1
  let highestContiguousSeq = 0
  let cutSeq = 0
  let stoppedAtWatermark = false

  const fileHandle = await open(journalSrc, 'r')
  try {
    const stat = await fileHandle.stat()
    const totalSize = stat.size
    const CHUNK_SIZE = 64 * 1024
    const buffer = Buffer.alloc(CHUNK_SIZE)
    let fileOffset = 0
    let remainderBuf = Buffer.alloc(0)
    let lineNumber = 0

    while (fileOffset < totalSize && !stoppedAtWatermark) {
      const { bytesRead } = await fileHandle.read(buffer, 0, CHUNK_SIZE, fileOffset)
      if (bytesRead === 0) break
      fileOffset += bytesRead

      const chunkBuf = buffer.subarray(0, bytesRead)
      const combinedBuf =
        remainderBuf.length > 0 ? Buffer.concat([remainderBuf, chunkBuf]) : chunkBuf

      let lineStart = 0
      while (true) {
        const newlineIdx = combinedBuf.indexOf(0x0a, lineStart)
        if (newlineIdx === -1) {
          remainderBuf = Buffer.from(combinedBuf.subarray(lineStart))
          if (remainderBuf.length > MAX_JOURNAL_RECORD_BYTES) {
            throw new BackupSnapshotError(
              'journal_corruption_error',
              `Journal record exceeds ${MAX_JOURNAL_RECORD_BYTES} bytes`
            )
          }
          break
        }

        const lineLength = newlineIdx - lineStart
        if (lineLength > MAX_JOURNAL_RECORD_BYTES) {
          throw new BackupSnapshotError(
            'journal_corruption_error',
            `Journal record exceeds ${MAX_JOURNAL_RECORD_BYTES} bytes`
          )
        }

        const lineStr = combinedBuf.subarray(lineStart, newlineIdx).toString('utf8').trim()
        lineStart = newlineIdx + 1

        if (!lineStr) {
          continue
        }

        lineNumber++
        let parsedObj: unknown
        try {
          parsedObj = JSON.parse(lineStr)
        } catch {
          throw new BackupSnapshotError(
            'journal_corruption_error',
            `Interior corruption in review-journal.jsonl at line ${lineNumber}`
          )
        }

        const parseRes = AnnotationJournalEntrySchema.safeParse(parsedObj)
        if (!parseRes.success) {
          throw new BackupSnapshotError(
            'journal_corruption_error',
            `Schema validation failed in review-journal.jsonl at line ${lineNumber}`
          )
        }

        const entry = parseRes.data
        if (entry.entrySeq !== expectedSeq) {
          throw new BackupSnapshotError(
            'journal_corruption_error',
            `Sequence disorder in review-journal.jsonl at line ${lineNumber} (expected ${expectedSeq}, got ${entry.entrySeq})`
          )
        }

        expectedSeq++
        highestContiguousSeq = entry.entrySeq

        if (entry.entrySeq <= options.requiredJournalSeq) {
          retainedLines.push(lineStr)
          cutSeq = entry.entrySeq
        } else {
          const isTerminalForSnapshotOp =
            (entry.kind === 'op_committed' || entry.kind === 'op_aborted') &&
            (snapshotOpSet.has(entry.opId) || entry.targetSeq <= options.requiredJournalSeq)
          if (isTerminalForSnapshotOp) {
            retainedLines.push(lineStr)
            cutSeq = entry.entrySeq
          } else {
            stoppedAtWatermark = true
            break
          }
        }
      }
    }
    // Note: any trailing partial line without '\n' in remainderBuf is dropped as an in-flight EOF write.
  } finally {
    await fileHandle.close()
  }

  if (highestContiguousSeq < options.requiredJournalSeq) {
    throw new BackupSnapshotError(
      'journal_corruption_error',
      `Annotation journal ended at seq ${highestContiguousSeq}, before required SQLite watermark ${options.requiredJournalSeq}`
    )
  }

  const stagedJournalBuf = Buffer.from(
    retainedLines.length > 0 ? `${retainedLines.join('\n')}\n` : '',
    'utf8'
  )
  const stagedJournalPath = join(options.stagedAnnotationsDir, 'review-journal.jsonl')
  writeBufferSyncFsync(stagedJournalPath, stagedJournalBuf)

  return {
    ownerMarkerRelativePath: 'annotations/.pv_annotations_owner',
    ownerMarkerSha256: sha256Buffer(ownerBuf),
    ownerMarkerByteSize: ownerBuf.length,
    journalRelativePath: 'annotations/review-journal.jsonl',
    journalSha256: sha256Buffer(stagedJournalBuf),
    journalByteSize: stagedJournalBuf.length,
    cutSeq,
    requiredJournalSeq: options.requiredJournalSeq
  }
}

async function verifyVaultPayloadReadOnly(
  vaultPath: string,
  relativePath: string,
  expectedSha256: string,
  expectedByteSize: number
): Promise<void> {
  const absPath = join(vaultPath, relativePath)
  assertPathContainedInVault(vaultPath, absPath, 'vault payload file')

  let handle
  try {
    handle = await open(absPath, 'r')
  } catch (err) {
    throw new BackupSnapshotError(
      'source_vault_integrity_error',
      `Vault file missing or unreadable at "${relativePath}": ${(err as Error).message}`
    )
  }

  try {
    const preStat = await handle.stat()
    if (!preStat.isFile()) {
      throw new BackupSnapshotError(
        'source_vault_integrity_error',
        `Vault payload "${relativePath}" is not a regular file`
      )
    }
    if (preStat.size !== expectedByteSize) {
      throw new BackupSnapshotError(
        'source_vault_integrity_error',
        `Vault payload "${relativePath}" size mismatch: expected ${expectedByteSize}, got ${preStat.size}`
      )
    }

    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(64 * 1024)
    let totalRead = 0
    let offset = 0
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
      if (bytesRead === 0) break
      hash.update(buf.subarray(0, bytesRead))
      totalRead += bytesRead
      offset += bytesRead
    }

    const postStat = await handle.stat()
    if (postStat.size !== preStat.size || postStat.mtimeMs !== preStat.mtimeMs) {
      throw new BackupSnapshotError(
        'source_vault_integrity_error',
        `Vault payload "${relativePath}" changed during verification`
      )
    }

    const actualSha = hash.digest('hex')
    if (
      totalRead !== expectedByteSize ||
      actualSha.toLowerCase() !== expectedSha256.toLowerCase()
    ) {
      throw new BackupSnapshotError(
        'source_vault_integrity_error',
        `Vault payload "${relativePath}" SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha}`
      )
    }
  } finally {
    await handle.close()
  }
}

async function captureAndVerifyActiveVault(options: {
  readonly stagingDir: string
  readonly workerResult: BackupSnapshotWorkerSuccessResult
  readonly hooks?: BackupSnapshotTestHooks
}): Promise<BackupStagingManifestV1['vault']> {
  const { activeVault, vaultCopies, importJobIds, importItems } = options.workerResult
  if (!activeVault) {
    return null
  }

  const vaultPath = activeVault.vaultPath
  const identitySrcPath = join(vaultPath, 'vault.json')
  try {
    assertPathContainedInVault(vaultPath, identitySrcPath, 'vault.json')
  } catch (err) {
    throw new BackupSnapshotError(
      'source_vault_integrity_error',
      `Vault containment check failed: ${(err as Error).message}`
    )
  }

  let identityBuf: Buffer
  try {
    identityBuf = readFileSync(identitySrcPath)
    const parsed = VaultIdentitySchema.parse(JSON.parse(identityBuf.toString('utf8')))
    if (parsed.vaultId !== activeVault.vaultId) {
      throw new Error(`vaultId mismatch: expected ${activeVault.vaultId}, got ${parsed.vaultId}`)
    }
  } catch (err) {
    throw new BackupSnapshotError(
      'source_vault_integrity_error',
      `Active vault identity invalid or missing: ${(err as Error).message}`
    )
  }

  const stagedIdentityPath = join(options.stagingDir, 'vault.json')
  writeBufferSyncFsync(stagedIdentityPath, identityBuf)

  const manifestsDir = join(options.stagingDir, 'manifests')
  mkdirSync(manifestsDir, { recursive: true })

  const importJobSet = new Set(importJobIds)
  const importItemMap = new Map(
    importItems.map((it) => [`${it.importJobId}:${it.fileLocationId}`, it])
  )
  const stagedCopies: BackupStagedVaultCopy[] = []

  for (const copy of vaultCopies) {
    await verifyVaultPayloadReadOnly(vaultPath, copy.relativePath, copy.sha256, copy.byteSize)

    await options.hooks?.onBeforeManifestRead?.(copy.sha256)

    const manifestSrcPath = join(vaultPath, copy.manifestRelativePath)
    try {
      assertPathContainedInVault(vaultPath, manifestSrcPath, 'manifest.json')
    } catch (err) {
      throw new BackupSnapshotError(
        'source_vault_integrity_error',
        `Manifest containment check failed: ${(err as Error).message}`
      )
    }

    let manifestBuf: Buffer
    let parsedManifest
    try {
      manifestBuf = readFileSync(manifestSrcPath)
      parsedManifest = VaultManifestSchema.parse(JSON.parse(manifestBuf.toString('utf8')))
      if (parsedManifest.sha256.toLowerCase() !== copy.sha256.toLowerCase()) {
        throw new Error(
          `manifest.sha256 "${parsedManifest.sha256}" does not match "${copy.sha256}"`
        )
      }
      if (parsedManifest.vaultId !== activeVault.vaultId) {
        throw new Error(
          `manifest.vaultId "${parsedManifest.vaultId}" does not match "${activeVault.vaultId}"`
        )
      }
    } catch (err) {
      throw new BackupSnapshotError(
        'source_vault_integrity_error',
        `Vault manifest corrupt or missing at "${copy.manifestRelativePath}": ${(err as Error).message}`
      )
    }

    // Detect concurrent duplicate-content import skew against staged T0 catalog
    for (const src of parsedManifest.sources) {
      const jobId = src.importResult.importJobId
      if (importJobSet.size > 0) {
        if (!importJobSet.has(jobId)) {
          throw new BackupSnapshotError(
            'source_vault_concurrent_modification',
            `Manifest "${copy.manifestRelativePath}" references post-snapshot import job "${jobId}"`
          )
        }
        const t0Item = importItemMap.get(`${jobId}:${src.fileLocationId}`)
        if (
          !t0Item ||
          t0Item.status !== 'completed' ||
          t0Item.discoveryObservationId !== src.recordedFacts.discoveryObservationId ||
          t0Item.sha256.toLowerCase() !== copy.sha256.toLowerCase()
        ) {
          throw new BackupSnapshotError(
            'source_vault_concurrent_modification',
            `Manifest "${copy.manifestRelativePath}" source (${jobId}:${src.fileLocationId}) is not completed in T0 catalog`
          )
        }
      } else if (src.importResult.importedAtMs > copy.updatedAtMs) {
        throw new BackupSnapshotError(
          'source_vault_concurrent_modification',
          `Manifest "${copy.manifestRelativePath}" timestamp exceeds T0 vault_copies.updated_at_ms`
        )
      }
    }

    const stagedManifestRel = `manifests/${copy.sha256}.manifest.json`
    const stagedManifestAbs = join(options.stagingDir, stagedManifestRel)
    writeBufferSyncFsync(stagedManifestAbs, manifestBuf)

    stagedCopies.push({
      sha256: copy.sha256,
      byteSize: copy.byteSize,
      sourcePayloadRelativePath: copy.relativePath,
      sourceManifestRelativePath: copy.manifestRelativePath,
      stagedManifestRelativePath: stagedManifestRel,
      manifestSha256: sha256Buffer(manifestBuf),
      manifestByteSize: manifestBuf.length
    })
  }

  return {
    vaultId: activeVault.vaultId,
    vaultName: activeVault.name,
    sourceVaultPath: vaultPath,
    identityRelativePath: 'vault.json',
    identitySha256: sha256Buffer(identityBuf),
    identityByteSize: identityBuf.length,
    copies: stagedCopies
  }
}

export async function captureConsistentBackupSnapshot(
  options: CaptureConsistentBackupSnapshotOptions,
  hooks?: BackupSnapshotTestHooks
): Promise<CaptureConsistentBackupSnapshotResult> {
  const canonicalStagingDir = validateBackupStagingDir({
    stagingDir: options.stagingDir,
    userDataDir: options.userDataDir,
    sourceRoots: options.sourceRoots,
    vaultRoots: options.vaultRoots
  })

  mkdirSync(canonicalStagingDir, { recursive: true })
  const stagingCatalogPath = join(canonicalStagingDir, 'vault-catalog.sqlite')
  if (
    existsSync(stagingCatalogPath) ||
    existsSync(join(canonicalStagingDir, 'staging-manifest.json'))
  ) {
    throw new BackupSnapshotError(
      'backup_staging_error',
      `Staging directory "${canonicalStagingDir}" already contains captured artifacts`
    )
  }

  const workerScriptPath = resolveMainWorkerScriptPath({
    workerFileName: 'backup_snapshot_worker.js',
    sourceEntryPath: resolve(__dirname, 'snapshot-worker.ts'),
    customPath: options.workerScriptPath,
    appPath: options.appPath,
    isPackaged: options.isPackaged,
    esbuildExternals: ['electron', 'esbuild']
  })

  const workerResult = await runSnapshotWorker(workerScriptPath, {
    catalogPath: options.catalogPath,
    stagingCatalogPath
  })

  await hooks?.onAfterSqliteSnapshot?.()

  const annotations = await captureAndVerifyJournal({
    annotationsDir: options.annotationsDir,
    stagedAnnotationsDir: join(canonicalStagingDir, 'annotations'),
    requiredJournalSeq: workerResult.requiredJournalSeq,
    snapshotJournalOpIds: workerResult.snapshotJournalOpIds
  })

  const vault = await captureAndVerifyActiveVault({
    stagingDir: canonicalStagingDir,
    workerResult,
    hooks
  })

  const stagingManifest: BackupStagingManifestV1 = {
    formatVersion: 1,
    schema: 'pv_backup_staging_v1',
    jobId: options.jobId,
    snapshotId: options.snapshotId,
    capturedAtMs: Date.now(),
    schemaVersion: workerResult.schemaVersion,
    excludesUnimportedOriginals: true,
    catalog: {
      stagedRelativePath: 'vault-catalog.sqlite',
      sha256: workerResult.catalogSha256,
      byteSize: workerResult.catalogByteSize
    },
    annotations,
    vault
  }

  const stagingManifestPath = writeStagingManifestAtomically(canonicalStagingDir, stagingManifest)

  return {
    canonicalStagingDir,
    stagingManifestPath,
    stagingManifest
  }
}
