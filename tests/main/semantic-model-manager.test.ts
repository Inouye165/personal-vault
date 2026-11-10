/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
  existsSync,
  symlinkSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_REPO,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_PREPROCESSING_VERSION,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  SEMANTIC_MODEL_TOTAL_BYTES,
  REQUIRED_MODEL_ARTIFACTS,
  computeManifestSha256,
  type SemanticModelArtifactSpec
} from '../../src/main/services/semantic/manifest'
import { SemanticModelManager } from '../../src/main/services/semantic/model-manager'

function buildSyntheticArtifacts(): {
  specs: SemanticModelArtifactSpec[]
  files: Map<string, Buffer>
} {
  const files = new Map<string, Buffer>()
  const specs: SemanticModelArtifactSpec[] = REQUIRED_MODEL_ARTIFACTS.map((entry, idx) => {
    const content = Buffer.from(`synthetic-artifact-${idx}-${entry.relativePath}`)
    const sha256 = createHash('sha256').update(content).digest('hex')
    files.set(entry.relativePath, content)
    return {
      relativePath: entry.relativePath,
      byteSize: content.byteLength,
      sha256
    }
  })
  return { specs, files }
}

function writeSyntheticModelFolder(baseDir: string, files: Map<string, Buffer>): void {
  for (const [relPath, buf] of files.entries()) {
    const target = join(baseDir, ...relPath.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buf)
  }
}

