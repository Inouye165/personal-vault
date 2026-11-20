/**
 * Personal Vault — Stage 8A Bundle Exporter & Single Completion Rule
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import {
  ExportBundleManifestV1Schema,
  ExportCompletionMarkerSchema,
  ExportPrivacyOptionsSchema,
  type ExportBundleManifestV1,
  type ExportErrorCode
} from '../../../shared/validation/export-schemas'
import { validateExportParentAndBundlePath } from './containment'
import {
  exportSingleItemToBundle,
  publishManifestTextFileNoOverwrite,
  readAndValidatePublishedManifest,
  safeUnlink
} from './copier'
import { classifyDestinationFsError, getSanitizedExportErrorMessage } from './errors'
import { resolveExportBatchFileNames } from './naming'
import { buildExportBundleManifestV1 } from './sidecar'
import {
  EXPORT_COMPLETE_MARKER,
  EXPORT_IN_PROGRESS_MARKER,
  EXPORT_MANIFEST_FILENAME,
  EXPORT_SIDECAR_SUFFIX,
  EXPORT_TEMP_DIR_NAME,
  type ExportBundleIncompleteReason,
  type ExportBundleInspectionResult,
  type ExportBundleParams,
  type ExportBundleResult,
  type ExportItemOutcome,
  type ExportTestHooks
} from './types'

function isDestinationFatalError(code: ExportErrorCode): boolean {
  return (
    code === 'destination_disk_full' ||
    code === 'destination_read_only' ||
    code === 'destination_access_denied'
  )
}

function writeAndSyncMarkerFile(targetPath: string, payload: unknown): void {
  const bytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
  const fd = openSync(targetPath, 'wx')
  try {
    writeSync(fd, bytes, 0, bytes.length, 0)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export async function exportBundle(
  params: ExportBundleParams,
  hooks?: ExportTestHooks
): Promise<ExportBundleResult> {
  const privacyOptions = ExportPrivacyOptionsSchema.parse(params.privacyOptions)
  const createdAtMs = Date.now()

  const { bundleDir } = validateExportParentAndBundlePath({
    parentDir: params.parentDir,
    bundleFolderName: params.bundleFolderName,
    sourceRoots: params.sourceRoots,
    vaultRoots: params.vaultRoots,
    userDataDir: params.userDataDir
  })

  // Exclusive creation of bundle directory (never merges into an existing folder)
  mkdirSync(bundleDir)
  const tempDir = join(bundleDir, EXPORT_TEMP_DIR_NAME)
  mkdirSync(tempDir)

  const inProgressPath = join(bundleDir, EXPORT_IN_PROGRESS_MARKER)
  writeFileSync(
    inProgressPath,
    JSON.stringify(
      {
        formatVersion: 1,
        exportJobId: params.exportJobId,
        startedAtMs: createdAtMs,
        status: 'running'
      },
      null,
      2
    ),
    { encoding: 'utf8', flag: 'wx' }
  )

  const resolvedNames = resolveExportBatchFileNames(params.items)
  const itemOutcomes: ExportItemOutcome[] = []
  const manifestItems: ExportBundleManifestV1['items'] = []
  let exportedItems = 0
  let failedItems = 0
  let cancelledItems = 0
  let vaultIntegrityWarnings = 0
  let wasCancelled = Boolean(params.signal?.aborted)
  let fatalDestCode: ExportErrorCode | null = null

  for (const item of params.items) {
    if (wasCancelled || params.signal?.aborted) {
      wasCancelled = true
      cancelledItems++
      const msg = getSanitizedExportErrorMessage('cancelled')
      itemOutcomes.push({
        fileLocationId: item.fileLocationId,
        status: 'cancelled',
        exportedFileName: null,
        sidecarFileName: null,
        byteSourceUsed: null,
        vaultIntegrityWarning: null,
        errorCode: 'cancelled',
        errorMessage: msg
      })
      manifestItems.push({
        fileLocationId: item.fileLocationId,
        category: item.category,
        originalFileName: item.fileName,
        expectedSha256: item.expectedSha256,
        expectedByteSize: item.recordedFacts.byteSize,
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: msg,
        vaultIntegrityWarning: null,
        exportedFileName: null,
        sidecarFileName: null,
        originalSourcePath: null
      })
      continue
    }

    if (fatalDestCode) {
      failedItems++
      const msg = getSanitizedExportErrorMessage(fatalDestCode)
      itemOutcomes.push({
        fileLocationId: item.fileLocationId,
        status: 'failed',
        exportedFileName: null,
        sidecarFileName: null,
        byteSourceUsed: null,
        vaultIntegrityWarning: null,
        errorCode: fatalDestCode,
        errorMessage: msg
      })
      manifestItems.push({
        fileLocationId: item.fileLocationId,
        category: item.category,
        originalFileName: item.fileName,
        expectedSha256: item.expectedSha256,
        expectedByteSize: item.recordedFacts.byteSize,
        status: 'failed',
        errorCode: fatalDestCode,
        errorMessage: msg,
        vaultIntegrityWarning: null,
        exportedFileName: null,
        sidecarFileName: null,
        originalSourcePath: null
      })
      continue
    }

    const exportedFileName = resolvedNames.get(item.fileLocationId) ?? item.fileName
    const outcome = await exportSingleItemToBundle({
      exportJobId: params.exportJobId,
      bundleDir,
      exportedFileName,
      item,
      vaultPath: params.vaultPath,
      approvedRoots: params.sourceRoots,
      appVersion: params.appVersion,
      privacyOptions,
      signal: params.signal,
      hooks
    })

    if (outcome.status === 'completed') {
      exportedItems++
      if (outcome.vaultIntegrityWarning) {
        vaultIntegrityWarnings++
      }
      itemOutcomes.push({
        fileLocationId: item.fileLocationId,
        status: 'completed',
        exportedFileName: outcome.exportedFileName,
        sidecarFileName: outcome.sidecarFileName,
        byteSourceUsed: outcome.byteSourceUsed,
        vaultIntegrityWarning: outcome.vaultIntegrityWarning,
        errorCode: null,
        errorMessage: null
      })
      manifestItems.push({
        fileLocationId: item.fileLocationId,
        category: item.category,
        originalFileName: item.fileName,
        exportedFileName: outcome.exportedFileName,
        sidecarFileName: outcome.sidecarFileName,
        verifiedSha256: item.expectedSha256,
        verifiedByteSize: item.recordedFacts.byteSize,
        byteSourceUsed: outcome.byteSourceUsed,
        vaultIntegrityWarning: outcome.vaultIntegrityWarning,
        status: 'completed',
        originalSourcePath: privacyOptions.includeOriginalPaths ? item.originalPath : null
      })
    } else if (outcome.status === 'cancelled') {
      wasCancelled = true
      cancelledItems++
      const msg = getSanitizedExportErrorMessage('cancelled')
      itemOutcomes.push({
        fileLocationId: item.fileLocationId,
        status: 'cancelled',
        exportedFileName: null,
        sidecarFileName: null,
        byteSourceUsed: null,
        vaultIntegrityWarning: null,
        errorCode: 'cancelled',
        errorMessage: msg
      })
      manifestItems.push({
        fileLocationId: item.fileLocationId,
        category: item.category,
        originalFileName: item.fileName,
        expectedSha256: item.expectedSha256,
        expectedByteSize: item.recordedFacts.byteSize,
        status: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: msg,
        vaultIntegrityWarning: null,
        exportedFileName: null,
        sidecarFileName: null,
        originalSourcePath: null
      })
    } else {
      failedItems++
      if (outcome.vaultIntegrityWarning) {
        vaultIntegrityWarnings++
      }
      if (isDestinationFatalError(outcome.errorCode)) {
        fatalDestCode = outcome.errorCode
      }
      itemOutcomes.push({
        fileLocationId: item.fileLocationId,
        status: 'failed',
        exportedFileName: null,
        sidecarFileName: null,
        byteSourceUsed: null,
        vaultIntegrityWarning: outcome.vaultIntegrityWarning,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage
      })
      manifestItems.push({
        fileLocationId: item.fileLocationId,
        category: item.category,
        originalFileName: item.fileName,
        expectedSha256: item.expectedSha256,
        expectedByteSize: item.recordedFacts.byteSize,
        status: 'failed',
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        vaultIntegrityWarning: outcome.vaultIntegrityWarning,
        exportedFileName: null,
        sidecarFileName: null,
        originalSourcePath: null
      })
    }
  }

  const completedAtMs = Date.now()
  const terminalStatus: 'completed' | 'cancelled' | 'failed' = wasCancelled
    ? 'cancelled'
    : exportedItems === 0 && failedItems > 0
      ? 'failed'
      : 'completed'

  // Build, stage, publish, and read-back-validate export-manifest.json
  const manifestObj = buildExportBundleManifestV1({
    exportJobId: params.exportJobId,
    status: terminalStatus,
    createdAtMs,
    completedAtMs,
    appVersion: params.appVersion,
    privacyOptions,
    items: manifestItems,
    vaultIntegrityWarnings
  })
  const manifestJson = JSON.stringify(manifestObj, null, 2)
  const stagingManifestPath = join(tempDir, `pv_manifest_${params.exportJobId}_${randomUUID()}.tmp`)
  const manifestPath = join(bundleDir, EXPORT_MANIFEST_FILENAME)

  let manifestErrorCode: ExportErrorCode | null = null
  let manifestSha256: string | null = null

  try {
    const pub = await publishManifestTextFileNoOverwrite({
      stagingPath: stagingManifestPath,
      destPath: manifestPath,
      content: manifestJson,
      hooks
    })
    if (!pub.ok) {
      manifestErrorCode = pub.errorCode
      safeUnlink(stagingManifestPath)
    } else if (!readAndValidatePublishedManifest(manifestPath, pub.manifestSha256)) {
      manifestErrorCode = 'manifest_write_failed'
    } else {
      manifestSha256 = pub.manifestSha256
    }
  } catch (err) {
    manifestErrorCode = classifyDestinationFsError(err)
    safeUnlink(stagingManifestPath)
  }

  if (!manifestSha256 || manifestErrorCode) {
    // Manifest failed: leave .pv-export-in-progress.json in place and DO NOT create completion marker.
    const errCode = manifestErrorCode ?? 'manifest_write_failed'
    return {
      exportJobId: params.exportJobId,
      bundleDir,
      status: 'failed',
      manifestPublished: false,
      totalItems: params.items.length,
      exportedItems,
      failedItems,
      cancelledItems,
      vaultIntegrityWarnings,
      errorCode: errCode,
      errorMessage: getSanitizedExportErrorMessage(errCode),
      itemOutcomes
    }
  }

  // Create explicit completion marker ONLY after manifest read-back & validation succeeded
  try {
    const completePath = join(bundleDir, EXPORT_COMPLETE_MARKER)
    writeAndSyncMarkerFile(completePath, {
      formatVersion: 1,
      schema: 'pv_export_complete_v1',
      exportJobId: params.exportJobId,
      manifestSha256,
      completedAtMs,
      status: terminalStatus
    })
  } catch (err) {
    const errCode = classifyDestinationFsError(err)
    return {
      exportJobId: params.exportJobId,
      bundleDir,
      status: 'failed',
      manifestPublished: true,
      totalItems: params.items.length,
      exportedItems,
      failedItems,
      cancelledItems,
      vaultIntegrityWarnings,
      errorCode: errCode,
      errorMessage: getSanitizedExportErrorMessage(errCode),
      itemOutcomes
    }
  }

  // Clean up in-progress marker and empty temp dir
  safeUnlink(inProgressPath)
  try {
    if (existsSync(tempDir) && readdirSync(tempDir).length === 0) {
      rmdirSync(tempDir)
    }
  } catch {
    // Best-effort temp dir removal
  }

  return {
    exportJobId: params.exportJobId,
    bundleDir,
    status: terminalStatus,
    manifestPublished: true,
    totalItems: params.items.length,
    exportedItems,
    failedItems,
    cancelledItems,
    vaultIntegrityWarnings,
    errorCode: fatalDestCode,
    errorMessage: fatalDestCode ? getSanitizedExportErrorMessage(fatalDestCode) : null,
    itemOutcomes
  }
}

/**
 * Single completion rule distinguishing a verified terminal bundle from a partial manifest,
 * an orphaned file without sidecar, or leftover in-progress/temp artifacts.
 */
