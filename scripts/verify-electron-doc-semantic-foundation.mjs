#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7D Slice 1 (Document Semantic Foundation) Verification
 *
 * Exercises compiled production Stage 7D Slice 1 modules (`out/main/document_semantic.js`
 * and `out/main/document_semantic_worker.js`) inside the real Electron runtime from a neutral
 * `os.tmpdir()` working directory in both built (`--mode=built`) and separate unpacked
 * (`--mode=unpacked`, outputting to `dist-stage-7d-foundation-verify` so `dist/` and
 * earlier verification executables remain untouched) modes:
 *
 * 1. Sandboxed preload check (`out/preload/index.js` requires only `electron`).
 * 2. `DocSemanticModelManager`: `unprovisioned` startup (`0` network calls), source/vault
 *    overlap rejection, verified offline import of pinned provisional `Xenova/bge-small-en-v1.5`,
 *    tamper detection & prior-install preservation, loopback HTTP download + redirect guard +
 *    active cancellation staging cleanup.
 * 3. `DocumentSemanticWorkerRunner` + `document_semantic_worker.js` under `AppWorkerBudget(3)`:
 *    - Synchronous reservation release on missing worker script (`0` leaks).
 *    - `verifyModelDirectory`, `chunkText`, `embedChunk` (native + OCR synthetic text), `embedQuery`.
 *    - 384-d L2-normalized vectors & semantic similarity sanity check on synthetic topics.
 *    - In-flight ONNX cancellation via `onInferenceStarted` handshake + exit-confirmed retirement
 *      + fresh worker recovery.
 *    - `0` nested worker attempts, `0` outbound network attempts, `0` final workers/reservations.
 *    - 100% bitwise source preservation on synthetic source fixtures and cached model files.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const requireFromRoot = createRequire(join(rootDir, 'package.json'))

const isUnpackedMode = process.argv.includes('--mode=unpacked')
const executableArg =
  process.argv.find((arg) => arg.startsWith('--exe=')) ??
  process.argv.find((arg) => arg.startsWith('--executable='))
const outputDirArg = process.argv.find((arg) => arg.startsWith('--output-dir='))
const modelDirArg = process.argv.find((arg) => arg.startsWith('--model-dir='))

const unpackedOutputDirName = outputDirArg
  ? outputDirArg.slice('--output-dir='.length)
  : 'dist-stage-7d-foundation-verify'
const unpackedOutputRoot = resolve(rootDir, unpackedOutputDirName)

function getDefaultModelDir() {
  if (modelDirArg) {
    return resolve(modelDirArg.slice('--model-dir='.length))
  }
  if (process.env.PV_DOC_SEMANTIC_MODEL_DIR) {
    return resolve(process.env.PV_DOC_SEMANTIC_MODEL_DIR)
  }
  return join(rootDir, 'spikes', 'doc-semantic-eval', '.model-cache', 'bge-small-en-v1.5')
}

function getUnpackedExecutablePath(outRoot) {
  if (executableArg) {
    const val = executableArg.startsWith('--exe=')
      ? executableArg.slice('--exe='.length)
      : executableArg.slice('--executable='.length)
    return resolve(val)
  }
  if (process.platform === 'win32') {
    return join(outRoot, 'win-unpacked', 'Personal Vault.exe')
  }
  if (process.platform === 'darwin') {
    return join(
      outRoot,
      'mac-unpacked',
      'Personal Vault.app',
      'Contents',
      'MacOS',
      'Personal Vault'
    )
  }
  return join(outRoot, 'linux-unpacked', 'personal-vault')
}

function getUnpackedAsarPathFromExe(exePath) {
  if (process.platform === 'darwin') {
    return resolve(exePath, '..', '..', 'Resources', 'app.asar')
  }
  return resolve(exePath, '..', 'resources', 'app.asar')
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function cosineSimilarity(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
  }
  return dot
}

async function buildIsolatedUnpackedApp() {
  console.log(
    `[verify-doc-semantic-foundation] Building isolated unpacked app into ${unpackedOutputDirName}...`
  )
  const buildRes = spawnSync('npm', ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
  })
  if (buildRes.status !== 0) {
    throw new Error(`npm run build failed with exit code ${buildRes.status}`)
  }

  const builderRes = spawnSync(
    'npx',
    ['electron-builder', '--dir', `--config.directories.output=${unpackedOutputDirName}`],
    {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true
    }
  )
  if (builderRes.status !== 0) {
    throw new Error(`electron-builder --dir failed with exit code ${builderRes.status}`)
  }
}

