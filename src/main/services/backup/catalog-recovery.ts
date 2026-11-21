/**
 * Personal Vault — Stage 8B Slice 2: Strict Catalog Recovery from Vault Manifests
 *
 * Rebuilds imported-file catalog records into a fresh, isolated profile from a
 * surviving vault's `vault.json`, `manifest.json` sidecars, and verified payloads.
 * Strictly read-only on `sourceVaultDir`; atomic staged publication with safe retry.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync
} from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  BACKUP_FORMAT_VERSION,
  CatalogRecoveryCompleteMarkerV1Schema,
  CatalogRecoveryInProgressMarkerV1Schema
} from '../../../shared/validation/backup-schemas'
import { CatalogDatabase } from '../catalog/database'
import type {
  RecoveredFileLocationEntry,
  RecoveredObservationEntry,
  RecoveredVaultCopyEntry
} from '../catalog/types'
import { normalizePathForLookup } from '../catalog/path-normalization'
import { assertPathContainedInVault } from '../vault/containment'
import { loadVaultIdentity } from '../vault/identity'
import { VaultManifestSchema } from '../vault/manifest-schema'
import { validateRestoreTargetPaths } from './containment'
import {
  BackupContainmentError,
  BackupRestoreError,
  CatalogRecoveryError,
  RecoveryIncompleteError
} from './errors'

export const RECOVERY_IN_PROGRESS_MARKER = '.pv-recovery-in-progress.json'
export const RECOVERY_COMPLETE_MARKER = '.pv-recovery-complete.json'
export const RECOVERY_TEMP_DIR = '.pv-recovery-temp'

const STREAM_CHUNK_BYTES = 64 * 1024
const inProcessHeldProfileKeys = new Set<string>()

export function computeProfileLockKey(profileDir: string): string {
  const abs = resolve(profileDir)
  const segments: string[] = []
  let cur = abs
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    segments.unshift(cur.slice(parent.length).replace(/^[/\\]+/, ''))
    cur = parent
  }
  const canonicalBase = existsSync(cur) ? realpathSync(cur) : cur
  const canonicalPath = segments.length > 0 ? join(canonicalBase, ...segments) : canonicalBase
  return createHash('sha256')
    .update(normalizePathForLookup(canonicalPath))
    .digest('hex')
    .slice(0, 32)
}

export async function acquireOsProfileLock(
  profileDir: string,
  errorFactory: (message: string) => Error
): Promise<() => Promise<void>> {
  const key = computeProfileLockKey(profileDir)
  if (inProcessHeldProfileKeys.has(key)) {
    throw errorFactory(
      `Profile "${profileDir}" is locked by an active startup, recovery, or cleanup operation`
    )
  }
  inProcessHeldProfileKeys.add(key)

  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\pv-profile-${key}`
      : join(tmpdir(), `pv-profile-${key}.sock`)

  const server = createNetServer()
  try {
    await new Promise<void>((resolveLock, rejectLock) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        rejectLock(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolveLock()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(endpoint)
    })
  } catch (err) {
    inProcessHeldProfileKeys.delete(key)
    try {
      server.close()
    } catch {
      // Ignore close failure on failed listen
    }
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      throw errorFactory(`Profile "${profileDir}" is locked by another process (${code})`)
    }
    throw err
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    } finally {
      inProcessHeldProfileKeys.delete(key)
    }
  }
}

export type CatalogRecoveryPhaseHook = (
  phase: 'after_verify' | 'after_stage_db' | 'after_record_staged_hash' | 'after_publish_db'
) => void | Promise<void>

export interface RecoverCatalogOptions {
  readonly sourceVaultDir: string
  readonly targetProfileDir: string
  readonly activeUserDataDir?: string | null
  readonly activeVaultPaths?: readonly string[]
  readonly activeSourceRoots?: readonly string[]
  readonly recoveryJobId?: string
  readonly signal?: AbortSignal
  readonly onPhase?: CatalogRecoveryPhaseHook
}

export interface CatalogRecoveryReport {
  readonly recoveryJobId: string
  readonly vaultId: string
  readonly vaultName: string
  readonly sourceVaultDir: string
  readonly targetProfileDir: string
  readonly catalogPath: string
  readonly catalogSha256: string
  readonly recoveredVaultCopies: number
  readonly recoveredSources: number
  readonly recoveredFileLocations: number
  readonly recoveredObservations: number
  readonly historicalObservations: number
  readonly recoveredAtMs: number
  readonly currentVersionSelectionNote: 'inferred_from_manifest_evidence'
  readonly omittedDataCategories: readonly string[]
}

export interface RecoveredProfileStatus {
  readonly status: 'clean' | 'interrupted' | 'complete'
  readonly recoveryJobId: string | null
  readonly vaultId: string | null
  readonly catalogPath: string | null
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CatalogRecoveryError('recovery_cancelled', 'Catalog recovery was cancelled')
  }
}

function writeJsonAtomicFsync(filePath: string, data: unknown, exclusive = false): void {
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC)
  const fd = openSync(filePath, flags, 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) {
      offset += closeSafeWrite(fd, bytes, offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function closeSafeWrite(fd: number, buf: Buffer, offset: number): number {
  return writeSync(fd, buf, offset, buf.length - offset, null)
}

async function streamVerifyFileSha256AndSize(
  filePath: string,
  expectedByteSize: number,
  expectedSha256: string,
  signal?: AbortSignal
): Promise<void> {
  checkAborted(signal)
  const hash = createHash('sha256')
  let totalBytes = 0
  const stream = createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES })
  try {
    for await (const chunk of stream) {
      checkAborted(signal)
      const buf = chunk as Buffer
      totalBytes += buf.length
      if (totalBytes > expectedByteSize) {
        throw new CatalogRecoveryError(
          'recovery_payload_hash_mismatch',
          `Payload "${filePath}" exceeds expected byte size ${expectedByteSize}`
        )
      }
      hash.update(buf)
    }
  } finally {
    stream.destroy()
  }

  if (totalBytes !== expectedByteSize) {
    throw new CatalogRecoveryError(
      'recovery_payload_hash_mismatch',
      `Payload "${filePath}" byte size ${totalBytes} does not match expected ${expectedByteSize}`
    )
  }

  const actualSha256 = hash.digest('hex').toLowerCase()
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new CatalogRecoveryError(
      'recovery_payload_hash_mismatch',
      `Payload "${filePath}" SHA-256 "${actualSha256}" does not match expected "${expectedSha256}"`
    )
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES })
  try {
    for await (const chunk of stream) {
      hash.update(chunk as Buffer)
    }
  } finally {
    stream.destroy()
  }
  return hash.digest('hex').toLowerCase()
}

function assertNoSymlinkDir(dirPath: string, label: string): string {
  let st
  try {
    st = lstatSync(dirPath)
  } catch (err) {
    throw new CatalogRecoveryError(
      'recovery_source_vault_invalid',
      `${label} "${dirPath}" is not accessible: ${(err as Error).message}`
    )
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new CatalogRecoveryError(
      'recovery_source_vault_invalid',
      `${label} "${dirPath}" must be a real directory (not a symlink or file)`
    )
  }
  return realpathSync(dirPath)
}

function deriveInferredSourceRoot(originalPath: string): string {
  const parent = dirname(originalPath)
  return parent && parent.length > 0 ? parent : originalPath
}

interface CandidateObservation {
  readonly originalPath: string
  readonly normalizedPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly sha256: string
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly inferredCaptureTimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly hashVerifiedAtMs: number
  readonly discoveryObservationId: number
  readonly importedAtMs: number
}

function compareCandidateDescending(a: CandidateObservation, b: CandidateObservation): number {
  if (a.lastSeenAtMs !== b.lastSeenAtMs) return b.lastSeenAtMs - a.lastSeenAtMs
  if (a.importedAtMs !== b.importedAtMs) return b.importedAtMs - a.importedAtMs
  if (a.hashVerifiedAtMs !== b.hashVerifiedAtMs) return b.hashVerifiedAtMs - a.hashVerifiedAtMs
  if (a.discoveryObservationId !== b.discoveryObservationId) {
    return b.discoveryObservationId - a.discoveryObservationId
  }
  return a.sha256.localeCompare(b.sha256)
}

export async function recoverCatalogFromVaultManifests(
  options: RecoverCatalogOptions
): Promise<CatalogRecoveryReport> {
  checkAborted(options.signal)

  const recoveryJobId = options.recoveryJobId ?? randomUUID()

  // 1. Validate source vault directory & identity strictly read-only
  const canonicalVaultDir = assertNoSymlinkDir(options.sourceVaultDir, 'Source vault directory')

  let vaultIdentity
  try {
    assertPathContainedInVault(
      canonicalVaultDir,
      join(canonicalVaultDir, 'vault.json'),
      'vault.json'
    )
    vaultIdentity = loadVaultIdentity(canonicalVaultDir)
  } catch (err) {
    throw new CatalogRecoveryError(
      'recovery_source_vault_invalid',
      `Invalid source vault identity at "${canonicalVaultDir}": ${(err as Error).message}`
    )
  }

  // 2. Validate isolated target profile directory
  let canonicalTargetProfileDir: string
  try {
    const validatedTargets = validateRestoreTargetPaths({
      targetProfileDir: options.targetProfileDir,
      targetVaultDir: null,
      backupRepoDir: canonicalVaultDir,
      activeUserDataDir: options.activeUserDataDir ?? undefined,
      activeVaultRoots: options.activeVaultPaths ?? [],
      activeSourceRoots: options.activeSourceRoots ?? []
    })
    canonicalTargetProfileDir = validatedTargets.targetProfileDir
  } catch (err) {
    if (err instanceof BackupContainmentError || err instanceof BackupRestoreError) {
      throw new CatalogRecoveryError('recovery_target_invalid', err.message)
    }
    throw err
  }

  // 3. Strictly enumerate and verify all content directories & manifests
  const vaultCopies: RecoveredVaultCopyEntry[] = []
  const candidatesByNormPath = new Map<string, CandidateObservation[]>()
  const verbatimPathByNormPath = new Map<string, string>()

  const filesDir = join(canonicalVaultDir, 'files')
  const recoveryVerifiedAtMs = Date.now()

  if (existsSync(filesDir)) {
    try {
      assertPathContainedInVault(canonicalVaultDir, filesDir, 'files directory')
    } catch (err) {
      throw new CatalogRecoveryError(
        'recovery_source_vault_invalid',
        `Vault files directory containment failed: ${(err as Error).message}`
      )
    }

    const prefixEntries = readdirSync(filesDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )

    for (const prefixEntry of prefixEntries) {
      checkAborted(options.signal)
      const prefixPath = join(filesDir, prefixEntry.name)
      const prefixStat = lstatSync(prefixPath)
      if (prefixStat.isSymbolicLink() || !prefixStat.isDirectory()) {
        throw new CatalogRecoveryError(
          'recovery_source_vault_invalid',
          `Unexpected non-directory or symlink at "${prefixPath}"`
        )
      }
      if (!/^[0-9a-f]{2}$/.test(prefixEntry.name)) {
        throw new CatalogRecoveryError(
          'recovery_source_vault_invalid',
          `Invalid vault prefix directory name "${prefixEntry.name}"`
        )
      }

      const hashEntries = readdirSync(prefixPath, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      )

      for (const hashEntry of hashEntries) {
        checkAborted(options.signal)
        const contentDir = join(prefixPath, hashEntry.name)
        const contentDirStat = lstatSync(contentDir)
        if (contentDirStat.isSymbolicLink() || !contentDirStat.isDirectory()) {
          throw new CatalogRecoveryError(
            'recovery_source_vault_invalid',
            `Unexpected non-directory or symlink at "${contentDir}"`
          )
        }
        if (
          !/^[0-9a-f]{64}$/.test(hashEntry.name) ||
          !hashEntry.name.startsWith(prefixEntry.name)
        ) {
          throw new CatalogRecoveryError(
            'recovery_source_vault_invalid',
            `Invalid vault content directory "${hashEntry.name}" under prefix "${prefixEntry.name}"`
          )
        }

        const dirSha256 = hashEntry.name
        const contentDirReal = realpathSync(contentDir)
        const contentItems = readdirSync(contentDir, { withFileTypes: true })
        for (const item of contentItems) {
          const itemPath = join(contentDir, item.name)
          const itemStat = lstatSync(itemPath)
          if (itemStat.isSymbolicLink() || itemStat.isDirectory()) {
            throw new CatalogRecoveryError(
              'recovery_payload_containment_error',
              `Unexpected symlink or directory inside content dir "${itemPath}"`
            )
          }
        }

        const manifestRelPath = join('files', prefixEntry.name, dirSha256, 'manifest.json')
        const manifestAbsPath = join(contentDir, 'manifest.json')
        if (!existsSync(manifestAbsPath)) {
          throw new CatalogRecoveryError(
            'recovery_manifest_missing',
            `Missing manifest.json in "${contentDir}"`
          )
        }

        try {
          assertPathContainedInVault(canonicalVaultDir, manifestAbsPath, 'manifest.json')
        } catch (err) {
          throw new CatalogRecoveryError(
            'recovery_payload_containment_error',
            `Manifest containment failed for "${manifestAbsPath}": ${(err as Error).message}`
          )
        }

        let parsedManifest
        try {
          const manifestBuf = readFileSync(manifestAbsPath)
          parsedManifest = VaultManifestSchema.parse(JSON.parse(manifestBuf.toString('utf8')))
        } catch (err) {
          throw new CatalogRecoveryError(
            'recovery_manifest_corrupt',
            `Corrupt manifest at "${manifestRelPath}": ${(err as Error).message}`
          )
        }

        if (parsedManifest.vaultId !== vaultIdentity.vaultId) {
          throw new CatalogRecoveryError(
            'recovery_manifest_corrupt',
            `Manifest "${manifestRelPath}" vaultId "${parsedManifest.vaultId}" does not match vault.json "${vaultIdentity.vaultId}"`
          )
        }
        if (parsedManifest.sha256.toLowerCase() !== dirSha256) {
          throw new CatalogRecoveryError(
            'recovery_manifest_corrupt',
            `Manifest "${manifestRelPath}" sha256 "${parsedManifest.sha256}" does not match directory "${dirSha256}"`
          )
        }

        // Keep each payload strictly within its own content directory
        const expectedPayloadRel = join(
          'files',
          prefixEntry.name,
          dirSha256,
          parsedManifest.managedCopy.fileName
        )
        const resolvedPayloadFromManifest = resolve(
          canonicalVaultDir,
          parsedManifest.managedCopy.relativePath
        )
        const expectedPayloadAbs = resolve(canonicalVaultDir, expectedPayloadRel)
        if (
          normalizePathForLookup(resolvedPayloadFromManifest) !==
          normalizePathForLookup(expectedPayloadAbs)
        ) {
          throw new CatalogRecoveryError(
            'recovery_payload_containment_error',
            `Manifest "${manifestRelPath}" managedCopy.relativePath "${parsedManifest.managedCopy.relativePath}" escapes content directory "${dirSha256}"`
          )
        }

        // Reject any extra/orphaned files in the content directory
        for (const item of contentItems) {
          if (item.name !== 'manifest.json' && item.name !== parsedManifest.managedCopy.fileName) {
            throw new CatalogRecoveryError(
              'recovery_manifest_corrupt',
              `Unexpected orphaned file "${item.name}" in content directory "${contentDir}"`
            )
          }
        }

        if (!existsSync(expectedPayloadAbs)) {
          throw new CatalogRecoveryError(
            'recovery_payload_missing',
            `Missing vault payload "${expectedPayloadRel}"`
          )
        }

        try {
          assertPathContainedInVault(canonicalVaultDir, expectedPayloadAbs, 'vault payload')
          const payloadReal = realpathSync(expectedPayloadAbs)
          const relInsideContent = relative(contentDirReal, payloadReal)
          if (
            !relInsideContent ||
            relInsideContent.startsWith('..') ||
            relInsideContent.includes(sep)
          ) {
            throw new Error(`Payload "${payloadReal}" is not directly inside "${contentDirReal}"`)
          }
        } catch (err) {
          throw new CatalogRecoveryError(
            'recovery_payload_containment_error',
            `Payload containment check failed for "${expectedPayloadRel}": ${(err as Error).message}`
          )
        }

        await streamVerifyFileSha256AndSize(
          expectedPayloadAbs,
          parsedManifest.byteSize,
          dirSha256,
          options.signal
        )

        let maxImportedAtMs = parsedManifest.managedCopy.publishedAtMs
        for (const src of parsedManifest.sources) {
          if (src.importResult.importedAtMs > maxImportedAtMs) {
            maxImportedAtMs = src.importResult.importedAtMs
          }

          const normPath = normalizePathForLookup(src.originalPath)
          const existingVerbatim = verbatimPathByNormPath.get(normPath)
          if (existingVerbatim !== undefined && existingVerbatim !== src.originalPath) {
            throw new CatalogRecoveryError(
              'recovery_conflicting_normalized_path',
              `Conflicting verbatim originalPath spellings "${existingVerbatim}" and "${src.originalPath}" normalize to "${normPath}"`
            )
          }
          verbatimPathByNormPath.set(normPath, src.originalPath)

          const candidate: CandidateObservation = {
            originalPath: src.originalPath,
            normalizedPath: normPath,
            fileName: src.fileName,
            extension: src.extension,
            category: src.category,
            sha256: dirSha256,
            byteSize: src.recordedFacts.byteSize,
            filesystemBirthtimeMs: src.recordedFacts.filesystemBirthtimeMs,
            filesystemMtimeMs: src.recordedFacts.filesystemMtimeMs,
            inferredCaptureTimeMs: src.inferredMetadata.inferredCaptureTimeMs,
            firstDiscoveredAtMs: src.recordedFacts.firstDiscoveredAtMs,
            lastSeenAtMs: src.recordedFacts.lastSeenAtMs,
            hashVerifiedAtMs: src.recordedFacts.hashVerifiedAtMs,
            discoveryObservationId: src.recordedFacts.discoveryObservationId,
            importedAtMs: src.importResult.importedAtMs
          }

          const list = candidatesByNormPath.get(normPath)
          if (list) {
            list.push(candidate)
          } else {
            candidatesByNormPath.set(normPath, [candidate])
          }
        }

        vaultCopies.push({
          sha256: dirSha256,
          byteSize: parsedManifest.byteSize,
          relativePath: expectedPayloadRel.replace(/\\/g, '/'),
          manifestRelativePath: manifestRelPath.replace(/\\/g, '/'),
          verifiedAtMs: recoveryVerifiedAtMs,
          createdAtMs: parsedManifest.managedCopy.publishedAtMs,
          updatedAtMs: maxImportedAtMs
        })
      }
    }
  }

  // 4. Build deterministic file_locations + observations (inferring is_current = 1)
  const fileLocations: RecoveredFileLocationEntry[] = []
  const sortedNormPaths = Array.from(candidatesByNormPath.keys()).sort((a, b) => a.localeCompare(b))
  for (const normPath of sortedNormPaths) {
    const candidates = candidatesByNormPath.get(normPath)!
    candidates.sort(compareCandidateDescending)
    const winner = candidates[0]!
    const sourceRootPath = deriveInferredSourceRoot(winner.originalPath)
    const normalizedSourceRootPath = normalizePathForLookup(sourceRootPath)

    const observations: RecoveredObservationEntry[] = candidates.map((c, index) => ({
      sha256: c.sha256,
      byteSize: c.byteSize,
      filesystemBirthtimeMs: c.filesystemBirthtimeMs,
      filesystemMtimeMs: c.filesystemMtimeMs,
      inferredCaptureTimeMs: c.inferredCaptureTimeMs,
      firstDiscoveredAtMs: c.firstDiscoveredAtMs,
      lastSeenAtMs: c.lastSeenAtMs,
      hashVerifiedAtMs: c.hashVerifiedAtMs,
      isCurrent: index === 0
    }))

    fileLocations.push({
      sourceRootPath,
      normalizedSourceRootPath,
      originalPath: winner.originalPath,
      normalizedPath: normPath,
      fileName: winner.fileName,
      extension: winner.extension,
      category: winner.category,
      currentObservation: observations[0]!,
      observations
    })
  }

  await options.onPhase?.('after_verify')
  checkAborted(options.signal)

  // 5. Atomic staged publication into targetProfileDir (under OS-released profile lock)
  const releaseLock = await acquireOsProfileLock(
    canonicalTargetProfileDir,
    (msg) => new CatalogRecoveryError('recovery_target_invalid', msg)
  )

  try {
    mkdirSync(canonicalTargetProfileDir, { recursive: true })
    const inProgressMarkerPath = join(canonicalTargetProfileDir, RECOVERY_IN_PROGRESS_MARKER)
    const completeMarkerPath = join(canonicalTargetProfileDir, RECOVERY_COMPLETE_MARKER)
    const tempDir = join(canonicalTargetProfileDir, RECOVERY_TEMP_DIR)
    const stagedDbPath = join(tempDir, 'vault-catalog.db')
    const publishedDbPath = join(canonicalTargetProfileDir, 'vault-catalog.db')

    writeJsonAtomicFsync(
      inProgressMarkerPath,
      {
        formatVersion: BACKUP_FORMAT_VERSION,
        schema: 'pv_recovery_in_progress_v1',
        recoveryJobId,
        vaultId: vaultIdentity.vaultId,
        sourceVaultDir: canonicalVaultDir,
        targetProfileDir: canonicalTargetProfileDir,
        stagedCatalogSha256: null,
        startedAtMs: recoveryVerifiedAtMs
      },
      true
    )

    mkdirSync(tempDir, { recursive: false })

    let populateResult
    const stagedCatalog = CatalogDatabase.open({ catalogPath: stagedDbPath })
    try {
      populateResult = stagedCatalog.populateRecoveredCatalog({
        vaultId: vaultIdentity.vaultId,
        vaultPath: canonicalVaultDir,
        normalizedVaultPath: normalizePathForLookup(canonicalVaultDir),
        vaultName: vaultIdentity.vaultName,
        vaultCreatedAtMs: vaultIdentity.createdAtMs,
        recoveredAtMs: recoveryVerifiedAtMs,
        vaultCopies,
        fileLocations
      })
    } finally {
      stagedCatalog.close()
    }

    await options.onPhase?.('after_stage_db')
    checkAborted(options.signal)

    if (existsSync(publishedDbPath)) {
      throw new CatalogRecoveryError(
        'recovery_target_invalid',
        `Target catalog "${publishedDbPath}" already exists; refusing to overwrite`
      )
    }

    const catalogSha256 = await hashFileSha256(stagedDbPath)
    writeJsonAtomicFsync(
      inProgressMarkerPath,
      {
        formatVersion: BACKUP_FORMAT_VERSION,
        schema: 'pv_recovery_in_progress_v1',
        recoveryJobId,
        vaultId: vaultIdentity.vaultId,
        sourceVaultDir: canonicalVaultDir,
        targetProfileDir: canonicalTargetProfileDir,
        stagedCatalogSha256: catalogSha256,
        startedAtMs: recoveryVerifiedAtMs
      },
      false
    )

    await options.onPhase?.('after_record_staged_hash')
    checkAborted(options.signal)

    try {
      linkSync(stagedDbPath, publishedDbPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'EEXIST') {
        throw new CatalogRecoveryError(
          'recovery_target_invalid',
          `Target catalog "${publishedDbPath}" appeared before publication; refusing to overwrite`
        )
      }
      throw err
    }

    await options.onPhase?.('after_publish_db')
    checkAborted(options.signal)

    const recoveredAtMs = Date.now()

    writeJsonAtomicFsync(completeMarkerPath, {
      formatVersion: BACKUP_FORMAT_VERSION,
      schema: 'pv_recovery_complete_v1',
      recoveryJobId,
      vaultId: vaultIdentity.vaultId,
      sourceVaultDir: canonicalVaultDir,
      targetProfileDir: canonicalTargetProfileDir,
      catalogSha256,
      recoveredVaultCopies: populateResult.recoveredVaultCopies,
      recoveredFileLocations: populateResult.recoveredFileLocations,
      recoveredObservations: populateResult.recoveredObservations,
      recoveredAtMs
    })

    rmSync(inProgressMarkerPath, { force: true })
    rmSync(tempDir, { recursive: true, force: true })

    return {
      recoveryJobId,
      vaultId: vaultIdentity.vaultId,
      vaultName: vaultIdentity.vaultName,
      sourceVaultDir: canonicalVaultDir,
      targetProfileDir: canonicalTargetProfileDir,
      catalogPath: publishedDbPath,
      catalogSha256,
      recoveredVaultCopies: populateResult.recoveredVaultCopies,
      recoveredSources: populateResult.recoveredSources,
      recoveredFileLocations: populateResult.recoveredFileLocations,
      recoveredObservations: populateResult.recoveredObservations,
      historicalObservations: populateResult.historicalObservations,
      recoveredAtMs,
      currentVersionSelectionNote: 'inferred_from_manifest_evidence',
      omittedDataCategories: [
        'photo_annotations',
        'collections',
        'collection_memberships',
        'similarity_decisions',
        'document_classification_overrides',
        'duplicate_reviews',
        'vault_imports',
        'vault_import_items',
        'scan_jobs',
        'unimported_source_files',
        'derived_indexes'
      ]
    }
  } finally {
    await releaseLock()
  }
}

export function inspectRecoveredProfileStatus(targetProfileDir: string): RecoveredProfileStatus {
  const inProgressPath = join(targetProfileDir, RECOVERY_IN_PROGRESS_MARKER)
  const completePath = join(targetProfileDir, RECOVERY_COMPLETE_MARKER)
  const dbPath = join(targetProfileDir, 'vault-catalog.db')

  if (existsSync(inProgressPath)) {
    let recoveryJobId: string | null = null
    let vaultId: string | null = null
    try {
      const parsed = CatalogRecoveryInProgressMarkerV1Schema.parse(
        JSON.parse(readFileSync(inProgressPath, 'utf8'))
      )
      recoveryJobId = parsed.recoveryJobId
      vaultId = parsed.vaultId
    } catch {
      // Corrupt marker is still interrupted
    }
    return {
      status: 'interrupted',
      recoveryJobId,
      vaultId,
      catalogPath: null
    }
  }

  if (existsSync(completePath) && existsSync(dbPath)) {
    try {
      const parsed = CatalogRecoveryCompleteMarkerV1Schema.parse(
        JSON.parse(readFileSync(completePath, 'utf8'))
      )
      return {
        status: 'complete',
        recoveryJobId: parsed.recoveryJobId,
        vaultId: parsed.vaultId,
        catalogPath: dbPath
      }
    } catch {
      return {
        status: 'interrupted',
        recoveryJobId: null,
        vaultId: null,
        catalogPath: null
      }
    }
  }

  if (existsSync(completePath) || existsSync(join(targetProfileDir, RECOVERY_TEMP_DIR))) {
    return {
      status: 'interrupted',
      recoveryJobId: null,
      vaultId: null,
      catalogPath: null
    }
  }

  return {
    status: 'clean',
    recoveryJobId: null,
    vaultId: null,
    catalogPath: null
  }
}

export function assertProfileSafeForCatalogOpen(userDataDir: string): void {
  const status = inspectRecoveredProfileStatus(userDataDir)
  if (status.status === 'interrupted') {
    throw new RecoveryIncompleteError(
      `Refusing startup: profile at "${userDataDir}" has an interrupted catalog recovery${status.recoveryJobId ? ` (${status.recoveryJobId})` : ''}`
    )
  }
}

export async function withProfileStartupCoordination<T>(
  userDataDir: string,
  fn: () => Promise<T> | T,
  onAfterMarkerCheckBeforeOpen?: () => Promise<void> | void
): Promise<T> {
  assertProfileSafeForCatalogOpen(userDataDir)
  const releaseLock = await acquireOsProfileLock(
    userDataDir,
    (msg) => new RecoveryIncompleteError(msg)
  )

  try {
    assertProfileSafeForCatalogOpen(userDataDir)
    await onAfterMarkerCheckBeforeOpen?.()
    return await fn()
  } finally {
    await releaseLock()
  }
}

function areSameHardLinkedFile(pathA: string, pathB: string): boolean {
  if (!existsSync(pathA) || !existsSync(pathB)) {
    return false
  }
  try {
    const statA = lstatSync(pathA, { bigint: true })
    const statB = lstatSync(pathB, { bigint: true })
    if (statA.isSymbolicLink() || statB.isSymbolicLink()) {
      return false
    }
    if (!statA.isFile() || !statB.isFile()) {
      return false
    }
    if (statA.ino === 0n || statB.ino === 0n) {
      return false
    }
    return statA.dev === statB.dev && statA.ino === statB.ino
  } catch {
    return false
  }
}

export async function cleanupInterruptedCatalogRecoveryTarget(params: {
  readonly targetProfileDir: string
  readonly expectedRecoveryJobId?: string
}): Promise<void> {
  if (!existsSync(params.targetProfileDir)) {
    throw new CatalogRecoveryError(
      'recovery_cleanup_refused',
      `Refusing cleanup: target directory "${params.targetProfileDir}" does not exist`
    )
  }
  const canonicalTarget = realpathSync(params.targetProfileDir)
  const releaseLock = await acquireOsProfileLock(
    canonicalTarget,
    (msg) => new CatalogRecoveryError('recovery_cleanup_refused', msg)
  )

  try {
    const inProgressPath = join(canonicalTarget, RECOVERY_IN_PROGRESS_MARKER)

    if (!existsSync(inProgressPath)) {
      throw new CatalogRecoveryError(
        'recovery_cleanup_refused',
        `Refusing cleanup: "${RECOVERY_IN_PROGRESS_MARKER}" is absent in "${canonicalTarget}"`
      )
    }

    let marker
    try {
      marker = CatalogRecoveryInProgressMarkerV1Schema.parse(
        JSON.parse(readFileSync(inProgressPath, 'utf8'))
      )
    } catch (err) {
      throw new CatalogRecoveryError(
        'recovery_cleanup_refused',
        `Refusing cleanup: invalid recovery marker in "${canonicalTarget}": ${(err as Error).message}`
      )
    }

    if (
      normalizePathForLookup(marker.targetProfileDir) !== normalizePathForLookup(canonicalTarget)
    ) {
      throw new CatalogRecoveryError(
        'recovery_cleanup_refused',
        `Refusing cleanup: marker targetProfileDir "${marker.targetProfileDir}" does not match "${canonicalTarget}"`
      )
    }

    if (params.expectedRecoveryJobId && marker.recoveryJobId !== params.expectedRecoveryJobId) {
      throw new CatalogRecoveryError(
        'recovery_cleanup_refused',
        `Refusing cleanup: marker recoveryJobId "${marker.recoveryJobId}" does not match expected "${params.expectedRecoveryJobId}"`
      )
    }

    // Verify hard-link identity (dev + ino) against the staged DB BEFORE removing staging.
    // SQLite sidecars (-wal / -shm) are never created in targetProfileDir by recovery, so leave them in place.
    const stagedDbPath = join(canonicalTarget, RECOVERY_TEMP_DIR, 'vault-catalog.db')
    const publishedDbPath = join(canonicalTarget, 'vault-catalog.db')
    const isOwnedPublishedDb =
      marker.stagedCatalogSha256 !== null &&
      areSameHardLinkedFile(stagedDbPath, publishedDbPath) &&
      (await hashFileSha256(publishedDbPath)) === marker.stagedCatalogSha256

    const pathsToRemove = [
      join(canonicalTarget, RECOVERY_TEMP_DIR),
      join(canonicalTarget, RECOVERY_COMPLETE_MARKER),
      ...(isOwnedPublishedDb ? [publishedDbPath] : []),
      inProgressPath
    ]

    for (const p of pathsToRemove) {
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true })
      }
    }
  } finally {
    await releaseLock()
  }
}
