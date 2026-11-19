import { createHash } from 'node:crypto'
import { open, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export const NATIVE_EXTRACT_RECIPE_VERSION = 'doc_extract_v1'
export const OCR_RECIPE_VERSION = 'doc_ocr_v1'

export const NATIVE_EXTRACT_MAX_INPUT_BYTES = 32 * 1024 * 1024 // 33,554,432 B (Stage 7B default)
export const OCR_MAX_INPUT_BYTES = 64 * 1024 * 1024 // 67,108,864 B (Stage 7C explicit OCR limit)

export const OCR_LIMITS = Object.freeze({
  MAX_INPUT_BYTES: OCR_MAX_INPUT_BYTES,
  MAX_PDF_PAGES: 100,
  RASTER_DPI: 200,
  MAX_RASTER_EDGE_PX: 3200,
  MAX_RASTER_PIXELS: 9_000_000,
  MAX_IMAGE_INPUT_PIXELS: 40_000_000,
  MAX_EXTRACTED_CHARS: 500_000,
  MIN_NATIVE_SELECTABLE_CHARS: 16,
  LARGE_RASTER_COVERAGE_RATIO: 0.25,
  READ_CHUNK_BYTES: 64 * 1024
})

export const PINNED_OCR_MODEL_MANIFEST = Object.freeze({
  modelId: 'tesseract-ocr/tessdata_fast:eng',
  upstreamRepo: 'https://github.com/tesseract-ocr/tessdata_fast',
  pinnedTag: '4.1.0',
  pinnedCommit: '65727574dfcd264acbb0c3e07860e4e9e9b22185',
  license: 'Apache-2.0',
  language: 'eng',
  enginePackage: 'tesseract.js-core@7.0.0',
  engineOem: 1, // LSTM_ONLY
  files: Object.freeze({
    'eng.traineddata': Object.freeze({
      byteSize: 4_113_088,
      sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
    })
  })
})

export function computeOcrManifestSha256(manifest = PINNED_OCR_MODEL_MANIFEST) {
  const canonical = JSON.stringify({
    modelId: manifest.modelId,
    pinnedCommit: manifest.pinnedCommit,
    language: manifest.language,
    engineOem: manifest.engineOem,
    files: manifest.files
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export const PINNED_OCR_MANIFEST_SHA256 = computeOcrManifestSha256(PINNED_OCR_MODEL_MANIFEST)

export async function verifyPinnedTrainedData(modelDir, manifest = PINNED_OCR_MODEL_MANIFEST) {
  const expected = manifest.files['eng.traineddata']
  const trainedDataPath = path.join(modelDir, 'eng.traineddata')

  let fh = null
  try {
    const preStat = await lstat(trainedDataPath)
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      return {
        valid: false,
        code: 'ocr_model_not_regular_file',
        message: 'Pinned eng.traineddata must be a regular non-symlink file.'
      }
    }
    if (preStat.size !== expected.byteSize) {
      return {
        valid: false,
        code: 'ocr_model_size_mismatch',
        message: `Expected ${expected.byteSize} bytes for eng.traineddata, got ${preStat.size} bytes.`
      }
    }

    fh = await open(trainedDataPath, 'r')
    const handleStat = await fh.stat()
    if (handleStat.size !== expected.byteSize) {
      return {
        valid: false,
        code: 'ocr_model_size_mismatch',
        message: `Handle size mismatch for eng.traineddata (${handleStat.size} !== ${expected.byteSize}).`
      }
    }

    const buffer = Buffer.allocUnsafe(expected.byteSize)
    let offset = 0
    while (offset < expected.byteSize) {
      const { bytesRead } = await fh.read(buffer, offset, expected.byteSize - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== expected.byteSize) {
      return {
        valid: false,
        code: 'ocr_model_truncated_read',
        message: `Short read while verifying eng.traineddata (${offset}/${expected.byteSize}).`
      }
    }

    const actualSha256 = createHash('sha256').update(buffer).digest('hex')
    if (actualSha256 !== expected.sha256) {
      return {
        valid: false,
        code: 'ocr_model_hash_mismatch',
        message: `SHA-256 mismatch for eng.traineddata (expected ${expected.sha256}, got ${actualSha256}).`
      }
    }

    return {
      valid: true,
      trainedDataPath,
      byteSize: expected.byteSize,
      sha256: actualSha256,
      manifestSha256: computeOcrManifestSha256(manifest),
      buffer
    }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') {
      return {
        valid: false,
        code: 'ocr_model_missing',
        message: `Pinned eng.traineddata not found at ${trainedDataPath}.`
      }
    }
    return {
      valid: false,
      code: 'ocr_model_unreadable',
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (fh !== null) {
      await fh.close().catch(() => {})
    }
  }
}

function isRealPathWithinRoots(candidateReal, canonicalRoots) {
  const normCandidate = process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal
  for (const root of canonicalRoots) {
    const normRoot = process.platform === 'win32' ? root.toLowerCase() : root
    const rel = path.relative(normRoot, normCandidate)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true
    }
  }
  return false
}

/**
 * Shared bounded read-only source verifier.
 * Requires an EXPLICIT numeric maxInputBytes so Stage 7B (32 MiB) and Stage 7C (64 MiB)
 * never silently inherit each other's size cap.
 */
export async function readAndVerifySourceWithLimit({
  filePath,
  approvedRoots,
  maxInputBytes,
  expectedByteSize,
  expectedSha256
}) {
  if (!Number.isInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new TypeError('maxInputBytes must be an explicit positive integer')
  }

  const canonicalRoots = []
  for (const root of approvedRoots) {
    try {
      const rootStat = await lstat(root)
      if (rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
        canonicalRoots.push(await realpath(root))
      }
    } catch {
      // Ignore missing roots during validation
    }
  }

  const preLstat = await lstat(filePath)
  if (!preLstat.isFile() || preLstat.isSymbolicLink()) {
    return {
      status: 'failed',
      errorCode: 'not_regular_file',
      errorMessage: 'Source path must be a regular non-symlink file.'
    }
  }

  const realTarget = await realpath(filePath)
  if (!isRealPathWithinRoots(realTarget, canonicalRoots)) {
    return {
      status: 'failed',
      errorCode: 'outside_approved_roots',
      errorMessage: 'Source path resolves outside approved read-only roots.'
    }
  }

  let fh = null
  try {
    fh = await open(realTarget, 'r')
    const fstatBefore = await fh.stat()
    if (
      !fstatBefore.isFile() ||
      fstatBefore.size !== preLstat.size ||
      fstatBefore.mtimeMs !== preLstat.mtimeMs
    ) {
      return {
        status: 'failed',
        errorCode: 'source_changed_during_open',
        errorMessage: 'Source metadata changed while opening read-only handle.'
      }
    }

    if (expectedByteSize !== undefined && fstatBefore.size !== expectedByteSize) {
      return {
        status: 'failed',
        errorCode: 'source_size_changed',
        errorMessage: `Expected ${expectedByteSize} bytes, found ${fstatBefore.size} bytes.`
      }
    }

    if (fstatBefore.size > maxInputBytes) {
      return {
        status: 'truncated',
        truncationReason: 'max_input_bytes_exceeded',
        observedBytes: fstatBefore.size,
        maxInputBytes
      }
    }

    const chunks = []
    const hasher = createHash('sha256')
    const scratch = Buffer.allocUnsafe(OCR_LIMITS.READ_CHUNK_BYTES)
    let totalBytes = 0

    while (true) {
      const { bytesRead } = await fh.read(scratch, 0, scratch.length, totalBytes)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > maxInputBytes) {
        return {
          status: 'truncated',
          truncationReason: 'max_input_bytes_exceeded_midstream',
          observedBytes: totalBytes,
          maxInputBytes
        }
      }
      const slice = Buffer.from(scratch.subarray(0, bytesRead))
      hasher.update(slice)
      chunks.push(slice)
    }

    const fstatAfter = await fh.stat()
    const postLstat = await lstat(realTarget)
    if (
      totalBytes !== fstatBefore.size ||
      fstatAfter.size !== fstatBefore.size ||
      fstatAfter.mtimeMs !== fstatBefore.mtimeMs ||
      postLstat.size !== preLstat.size ||
      postLstat.mtimeMs !== preLstat.mtimeMs
    ) {
      return {
        status: 'failed',
        errorCode: 'source_mutated_during_read',
        errorMessage: 'Source file changed during bounded read.'
      }
    }

    const sha256 = hasher.digest('hex')
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      return {
        status: 'failed',
        errorCode: 'source_hash_mismatch',
        errorMessage: `Source SHA-256 changed from cataloged ${expectedSha256} to ${sha256}.`
      }
    }

    return {
      status: 'ok',
      buffer: Buffer.concat(chunks, totalBytes),
      byteSize: totalBytes,
      sha256,
      maxInputBytes
    }
  } finally {
    if (fh !== null) {
      await fh.close().catch(() => {})
    }
  }
}

/**
 * Per-page mixed-PDF OCR classifier (Requirement 5b).
 * - Digital text pages with >= MIN_NATIVE_SELECTABLE_CHARS keep native text directly.
 * - Image-bearing pages with 0 selectable chars always require OCR.
 * - Image-bearing pages with tiny text (< 16 chars, e.g. scanner stamp/page number) AND a
 *   large raster XObject (>= 25% of page area) require OCR so scanned content is not missed.
 * - Vector-only blank spacer pages (0 selectable chars AND 0 raster image ops) are skipped
 *   without false-triggering OCR.
 */
export function classifyPdfPageForOcr({
  selectableCharCount,
  rasterImageOpCount,
  maxRasterCoverageRatio = 0
}) {
  if (rasterImageOpCount <= 0) {
    return {
      needsOcr: false,
      reason: selectableCharCount > 0 ? 'native_text_only' : 'blank_or_vector_only'
    }
  }
  if (selectableCharCount === 0) {
    return {
      needsOcr: true,
      reason: 'image_only_page'
    }
  }
  if (
    selectableCharCount < OCR_LIMITS.MIN_NATIVE_SELECTABLE_CHARS &&
    maxRasterCoverageRatio >= OCR_LIMITS.LARGE_RASTER_COVERAGE_RATIO
  ) {
    return {
      needsOcr: true,
      reason: 'sparse_stamp_over_page_scan'
    }
  }
  return {
    needsOcr: false,
    reason: 'sufficient_native_text'
  }
}

/**
 * Dual-track coexistence & staleness validators (Requirement 5c).
 * Native extraction (`document_extractions`, recipe `doc_extract_v1`) and OCR extraction
 * (`document_ocr_extractions`, recipe `doc_ocr_v1`) live in independent current-record tracks.
 * Neither track overwrites the other's provenance or marks the other stale.
 */
export function isNativeExtractionCurrent(nativeRow, currentFileFact) {
  if (!nativeRow || !nativeRow.isCurrent) return false
  return (
    nativeRow.recipeVersion === NATIVE_EXTRACT_RECIPE_VERSION &&
    nativeRow.contentRevision === currentFileFact.contentRevision &&
    nativeRow.observedSha256 === currentFileFact.sha256 &&
    nativeRow.observedByteSize === currentFileFact.byteSize
  )
}

export function isOcrExtractionCurrent(ocrRow, currentFileFact, activeOcrPolicy) {
  if (!ocrRow || !ocrRow.isCurrent) return false
  return (
    ocrRow.recipeVersion === OCR_RECIPE_VERSION &&
    ocrRow.ocrModelId === activeOcrPolicy.modelId &&
    ocrRow.ocrModelManifestSha256 === activeOcrPolicy.manifestSha256 &&
    ocrRow.ocrLanguage === activeOcrPolicy.language &&
    ocrRow.contentRevision === currentFileFact.contentRevision &&
    ocrRow.observedSha256 === currentFileFact.sha256 &&
    ocrRow.observedByteSize === currentFileFact.byteSize
  )
}

export function composeDocumentExtractionTracks({
  currentFileFact,
  nativeRow,
  ocrRow,
  activeOcrPolicy
}) {
  const nativeCurrent = isNativeExtractionCurrent(nativeRow, currentFileFact)
  const ocrCurrent = isOcrExtractionCurrent(ocrRow, currentFileFact, activeOcrPolicy)

  return {
    fileLocationId: currentFileFact.fileLocationId,
    contentRevision: currentFileFact.contentRevision,
    nativeTrack: nativeRow
      ? {
          status: nativeCurrent ? nativeRow.status : 'stale',
          recipeVersion: nativeRow.recipeVersion,
          extractionMethod: nativeRow.extractionMethod,
          extractedCharCount: nativeRow.extractedCharCount,
          ocrCandidatePageCount: nativeRow.ocrCandidatePageCount ?? 0,
          provenancePreserved: true
        }
      : null,
    ocrTrack: ocrRow
      ? {
          status: ocrCurrent ? ocrRow.status : 'stale',
          recipeVersion: ocrRow.recipeVersion,
          extractionMethod: ocrRow.extractionMethod,
          ocrModelId: ocrRow.ocrModelId,
          ocrModelManifestSha256: ocrRow.ocrModelManifestSha256,
          ocrLanguage: ocrRow.ocrLanguage,
          ocrPageCount: ocrRow.ocrPageCount,
          meanConfidence: ocrRow.meanConfidence,
          extractedCharCount: ocrRow.extractedCharCount,
          provenancePreserved: true
        }
      : null,
    effectiveSearchableText:
      ocrCurrent && ocrRow.extractedText
        ? ocrRow.extractedText
        : nativeCurrent && nativeRow.extractedText
          ? nativeRow.extractedText
          : ''
  }
}
