// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DOC_SEMANTIC_EMBEDDING_BYTE_LENGTH,
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  DOC_SEMANTIC_MODEL_COMMIT,
  DOC_SEMANTIC_MODEL_ID,
  DocSemanticModelManager,
  DocSemanticModelSecurityError,
  DocumentSemanticWorkerRunner,
  REQUIRED_DOC_SEMANTIC_ARTIFACTS,
  type DocSemanticModelArtifactSpec
} from '../../src/main/services/documents/semantic'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'

const REPO_ROOT = resolve(__dirname, '../..')
const BUILT_WORKER_PATH = join(REPO_ROOT, 'out', 'main', 'document_semantic_worker.js')
const CACHED_BGE_DIR = join(
  REPO_ROOT,
  'spikes',
  'doc-semantic-eval',
  '.model-cache',
  'bge-small-en-v1.5'
)

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function createSyntheticArtifacts(sourceDir: string): DocSemanticModelArtifactSpec[] {
  const files: Array<{ relativePath: string; content: Buffer }> = [
    { relativePath: 'config.json', content: Buffer.from('{"hidden_size":384}\n', 'utf8') },
    { relativePath: 'tokenizer.json', content: Buffer.from('{"version":"1.0"}\n', 'utf8') },
    {
      relativePath: 'tokenizer_config.json',
      content: Buffer.from('{"model_max_length":512}\n', 'utf8')
    },
    {
      relativePath: 'special_tokens_map.json',
      content: Buffer.from('{"cls_token":"[CLS]"}\n', 'utf8')
    },
    {
      relativePath: 'onnx/model_quantized.onnx',
      content: Buffer.from('FAKE_ONNX_BYTES_V1', 'utf8')
    }
  ]

  const specs: DocSemanticModelArtifactSpec[] = []
  for (const file of files) {
    const abs = join(sourceDir, file.relativePath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, file.content)
    specs.push({
      relativePath: file.relativePath,
      byteSize: file.content.byteLength,
      sha256: sha256Hex(file.content)
    })
  }
  return specs
}