describe('Stage 6B — SemanticModelManager & Pinned Manifest', () => {
  let tempDir: string
  let modelsRootDir: string
  let sourceRootDir: string
  let vaultRootDir: string
  let importFixtureDir: string
  let synthetic: { specs: SemanticModelArtifactSpec[]; files: Map<string, Buffer> }
  let server: Server | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-semantic-model-test-'))
    modelsRootDir = join(tempDir, 'userData', 'semantic-models')
    sourceRootDir = join(tempDir, 'photos-source')
    vaultRootDir = join(tempDir, 'vault-storage')
    importFixtureDir = join(tempDir, 'offline-bundle')
    mkdirSync(sourceRootDir, { recursive: true })
    mkdirSync(vaultRootDir, { recursive: true })
    mkdirSync(importFixtureDir, { recursive: true })
    synthetic = buildSyntheticArtifacts()
    writeSyntheticModelFolder(importFixtureDir, synthetic.files)
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('pins CLIP ViT-B/32 model constants, bicubic recipe version, 512 dimensions, and 7 artifacts', () => {
    expect(SEMANTIC_MODEL_ID).toBe('Xenova/clip-vit-base-patch32@6b7c5237')
    expect(SEMANTIC_MODEL_REPO).toBe('Xenova/clip-vit-base-patch32')
    expect(SEMANTIC_MODEL_COMMIT).toBe('6b7c523703ae26e39be4b03774966f8571c7f523')
    expect(SEMANTIC_PREPROCESSING_VERSION).toBe('clip_vit_b32_224_bicubic_center_rgb_v1')
    expect(SEMANTIC_EMBEDDING_DIMENSIONS).toBe(512)
    expect(REQUIRED_MODEL_ARTIFACTS).toHaveLength(7)
    expect(SEMANTIC_MODEL_TOTAL_BYTES).toBe(155851918)
    const manifestHash = computeManifestSha256(REQUIRED_MODEL_ARTIFACTS)
    expect(manifestHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports missing status initially and cleans up leftover owned staging directories without touching unrelated files', async () => {
    mkdirSync(modelsRootDir, { recursive: true })
    const leftoverStaging = join(modelsRootDir, '.model_staging_interrupted_123')
    mkdirSync(leftoverStaging, { recursive: true })
    writeFileSync(join(leftoverStaging, 'partial.tmp'), 'incomplete')

    const unrelatedFile = join(modelsRootDir, 'keep-note.txt')
    writeFileSync(unrelatedFile, 'preserve-me')

    const manager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [sourceRootDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: synthetic.specs
    })

    const status = await manager.initialize()
    expect(status.state).toBe('missing')
    expect(status.modelId).toBe(SEMANTIC_MODEL_ID)
    expect(status.preprocessingVersion).toBe(SEMANTIC_PREPROCESSING_VERSION)
    expect(status.dimensions).toBe(512)
    expect(existsSync(leftoverStaging)).toBe(false)
    expect(existsSync(unrelatedFile)).toBe(true)
    expect(readFileSync(unrelatedFile, 'utf-8')).toBe('preserve-me')
  })

  it('imports verified offline model folder into managed storage while leaving source folder untouched', async () => {
    const beforeSnapshots = new Map<string, { sha256: string; size: number; mtimeMs: number }>()
    for (const spec of synthetic.specs) {
      const p = join(importFixtureDir, ...spec.relativePath.split('/'))
      const st = statSync(p)
      const sha256 = createHash('sha256').update(readFileSync(p)).digest('hex')
      beforeSnapshots.set(spec.relativePath, { sha256, size: st.size, mtimeMs: st.mtimeMs })
    }

    const manager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [sourceRootDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: synthetic.specs
    })
    await manager.initialize()

    const status = await manager.importFromDirectory(importFixtureDir)
    expect(status.state).toBe('ready')
    expect(status.verifiedAtMs).toBeGreaterThan(0)

    // Verify source folder invariance
    for (const spec of synthetic.specs) {
      const p = join(importFixtureDir, ...spec.relativePath.split('/'))
      const st = statSync(p)
      const sha256 = createHash('sha256').update(readFileSync(p)).digest('hex')
      const before = beforeSnapshots.get(spec.relativePath)!
      expect(sha256).toBe(before.sha256)
      expect(st.size).toBe(before.size)
      expect(st.mtimeMs).toBe(before.mtimeMs)
    }

    // Verify managed files exist and match digests
    const installDir = manager.getActiveModelInstallDir()
    expect(installDir).not.toBeNull()
    for (const spec of synthetic.specs) {
      const managedFile = join(installDir!, ...spec.relativePath.split('/'))
      const sha256 = createHash('sha256').update(readFileSync(managedFile)).digest('hex')
      expect(sha256).toBe(spec.sha256)
    }
  })

  it('rejects corrupt or missing files during offline folder import and never marks model ready', async () => {
    const corruptFile = join(importFixtureDir, 'onnx', 'vision_model_quantized.onnx')
    writeFileSync(corruptFile, Buffer.from('corrupted-onnx-weights'))

    const manager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [sourceRootDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: synthetic.specs
    })
    await manager.initialize()

    const status = await manager.importFromDirectory(importFixtureDir)
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/digest|size|mismatch/i)
    expect(manager.getActiveModelInstallDir()).toBeNull()
  })

  it('rejects storage containment overlap with source roots or vault storage, and rejects symlinks', async () => {
    const overlappingManager = new SemanticModelManager({
      modelsRootDir: join(sourceRootDir, 'nested-models'),
      getApprovedRoots: () => [sourceRootDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: synthetic.specs
    })

    const overlapStatus = await overlappingManager.importFromDirectory(importFixtureDir)
    expect(overlapStatus.state).toBe('error')
    expect(overlapStatus.error).toMatch(/containment|source|vault|overlap/i)

    // Test symlink rejection inside import directory if OS permits creating symlink/junction
    const symlinkImportDir = join(tempDir, 'symlink-import')
    writeSyntheticModelFolder(symlinkImportDir, synthetic.files)
    const targetConfig = join(symlinkImportDir, 'config.json')
    const outsideConfig = join(tempDir, 'outside-config.json')
    writeFileSync(outsideConfig, synthetic.files.get('config.json')!)
    rmSync(targetConfig)
    let symlinkCreated: boolean
    try {
      symlinkSync(outsideConfig, targetConfig, 'file')
      symlinkCreated = true
    } catch {
      // Windows without developer mode may block file symlinks; test directory junction
      const onnxDir = join(symlinkImportDir, 'onnx')
      const outsideOnnxDir = join(tempDir, 'outside-onnx')
      mkdirSync(outsideOnnxDir, { recursive: true })
      writeFileSync(
        join(outsideOnnxDir, 'vision_model_quantized.onnx'),
        synthetic.files.get('onnx/vision_model_quantized.onnx')!
      )
      writeFileSync(
        join(outsideOnnxDir, 'text_model_quantized.onnx'),
        synthetic.files.get('onnx/text_model_quantized.onnx')!
      )
      writeFileSync(targetConfig, synthetic.files.get('config.json')!)
      rmSync(onnxDir, { recursive: true, force: true })
      symlinkSync(outsideOnnxDir, onnxDir, 'junction')
      symlinkCreated = true
    }

    if (symlinkCreated) {
      const validManager = new SemanticModelManager({
        modelsRootDir,
        getApprovedRoots: () => [sourceRootDir],
        getVaultRoot: () => vaultRootDir,
        artifacts: synthetic.specs
      })
      const symStatus = await validManager.importFromDirectory(symlinkImportDir)
      expect(symStatus.state).toBe('error')
      expect(symStatus.error).toMatch(/symlink|junction|reparse|canonical/i)
    }
  })

  it('validates downloads against pinned digests, sizes, and redirect policies via local HTTP fixture server', async () => {
    let behavior: 'valid' | 'bad_digest' | 'bad_size' | 'evil_redirect' | 'slow_stream' = 'valid'
    let serverPort = 0

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${serverPort}`)
      const relPath = url.pathname.replace(/^\/model\//, '')

      if (behavior === 'evil_redirect') {
        res.writeHead(302, { Location: 'http://evil.example.com/malicious.onnx' })
        res.end()
        return
      }

      const buf = synthetic.files.get(relPath)
      if (!buf) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      if (behavior === 'bad_digest') {
        const mutated = Buffer.from(buf)
        mutated[0] = (mutated[0] ?? 0) ^ 0xff
        res.writeHead(200, { 'Content-Length': String(mutated.byteLength) })
        res.end(mutated)
        return
      }

      if (behavior === 'bad_size') {
        const extra = Buffer.concat([buf, Buffer.from('extra-bytes')])
        res.writeHead(200, { 'Content-Length': String(extra.byteLength) })
        res.end(extra)
        return
      }

      if (behavior === 'slow_stream') {
        res.writeHead(200, { 'Content-Length': String(buf.byteLength) })
        res.write(buf.subarray(0, 4))
        // Keep connection open so cancellation can be exercised mid-download
        return
      }

      res.writeHead(200, { 'Content-Length': String(buf.byteLength) })
      res.end(buf)
    })

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address()
        if (addr && typeof addr === 'object') {
          serverPort = addr.port
        }
        resolve()
      })
    })

    const manager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [sourceRootDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: synthetic.specs,
      baseDownloadUrl: `http://127.0.0.1:${serverPort}/model`,
      allowedHosts: ['127.0.0.1'],
      allowLoopbackHttpForTests: true
    })
    await manager.initialize()

    // 1. Reject evil redirect host
    behavior = 'evil_redirect'
    const redirectStatus = await manager.downloadModel()
    expect(redirectStatus.state).toBe('error')
    expect(redirectStatus.error).toMatch(/host|redirect|protocol/i)

    // 2. Reject size mismatch
    behavior = 'bad_size'
    const sizeStatus = await manager.downloadModel()
    expect(sizeStatus.state).toBe('error')
    expect(sizeStatus.error).toMatch(/size|length/i)

    // 3. Reject digest mismatch
    behavior = 'bad_digest'
    const digestStatus = await manager.downloadModel()
    expect(digestStatus.state).toBe('error')
    expect(digestStatus.error).toMatch(/digest|sha256|mismatch/i)

    // 4. Cancel mid-download and verify cancelled state + staging cleanup
    behavior = 'slow_stream'
    const slowPromise = manager.downloadModel()
    await new Promise((r) => setTimeout(r, 40))
    const cancelStatus = await manager.cancelProvisioning()
    expect(cancelStatus.state).toBe('cancelled')
    const finalSlow = await slowPromise
    expect(finalSlow.state).toBe('cancelled')
    const entriesAfterCancel = existsSync(modelsRootDir) ? readdirSync(modelsRootDir) : []
    expect(entriesAfterCancel.filter((e) => e.startsWith('.model_staging_'))).toHaveLength(0)

    // 5. Succeed with valid artifacts
    behavior = 'valid'
    const okStatus = await manager.downloadModel()
    expect(okStatus.state).toBe('ready')
    expect(manager.getActiveModelInstallDir()).not.toBeNull()

    // 6. Preserve existing verified installation when a replacement fails
    behavior = 'bad_digest'
    const failedReplacement = await manager.downloadModel()
    expect(failedReplacement.state).toBe('ready')
    expect(failedReplacement.lastReplacementError).toMatch(/digest|sha256|mismatch/i)
    expect(manager.getActiveModelInstallDir()).not.toBeNull()
  })

  it('revalidates model integrity via off-main verifier before loading and detects tampering', async () => {
    let offMainCalls = 0
    const manager = new SemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [sourceRootDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: synthetic.specs,
      verifyDirectoryOffMain: async (dirPath, specs) => {
        offMainCalls += 1
        for (const spec of specs) {
          const filePath = join(dirPath, ...spec.relativePath.split('/'))
          const st = statSync(filePath)
          if (st.size !== spec.byteSize) {
            return { ok: false, error: `Size mismatch on ${spec.relativePath}` }
          }
          const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex')
          if (digest !== spec.sha256) {
            return { ok: false, error: `Digest mismatch on ${spec.relativePath}` }
          }
        }
        return { ok: true }
      }
    })

    await manager.initialize()
    await manager.importFromDirectory(importFixtureDir)
    expect(offMainCalls).toBeGreaterThanOrEqual(1)

    const verifiedBeforeLoad = await manager.revalidateForLoading()
    expect(verifiedBeforeLoad.ok).toBe(true)
    expect(offMainCalls).toBeGreaterThanOrEqual(2)

    // Tamper with an installed file on disk
    const installDir = manager.getActiveModelInstallDir()!
    writeFileSync(join(installDir, 'config.json'), 'tampered-after-install')

    const verifiedAfterTamper = await manager.revalidateForLoading()
    expect(verifiedAfterTamper.ok).toBe(false)
    expect(manager.getStatus().state).toBe('error')
  })
})
