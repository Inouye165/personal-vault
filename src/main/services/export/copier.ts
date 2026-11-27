/**
 * Personal Vault — Stage 8A Verified Export Copier & Atomic Publication
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ExportByteSourceUsed,
  ExportErrorCode,
  ExportPrivacyOptions,
  ExportVaultIntegrityWarning
} from '../../../shared/validation/export-schemas'
import { ExportBundleManifestV1Schema } from '../../../shared/validation/export-schemas'
import { isPathContainedInRoot } from '../hashing/path-security'
import { isTimestampConsistentWithExpectation } from '../hashing/hasher'
import { assertPathContainedInVault } from '../vault/containment'
import { classifyDestinationFsError, getSanitizedExportErrorMessage } from './errors'
import { buildExportSidecarV1 } from './sidecar'
import {
  EXPORT_SIDECAR_SUFFIX,
  EXPORT_TEMP_DIR_NAME,
  type ExportItemInput,
  type ExportTestHooks
} from './types'

const CHUNK_SIZE = 64 * 1024

export async function hashFileReadOnly(
  filePath: string,
  signal?: AbortSignal
): Promise<
  | { readonly ok: true; readonly sha256: string; readonly byteSize: number }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled: false; readonly error: unknown }
> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) {
      return { ok: false, cancelled: false, error: new Error('Not a regular file') }
    }
    const hasher = createHash('sha256')
    const buf = Buffer.alloc(CHUNK_SIZE)
    let bytesRead = 0
    while ((bytesRead = (await handle.read(buf, 0, CHUNK_SIZE)).bytesRead) > 0) {
      if (signal?.aborted) {
        return { ok: false, cancelled: true }
      }
      hasher.update(buf.subarray(0, bytesRead))
    }
    return { ok: true, sha256: hasher.digest('hex'), byteSize: stat.size }
  } catch (err) {
    return { ok: false, cancelled: false, error: err }
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Ignore close failure
      }
    }
  }
}

export function safeUnlink(targetPath: string | null | undefined): void {
  if (!targetPath) return
  try {
    if (existsSync(targetPath)) {
      unlinkSync(targetPath)
    }
  } catch {
    // Best-effort cleanup
  }
}

export async function publishStagedFileNoOverwrite(params: {
  readonly stagingPath: string
  readonly destPath: string
  readonly expectedSha256: string
  readonly expectedByteSize: number
  readonly hooks?: ExportTestHooks
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly errorCode: ExportErrorCode }> {
  const { stagingPath, destPath, expectedSha256, expectedByteSize, hooks } = params
  const doLink = hooks?.linkSync ?? linkSync
  const doCopy = hooks?.copyFileSync ?? copyFileSync

  try {
    hooks?.beforePublishHook?.(destPath)
  } catch (err) {
    return { ok: false, errorCode: classifyDestinationFsError(err) }
  }

  let usedCopyFallback = false
  try {
    doLink(stagingPath, destPath)
  } catch (linkErr) {
    const code = (linkErr as NodeJS.ErrnoException | null)?.code
    if (code === 'EEXIST') {
      return { ok: false, errorCode: 'destination_collision' }
    }
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') {
      return { ok: false, errorCode: classifyDestinationFsError(linkErr) }
    }

    usedCopyFallback = true
    try {
      doCopy(stagingPath, destPath, constants.COPYFILE_EXCL)
    } catch (copyErr) {
      return { ok: false, errorCode: classifyDestinationFsError(copyErr) }
    }
  }

  // On the COPYFILE_EXCL fallback path, independently verify final destination bytes before unlinking staging
  if (usedCopyFallback) {
    const verify = await hashFileReadOnly(destPath)
    if (
      !verify.ok ||
      verify.byteSize !== expectedByteSize ||
      verify.sha256.toLowerCase() !== expectedSha256.toLowerCase()
    ) {
      // Only safe to unlink because COPYFILE_EXCL guaranteed we just created destPath
      safeUnlink(destPath)
      return { ok: false, errorCode: 'destination_write_failed' }
    }
  }

  safeUnlink(stagingPath)
  return { ok: true }
}

function writeAndSyncStagingTextFile(stagingPath: string, content: string): string {
  const bytes = Buffer.from(content, 'utf8')
  const fd = openSync(stagingPath, 'wx')
  try {
    writeSync(fd, bytes, 0, bytes.length, 0)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return createHash('sha256').update(bytes).digest('hex')
}

function verifyOriginalSourcePathAllowed(
  originalPath: string,
  approvedRoots: readonly string[]
):
  | { readonly ok: true; readonly canonicalPath: string }
  | { readonly ok: false; readonly code: ExportErrorCode } {
  if (!existsSync(originalPath)) {
    return { ok: false, code: 'source_missing' }
  }
  let lstat
  try {
    lstat = lstatSync(originalPath)
  } catch {
    return { ok: false, code: 'source_missing' }
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    return { ok: false, code: 'source_not_regular_file' }
  }

  let canonicalSource: string
  try {
    canonicalSource = realpathSync(originalPath)
  } catch {
    return { ok: false, code: 'source_missing' }
  }

  const allowed = approvedRoots.some((root) => {
    try {
      const canonicalRoot = realpathSync(root)
      return isPathContainedInRoot(canonicalRoot, canonicalSource)
    } catch {
      return false
    }
  })

  if (!allowed) {
    return { ok: false, code: 'source_outside_approved_roots' }
  }
  return { ok: true, canonicalPath: canonicalSource }
}

async function streamReadAndVerifyToStaging(params: {
  readonly readPath: string
  readonly expectedSha256: string
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly enforceExpectedMtime: boolean
  readonly stagingPath: string
  readonly signal?: AbortSignal
  readonly hooks?: ExportTestHooks
}): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled: false; readonly errorCode: ExportErrorCode }
> {
  if (params.signal?.aborted) {
    return { ok: false, cancelled: true }
  }

  let sourceHandle
  try {
    sourceHandle = await open(params.readPath, 'r')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      cancelled: false,
      errorCode: code === 'ENOENT' ? 'source_missing' : 'source_changed'
    }
  }

  let stagingHandle
  try {
    const preStat = await sourceHandle.stat()
    if (!preStat.isFile()) {
      return { ok: false, cancelled: false, errorCode: 'source_not_regular_file' }
    }
    if (preStat.size !== params.expectedByteSize) {
      return { ok: false, cancelled: false, errorCode: 'source_changed' }
    }
    if (
      params.enforceExpectedMtime &&
      params.expectedMtimeMs !== null &&
      !isTimestampConsistentWithExpectation(preStat.mtimeMs, params.expectedMtimeMs)
    ) {
      return { ok: false, cancelled: false, errorCode: 'source_changed' }
    }

    stagingHandle = await open(params.stagingPath, 'wx')
    const hasher = createHash('sha256')
    const buffer = Buffer.alloc(CHUNK_SIZE)
    let bytesRead = 0

    while ((bytesRead = (await sourceHandle.read(buffer, 0, CHUNK_SIZE)).bytesRead) > 0) {
      params.hooks?.onChunkReadHook?.()
      if (params.signal?.aborted) {
        return { ok: false, cancelled: true }
      }
      const chunk = buffer.subarray(0, bytesRead)
      hasher.update(chunk)
      await stagingHandle.write(chunk)
    }

    await stagingHandle.sync()
    await stagingHandle.close()
    stagingHandle = undefined

    const postStat = await sourceHandle.stat()
    if (
      postStat.size !== preStat.size ||
      !isTimestampConsistentWithExpectation(postStat.mtimeMs, preStat.mtimeMs)
    ) {
      return { ok: false, cancelled: false, errorCode: 'source_changed' }
    }

    const liveStat = statSync(params.readPath)
    if (
      liveStat.size !== preStat.size ||
      !isTimestampConsistentWithExpectation(liveStat.mtimeMs, preStat.mtimeMs)
    ) {
      return { ok: false, cancelled: false, errorCode: 'source_changed' }
    }

    const computedSha = hasher.digest('hex')
    if (computedSha.toLowerCase() !== params.expectedSha256.toLowerCase()) {
      return { ok: false, cancelled: false, errorCode: 'source_hash_mismatch' }
    }

    // Independent staging read-back verification before publication
    const stagingVerify = await hashFileReadOnly(params.stagingPath, params.signal)
    if (!stagingVerify.ok) {
      if (stagingVerify.cancelled) return { ok: false, cancelled: true }
      return { ok: false, cancelled: false, errorCode: 'destination_write_failed' }
    }
    if (
      stagingVerify.byteSize !== params.expectedByteSize ||
      stagingVerify.sha256.toLowerCase() !== params.expectedSha256.toLowerCase()
    ) {
      return { ok: false, cancelled: false, errorCode: 'destination_write_failed' }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, cancelled: false, errorCode: classifyDestinationFsError(err) }
  } finally {
    if (stagingHandle) {
      try {
        await stagingHandle.close()
      } catch {
        // Ignore close failure
      }
    }
    try {
      await sourceHandle.close()
    } catch {
      // Ignore close failure
    }
  }
}

export type ExportSingleItemResult =
  | {
      readonly status: 'completed'
      readonly exportedFileName: string
      readonly sidecarFileName: string
      readonly byteSourceUsed: ExportByteSourceUsed
      readonly vaultIntegrityWarning: ExportVaultIntegrityWarning | null
    }
  | {
      readonly status: 'cancelled'
    }
  | {
      readonly status: 'failed'
      readonly errorCode: ExportErrorCode
      readonly errorMessage: string
      readonly vaultIntegrityWarning: ExportVaultIntegrityWarning | null
    }

export async function exportSingleItemToBundle(params: {
  readonly exportJobId: string
  readonly bundleDir: string
  readonly exportedFileName: string
  readonly item: ExportItemInput
  readonly vaultPath: string | null
  readonly approvedRoots: readonly string[]
  readonly appVersion: string
  readonly privacyOptions: ExportPrivacyOptions
  readonly signal?: AbortSignal
  readonly hooks?: ExportTestHooks
}): Promise<ExportSingleItemResult> {
  const {
    exportJobId,
    bundleDir,
    exportedFileName,
    item,
    vaultPath,
    approvedRoots,
    signal,
    hooks
  } = params
  const tempDir = join(bundleDir, EXPORT_TEMP_DIR_NAME)
  const sidecarFileName = `${exportedFileName}${EXPORT_SIDECAR_SUFFIX}`
  const destFilePath = join(bundleDir, exportedFileName)
  const destSidecarPath = join(bundleDir, sidecarFileName)

  if (signal?.aborted) {
    return { status: 'cancelled' }
  }

  let vaultIntegrityWarning: ExportVaultIntegrityWarning | null = null
  let byteSourceUsed: ExportByteSourceUsed = 'source_file'
  let stagingFilePath: string | null = null
  let stagingSidecarPath: string | null = null

  try {
    // 1. Prefer verified vault copy if registered
    let stagedFromVault = false
    if (vaultPath && item.vaultCopy) {
      const vaultCopyAbs = join(vaultPath, item.vaultCopy.relativePath)
      let vaultContainmentOk = false
      try {
        assertPathContainedInVault(vaultPath, vaultCopyAbs, 'vault copy')
        vaultContainmentOk = existsSync(vaultCopyAbs) && !lstatSync(vaultCopyAbs).isSymbolicLink()
      } catch {
        vaultContainmentOk = false
      }

      if (!vaultContainmentOk) {
        vaultIntegrityWarning = 'vault_copy_missing'
      } else {
        stagingFilePath = join(
          tempDir,
          `pv_exp_${exportJobId}_${item.fileLocationId}_${randomUUID()}.tmp`
        )
        const vaultStream = await streamReadAndVerifyToStaging({
          readPath: vaultCopyAbs,
          expectedSha256: item.expectedSha256,
          expectedByteSize: item.recordedFacts.byteSize,
          expectedMtimeMs: null,
          enforceExpectedMtime: false,
          stagingPath: stagingFilePath,
          signal,
          hooks
        })

        if (vaultStream.ok) {
          stagedFromVault = true
          byteSourceUsed = 'vault_copy'
        } else if (vaultStream.cancelled) {
          safeUnlink(stagingFilePath)
          return { status: 'cancelled' }
        } else {
          safeUnlink(stagingFilePath)
          stagingFilePath = null
          vaultIntegrityWarning =
            vaultStream.errorCode === 'source_missing'
              ? 'vault_copy_missing'
              : 'vault_copy_hash_mismatch'
        }
      }
    }

    // 2. Source read (primary when no vault copy, or fallback with warning when vault copy failed)
    if (!stagedFromVault) {
      const sourceCheck = verifyOriginalSourcePathAllowed(item.originalPath, approvedRoots)
      if (!sourceCheck.ok) {
        const finalCode: ExportErrorCode = vaultIntegrityWarning
          ? 'vault_and_source_unavailable'
          : sourceCheck.code
        return {
          status: 'failed',
          errorCode: finalCode,
          errorMessage: getSanitizedExportErrorMessage(finalCode),
          vaultIntegrityWarning
        }
      }

      stagingFilePath = join(
        tempDir,
        `pv_exp_${exportJobId}_${item.fileLocationId}_${randomUUID()}.tmp`
      )
      const sourceStream = await streamReadAndVerifyToStaging({
        readPath: sourceCheck.canonicalPath,
        expectedSha256: item.expectedSha256,
        expectedByteSize: item.recordedFacts.byteSize,
        expectedMtimeMs: item.recordedFacts.filesystemMtimeMs,
        enforceExpectedMtime: true,
        stagingPath: stagingFilePath,
        signal,
        hooks
      })

      if (!sourceStream.ok) {
        safeUnlink(stagingFilePath)
        if (sourceStream.cancelled) {
          return { status: 'cancelled' }
        }
        const finalCode: ExportErrorCode = vaultIntegrityWarning
          ? 'vault_and_source_unavailable'
          : sourceStream.errorCode
        return {
          status: 'failed',
          errorCode: finalCode,
          errorMessage: getSanitizedExportErrorMessage(finalCode),
          vaultIntegrityWarning
        }
      }

      byteSourceUsed = vaultIntegrityWarning ? 'source_fallback_after_vault_warning' : 'source_file'
    }

    if (!stagingFilePath) {
      return {
        status: 'failed',
        errorCode: 'destination_write_failed',
        errorMessage: getSanitizedExportErrorMessage('destination_write_failed'),
        vaultIntegrityWarning
      }
    }

    // 3. Build and stage sidecar before publishing either file
    const sidecarObj = buildExportSidecarV1({
      exportJobId,
      exportedAtMs: Date.now(),
      appVersion: params.appVersion,
      exportedFileName,
      verifiedSha256: item.expectedSha256,
      verifiedByteSize: item.recordedFacts.byteSize,
      byteSourceUsed,
      vaultIntegrityWarning,
      privacyOptions: params.privacyOptions,
      item
    })
    const sidecarJson = JSON.stringify(sidecarObj, null, 2)
    stagingSidecarPath = join(
      tempDir,
      `pv_sidecar_${exportJobId}_${item.fileLocationId}_${randomUUID()}.tmp`
    )
    const sidecarSha256 = writeAndSyncStagingTextFile(stagingSidecarPath, sidecarJson)
    const sidecarByteSize = Buffer.byteLength(sidecarJson, 'utf8')

    // 4. Publish data file without overwriting
    const pubFile = await publishStagedFileNoOverwrite({
      stagingPath: stagingFilePath,
      destPath: destFilePath,
      expectedSha256: item.expectedSha256,
      expectedByteSize: item.recordedFacts.byteSize,
      hooks
    })
    if (!pubFile.ok) {
      safeUnlink(stagingFilePath)
      safeUnlink(stagingSidecarPath)
      return {
        status: 'failed',
        errorCode: pubFile.errorCode,
        errorMessage: getSanitizedExportErrorMessage(pubFile.errorCode),
        vaultIntegrityWarning
      }
    }
    stagingFilePath = null

    // 5. Publish sidecar without overwriting; rollback data file if sidecar publication fails
    const pubSidecar = await publishStagedFileNoOverwrite({
      stagingPath: stagingSidecarPath,
      destPath: destSidecarPath,
      expectedSha256: sidecarSha256,
      expectedByteSize: sidecarByteSize,
      hooks
    })
    if (!pubSidecar.ok) {
      safeUnlink(destFilePath)
      safeUnlink(stagingSidecarPath)
      const errCode: ExportErrorCode =
        pubSidecar.errorCode === 'destination_collision'
          ? 'destination_collision'
          : 'sidecar_publish_failed'
      return {
        status: 'failed',
        errorCode: errCode,
        errorMessage: getSanitizedExportErrorMessage(errCode),
        vaultIntegrityWarning
      }
    }
    stagingSidecarPath = null

    return {
      status: 'completed',
      exportedFileName,
      sidecarFileName,
      byteSourceUsed,
      vaultIntegrityWarning
    }
  } catch (err) {
    safeUnlink(stagingFilePath)
    safeUnlink(stagingSidecarPath)
    const code = classifyDestinationFsError(err)
    return {
      status: 'failed',
      errorCode: code,
      errorMessage: getSanitizedExportErrorMessage(code),
      vaultIntegrityWarning
    }
  }
}

export function publishManifestTextFileNoOverwrite(params: {
  readonly stagingPath: string
  readonly destPath: string
  readonly content: string
  readonly hooks?: ExportTestHooks
}): Promise<
  | { readonly ok: true; readonly manifestSha256: string }
  | { readonly ok: false; readonly errorCode: ExportErrorCode }
> {
  const sha256 = writeAndSyncStagingTextFile(params.stagingPath, params.content)
  const byteSize = Buffer.byteLength(params.content, 'utf8')
  return publishStagedFileNoOverwrite({
    stagingPath: params.stagingPath,
    destPath: params.destPath,
    expectedSha256: sha256,
    expectedByteSize: byteSize,
    hooks: params.hooks
  }).then((res) => (res.ok ? { ok: true, manifestSha256: sha256 } : res))
}

export function readAndValidatePublishedManifest(
  manifestPath: string,
  expectedSha256: string
): boolean {
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    const actualSha = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex')
    if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      return false
    }
    const parsed: unknown = JSON.parse(raw)
    return ExportBundleManifestV1Schema.safeParse(parsed).success
  } catch {
    return false
  }
}