export function inspectExportBundleStatus(bundleDir: string): ExportBundleInspectionResult {
  const reasons: ExportBundleIncompleteReason[] = []

  if (!existsSync(bundleDir)) {
    return { isCompleteVerified: false, reasons: ['bundle_dir_missing'] }
  }

  if (existsSync(join(bundleDir, EXPORT_IN_PROGRESS_MARKER))) {
    reasons.push('in_progress_marker_present')
  }

  if (existsSync(join(bundleDir, EXPORT_TEMP_DIR_NAME))) {
    reasons.push('temp_dir_present')
  }

  const completeMarkerPath = join(bundleDir, EXPORT_COMPLETE_MARKER)
  let parsedMarker: ReturnType<typeof ExportCompletionMarkerSchema.parse> | null = null
  if (!existsSync(completeMarkerPath)) {
    reasons.push('completion_marker_missing')
  } else {
    try {
      const raw = readFileSync(completeMarkerPath, 'utf8')
      const res = ExportCompletionMarkerSchema.safeParse(JSON.parse(raw))
      if (!res.success) {
        reasons.push('completion_marker_invalid')
      } else {
        parsedMarker = res.data
      }
    } catch {
      reasons.push('completion_marker_invalid')
    }
  }

  const manifestPath = join(bundleDir, EXPORT_MANIFEST_FILENAME)
  let parsedManifest: ExportBundleManifestV1 | null = null
  if (!existsSync(manifestPath)) {
    reasons.push('manifest_missing')
  } else {
    try {
      const raw = readFileSync(manifestPath, 'utf8')
      const actualSha = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex')
      const res = ExportBundleManifestV1Schema.safeParse(JSON.parse(raw))
      if (!res.success) {
        reasons.push('manifest_invalid')
      } else {
        parsedManifest = res.data
        if (parsedMarker && actualSha.toLowerCase() !== parsedMarker.manifestSha256.toLowerCase()) {
          reasons.push('manifest_hash_mismatch')
        }
      }
    } catch {
      reasons.push('manifest_invalid')
    }
  }

  if (parsedManifest) {
    for (const item of parsedManifest.items) {
      if (item.status === 'completed') {
        if (
          !existsSync(join(bundleDir, item.exportedFileName)) ||
          !existsSync(join(bundleDir, item.sidecarFileName))
        ) {
          if (!reasons.includes('missing_pair_file')) {
            reasons.push('missing_pair_file')
          }
        }
      }
    }
  }

  // Detect any orphaned data files on disk lacking a matching .pv-meta.json sidecar
  const ignoredTopLevel = new Set([
    EXPORT_MANIFEST_FILENAME,
    EXPORT_IN_PROGRESS_MARKER,
    EXPORT_COMPLETE_MARKER,
    EXPORT_TEMP_DIR_NAME
  ])
  const entries = readdirSync(bundleDir)
  for (const entry of entries) {
    if (ignoredTopLevel.has(entry)) continue
    if (entry.endsWith(EXPORT_SIDECAR_SUFFIX)) continue
    if (!existsSync(join(bundleDir, `${entry}${EXPORT_SIDECAR_SUFFIX}`))) {
      if (!reasons.includes('orphaned_file_without_sidecar')) {
        reasons.push('orphaned_file_without_sidecar')
      }
    }
  }

  return {
    isCompleteVerified: reasons.length === 0,
    reasons
  }
}
