/**
 * Personal Vault — Verified Vault Copier and Pipeline (Stage 4)
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isSameOrDescendantPath } from '../catalog/path-normalization'
import { isTimestampConsistentWithExpectation } from '../hashing/hasher'
import { VaultOverlapError } from './errors'
import { assertPathContainedInVault } from './containment'
import {
  getManifestRelativePath,
  mergeManifestSources,
  readVaultManifest,
  writeVaultManifest
} from './manifest'
import type {
  CopyFileResult,
  CopyFileToVaultParams,
  VaultManifestManagedCopy,
  VaultManifestSourceEntry
} from './types'

const CHUNK_SIZE = 64 * 1024 // 64 KiB

function sanitizeFileName(name: string): string {
  // Strip control chars and illegal chars on Windows: <>:"/\|?*
  const clean = Array.from(name)
    .map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c))
    .join('')
    .trim()
  if (clean.toLowerCase() === 'manifest.json') {
    return 'content_manifest.json'
  }
  return clean || 'file.bin'
}

function getCanonicalPath(targetPath: string): string {
  try {
    return realpathSync(targetPath)
  } catch {
    return resolve(targetPath)
  }
}

export function validateVaultSeparation(vaultPath: string, sourceRoots: readonly string[]): void {
  const canonicalVault = getCanonicalPath(vaultPath)

  for (const root of sourceRoots) {
    const canonicalSource = getCanonicalPath(root)
    if (
      isSameOrDescendantPath(canonicalVault, canonicalSource) ||
      isSameOrDescendantPath(canonicalSource, canonicalVault)
    ) {
      throw new VaultOverlapError(`Vault path "${vaultPath}" overlaps with source root "${root}"`)
    }
  }
}

export function cleanupOwnedStagingFiles(vaultPath: string, vaultId?: string): number {
  const stagingDir = join(vaultPath, '.vault-temp')
  if (!existsSync(stagingDir)) return 0

  let cleaned = 0
  try {
    const entries = readdirSync(stagingDir)
    for (const entry of entries) {
      const isOwned = vaultId
        ? (entry.startsWith(`pv_staging_${vaultId}_`) ||
            entry.startsWith(`pv_manifest_${vaultId}_`)) &&
          entry.endsWith('.tmp')
        : (entry.startsWith('pv_staging_') ||
            entry.startsWith('pv_manifest_') ||
            entry.startsWith('staging_') ||
            entry.startsWith('manifest_')) &&
          entry.endsWith('.tmp')
      if (isOwned) {
        try {
          unlinkSync(join(stagingDir, entry))
          cleaned++
        } catch {
          // Ignore individual unlinking failure
        }
      }
    }
  } catch {
    // Ignore readdir failure
  }
  return cleaned
}

export async function copyAndVerifyFileToVault(
  params: CopyFileToVaultParams
): Promise<CopyFileResult> {
  const { vaultPath, vaultId, importJobId, source, signal } = params

  if (signal?.aborted) {
    return { status: 'cancelled' }
  }

  // Path containment & separation verification
  const canonicalVault = getCanonicalPath(vaultPath)
  const canonicalSource = getCanonicalPath(source.originalPath)
  if (isSameOrDescendantPath(canonicalVault, canonicalSource)) {
    return {
      status: 'error',
      code: 'source_inside_vault',
      message: `Source path "${source.originalPath}" cannot be inside the vault destination`
    }
  }

  const prefix = source.expectedSha256.slice(0, 2)
  const destDir = join(vaultPath, 'files', prefix, source.expectedSha256)
  const safeName = sanitizeFileName(source.fileName)
  const destFilePath = join(destDir, safeName)
  const destRelativePath = `files/${prefix}/${source.expectedSha256}/${safeName}`
  const manifestRelPath = getManifestRelativePath(source.expectedSha256)

  assertPathContainedInVault(vaultPath, destDir, 'destination directory')
  assertPathContainedInVault(vaultPath, destFilePath, 'destination file')

  // 1. Open source file strictly in read-only mode
  let sourceHandle
  try {
    sourceHandle = await open(source.originalPath, 'r')
  } catch (err) {
    return {
      status: 'error',
      code: 'source_open_failed',
      message: `Failed to open source file: ${(err as Error).message}`
    }
  }

  let stagingFilePath: string | null = null

  try {
    // 2. Pre-read fstat verification
    const preStat = await sourceHandle.stat()
    if (!preStat.isFile()) {
      return {
        status: 'error',
        code: 'source_not_regular_file',
        message: 'Source path is not a regular file'
      }
    }
    if (preStat.size !== source.expectedByteSize) {
      return {
        status: 'error',
        code: 'source_changed',
        message: `Source size changed: expected ${source.expectedByteSize}, found ${preStat.size}`
      }
    }
    if (
      source.recordedFacts.filesystemMtimeMs !== null &&
      !isTimestampConsistentWithExpectation(preStat.mtimeMs, source.recordedFacts.filesystemMtimeMs)
    ) {
      return {
        status: 'error',
        code: 'source_changed',
        message: `Source modification timestamp changed: expected ${source.recordedFacts.filesystemMtimeMs}, found ${preStat.mtimeMs}`
      }
    }

    // 3. Staging and live source streaming
    const stagingDir = join(vaultPath, '.vault-temp')
    assertPathContainedInVault(vaultPath, stagingDir, 'staging directory')
    mkdirSync(stagingDir, { recursive: true })
    stagingFilePath = join(
      stagingDir,
      `pv_staging_${vaultId}_${importJobId}_${source.fileLocationId}_${randomUUID()}.tmp`
    )
    assertPathContainedInVault(vaultPath, stagingFilePath, 'staging file')

    const stagingHandle = await open(stagingFilePath, 'wx')
    const sourceHasher = createHash('sha256')

    try {
      const buffer = Buffer.alloc(CHUNK_SIZE)
      let bytesRead = 0
      while ((bytesRead = (await sourceHandle.read(buffer, 0, CHUNK_SIZE)).bytesRead) > 0) {
        if (signal?.aborted) {
          await stagingHandle.close()
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore staging cleanup failure
          }
          return { status: 'cancelled' }
        }
        const chunk = buffer.subarray(0, bytesRead)
        sourceHasher.update(chunk)
        await stagingHandle.write(chunk)
      }
      await stagingHandle.sync()
    } finally {
      await stagingHandle.close()
    }

    // 4. Post-read descriptor & live stat verification on source
    const postStat = await sourceHandle.stat()
    if (
      postStat.size !== preStat.size ||
      !isTimestampConsistentWithExpectation(postStat.mtimeMs, preStat.mtimeMs)
    ) {
      if (stagingFilePath && existsSync(stagingFilePath)) {
        try {
          unlinkSync(stagingFilePath)
        } catch {
          // Ignore cleanup
        }
      }
      return {
        status: 'error',
        code: 'source_file_changed',
        message: 'Source file was modified on disk during copy read'
      }
    }

    try {
      const liveStat = statSync(source.originalPath)
      if (
        liveStat.size !== preStat.size ||
        !isTimestampConsistentWithExpectation(liveStat.mtimeMs, preStat.mtimeMs)
      ) {
        if (stagingFilePath && existsSync(stagingFilePath)) {
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore cleanup
          }
        }
        return {
          status: 'error',
          code: 'source_file_changed',
          message: 'Source file metadata shifted during copy operation'
        }
      }
    } catch (err) {
      if (stagingFilePath && existsSync(stagingFilePath)) {
        try {
          unlinkSync(stagingFilePath)
        } catch {
          // Ignore cleanup
        }
      }
      return {
        status: 'error',
        code: 'source_disappeared',
        message: `Source file disappeared or became inaccessible: ${(err as Error).message}`
      }
    }

    // 5. Verify source SHA-256 against expected observation
    const computedSourceSha = sourceHasher.digest('hex')
    if (computedSourceSha !== source.expectedSha256) {
      if (stagingFilePath && existsSync(stagingFilePath)) {
        try {
          unlinkSync(stagingFilePath)
        } catch {
          // Ignore cleanup
        }
      }
      return {
        status: 'error',
        code: 'source_mismatch',
        message: `Source SHA-256 digest ${computedSourceSha} did not match expected ${source.expectedSha256}`
      }
    }

    // 6. Handle destination verification, existing-copy reuse, or publication
    const markerPath = join(destDir, `.pv_in_progress_${vaultId}_${importJobId}.json`)
    assertPathContainedInVault(vaultPath, markerPath, 'in-progress marker path')

    let existingManagedManifest = null
    try {
      existingManagedManifest = readVaultManifest(vaultPath, source.expectedSha256)
    } catch (err) {
      if (stagingFilePath && existsSync(stagingFilePath)) {
        try {
          unlinkSync(stagingFilePath)
        } catch {
          // Ignore
        }
      }
      return {
        status: 'error',
        code: 'destination_collision',
        message: `Destination file exists but manifest is corrupted: ${(err as Error).message}`
      }
    }

    // Path A: Existing valid manifest for this vault -> reuse existing managed copy
    if (existingManagedManifest) {
      if (existingManagedManifest.vaultId !== vaultId) {
        if (stagingFilePath && existsSync(stagingFilePath)) {
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore
          }
        }
        return {
          status: 'error',
          code: 'destination_collision',
          message: `Destination file is managed by a different vault (${existingManagedManifest.vaultId})`
        }
      }

      const existingCopyPath = join(vaultPath, existingManagedManifest.managedCopy.relativePath)
      assertPathContainedInVault(vaultPath, existingCopyPath, 'managed copy path')
      if (!existsSync(existingCopyPath)) {
        if (stagingFilePath && existsSync(stagingFilePath)) {
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore
          }
        }
        return {
          status: 'error',
          code: 'destination_collision',
          message: `Manifest exists but managed copy is missing at "${existingCopyPath}"`
        }
      }

      // Independently verify existing destination file
      const destStat = statSync(existingCopyPath)
      if (destStat.size !== source.expectedByteSize) {
        if (stagingFilePath && existsSync(stagingFilePath)) {
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore
          }
        }
        return {
          status: 'error',
          code: 'destination_collision',
          message: `Existing destination file size (${destStat.size}) does not match expected (${source.expectedByteSize})`
        }
      }

      const destHandle = await open(existingCopyPath, 'r')
      const destHasher = createHash('sha256')
      try {
        const destBuf = Buffer.alloc(CHUNK_SIZE)
        let destRead = 0
        while ((destRead = (await destHandle.read(destBuf, 0, CHUNK_SIZE)).bytesRead) > 0) {
          if (signal?.aborted) {
            if (stagingFilePath && existsSync(stagingFilePath)) {
              try {
                unlinkSync(stagingFilePath)
              } catch {
                // Ignore
              }
            }
            return { status: 'cancelled' }
          }
          destHasher.update(destBuf.subarray(0, destRead))
        }
      } finally {
        await destHandle.close()
      }

      const existingDestSha = destHasher.digest('hex')
      if (existingDestSha !== source.expectedSha256) {
        if (stagingFilePath && existsSync(stagingFilePath)) {
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore
          }
        }
        return {
          status: 'error',
          code: 'destination_hash_mismatch',
          message: `Existing destination file SHA-256 corrupted: expected ${source.expectedSha256}, found ${existingDestSha}`
        }
      }

      // Staging file not needed because existing copy is identical and verified
      if (stagingFilePath && existsSync(stagingFilePath)) {
        try {
          unlinkSync(stagingFilePath)
        } catch {
          // Ignore
        }
      }
      stagingFilePath = null

      // Update portable manifest with new source provenance
      const sourceEntry: VaultManifestSourceEntry = {
        fileLocationId: source.fileLocationId,
        originalPath: source.originalPath,
        fileName: source.fileName,
        extension: source.extension,
        category: source.category,
        recordedFacts: {
          byteSize: source.recordedFacts.byteSize,
          filesystemBirthtimeMs: source.recordedFacts.filesystemBirthtimeMs,
          filesystemMtimeMs: source.recordedFacts.filesystemMtimeMs,
          firstDiscoveredAtMs: source.recordedFacts.firstDiscoveredAtMs,
          lastSeenAtMs: source.recordedFacts.lastSeenAtMs,
          discoveryObservationId: source.discoveryObservationId,
          hashObservationId: source.recordedFacts.hashObservationId,
          hashVerifiedAtMs: source.recordedFacts.hashVerifiedAtMs
        },
        inferredMetadata: {
          inferredCaptureTimeMs: source.inferredMetadata.inferredCaptureTimeMs
        },
        reviewDecisions: {
          isPreferred: source.reviewDecisions.isPreferred,
          duplicateReviewStatus: source.reviewDecisions.duplicateReviewStatus
        },
        importResult: {
          importJobId,
          importedAtMs: Date.now(),
          verifiedSourceSha256: source.expectedSha256,
          verifiedSourceByteSize: source.expectedByteSize,
          sourceStability: {
            preCopyMtimeMs: preStat.mtimeMs,
            postCopyMtimeMs: postStat.mtimeMs,
            preCopyByteSize: preStat.size,
            postCopyByteSize: postStat.size
          }
        }
      }

      const updatedManifest = mergeManifestSources(
        existingManagedManifest,
        sourceEntry,
        existingManagedManifest.managedCopy,
        vaultId,
        source.expectedSha256,
        source.expectedByteSize
      )
      writeVaultManifest(vaultPath, updatedManifest, importJobId)

      return {
        status: 'success',
        sha256: source.expectedSha256,
        byteSize: source.expectedByteSize,
        relativePath: existingManagedManifest.managedCopy.relativePath,
        manifestRelativePath: manifestRelPath,
        reusedExistingCopy: true
      }
    }

    // Path B: Interrupted job recovery using in-progress publication marker
    if (existsSync(markerPath)) {
      try {
        const markerRaw = readFileSync(markerPath, 'utf-8')
        const marker = JSON.parse(markerRaw)
        if (
          marker.vaultId === vaultId &&
          marker.jobId === importJobId &&
          marker.sha256 === source.expectedSha256
        ) {
          const publishedName = marker.fileName || safeName
          const publishedPath = join(destDir, publishedName)
          if (existsSync(publishedPath)) {
            const pubStat = statSync(publishedPath)
            if (pubStat.size === source.expectedByteSize) {
              const pubHandle = await open(publishedPath, 'r')
              const pubHasher = createHash('sha256')
              try {
                const pubBuf = Buffer.alloc(CHUNK_SIZE)
                let pubRead = 0
                while ((pubRead = (await pubHandle.read(pubBuf, 0, CHUNK_SIZE)).bytesRead) > 0) {
                  pubHasher.update(pubBuf.subarray(0, pubRead))
                }
              } finally {
                await pubHandle.close()
              }

              if (pubHasher.digest('hex') === source.expectedSha256) {
                if (stagingFilePath && existsSync(stagingFilePath)) {
                  try {
                    unlinkSync(stagingFilePath)
                  } catch {
                    // Ignore
                  }
                }
                stagingFilePath = null

                const publishedRelativePath = `files/${prefix}/${source.expectedSha256}/${publishedName}`
                const managedCopy: VaultManifestManagedCopy = {
                  relativePath: publishedRelativePath,
                  fileName: publishedName,
                  publishedAtMs: marker.publishedAtMs || Date.now(),
                  verifiedSha256: source.expectedSha256,
                  verifiedByteSize: source.expectedByteSize
                }

                const sourceEntry: VaultManifestSourceEntry = {
                  fileLocationId: source.fileLocationId,
                  originalPath: source.originalPath,
                  fileName: source.fileName,
                  extension: source.extension,
                  category: source.category,
                  recordedFacts: {
                    byteSize: source.recordedFacts.byteSize,
                    filesystemBirthtimeMs: source.recordedFacts.filesystemBirthtimeMs,
                    filesystemMtimeMs: source.recordedFacts.filesystemMtimeMs,
                    firstDiscoveredAtMs: source.recordedFacts.firstDiscoveredAtMs,
                    lastSeenAtMs: source.recordedFacts.lastSeenAtMs,
                    discoveryObservationId: source.discoveryObservationId,
                    hashObservationId: source.recordedFacts.hashObservationId,
                    hashVerifiedAtMs: source.recordedFacts.hashVerifiedAtMs
                  },
                  inferredMetadata: {
                    inferredCaptureTimeMs: source.inferredMetadata.inferredCaptureTimeMs
                  },
                  reviewDecisions: {
                    isPreferred: source.reviewDecisions.isPreferred,
                    duplicateReviewStatus: source.reviewDecisions.duplicateReviewStatus
                  },
                  importResult: {
                    importJobId,
                    importedAtMs: Date.now(),
                    verifiedSourceSha256: source.expectedSha256,
                    verifiedSourceByteSize: source.expectedByteSize,
                    sourceStability: {
                      preCopyMtimeMs: preStat.mtimeMs,
                      postCopyMtimeMs: postStat.mtimeMs,
                      preCopyByteSize: preStat.size,
                      postCopyByteSize: postStat.size
                    }
                  }
                }

                const newManifest = mergeManifestSources(
                  null,
                  sourceEntry,
                  managedCopy,
                  vaultId,
                  source.expectedSha256,
                  source.expectedByteSize
                )
                writeVaultManifest(vaultPath, newManifest, importJobId)
                try {
                  unlinkSync(markerPath)
                } catch {
                  // Ignore
                }

                return {
                  status: 'success',
                  sha256: source.expectedSha256,
                  byteSize: source.expectedByteSize,
                  relativePath: publishedRelativePath,
                  manifestRelativePath: manifestRelPath,
                  reusedExistingCopy: false
                }
              }
            }
          }
        }
      } catch {
        // Failed reading marker, proceed to collision checks
      }
    }

    // Path C: Reject unmanaged files in destination directory
    if (existsSync(destDir)) {
      const existingEntries = readdirSync(destDir).filter((e) => !e.startsWith('.pv_in_progress_'))
      if (existingEntries.length > 0 || existsSync(destFilePath)) {
        if (stagingFilePath && existsSync(stagingFilePath)) {
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore
          }
        }
        return {
          status: 'error',
          code: 'destination_collision',
          message: `Destination directory "${destDir}" contains unmanaged files without a valid manifest or workflow ownership`
        }
      }
    }

    if (!stagingFilePath) {
      return {
        status: 'error',
        code: 'staging_missing',
        message: 'Internal error: staging file was not created'
      }
    }

    // 7. Independently verify destination staging file before publishing
    const verifyStagingHandle = await open(stagingFilePath, 'r')
    const verifyHasher = createHash('sha256')
    try {
      const verifyBuf = Buffer.alloc(CHUNK_SIZE)
      let verifyRead = 0
      while (
        (verifyRead = (await verifyStagingHandle.read(verifyBuf, 0, CHUNK_SIZE)).bytesRead) > 0
      ) {
        if (signal?.aborted) {
          return { status: 'cancelled' }
        }
        verifyHasher.update(verifyBuf.subarray(0, verifyRead))
      }
    } finally {
      await verifyStagingHandle.close()
    }

    const stagingSha = verifyHasher.digest('hex')
    if (stagingSha !== source.expectedSha256) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore
      }
      return {
        status: 'error',
        code: 'destination_hash_mismatch',
        message: `Staged destination SHA-256 digest ${stagingSha} did not match expected ${source.expectedSha256}`
      }
    }

    // 8. Publish staging file to destination with strict no-overwrite policy
    mkdirSync(destDir, { recursive: true })
    assertPathContainedInVault(vaultPath, destDir, 'destination directory')
    assertPathContainedInVault(vaultPath, destFilePath, 'destination file')

    if (existsSync(destFilePath)) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore
      }
      return {
        status: 'error',
        code: 'destination_collision',
        message: `Destination file "${destFilePath}" appeared concurrently`
      }
    }

    // Write in-progress marker before publishing
    const markerData = {
      vaultId,
      jobId: importJobId,
      sha256: source.expectedSha256,
      byteSize: source.expectedByteSize,
      fileName: safeName,
      publishedAtMs: Date.now()
    }
    writeFileSync(markerPath, JSON.stringify(markerData, null, 2), {
      encoding: 'utf-8',
      flag: 'w'
    })

    const currentStaging = stagingFilePath
    try {
      renameSync(currentStaging, destFilePath)
      stagingFilePath = null
    } catch {
      try {
        copyFileSync(currentStaging, destFilePath, constants.COPYFILE_EXCL)
        unlinkSync(currentStaging)
        stagingFilePath = null
      } catch (publishErr) {
        try {
          unlinkSync(markerPath)
        } catch {
          // Ignore
        }
        if (stagingFilePath && existsSync(stagingFilePath)) {
          try {
            unlinkSync(stagingFilePath)
          } catch {
            // Ignore
          }
        }
        return {
          status: 'error',
          code: 'destination_collision',
          message: `Failed to publish without overwriting: ${(publishErr as Error).message}`
        }
      }
    }

    // 9. Write portable metadata manifest
    const sourceEntry: VaultManifestSourceEntry = {
      fileLocationId: source.fileLocationId,
      originalPath: source.originalPath,
      fileName: source.fileName,
      extension: source.extension,
      category: source.category,
      recordedFacts: {
        byteSize: source.recordedFacts.byteSize,
        filesystemBirthtimeMs: source.recordedFacts.filesystemBirthtimeMs,
        filesystemMtimeMs: source.recordedFacts.filesystemMtimeMs,
        firstDiscoveredAtMs: source.recordedFacts.firstDiscoveredAtMs,
        lastSeenAtMs: source.recordedFacts.lastSeenAtMs,
        discoveryObservationId: source.discoveryObservationId,
        hashObservationId: source.recordedFacts.hashObservationId,
        hashVerifiedAtMs: source.recordedFacts.hashVerifiedAtMs
      },
      inferredMetadata: {
        inferredCaptureTimeMs: source.inferredMetadata.inferredCaptureTimeMs
      },
      reviewDecisions: {
        isPreferred: source.reviewDecisions.isPreferred,
        duplicateReviewStatus: source.reviewDecisions.duplicateReviewStatus
      },
      importResult: {
        importJobId,
        importedAtMs: Date.now(),
        verifiedSourceSha256: source.expectedSha256,
        verifiedSourceByteSize: source.expectedByteSize,
        sourceStability: {
          preCopyMtimeMs: preStat.mtimeMs,
          postCopyMtimeMs: postStat.mtimeMs,
          preCopyByteSize: preStat.size,
          postCopyByteSize: postStat.size
        }
      }
    }

    const managedCopy: VaultManifestManagedCopy = {
      relativePath: destRelativePath,
      fileName: safeName,
      publishedAtMs: Date.now(),
      verifiedSha256: source.expectedSha256,
      verifiedByteSize: source.expectedByteSize
    }

    const updatedManifest = mergeManifestSources(
      null,
      sourceEntry,
      managedCopy,
      vaultId,
      source.expectedSha256,
      source.expectedByteSize
    )
    writeVaultManifest(vaultPath, updatedManifest, importJobId)

    try {
      unlinkSync(markerPath)
    } catch {
      // Ignore
    }

    return {
      status: 'success',
      sha256: source.expectedSha256,
      byteSize: source.expectedByteSize,
      relativePath: destRelativePath,
      manifestRelativePath: manifestRelPath,
      reusedExistingCopy: false
    }
  } catch (err) {
    if (stagingFilePath && existsSync(stagingFilePath)) {
      try {
        unlinkSync(stagingFilePath)
      } catch {
        // Ignore staging cleanup error
      }
    }
    return {
      status: 'error',
      code: 'copy_failed',
      message: (err as Error).message || String(err)
    }
  } finally {
    try {
      await sourceHandle.close()
    } catch {
      // Ignore handle close error
    }
  }
}