describe('DocSemanticModelManager', () => {
  let tempRoot: string
  let modelsRoot: string
  let approvedRoot: string
  let vaultRoot: string
  let sourceModelDir: string
  let artifacts: DocSemanticModelArtifactSpec[]
  let servers: Server[] = []

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pv-doc-sem-mgr-'))
    modelsRoot = join(tempRoot, 'models')
    approvedRoot = join(tempRoot, 'approved-docs')
    vaultRoot = join(tempRoot, 'vault')
    sourceModelDir = join(tempRoot, 'offline-bge')
    mkdirSync(modelsRoot, { recursive: true })
    mkdirSync(approvedRoot, { recursive: true })
    mkdirSync(vaultRoot, { recursive: true })
    mkdirSync(sourceModelDir, { recursive: true })
    artifacts = createSyntheticArtifacts(sourceModelDir)
    servers = []
  })

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolveClose) => s.close(() => resolveClose()))
    }
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('starts unprovisioned with zero automatic downloads', async () => {
    const manager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [approvedRoot],
      getVaultRoot: () => vaultRoot,
      artifacts
    })

    const status = await manager.initialize()
    expect(status.state).toBe('unprovisioned')
    expect(status.modelId).toBe(DOC_SEMANTIC_MODEL_ID)
    expect(status.modelCommit).toBe(DOC_SEMANTIC_MODEL_COMMIT)
    expect(status.installDir).toBeNull()
    expect(existsSync(manager.getInstallDir())).toBe(false)
  })

  it('rejects source-root and vault-root overlaps', async () => {
    const manager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [approvedRoot],
      getVaultRoot: () => vaultRoot,
      artifacts
    })
    await manager.initialize()

    const overlapApproved = join(approvedRoot, 'nested-model')
    mkdirSync(overlapApproved, { recursive: true })
    await expect(manager.importFromDirectory(overlapApproved)).rejects.toThrow(
      DocSemanticModelSecurityError
    )

    const overlapVault = join(vaultRoot, 'nested-model')
    mkdirSync(overlapVault, { recursive: true })
    await expect(manager.importFromDirectory(overlapVault)).rejects.toThrow(
      DocSemanticModelSecurityError
    )
  })

  it('imports from verified offline directory, verifies integrity, and rejects tampering while preserving prior valid install', async () => {
    const manager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [approvedRoot],
      getVaultRoot: () => vaultRoot,
      artifacts
    })
    await manager.initialize()

    const installed = await manager.importFromDirectory(sourceModelDir)
    expect(installed.state).toBe('ready')
    expect(installed.installDir).toBe(manager.getInstallDir())

    const checkOk = await manager.verifyInstalledIntegrity()
    expect(checkOk.installDir).toBe(manager.getInstallDir())

    // Attempt re-import from a tampered directory — must fail and keep existing install intact
    const tamperedDir = join(tempRoot, 'tampered-bge')
    mkdirSync(tamperedDir, { recursive: true })
    createSyntheticArtifacts(tamperedDir)
    writeFileSync(
      join(tamperedDir, 'onnx/model_quantized.onnx'),
      Buffer.from('TAMPERED_ONNX_BYTES')
    )

    await expect(manager.importFromDirectory(tamperedDir)).rejects.toThrow(/checksum|size/i)
    expect(manager.getStatus().state).toBe('ready')

    // Existing install directory must still pass integrity check
    const checkStillOk = await manager.verifyInstalledIntegrity()
    expect(checkStillOk.installDir).toBe(manager.getInstallDir())

    // Now tamper the installed file directly on disk and verify detection
    writeFileSync(join(manager.getInstallDir(), 'config.json'), Buffer.from('{"corrupted":true}'))
    await expect(manager.verifyInstalledIntegrity()).rejects.toThrow(/checksum|size/i)
    expect(manager.getStatus().state).toBe('corrupt')
    expect(manager.getStatus().errorCode).toBe('DOC_MODEL_INVALID')

    // Remove cleans up install
    const removed = await manager.removeModel()
    expect(removed.state).toBe('unprovisioned')
    expect(existsSync(manager.getInstallDir())).toBe(false)
  })

  it('rejects symlinked artifacts in import source directory', async () => {
    const symlinkSource = join(tempRoot, 'symlink-bge')
    mkdirSync(symlinkSource, { recursive: true })
    createSyntheticArtifacts(symlinkSource)
    const targetOutside = join(tempRoot, 'outside.json')
    writeFileSync(targetOutside, readFileSync(join(symlinkSource, 'config.json')))
    rmSync(join(symlinkSource, 'config.json'))

    let createdSymlink: boolean
    try {
      symlinkSync(targetOutside, join(symlinkSource, 'config.json'))
      createdSymlink = true
    } catch {
      // Windows without Developer Mode may forbid file symlinks; skip assertion cleanly if OS blocks symlink creation.
      createdSymlink = false
    }

    if (!createdSymlink) return

    const manager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [approvedRoot],
      getVaultRoot: () => vaultRoot,
      artifacts
    })
    await manager.initialize()

    const status = await manager.importFromDirectory(symlinkSource)
    expect(status.state).toBe('error')
    expect(status.errorMessage).toMatch(/symlink/i)
  })

  it('supports loopback HTTP download with redirects and active cancellation cleanup', async () => {
    const fileMap = new Map<string, Buffer>()
    for (const spec of artifacts) {
      fileMap.set(spec.relativePath, readFileSync(join(sourceModelDir, spec.relativePath)))
    }

    let throttleLastArtifact = false
    let releaseThrottledRequest: (() => void) | null = null

    const server = createServer((req, res) => {
      const urlPath = (req.url ?? '').replace(/^\/+/, '')
      if (urlPath.startsWith('redirect/')) {
        const target = urlPath.slice('redirect/'.length)
        res.writeHead(302, { Location: `/${target}` })
        res.end()
        return
      }
      const data = fileMap.get(urlPath)
      if (!data) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      if (throttleLastArtifact && urlPath === 'onnx/model_quantized.onnx') {
        res.writeHead(200, { 'Content-Length': String(data.byteLength) })
        res.write(data.subarray(0, 4))
        releaseThrottledRequest = () => {
          if (!res.writableEnded) {
            res.end(data.subarray(4))
          }
        }
        return
      }
      res.writeHead(200, { 'Content-Length': String(data.byteLength) })
      res.end(data)
    })
    servers.push(server)

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address')
    const baseUrl = `http://127.0.0.1:${addr.port}/redirect`

    const manager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [approvedRoot],
      getVaultRoot: () => vaultRoot,
      artifacts,
      baseDownloadUrl: baseUrl,
      allowedHosts: ['127.0.0.1'],
      allowLoopbackHttpForTests: true
    })
    await manager.initialize()

    const downloaded = await manager.downloadModel()
    expect(downloaded.state).toBe('ready')
    expect(downloaded.installDir).toBe(manager.getInstallDir())

    // Test disallowed host rejection
    const badHostMgr = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [approvedRoot],
      getVaultRoot: () => vaultRoot,
      artifacts,
      baseDownloadUrl: 'https://evil.example.com/model'
    })
    await expect(badHostMgr.downloadModel()).rejects.toThrow(DocSemanticModelSecurityError)

    // Test active cancellation cleans up staging directories
    await manager.removeModel()
    throttleLastArtifact = true
    const downloadPromise = manager.downloadModel()
    const downloadAbortExpect = expect(downloadPromise).rejects.toThrow(/cancelled/i)
    await new Promise((r) => setTimeout(r, 80))
    const cancelStatus = await manager.cancelProvisioning()
    expect(cancelStatus.state).toBe('cancelled')
    ;(releaseThrottledRequest as (() => void) | null)?.()
    await downloadAbortExpect

    const leftoverStaging = readdirSync(modelsRoot).filter((name) =>
      name.startsWith('.doc_model_staging_')
    )
    expect(leftoverStaging).toHaveLength(0)
  })

  it('cancels import and download cleanly during final off-main verification without publishing and preserves prior valid install', async () => {
    const fileMap = new Map<string, Buffer>()
    for (const spec of artifacts) {
      fileMap.set(spec.relativePath, readFileSync(join(sourceModelDir, spec.relativePath)))
    }
    const server = createServer((req, res) => {
      const urlPath = (req.url ?? '').replace(/^\/+/, '')
      const data = fileMap.get(urlPath)
      if (!data) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Length': String(data.byteLength) })
      res.end(data)
    })
    servers.push(server)
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address')

    let gateVerifier = false
    let notifyVerifyEntered: (() => void) | null = null
    let releaseVerify: ((res: { ok: boolean }) => void) | null = null

    const manager = new DocSemanticModelManager({
      modelsRootDir: modelsRoot,
      getApprovedRoots: () => [approvedRoot],
      getVaultRoot: () => vaultRoot,
      artifacts,
      baseDownloadUrl: `http://127.0.0.1:${addr.port}`,
      allowedHosts: ['127.0.0.1'],
      allowLoopbackHttpForTests: true,
      verifyDirectoryOffMain: async (dir) => {
        if (!gateVerifier || !dir.includes('.doc_model_staging_')) return { ok: true }
        notifyVerifyEntered?.()
        return await new Promise<{ ok: boolean }>((resolveGate) => {
          releaseVerify = resolveGate
        })
      }
    })
    await manager.initialize()

    // Case 1: unprovisioned import cancelled while final verifyDirectoryOffMain is in flight
    gateVerifier = true
    const verifyEntered1 = new Promise<void>((r) => {
      notifyVerifyEntered = r
    })
    const importPromise1 = manager.importFromDirectory(sourceModelDir)
    const importExpect1 = expect(importPromise1).rejects.toThrow(/cancelled/i)
    await verifyEntered1
    const cancelPromise1 = manager.cancelProvisioning()
    ;(releaseVerify as ((res: { ok: boolean }) => void) | null)?.({ ok: true })
    const cancelStatus1 = await cancelPromise1
    await importExpect1
    expect(cancelStatus1.state).toBe('cancelled')
    expect(existsSync(manager.getInstallDir())).toBe(false)
    expect(readdirSync(modelsRoot).filter((n) => n.startsWith('.doc_model_staging_'))).toHaveLength(
      0
    )

    // Case 2: unprovisioned download cancelled while final verifyDirectoryOffMain is in flight
    const verifyEntered2 = new Promise<void>((r) => {
      notifyVerifyEntered = r
    })
    const dlPromise = manager.downloadModel()
    const dlExpect = expect(dlPromise).rejects.toThrow(/cancelled/i)
    await verifyEntered2
    const cancelPromise2 = manager.cancelProvisioning()
    ;(releaseVerify as ((res: { ok: boolean }) => void) | null)?.({ ok: true })
    const cancelStatus2 = await cancelPromise2
    await dlExpect
    expect(cancelStatus2.state).toBe('cancelled')
    expect(existsSync(manager.getInstallDir())).toBe(false)
    expect(readdirSync(modelsRoot).filter((n) => n.startsWith('.doc_model_staging_'))).toHaveLength(
      0
    )

    // Case 3: install valid model first, then cancel a re-import during final verification -> prior install preserved
    gateVerifier = false
    const readyStatus = await manager.importFromDirectory(sourceModelDir)
    expect(readyStatus.state).toBe('ready')
    const markerBefore = readFileSync(join(manager.getInstallDir(), 'config.json'), 'utf8')

    gateVerifier = true
    const verifyEntered3 = new Promise<void>((r) => {
      notifyVerifyEntered = r
    })
    const reimportPromise = manager.importFromDirectory(sourceModelDir)
    const reimportExpect = expect(reimportPromise).rejects.toThrow(/cancelled/i)
    await verifyEntered3
    const cancelPromise3 = manager.cancelProvisioning()
    ;(releaseVerify as ((res: { ok: boolean }) => void) | null)?.({ ok: true })
    const cancelStatus3 = await cancelPromise3
    await reimportExpect
    expect(cancelStatus3.state).toBe('ready')
    expect(readFileSync(join(manager.getInstallDir(), 'config.json'), 'utf8')).toBe(markerBefore)
    expect(readdirSync(modelsRoot).filter((n) => n.startsWith('.doc_model_staging_'))).toHaveLength(
      0
    )
  })
})