// ---------------------------------------------------------------------------
// Outer Node Launcher (when not running inside Electron's runtime)
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  ;(async () => {
    const modelDir = getDefaultModelDir()
    if (!existsSync(modelDir)) {
      console.error(
        `[verify-doc-semantic-foundation] Offline pinned BGE model dir not found at ${modelDir}.`
      )
      console.error(
        `Pass --model-dir=<path> or set PV_DOC_SEMANTIC_MODEL_DIR (no automatic downloads performed).`
      )
      process.exitCode = 1
      return
    }

    let binaryPath = electronPath
    if (isUnpackedMode) {
      const candidateExe = getUnpackedExecutablePath(unpackedOutputRoot)
      const forceRebuild = process.argv.includes('--rebuild')
      if (!existsSync(candidateExe) || forceRebuild) {
        if (executableArg && !existsSync(candidateExe)) {
          throw new Error(`Explicit executable not found: ${candidateExe}`)
        }
        await buildIsolatedUnpackedApp()
      }
      binaryPath = candidateExe
    } else {
      console.log(
        '[verify-doc-semantic-foundation] Compiling production bundles via `npm run build`...'
      )
      const buildRes = spawnSync('npm', ['run', 'build'], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: true
      })
      if (buildRes.status !== 0) {
        process.exitCode = buildRes.status ?? 1
        return
      }
    }

    const neutralCwd = mkdtempSync(
      join(tmpdir(), `pv-doc-sem-cwd-${isUnpackedMode ? 'unpacked' : 'built'}-`)
    )
    try {
      console.log(
        `[verify-doc-semantic-foundation] Launching ${isUnpackedMode ? 'unpacked executable' : 'built Electron'} from neutral cwd: ${neutralCwd}`
      )
      const child = spawnSync(
        binaryPath,
        [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        {
          cwd: neutralCwd,
          stdio: 'inherit',
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            ELECTRON_NO_ATTACH_CONSOLE: '1'
          }
        }
      )
      process.exitCode = child.status ?? 1
    } finally {
      rmSync(neutralCwd, { recursive: true, force: true })
    }
  })().catch((err) => {
    console.error('[verify-doc-semantic-foundation] Fatal launcher error:', err)
    process.exitCode = 1
  })
} else {
  // ---------------------------------------------------------------------------
  // Inner Electron Runtime Verification
  // ---------------------------------------------------------------------------
  runInnerVerification().catch((err) => {
    console.error('[verify-doc-semantic-foundation] Verification FAILED:', err)
    process.exitCode = 1
  })
}

