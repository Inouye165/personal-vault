// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APPROVED_OCR_DOWNLOAD_HOSTS,
  OCR_MODEL_COMMIT,
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  REQUIRED_OCR_MODEL_ARTIFACTS,
  computeOcrManifestSha256
} from '../../src/main/services/documents/ocr/manifest'
import { OcrModelManager } from '../../src/main/services/documents/ocr/model-manager'
import type { OcrModelArtifactSpec } from '../../src/main/services/documents/ocr/types'

function makeSyntheticArtifactSpec(bytes: Buffer): OcrModelArtifactSpec {
  return {
    relativePath: 'eng.traineddata',
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

describe('OcrModelManager & pinned English OCR manifest', () => {
  let tempRoot = ''
  let activeServer: Server | null = null

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pv-ocr-model-mgr-'))
  })

  afterEach(async () => {
    if (activeServer) {
      await new Promise<void>((res) => activeServer!.close(() => res()))
      activeServer = null
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('pins the exact tessdata_fast 4.1.0 English traineddata size, commit, and SHA-256', () => {
    expect(OCR_MODEL_ID).toBe('tesseract-ocr/tessdata_fast:eng@65727574')
    expect(OCR_MODEL_COMMIT).toBe('65727574dfcd264acbb0c3e07860e4e9e9b22185')
    expect(OCR_MODEL_LANGUAGE).toBe('eng')
    expect(REQUIRED_OCR_MODEL_ARTIFACTS).toEqual([
      {
        relativePath: 'eng.traineddata',
        byteSize: 4_113_088,
        sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
      }
    ])
    expect(APPROVED_OCR_DOWNLOAD_HOSTS).toContain('raw.githubusercontent.com')
    expect(computeOcrManifestSha256()).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reports missing status on initialize without performing any automatic download', async () => {
    const modelsRootDir = join(tempRoot, 'ocr-models')
    const manager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [join(tempRoot, 'sources')],
      getVaultRoot: () => join(tempRoot, 'vault'),
      baseDownloadUrl: 'http://127.0.0.1:1/unreachable'
    })

    const status = await manager.initialize()
    expect(status.state).toBe('missing')
    expect(status.error).toBeNull()
    expect(manager.getActiveModelInstallDir()).toBeNull()
  })

  it('rejects storage containment overlap with approved source roots or vault root', async () => {
    const sharedDir = join(tempRoot, 'sources')
    await mkdir(sharedDir, { recursive: true })

    const manager = new OcrModelManager({
      modelsRootDir: join(sharedDir, 'nested-ocr-models'),
      getApprovedRoots: () => [sharedDir],
      getVaultRoot: () => null
    })

    const status = await manager.initialize()
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/overlaps with approved source root/i)
  })

  it('imports a verified local directory, rejects tampered/wrong-size/symlink artifacts, and cleans staging', async () => {
    const validBytes = Buffer.from('SYNTHETIC_TESSDATA_PAYLOAD_V1_VALID_BYTES')
    const customArtifacts = [makeSyntheticArtifactSpec(validBytes)]
    const modelsRootDir = join(tempRoot, 'ocr-models')
    const validImportDir = join(tempRoot, 'import-valid')
    const badHashDir = join(tempRoot, 'import-bad-hash')
    await mkdir(validImportDir, { recursive: true })
    await mkdir(badHashDir, { recursive: true })

    const tampered = Buffer.from(validBytes)
    tampered[0]! ^= 0xff
    await writeFile(join(badHashDir, 'eng.traineddata'), tampered)

    const manager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [],
      getVaultRoot: () => null,
      artifacts: customArtifacts
    })

    const badRes = await manager.importFromDirectory(badHashDir)
    expect(badRes.state).toBe('error')
    expect(badRes.error).toMatch(/SHA-256 digest mismatch/i)

    // Ensure no leftover staging directories remain after failed import
    const entriesAfterFail = await readdir(modelsRootDir)
    expect(entriesAfterFail.filter((e) => e.startsWith('.ocr_model_staging_'))).toHaveLength(0)

    // Symlink artifact check (skip gracefully only if Windows lacks symlink privilege)
    const symlinkDir = join(tempRoot, 'import-symlink')
    await mkdir(symlinkDir, { recursive: true })
    const targetFile = join(tempRoot, 'external.traineddata')
    await writeFile(targetFile, validBytes)
    let createdSymlink: boolean
    try {
      await symlink(targetFile, join(symlinkDir, 'eng.traineddata'))
      createdSymlink = true
    } catch {
      createdSymlink = false
    }
    if (createdSymlink) {
      const symRes = await manager.importFromDirectory(symlinkDir)
      expect(symRes.state).toBe('error')
      expect(symRes.error).toMatch(/symlink/i)
    }

    // Valid import succeeds
    await writeFile(join(validImportDir, 'eng.traineddata'), validBytes)
    const okRes = await manager.importFromDirectory(validImportDir)
    expect(okRes.state).toBe('ready')
    expect(manager.getActiveModelInstallDir()).not.toBeNull()
    expect((await manager.revalidateForLoading()).ok).toBe(true)
  })

  it('rolls back to the previously active verified model if promotion fails or replacement import/download fails', async () => {
    const validBytes = Buffer.from('VERIFIED_ACTIVE_TESSDATA_ROLLBACK_CHECK')
    const customArtifacts = [makeSyntheticArtifactSpec(validBytes)]
    const modelsRootDir = join(tempRoot, 'ocr-models')
    const importDir = join(tempRoot, 'import-good')
    const corruptImportDir = join(tempRoot, 'import-corrupt')
    await mkdir(importDir, { recursive: true })
    await mkdir(corruptImportDir, { recursive: true })
    await writeFile(join(importDir, 'eng.traineddata'), validBytes)
    const corruptBytes = Buffer.from(validBytes)
    corruptBytes[4]! ^= 0xff
    await writeFile(join(corruptImportDir, 'eng.traineddata'), corruptBytes)

    let failSecondPromotionRename = false
    const { renameSync } = await import('node:fs')

    const manager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [],
      getVaultRoot: () => null,
      artifacts: customArtifacts,
      renameImpl: (oldPath, newPath) => {
        if (failSecondPromotionRename && String(oldPath).includes('.ocr_model_staging_')) {
          throw new Error('SIMULATED_PROMOTION_RENAME_FAILURE')
        }
        renameSync(oldPath, newPath)
      }
    })

    const initial = await manager.importFromDirectory(importDir)
    expect(initial.state).toBe('ready')

    // 1. Replacement with corrupt directory preserves ready state & active model
    const failedReplace = await manager.importFromDirectory(corruptImportDir)
    expect(failedReplace.state).toBe('ready')
    expect(failedReplace.lastReplacementError).toMatch(/SHA-256 digest mismatch/i)
    expect((await manager.revalidateForLoading()).ok).toBe(true)

    // 2. Simulated atomic rename failure after moving active install to backup rolls back cleanly
    failSecondPromotionRename = true
    const failedSwap = await manager.importFromDirectory(importDir)
    expect(failedSwap.state).toBe('ready')
    expect(failedSwap.lastReplacementError).toMatch(/SIMULATED_PROMOTION_RENAME_FAILURE/)
    expect((await manager.revalidateForLoading()).ok).toBe(true)

    const rootEntries = await readdir(modelsRootDir)
    expect(rootEntries.filter((e) => e.startsWith('.ocr_model_staging_'))).toHaveLength(0)
    expect(rootEntries.filter((e) => e.startsWith('.ocr_model_backup_'))).toHaveLength(0)
  })

  it('supports explicit verified download, redirect host validation, active cancellation, and cleanup', async () => {
    const validBytes = Buffer.alloc(128 * 1024, 0x5a)
    const customArtifacts = [makeSyntheticArtifactSpec(validBytes)]
    let mode: 'valid' | 'redirect-bad-host' | 'slow-stream' = 'redirect-bad-host'

    activeServer = createServer((req, res) => {
      if (mode === 'redirect-bad-host') {
        res.writeHead(302, { Location: 'https://untrusted-evil.example.com/eng.traineddata' })
        res.end()
        return
      }
      if (mode === 'slow-stream') {
        res.writeHead(200, { 'Content-Length': String(validBytes.byteLength) })
        res.write(validBytes.subarray(0, 16 * 1024))
        const timer = setTimeout(() => {
          res.end(validBytes.subarray(16 * 1024))
        }, 5000)
        req.on('close', () => clearTimeout(timer))
        return
      }
      res.writeHead(200, { 'Content-Length': String(validBytes.byteLength) })
      res.end(validBytes)
    })

    await new Promise<void>((res) => activeServer!.listen(0, '127.0.0.1', () => res()))
    const addr = activeServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const modelsRootDir = join(tempRoot, 'ocr-models')
    const manager = new OcrModelManager({
      modelsRootDir,
      getApprovedRoots: () => [],
      getVaultRoot: () => null,
      artifacts: customArtifacts,
      baseDownloadUrl: `http://127.0.0.1:${port}`,
      allowedHosts: ['127.0.0.1'],
      allowLoopbackHttpForTests: true
    })

    // 1. Disallowed redirect host rejected
    const redirectFail = await manager.downloadModel()
    expect(redirectFail.state).toBe('error')
    expect(redirectFail.error).toMatch(/Disallowed download host/i)

    // 2. Repeated active mid-download cancellations wait for Windows fileStream close & clean staging
    mode = 'slow-stream'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const downloadPromise = manager.downloadModel()
      await new Promise((r) => setTimeout(r, 20))
      const cancelStatus = await manager.cancelProvisioning()
      expect(cancelStatus.state).toBe('cancelled')
      const settledCancel = await downloadPromise
      expect(settledCancel.state).toBe('cancelled')
    }

    const entriesAfterCancel = await readdir(modelsRootDir)
    expect(entriesAfterCancel.filter((e) => e.startsWith('.ocr_model_staging_'))).toHaveLength(0)

    // 3. Valid explicit download succeeds and verifies SHA-256
    mode = 'valid'
    const okDownload = await manager.downloadModel()
    expect(okDownload.state).toBe('ready')
    expect(okDownload.downloadedBytes).toBe(validBytes.byteLength)
    expect((await manager.revalidateForLoading()).ok).toBe(true)

    // 4. Explicit removeModel cleans active directory
    const removed = await manager.removeModel()
    expect(removed.state).toBe('missing')
    expect(manager.getActiveModelInstallDir()).toBeNull()
  })

  it('shutdown() cancels and awaits active provisioning, cleans staging files, and preserves valid installations', async () => {
    const modelsRootDir = join(tempRoot, 'models-shutdown')
    const fakeBytes = Buffer.from('fake-tesseract-traineddata-payload-for-shutdown-test')
    const spec = makeSyntheticArtifactSpec(fakeBytes)
    let releaseResponse: (() => void) | null = null
    const requestStarted = new Promise<void>((resolve) => {
      activeServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': String(fakeBytes.byteLength) })
        res.write(fakeBytes.subarray(0, 6))
        resolve()
        releaseResponse = () => {
          res.end()
        }
      })
    })

    await new Promise<void>((resolve) => {
      activeServer!.listen(0, '127.0.0.1', () => resolve())
    })

    try {
      const addr = activeServer!.address() as { port: number }
      const manager = new OcrModelManager({
        modelsRootDir,
        getApprovedRoots: () => [],
        getVaultRoot: () => null,
        artifacts: [spec],
        baseDownloadUrl: `http://127.0.0.1:${addr.port}`,
        allowedHosts: ['127.0.0.1'],
        allowLoopbackHttpForTests: true
      })
      await manager.initialize()

      const downloadPromise = manager.downloadModel()
      await requestStarted

      // Calling shutdown() while download is mid-stream must abort, await completion, and clean staging
      await manager.shutdown()
      const finalStatus = await downloadPromise
      expect(finalStatus.state).toBe('cancelled')

      const entriesAfterCancel = await readdir(modelsRootDir)
      const leftover = entriesAfterCancel.filter((n) => n.startsWith('.ocr_model_staging_'))
      expect(leftover).toHaveLength(0)

      // Now install a valid model and verify shutdown() preserves it (even with no active provisioning)
      const importSource = join(tempRoot, 'valid-import')
      await mkdir(importSource, { recursive: true })
      await writeFile(join(importSource, 'eng.traineddata'), fakeBytes)
      const readyStatus = await manager.importFromDirectory(importSource)
      expect(readyStatus.state).toBe('ready')

      await manager.shutdown()
      expect(manager.getStatus().state).toBe('ready')
      expect(manager.getStatus().lastReplacementError).toBeNull()
      expect(manager.getActiveModelInstallDir()).not.toBeNull()
    } finally {
      if (releaseResponse) (releaseResponse as () => void)()
    }
  })
})