describe('DocumentSemanticWorkerRunner', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pv-doc-sem-worker-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('releases AppWorkerBudget reservation synchronously when worker script path fails', async () => {
    const budget = new AppWorkerBudget(3)
    const runner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      isPackaged: true,
      appPath: tempRoot,
      workerScriptPath: join(tempRoot, 'nonexistent-worker.js')
    })

    await expect(runner.embedQuery(tempRoot, 'hello')).rejects.toThrow()
    expect(budget.getWorkerCount()).toBe(0)
    expect(budget.getReservedCount()).toBe(0)
    expect(budget.getLiveCount()).toBe(0)

    await runner.shutdown()
  })

  it('handles bounded queue, timeout recovery, in-flight cancellation with exit-confirmed retirement, and shutdown using a test worker', async () => {
    const testWorkerPath = join(tempRoot, 'mock-doc-worker.cjs')
    writeFileSync(
      testWorkerPath,
      `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  if (msg.type === 'embed_query') {
    if (msg.query === 'HANG') {
      if (msg.notifyInferenceStart) {
        parentPort.postMessage({ id: msg.id, type: 'inference_started', seqLen: 12 });
      }
      setTimeout(() => {
        const vec = new Float32Array(384);
        vec[0] = 1;
        parentPort.postMessage({
          id: msg.id,
          ok: true,
          embedResult: {
            vector: vec,
            dimensions: 384,
            tokenCount: 12,
            truncatedToSeqLimit: false,
            embedMs: 5
          }
        });
      }, 60000);
      return;
    }
    const vec = new Float32Array(384);
    vec[0] = 1;
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      embedResult: {
        vector: vec,
        dimensions: 384,
        tokenCount: 4,
        truncatedToSeqLimit: false,
        embedMs: 1
      }
    });
  }
});
`,
      'utf8'
    )

    const budget = new AppWorkerBudget(3)
    const runner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      workerScriptPath: testWorkerPath,
      workerTimeoutMs: 120,
      maxQueuedRequests: 2
    })

    // Queue bound check (maxQueuedRequests = 2: p1 active or queued + 2 queued -> p4 overflows)
    const p1 = runner.embedQuery(tempRoot, 'HANG')
    const p1TimeoutExpect = expect(p1).rejects.toThrow(/WORKER_TIMEOUT/)
    const p2 = runner.embedQuery(tempRoot, 'ok-2')
    const p3 = runner.embedQuery(tempRoot, 'ok-3')
    const p4 = runner.embedQuery(tempRoot, 'ok-4')
    await expect(p4).rejects.toThrow(/WORKER_QUEUE_FULL/)
    await p1TimeoutExpect
    expect((await p2).dimensions).toBe(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    expect((await p3).dimensions).toBe(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    expect(budget.getLiveCount()).toBe(1)

    // In-flight cancellation after inference_started + exit-confirmed retirement + recovery
    let inferenceStartedSeq = 0
    const hangPromise = runner.embedQuery(tempRoot, 'HANG', {
      notifyInferenceStart: true,
      onInferenceStarted: (seqLen) => {
        inferenceStartedSeq = seqLen
      }
    })
    await new Promise<void>((resolveWait) => {
      const check = () => {
        if (inferenceStartedSeq > 0) resolveWait()
        else setTimeout(check, 10)
      }
      check()
    })
    expect(inferenceStartedSeq).toBe(12)

    const hangAbortExpect = expect(hangPromise).rejects.toThrow(/CANCELLED/)
    await runner.cancelActiveRequests('CANCELLED: test abort')
    await hangAbortExpect
    expect(budget.getWorkerCount()).toBe(0)

    // Recovery after cancellation
    const recovered = await runner.embedQuery(tempRoot, 'recovered query')
    expect(recovered.dimensions).toBe(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    expect(recovered.vector.byteLength).toBe(DOC_SEMANTIC_EMBEDDING_BYTE_LENGTH)
    expect(budget.getLiveCount()).toBe(1)

    await runner.shutdown()
    expect(budget.getWorkerCount()).toBe(0)
  })

  it('executes real built document_semantic_worker end-to-end when built worker and cached BGE model exist', async () => {
    if (!existsSync(BUILT_WORKER_PATH) || !existsSync(CACHED_BGE_DIR)) {
      return
    }

    const budget = new AppWorkerBudget(3)
    const runner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      workerScriptPath: BUILT_WORKER_PATH,
      workerTimeoutMs: 30000
    })

    try {
      const verify = await runner.verifyModelDirectory(
        CACHED_BGE_DIR,
        REQUIRED_DOC_SEMANTIC_ARTIFACTS
      )
      expect(verify.ok).toBe(true)

      const chunkRes = await runner.chunkText(
        CACHED_BGE_DIR,
        'Invoice #INV-2026-441 for server rack maintenance.\n\nTotal due: $1,250.00.',
        { maxContentTokensPerChunk: 32, overlapTokens: 8 }
      )
      expect(chunkRes.chunks.length).toBeGreaterThanOrEqual(1)
      expect(chunkRes.truncated).toBe(false)

      const chunkVec = await runner.embedChunk(CACHED_BGE_DIR, chunkRes.chunks[0]!.text)
      expect(chunkVec.dimensions).toBe(384)
      expect(chunkVec.vector.byteLength).toBe(384 * 4)

      // In-flight cancellation during real ONNX inference + recovery
      let started = false
      const slowPromise = runner.embedChunk(
        CACHED_BGE_DIR,
        'Server maintenance hardware agreement. '.repeat(40),
        {
          notifyInferenceStart: true,
          repeatCount: 20,
          onInferenceStarted: () => {
            started = true
          }
        }
      )

      const deadline = Date.now() + 10000
      while (!started && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15))
      }
      expect(started).toBe(true)

      const slowAbortExpect = expect(slowPromise).rejects.toThrow(/CANCELLED/)
      await runner.cancelActiveRequests('CANCELLED: real onnx abort')
      await slowAbortExpect
      expect(budget.getWorkerCount()).toBe(0)

      const queryVec = await runner.embedQuery(CACHED_BGE_DIR, 'server rack invoice')
      expect(queryVec.dimensions).toBe(384)
      const diag = runner.getDiagnostics()
      expect(diag.nestedWorkerAttempts).toBe(0)
      expect(diag.outboundNetworkAttempts).toBe(0)
    } finally {
      await runner.shutdown()
      expect(budget.getWorkerCount()).toBe(0)
    }
  }, 60000)

  it('cancels and shuts down cleanly during worker admission without spawning or resolving after capacity release', async () => {
    const validWorkerPath = join(tempRoot, 'admission-worker.cjs')
    writeFileSync(
      validWorkerPath,
      `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  if (msg.type === 'verify_model') {
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      verifyResult: { ok: true },
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0
    });
  } else if (msg.type === 'embed_query') {
    const vec = new Float32Array(384);
    vec[0] = 1;
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      embedResult: {
        vector: Array.from(vec),
        dimensions: 384,
        tokenCount: 4,
        rawTokenCount: 4,
        truncated: false,
        embedMs: 1
      },
      nestedWorkerAttempts: 0,
      outboundNetworkAttempts: 0
    });
  }
});
`,
      'utf8'
    )

    const budget = new AppWorkerBudget(3)
    const runner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      workerScriptPath: validWorkerPath,
      admissionWaitTimeoutMs: 5000
    })

    // Hold all 3 capacity slots
    const r1 = budget.tryReserve()!
    const r2 = budget.tryReserve()!
    const r3 = budget.tryReserve()!
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r3).not.toBeNull()
    expect(budget.getReservedCount()).toBe(3)
    expect(budget.tryReserve()).toBeNull()

    // Submit verifyModelDirectory while capacity is full, then cancel, then release capacity
    const verifyPromise = runner.verifyModelDirectory(tempRoot, REQUIRED_DOC_SEMANTIC_ARTIFACTS)
    const verifyCancelExpect = expect(verifyPromise).rejects.toThrow(/CANCELLED/)
    await new Promise((r) => setTimeout(r, 40))
    await runner.cancelActiveRequests('CANCELLED: aborted during admission')
    budget.releaseReservation(r1)
    budget.releaseReservation(r2)
    budget.releaseReservation(r3)
    await verifyCancelExpect
    await new Promise((r) => setTimeout(r, 60))
    expect(budget.getWorkerCount()).toBe(0)
    expect(runner.getDiagnostics().liveWorkers).toBe(0)

    // Hold all 3 capacity slots again, submit embedQuery, call shutdown(), then release capacity
    const s1 = budget.tryReserve()!
    const s2 = budget.tryReserve()!
    const s3 = budget.tryReserve()!
    const embedPromise = runner.embedQuery(tempRoot, 'shutdown admission check')
    const embedShutdownExpect = expect(embedPromise).rejects.toThrow(/CANCELLED|shut down/i)
    await new Promise((r) => setTimeout(r, 40))
    const shutdownPromise = runner.shutdown()
    await new Promise((r) => setTimeout(r, 30))
    budget.releaseReservation(s1)
    budget.releaseReservation(s2)
    budget.releaseReservation(s3)
    await shutdownPromise
    await embedShutdownExpect
    expect(budget.getWorkerCount()).toBe(0)
    expect(runner.getDiagnostics().liveWorkers).toBe(0)
  })

  it('retains failed workers until confirmed exit, blocks premature replacement, and scopes exit events to owning worker', async () => {
    const workerPath = join(tempRoot, 'error-exit-ownership-worker.cjs')
    writeFileSync(
      workerPath,
      `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  if (msg.type === 'abort_and_exit') {
    return;
  }
  if (msg.type === 'embed_query' && msg.query === 'SLOW_SUCCESS') {
    setTimeout(() => {
      const vec = new Float32Array(384);
      vec[0] = 1;
      parentPort.postMessage({
        id: msg.id,
        ok: true,
        embedResult: {
          vector: Array.from(vec),
          dimensions: 384,
          tokenCount: 4,
          rawTokenCount: 4,
          truncated: false,
          embedMs: 2
        },
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      });
    }, 80);
  }
});
`,
      'utf8'
    )

    const budget = new AppWorkerBudget(3)
    const runner = new DocumentSemanticWorkerRunner({
      workerBudget: budget,
      workerScriptPath: workerPath,
      workerTimeoutMs: 5000
    })

    // Access private internals only for deterministic fault-injection of late worker error/exit & terminate() rejection
    const internalRunner = runner as unknown as {
      ensureWorker: () => Promise<import('node:worker_threads').Worker>
      terminateWorkerAndWaitExit: (w: import('node:worker_threads').Worker) => Promise<void>
      worker: import('node:worker_threads').Worker | null
    }

    const oldWorker = await internalRunner.ensureWorker()
    // Reject terminate() on oldWorker and delay its exit so we observe terminatingWorkers + budget retention
    oldWorker.terminate = () => Promise.reject(new Error('Simulated terminate() failure'))
    expect(budget.getWorkerCount()).toBe(1)

    // Inject 'error' on oldWorker while it has not yet exited
    oldWorker.emit('error', new Error('Simulated worker error'))
    expect(runner.getDiagnostics().terminatingWorkers).toBe(1)
    expect(runner.getDiagnostics().liveWorkers).toBe(1)
    expect(budget.getWorkerCount()).toBe(1)

    // Start replacement request while oldWorker is still alive — must wait for oldWorker's exit instead of spawning prematurely
    let replacementResolved = false
    const replacementPromise = runner.embedQuery(tempRoot, 'SLOW_SUCCESS').then((res) => {
      replacementResolved = true
      return res
    })
    await new Promise((r) => setTimeout(r, 40))
    expect(budget.getWorkerCount()).toBe(1)
    expect(replacementResolved).toBe(false)

    // Now emit actual exit on oldWorker -> replacement worker spawns and runs SLOW_SUCCESS
    // Also re-emit a late exit on oldWorker while replacement is in-flight to verify it does not reject replacement
    oldWorker.emit('exit', 1)
    await new Promise((r) => setTimeout(r, 30))
    oldWorker.emit('exit', 1)

    const res = await replacementPromise
    expect(res.dimensions).toBe(384)
    expect(budget.getWorkerCount()).toBe(1)

    await runner.shutdown()
    expect(budget.getWorkerCount()).toBe(0)
  })
})
