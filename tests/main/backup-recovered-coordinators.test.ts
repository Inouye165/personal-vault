// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverCatalogFromVaultManifests } from '../../src/main/services/backup/catalog-recovery'
import { resolveReadableFileLocation } from '../../src/main/services/backup/recovered-file-resolver'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import {
  DocumentOcrCoordinator,
  OcrModelManager,
  type OcrModelArtifactSpec
} from '../../src/main/services/documents/ocr'
import { PhotoMetadataCoordinator } from '../../src/main/services/metadata/coordinator'
import { SemanticIndexCoordinator } from '../../src/main/services/semantic/coordinator'
import {
  REQUIRED_MODEL_ARTIFACTS,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  SEMANTIC_MODEL_ID,
  SEMANTIC_PREPROCESSING_VERSION,
  type SemanticModelArtifactSpec
} from '../../src/main/services/semantic/manifest'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { initializeVault } from '../../src/main/services/vault/identity'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function waitForDone<T extends { status: string }>(getProgress: () => T): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const p = getProgress()
    if (p.status === 'completed' || p.status === 'failed' || p.status === 'cancelled') {
      return p
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Job did not finish within 10s (status=${getProgress().status})`)
}

function writeVaultEntry(params: {
  vaultDir: string
  vaultId: string
  payload: Buffer
  fileName: string
  extension: string
  category: 'photo' | 'document'
  originalPath: string
}): { payloadPath: string; sha256: string } {
  const sha = sha256Of(params.payload)
  const prefix = sha.slice(0, 2)
  const contentDir = join(params.vaultDir, 'files', prefix, sha)
  mkdirSync(contentDir, { recursive: true })

  const relPayload = `files/${prefix}/${sha}/${params.fileName}`
  const payloadPath = join(contentDir, params.fileName)
  writeFileSync(payloadPath, params.payload)

  const manifest = {
    formatVersion: 1 as const,
    vaultId: params.vaultId,
    sha256: sha,
    byteSize: params.payload.length,
    managedCopy: {
      relativePath: relPayload,
      fileName: params.fileName,
      publishedAtMs: 1_700_000_001_000,
      verifiedSha256: sha,
      verifiedByteSize: params.payload.length
    },
    sources: [
      {
        fileLocationId: 1,
        originalPath: params.originalPath,
        fileName: params.fileName,
        extension: params.extension,
        category: params.category,
        recordedFacts: {
          byteSize: params.payload.length,
          filesystemBirthtimeMs: null,
          filesystemMtimeMs: 1_700_000_000_500,
          firstDiscoveredAtMs: 1_700_000_000_800,
          lastSeenAtMs: 1_700_000_000_900,
          discoveryObservationId: 100,
          hashObservationId: 200,
          hashVerifiedAtMs: 1_700_000_000_950
        },
        inferredMetadata: {
          inferredCaptureTimeMs: null
        },
        reviewDecisions: {
          isPreferred: false,
          duplicateReviewStatus: null
        },
        importResult: {
          importJobId: 'import-job-1',
          importedAtMs: 1_700_000_001_000,
          verifiedSourceSha256: sha,
          verifiedSourceByteSize: params.payload.length,
          sourceStability: {
            preCopyMtimeMs: 1_700_000_000_500,
            postCopyMtimeMs: 1_700_000_000_500,
            preCopyByteSize: params.payload.length,
            postCopyByteSize: params.payload.length
          }
        }
      }
    ]
  }

  writeFileSync(join(contentDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { payloadPath, sha256: sha }
}

function buildSyntheticSemanticModel(modelsRootDir: string): SemanticModelArtifactSpec[] {
  const specs = REQUIRED_MODEL_ARTIFACTS.map((entry, idx) => {
    const buf = Buffer.from(`synthetic-clip-weight-${idx}-${entry.relativePath}`)
    const sha256 = sha256Of(buf)
    const fullPath = join(modelsRootDir, 'clip-stage6b', ...entry.relativePath.split('/'))
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, buf)
    return {
      relativePath: entry.relativePath,
      byteSize: buf.byteLength,
      sha256
    }
  })
  return specs
}

function buildSyntheticOcrModel(modelsRootDir: string): OcrModelArtifactSpec[] {
  const bytes = Buffer.from('SYNTHETIC_TESSDATA_RECOVERED_PROFILE_TEST')
  const sha = sha256Of(bytes)
  const modelDir = join(modelsRootDir, 'ocr-stage7c')
  mkdirSync(modelDir, { recursive: true })
  writeFileSync(join(modelDir, 'eng.traineddata'), bytes)
  return [{ relativePath: 'eng.traineddata', byteSize: bytes.byteLength, sha256: sha }]
}

function writeSyntheticOcrWorkerScript(dir: string, logFilePath: string): string {
  const scriptPath = join(dir, 'synthetic_ocr_worker.cjs')
  writeFileSync(
    scriptPath,
    `const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const logPath = ${JSON.stringify(logFilePath)};
parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    parentPort.postMessage({ id: msg.id, type: 'shutdown_ack', ok: true, nestedWorkerAttempts: 0, outboundNetworkAttempts: 0 });
    return;
  }
  if (msg.type === 'verify_source' || msg.type === 'ocr_file') {
    const bytes = fs.readFileSync(msg.sourcePath);
    const st = fs.statSync(msg.sourcePath);
    const sha = createHash('sha256').update(bytes).digest('hex');
    fs.appendFileSync(logPath, JSON.stringify({ type: msg.type, sourcePath: msg.sourcePath, approvedRoots: msg.approvedRoots }) + '\\n');
    if (msg.type === 'verify_source') {
      parentPort.postMessage({
        id: msg.id,
        type: 'verify_result',
        ok: true,
        observedByteSize: st.size,
        observedMtimeMs: st.mtimeMs,
        observedSha256: sha,
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0,
        durationMs: 1
      });
      return;
    }
    const text = bytes.toString('utf8');
    parentPort.postMessage({
      id: msg.id,
      type: 'ocr_result',
      ok: true,
      observedByteSize: st.size,
      observedMtimeMs: st.mtimeMs,
      observedSha256: sha,
      maxInputBytesUsed: 67108864,
      outcome: {
        status: 'extracted',
        recipeVersion: 'doc_ocr_v1',
        extractionMethod: 'ocr_pdf_tesseract',
        text,
        extractedCharCount: text.length,
        pageCount: 1,
        ocrPageCount: 1,
        nativeOnlyPageCount: 0,
        skippedBlankPageCount: 0,
        meanConfidence: 95,
        truncated: false,
        truncationReason: null,
        statusDetail: null,
        pageDetails: []
      },
      engineTelemetry: null,
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0,
      durationMs: 2
    });
  }
});`
  )
  return scriptPath
}

describe('Recovered read-only profile — PhotoMetadata, SemanticIndex, and DocumentOcr coordinators', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads from verified vault copies when original source paths are missing or decoyed and leaves vault bytes untouched', async () => {
    const root = makeTempDir('pv-rec-coords-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'recovered-profile')
    const cacheDir = join(root, 'thumbnails')
    const modelsRootDir = join(root, 'models')

    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Recovered Coords Vault' })

    const jpegBytes = await sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 24, g: 130, b: 210 } }
    })
      .jpeg()
      .toBuffer()
    const missingPhotoOriginal = join(root, 'missing-source', 'vacation.jpg')
    const photoEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: jpegBytes,
      fileName: 'vacation.jpg',
      extension: '.jpg',
      category: 'photo',
      originalPath: missingPhotoOriginal
    })

    // Decoy exists at original_path with different bytes; OCR must read the vault copy instead.
    const decoyDocOriginal = join(root, 'decoy-source', 'invoice.pdf')
    mkdirSync(dirname(decoyDocOriginal), { recursive: true })
    writeFileSync(decoyDocOriginal, Buffer.from('%PDF-1.4\nDECOY ORIGINAL CONTENT\n'))

    const vaultPdfBytes = Buffer.from('%PDF-1.4\nVERIFIED VAULT OCR PAYLOAD 2026\n')
    const docEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: vaultPdfBytes,
      fileName: 'invoice.pdf',
      extension: '.pdf',
      category: 'document',
      originalPath: decoyDocOriginal
    })

    const photoMtimeBefore = statSync(photoEntry.payloadPath).mtimeMs
    const docMtimeBefore = statSync(docEntry.payloadPath).mtimeMs

    const recoveryReport = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })
    const catalog = CatalogDatabase.open({ catalogPath: recoveryReport.catalogPath })

    const thumbCoord = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null
    })
    await thumbCoord.initialize()

    const bundlesRootDir = join(root, 'model-bundles')
    const semanticSpecs = buildSyntheticSemanticModel(bundlesRootDir)
    const semanticBundleDir = join(bundlesRootDir, 'clip-stage6b')
    const semanticManager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [semanticBundleDir],
      getVaultRoot: () => vaultDir,
      artifacts: semanticSpecs,
      verifyDirectoryOffMain: (dirPath, artifactSpecs) =>
        thumbCoord.verifyModelDirectory(dirPath, artifactSpecs)
    })
    await semanticManager.initialize()
    await semanticManager.importFromDirectory(semanticBundleDir)

    const ocrSpecs = buildSyntheticOcrModel(bundlesRootDir)
    const ocrBundleDir = join(bundlesRootDir, 'ocr-stage7c')
    const ocrManager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [ocrBundleDir],
      getVaultRoot: () => vaultDir,
      artifacts: ocrSpecs
    })
    await ocrManager.initialize()
    await ocrManager.importFromDirectory(ocrBundleDir)

    const metadataCoord = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoord
    })
    metadataCoord.initialize()

    const seenSemanticPaths: string[] = []
    const semanticCoord = new SemanticIndexCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoord,
      modelManager: semanticManager,
      embedSourceTask: async (params) => {
        seenSemanticPaths.push(params.sourcePath)
        const bytes = readFileSync(params.sourcePath)
        const st = statSync(params.sourcePath)
        const vec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
        vec[0] = 1
        return {
          ok: true,
          sha256: sha256Of(bytes),
          observedByteSize: st.size,
          observedMtimeMs: st.mtimeMs,
          width: 32,
          height: 24,
          vector: vec
        }
      }
    })
    semanticCoord.initialize()

    const ocrWorkerLogPath = join(root, 'ocr-worker-calls.jsonl')
    const ocrWorkerScriptPath = writeSyntheticOcrWorkerScript(root, ocrWorkerLogPath)
    const ocrCoord = new DocumentOcrCoordinator({
      catalog,
      modelManager: ocrManager,
      workerScriptPath: ocrWorkerScriptPath
    })
    ocrCoord.initialize()

    try {
      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const photoRow = rawDb
        .prepare("SELECT id, original_path FROM file_locations WHERE category = 'photo';")
        .get() as { id: number; original_path: string }
      const docRow = rawDb
        .prepare("SELECT id, original_path FROM file_locations WHERE category = 'document';")
        .get() as { id: number; original_path: string }

      const resolvedPhoto = resolveReadableFileLocation(catalog, photoRow.id)
      const resolvedDoc = resolveReadableFileLocation(catalog, docRow.id)
      expect(resolvedPhoto.ok).toBe(true)
      expect(resolvedDoc.ok).toBe(true)
      if (!resolvedPhoto.ok || !resolvedDoc.ok) throw new Error('Expected vault copy resolution')

      // 1. PhotoMetadataCoordinator reads from vault copy
      await metadataCoord.startExtraction()
      const metaProgress = await waitForDone(() => metadataCoord.getProgress())
      expect(metaProgress.status).toBe('completed')
      expect(metaProgress.coverage.extractedCount + metaProgress.coverage.noMetadataCount).toBe(1)
      expect(metaProgress.coverage.failedCount).toBe(0)
      const metaRow = rawDb
        .prepare(
          'SELECT encoded_width_px, encoded_height_px FROM photo_technical_metadata WHERE file_location_id = ? AND is_current = 1;'
        )
        .get(photoRow.id) as { encoded_width_px: number; encoded_height_px: number } | undefined
      expect(metaRow).toBeDefined()
      expect(metaRow!.encoded_width_px).toBe(32)
      expect(metaRow!.encoded_height_px).toBe(24)

      // 2. SemanticIndexCoordinator reads from vault copy
      await semanticCoord.startIndexing()
      const semProgress = await waitForDone(() => semanticCoord.getStatus())
      expect(semProgress.status).toBe('completed')
      expect(semProgress.processedPhotos).toBe(1)
      expect(semProgress.failedPhotos).toBe(0)
      expect(seenSemanticPaths).toEqual([resolvedPhoto.filePath])
      const semRow = catalog.getPhotoSemanticEmbedding(
        photoRow.id,
        SEMANTIC_MODEL_ID,
        SEMANTIC_PREPROCESSING_VERSION
      )
      expect(semRow).not.toBeNull()
      expect(semRow!.contentSha256).toBe(photoEntry.sha256)

      // 3. DocumentOcrCoordinator reads from vault copy, not decoy original_path
      await ocrCoord.ocrSelected({ fileLocationIds: [docRow.id] })
      const ocrProgress = await waitForDone(() => ocrCoord.getProgress())
      expect(ocrProgress.status).toBe('completed')
      expect(ocrProgress.extractedItems).toBe(1)
      expect(ocrProgress.failedItems).toBe(0)
      const ocrCalls = readFileSync(ocrWorkerLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sourcePath: string; approvedRoots: string[] })
      expect(ocrCalls).toHaveLength(1)
      expect(ocrCalls[0]!.sourcePath).toBe(resolvedDoc.filePath)
      expect(ocrCalls[0]!.approvedRoots).toEqual(resolvedDoc.approvedRoots)
      const ocrPreview = ocrCoord.getOcrPreview(docRow.id)
      expect(ocrPreview?.extractedText).toContain('VERIFIED VAULT OCR PAYLOAD 2026')

      // Provenance and surviving vault payload bytes remain untouched
      expect(catalog.getFileLocationById(photoRow.id)?.originalPath).toBe(missingPhotoOriginal)
      expect(catalog.getFileLocationById(docRow.id)?.originalPath).toBe(decoyDocOriginal)
      expect(readFileSync(photoEntry.payloadPath)).toEqual(jpegBytes)
      expect(statSync(photoEntry.payloadPath).mtimeMs).toBe(photoMtimeBefore)
      expect(readFileSync(docEntry.payloadPath)).toEqual(vaultPdfBytes)
      expect(statSync(docEntry.payloadPath).mtimeMs).toBe(docMtimeBefore)
    } finally {
      await ocrCoord.shutdown()
      await semanticCoord.shutdown()
      await metadataCoord.shutdown()
      await thumbCoord.shutdown()
      catalog.close()
    }
  })

  it('fails closed on corrupt vault copies without falling back to original_path', async () => {
    const root = makeTempDir('pv-rec-coords-corrupt-')
    const vaultDir = join(root, 'vault')
    const targetProfileDir = join(root, 'recovered-profile')
    const cacheDir = join(root, 'thumbnails')
    const modelsRootDir = join(root, 'models')

    const identity = initializeVault({ vaultPath: vaultDir, vaultName: 'Corrupt Vault' })

    const origPhoto = join(root, 'orig', 'photo.jpg')
    const origDoc = join(root, 'orig', 'doc.pdf')
    mkdirSync(join(root, 'orig'), { recursive: true })
    const validJpeg = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(origPhoto, validJpeg)
    writeFileSync(origDoc, Buffer.from('%PDF-1.4\nORIG DOC\n'))

    const photoEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: validJpeg,
      fileName: 'photo.jpg',
      extension: '.jpg',
      category: 'photo',
      originalPath: origPhoto
    })
    const docEntry = writeVaultEntry({
      vaultDir,
      vaultId: identity.vaultId,
      payload: Buffer.from('%PDF-1.4\nVAULT DOC\n'),
      fileName: 'doc.pdf',
      extension: '.pdf',
      category: 'document',
      originalPath: origDoc
    })

    const recoveryReport = await recoverCatalogFromVaultManifests({
      sourceVaultDir: vaultDir,
      targetProfileDir
    })
    // Corrupt both vault payloads after recovery
    writeFileSync(photoEntry.payloadPath, Buffer.from('corrupt-photo-bytes'))
    writeFileSync(docEntry.payloadPath, Buffer.from('corrupt-doc-bytes'))

    const catalog = CatalogDatabase.open({ catalogPath: recoveryReport.catalogPath })
    const thumbCoord = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: () => catalog.getAllSourceRoots(),
      vaultPath: () => catalog.getActiveVault()?.vaultPath ?? null
    })
    await thumbCoord.initialize()

    const metadataCoord = new PhotoMetadataCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoord
    })
    metadataCoord.initialize()

    const bundlesRootDir = join(root, 'model-bundles')
    const semanticSpecs = buildSyntheticSemanticModel(bundlesRootDir)
    const semanticBundleDir = join(bundlesRootDir, 'clip-stage6b')
    const semanticManager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [semanticBundleDir],
      getVaultRoot: () => vaultDir,
      artifacts: semanticSpecs,
      verifyDirectoryOffMain: (dirPath, artifactSpecs) =>
        thumbCoord.verifyModelDirectory(dirPath, artifactSpecs)
    })
    await semanticManager.initialize()
    await semanticManager.importFromDirectory(semanticBundleDir)
    const semanticCoord = new SemanticIndexCoordinator({
      catalog,
      thumbnailCoordinator: thumbCoord,
      modelManager: semanticManager,
      embedSourceTask: async () => {
        throw new Error('embedSourceTask should not be called for corrupt vault copy')
      }
    })
    semanticCoord.initialize()

    const ocrSpecs = buildSyntheticOcrModel(bundlesRootDir)
    const ocrBundleDir = join(bundlesRootDir, 'ocr-stage7c')
    const ocrManager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [ocrBundleDir],
      getVaultRoot: () => vaultDir,
      artifacts: ocrSpecs
    })
    await ocrManager.initialize()
    await ocrManager.importFromDirectory(ocrBundleDir)
    const corruptOcrLogPath = join(root, 'corrupt-ocr-calls.jsonl')
    const ocrCoord = new DocumentOcrCoordinator({
      catalog,
      modelManager: ocrManager,
      workerScriptPath: writeSyntheticOcrWorkerScript(root, corruptOcrLogPath)
    })
    ocrCoord.initialize()

    try {
      await metadataCoord.startExtraction()
      const metaProgress = await waitForDone(() => metadataCoord.getProgress())
      expect(metaProgress.coverage.failedCount).toBe(1)
      expect(metaProgress.coverage.extractedCount).toBe(0)

      await semanticCoord.startIndexing()
      const semProgress = await waitForDone(() => semanticCoord.getStatus())
      expect(semProgress.failedPhotos).toBe(1)
      expect(semProgress.processedPhotos).toBe(0)

      const rawDb = (catalog as unknown as { db: import('node:sqlite').DatabaseSync }).db
      const docRow = rawDb
        .prepare("SELECT id FROM file_locations WHERE category = 'document';")
        .get() as { id: number }

      await ocrCoord.ocrSelected({ fileLocationIds: [docRow.id] })
      const ocrProgress = await waitForDone(() => ocrCoord.getProgress())
      expect(ocrProgress.failedItems).toBe(1)
      expect(ocrProgress.extractedItems).toBe(0)
    } finally {
      await ocrCoord.shutdown()
      await semanticCoord.shutdown()
      await metadataCoord.shutdown()
      await thumbCoord.shutdown()
      catalog.close()
    }
  })
})