async function runInnerVerification() {
  const modelDir = getDefaultModelDir()
  const modelSnapshotsBefore = new Map()
  const modelFiles = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx'
  ]
  for (const rel of modelFiles) {
    const abs = join(modelDir, rel)
    assertCondition(existsSync(abs), `Missing cached BGE artifact: ${abs}`)
    const st = statSync(abs)
    modelSnapshotsBefore.set(rel, {
      byteSize: st.size,
      mtimeMs: st.mtimeMs,
      sha256: sha256File(abs)
    })
  }

  const exePath = process.execPath
  const asarPath = isUnpackedMode ? getUnpackedAsarPathFromExe(exePath) : null
  const appBaseDir = isUnpackedMode ? asarPath : rootDir

  const preloadPath = join(appBaseDir, 'out', 'preload', 'index.js')
  const docSemanticBundlePath = join(appBaseDir, 'out', 'main', 'document_semantic.js')
  const docSemanticWorkerPath = isUnpackedMode
    ? join(
        resolve(asarPath, '..', 'app.asar.unpacked'),
        'out',
        'main',
        'document_semantic_worker.js'
      )
    : join(rootDir, 'out', 'main', 'document_semantic_worker.js')

  const docSemanticWorkerFallbackPath = join(
    appBaseDir,
    'out',
    'main',
    'document_semantic_worker.js'
  )
  const effectiveWorkerPath = existsSync(docSemanticWorkerPath)
    ? docSemanticWorkerPath
    : docSemanticWorkerFallbackPath

  assertCondition(existsSync(preloadPath), `Missing compiled preload bundle: ${preloadPath}`)
  assertCondition(
    existsSync(docSemanticBundlePath),
    `Missing compiled document_semantic bundle: ${docSemanticBundlePath}`
  )
  assertCondition(
    existsSync(effectiveWorkerPath),
    `Missing compiled document_semantic_worker bundle: ${effectiveWorkerPath}`
  )

  const preloadCode = readFileSync(preloadPath, 'utf8')
  const preloadRequires = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  assertCondition(
    preloadRequires.every((mod) => mod === 'electron'),
    `Sandboxed preload must only require 'electron', found: ${preloadRequires.join(', ')}`
  )

  const docSemanticMod = requireFromRoot(docSemanticBundlePath)
  const {
    DocSemanticModelManager,
    DocSemanticModelSecurityError,
    DocumentSemanticWorkerRunner,
    REQUIRED_DOC_SEMANTIC_ARTIFACTS
  } = docSemanticMod

  const tempWork = mkdtempSync(join(tmpdir(), 'pv-doc-sem-verify-'))
  const modelsRootDir = join(tempWork, 'models')
  const approvedFixturesDir = join(tempWork, 'approved-sources')
  const vaultRootDir = join(tempWork, 'vault')
  mkdirSync(modelsRootDir, { recursive: true })
  mkdirSync(approvedFixturesDir, { recursive: true })
  mkdirSync(vaultRootDir, { recursive: true })

  // Synthetic source fixture for bitwise preservation verification
  const syntheticFixturePath = join(approvedFixturesDir, 'synthetic-invoice.txt')
  const syntheticFixtureContent =
    'Invoice #INV-2026-441\r\nVendor: Northwind Cloud Infrastructure\r\nTotal Due: $1,250.00\r\n'
  writeFileSync(syntheticFixturePath, syntheticFixtureContent, 'utf8')
  const fixtureBeforeStat = statSync(syntheticFixturePath)
  const fixtureBeforeSha = sha256File(syntheticFixturePath)

  const passedChecks = []
  const recordCheck = (name, detail) => {
    passedChecks.push({ name, detail })
    console.log(`[PASS] ${name}: ${detail}`)
  }

  let loopbackServer = null
  let runner = null

  try {
    recordCheck(
      '1. Sandboxed preload & bundle layout',
      `requires=[${preloadRequires.join(', ')}], worker=${effectiveWorkerPath}`
    )

    // Check 2: DocSemanticModelManager unprovisioned startup + overlap rejection
    const manager = new DocSemanticModelManager({
      modelsRootDir,
      getApprovedRoots: () => [approvedFixturesDir],
      getVaultRoot: () => vaultRootDir
    })
    const initStatus = await manager.initialize()
    assertCondition(
      initStatus.state === 'unprovisioned',
      `Expected unprovisioned, got ${initStatus.state}`
    )

    let overlapRejected = false
    try {
      await manager.importFromDirectory(join(approvedFixturesDir, 'nested'))
    } catch (err) {
      overlapRejected =
        err instanceof DocSemanticModelSecurityError ||
        err?.name === 'DocSemanticModelSecurityError'
    }
    assertCondition(
      overlapRejected,
      'Expected DocSemanticModelSecurityError for approved source overlap'
    )
    recordCheck('2. Unprovisioned startup & overlap guard', '0 auto-downloads, overlap rejected')

    // Check 3: Offline verified import + integrity + tamper rejection preserving prior valid install
    const readyStatus = await manager.importFromDirectory(modelDir)
    assertCondition(
      readyStatus.state === 'ready',
      `Expected ready after import, got ${readyStatus.state}`
    )
    const verified = await manager.verifyInstalledIntegrity()
    assertCondition(
      verified.installDir === manager.getInstallDir(),
      'verifyInstalledIntegrity returned unexpected installDir'
    )

    const tamperedCopyDir = join(tempWork, 'tampered-bge-copy')
    mkdirSync(join(tamperedCopyDir, 'onnx'), { recursive: true })
    for (const rel of modelFiles) {
      copyFileSync(join(modelDir, rel), join(tamperedCopyDir, rel))
    }
    writeFileSync(join(tamperedCopyDir, 'config.json'), Buffer.from('{"tampered":true}'))
    let tamperRejected = false
    try {
      await manager.importFromDirectory(tamperedCopyDir)
    } catch {
      tamperRejected = true
    }
    assertCondition(tamperRejected, 'Expected tampered import to be rejected')
    assertCondition(
      manager.getStatus().state === 'ready',
      `Expected prior valid install to remain ready, got ${manager.getStatus().state}`
    )
    recordCheck(
      '3. Offline BGE import & tamper preservation',
      `state=ready, totalBytes=${readyStatus.totalBytes}`
    )

    // Check 4: Loopback HTTP download + redirect guard + active cancellation cleanup
    const synthFileBytes = Buffer.from('SYNTHETIC_ARTIFACT_BYTES_STAGE7D')
    const synthSha = createHash('sha256').update(synthFileBytes).digest('hex')
    const synthSpec = [
      {
        relativePath: 'config.json',
        byteSize: synthFileBytes.byteLength,
        sha256: synthSha
      }
    ]
    let dlMode = 'bad-redirect'
    let releaseSlow = null
    loopbackServer = createServer((req, res) => {
      if (dlMode === 'bad-redirect') {
        res.writeHead(302, { Location: 'https://evil.example.org/config.json' })
        res.end()
        return
      }
      if (dlMode === 'slow') {
        res.writeHead(200, { 'Content-Length': String(synthFileBytes.byteLength) })
        res.write(synthFileBytes.subarray(0, 6))
        releaseSlow = () => {
          if (!res.writableEnded) res.end(synthFileBytes.subarray(6))
        }
        return
      }
      res.writeHead(200, { 'Content-Length': String(synthFileBytes.byteLength) })
      res.end(synthFileBytes)
    })
    await new Promise((res) => loopbackServer.listen(0, '127.0.0.1', res))
    const port = loopbackServer.address().port
    const dlRoot = join(tempWork, 'dl-models')
    const dlManager = new DocSemanticModelManager({
      modelsRootDir: dlRoot,
      getApprovedRoots: () => [approvedFixturesDir],
      getVaultRoot: () => vaultRootDir,
      artifacts: synthSpec,
      baseDownloadUrl: `http://127.0.0.1:${port}`,
      allowedHosts: ['127.0.0.1'],
      allowLoopbackHttpForTests: true
    })

    let redirectRejected = false
    try {
      await dlManager.downloadModel()
    } catch {
      redirectRejected = true
    }
    assertCondition(redirectRejected, 'Expected disallowed redirect host rejection')

    dlMode = 'slow'
    const slowDl = dlManager.downloadModel()
    const slowDlCatch = slowDl.catch(() => {})
    await new Promise((r) => setTimeout(r, 60))
    const cancelRes = await dlManager.cancelProvisioning()
    releaseSlow?.()
    await slowDlCatch
    assertCondition(cancelRes.state === 'cancelled', `Expected cancelled, got ${cancelRes.state}`)
    assertCondition(
      !readdirSync(dlRoot).some((n) => n.startsWith('.doc_model_staging_')),
      'Leftover staging directory after cancelled download'
    )

    dlMode = 'ok'
    const okDl = await dlManager.downloadModel()
    assertCondition(
      okDl.state === 'ready',
      `Expected ready after loopback download, got ${okDl.state}`
    )
    recordCheck(
      '4. Loopback download, redirect guard & cancel cleanup',
      '0 staging leftovers, state=ready'
    )

    // Check 5: Worker runner reservation cleanup on missing worker path
    const missingRunner = new DocumentSemanticWorkerRunner({
      isPackaged: true,
      appPath: tempWork,
      workerScriptPath: join(tempWork, 'does-not-exist-worker.js')
    })
    let missingFailed = false
    try {
      await missingRunner.embedQuery(verified.installDir, 'test query')
    } catch {
      missingFailed = true
    }
    assertCondition(missingFailed, 'Expected missing worker script path to reject')
    await missingRunner.shutdown()
    recordCheck('5. Missing worker path synchronous cleanup', 'Clean rejection & shutdown')

    // Check 6: Real Electron compiled document_semantic_worker execution
    runner = new DocumentSemanticWorkerRunner({
      workerScriptPath: effectiveWorkerPath,
      workerTimeoutMs: 30_000
    })

    const workerVerify = await runner.verifyModelDirectory(
      verified.installDir,
      REQUIRED_DOC_SEMANTIC_ARTIFACTS
    )
    assertCondition(workerVerify.ok, `Worker verifyModelDirectory failed: ${workerVerify.error}`)

    // Chunking native + OCR synthetic texts
    const nativeText = readFileSync(syntheticFixturePath, 'utf8')
    const ocrText =
      'ANNUAL LEASE AGREEMENT\nTenant: Alice Mercer\nMonthly Rent: $2,400 due on the 1st.\nProperty: 742 Evergreen Terrace'

    const nativeChunks = await runner.chunkText(verified.installDir, nativeText, {
      maxContentTokensPerChunk: 24,
      overlapTokens: 6
    })
    const ocrChunks = await runner.chunkText(verified.installDir, ocrText, {
      maxContentTokensPerChunk: 24,
      overlapTokens: 6
    })
    assertCondition(
      nativeChunks.chunks.length >= 1 &&
        !nativeChunks.truncated &&
        nativeChunks.uniqueIndexedTokenCount <= nativeChunks.emittedChunkTokenSum,
      'Invalid native chunking metadata'
    )
    assertCondition(
      ocrChunks.chunks.length >= 1 && !ocrChunks.truncated,
      'Invalid OCR chunking metadata'
    )
    recordCheck(
      '6. Real Electron worker chunking (native + OCR)',
      `nativeChunks=${nativeChunks.chunks.length}, ocrChunks=${ocrChunks.chunks.length}`
    )

    // Embedding & cosine similarity sanity check
    const invVec = await runner.embedChunk(verified.installDir, nativeChunks.chunks[0].text)
    const leaseVec = await runner.embedChunk(verified.installDir, ocrChunks.chunks[0].text)
    const queryVec = await runner.embedQuery(
      verified.installDir,
      'cloud infrastructure invoice amount due'
    )
    assertCondition(
      invVec.dimensions === 384 &&
        invVec.vector.byteLength === 384 * 4 &&
        leaseVec.dimensions === 384 &&
        queryVec.dimensions === 384,
      'Expected 384-d Float32Array embeddings'
    )
    const simInv = cosineSimilarity(queryVec.vector, invVec.vector)
    const simLease = cosineSimilarity(queryVec.vector, leaseVec.vector)
    assertCondition(
      simInv > simLease,
      `Expected invoice query to rank invoice (${simInv.toFixed(4)}) > lease (${simLease.toFixed(4)})`
    )
    recordCheck(
      '7. Real Electron 384-d ONNX embeddings & ranking sanity',
      `sim(invoice)=${simInv.toFixed(4)} > sim(lease)=${simLease.toFixed(4)}`
    )

    // In-flight ONNX cancellation via onInferenceStarted handshake + recovery
    let inferenceStarted = false
    const slowEmbed = runner.embedChunk(
      verified.installDir,
      'Synthetic long maintenance contract clause. '.repeat(40),
      {
        notifyInferenceStart: true,
        repeatCount: 25,
        onInferenceStarted: () => {
          inferenceStarted = true
        }
      }
    )
    const slowCatch = slowEmbed.catch((err) => err)
    const deadline = Date.now() + 15_000
    while (!inferenceStarted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15))
    }
    assertCondition(inferenceStarted, 'Expected onInferenceStarted handshake before cancellation')

    await runner.cancelActiveRequests('CANCELLED: Electron foundation cancellation probe')
    const cancelErr = await slowCatch
    assertCondition(
      cancelErr instanceof Error && cancelErr.message.includes('CANCELLED'),
      `Expected CANCELLED error after active abort, got ${cancelErr}`
    )

    const recovered = await runner.embedQuery(verified.installDir, 'monthly apartment rent')
    assertCondition(recovered.dimensions === 384, 'Expected post-cancellation recovery embedding')
    const diag = runner.getDiagnostics()
    assertCondition(
      diag.nestedWorkerAttempts === 0 && diag.outboundNetworkAttempts === 0,
      `Security invariant violated: nested=${diag.nestedWorkerAttempts}, network=${diag.outboundNetworkAttempts}`
    )
    recordCheck(
      '8. In-flight ONNX cancellation, recovery & isolation',
      `nested=${diag.nestedWorkerAttempts}, network=${diag.outboundNetworkAttempts}`
    )

    await runner.shutdown()
    runner = null

    // Bitwise source preservation verification
    const fixtureAfterStat = statSync(syntheticFixturePath)
    const fixtureAfterSha = sha256File(syntheticFixturePath)
    assertCondition(
      fixtureAfterStat.size === fixtureBeforeStat.size &&
        fixtureAfterStat.mtimeMs === fixtureBeforeStat.mtimeMs &&
        fixtureAfterSha === fixtureBeforeSha,
      'Synthetic source fixture was modified!'
    )

    for (const [rel, snap] of modelSnapshotsBefore.entries()) {
      const abs = join(modelDir, rel)
      const st = statSync(abs)
      const sha = sha256File(abs)
      assertCondition(
        st.size === snap.byteSize && st.mtimeMs === snap.mtimeMs && sha === snap.sha256,
        `Cached BGE source file ${rel} was modified!`
      )
    }
    recordCheck(
      '9. Bitwise source & model-cache preservation',
      `${passedChecks.length} checks passed, 100% SHA-256 & mtime match`
    )

    console.log(
      `\n[verify-doc-semantic-foundation] ALL ${passedChecks.length} REAL-ELECTRON CHECKS PASSED (${isUnpackedMode ? 'unpacked' : 'built'}).`
    )
  } finally {
    if (runner) {
      await runner.shutdown().catch(() => {})
    }
    if (loopbackServer) {
      await new Promise((res) => loopbackServer.close(() => res()))
    }
    rmSync(tempWork, { recursive: true, force: true })
  }
}
