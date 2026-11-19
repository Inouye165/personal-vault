#!/usr/bin/env node
/**
 * Personal Vault — Real Electron Stage 7E Slice 1 (Document Classification Foundation) Verification
 *
 * Exercises compiled production Stage 7E Slice 1 modules (`out/main/document_classify.js`
 * and `out/main/document_classify_worker.js`) inside the real Electron runtime from a neutral
 * `os.tmpdir()` working directory in both built (`--mode=built`) and separate unpacked
 * (`--mode=unpacked`, outputting to `dist-stage-7e-foundation-verify` so `dist/` and
 * earlier verification executables remain untouched) modes:
 *
 * 1. Sandboxed preload check (`out/preload/index.js` requires only `electron`).
 * 2. `DocumentClassificationWorkerRunner` + `document_classify_worker.js` under `AppWorkerBudget(3)`:
 *    - Synchronous reservation release on missing worker script (`0` leaks).
 *    - Single & batch classification (native, OCR confidence caps, `other` vs `unknown`, clutter).
 *    - Active cancellation + clean recovery on subsequent classification.
 *    - Tier 3 main-loop responsiveness (`monitorEventLoopDelay` p95 `< 100 ms`) on 500k docs.
 *    - `0` nested worker attempts, `0` outbound network attempts, `0` final workers/reservations.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
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

const unpackedOutputDirName = outputDirArg
  ? outputDirArg.slice('--output-dir='.length)
  : 'dist-stage-7e-foundation-verify'
const unpackedOutputRoot = resolve(rootDir, unpackedOutputDirName)

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

async function buildIsolatedUnpackedApp() {
  console.log(
    `[verify-doc-classify-foundation] Building isolated unpacked app into ${unpackedOutputDirName}...`
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

if (!process.versions.electron) {
  ;(async () => {
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
        '[verify-doc-classify-foundation] Compiling production bundles via `npm run build`...'
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
      join(tmpdir(), `pv-doc-cls-cwd-${isUnpackedMode ? 'unpacked' : 'built'}-`)
    )
    try {
      console.log(
        `[verify-doc-classify-foundation] Launching ${isUnpackedMode ? 'unpacked executable' : 'built Electron'} from neutral cwd: ${neutralCwd}`
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
  })()
} else {
  ;(async () => {
    let passed = 0
    let failed = 0
    function record(ok, name, detail = '') {
      if (ok) {
        passed += 1
        console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
      } else {
        failed += 1
        console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
      }
    }

    const appRoot = isUnpackedMode ? getUnpackedAsarPathFromExe(process.execPath) : rootDir

    const classifyModulePath = join(appRoot, 'out', 'main', 'document_classify.js')
    const preloadPath = join(appRoot, 'out', 'preload', 'index.js')

    try {
      // 1. Preload sandbox check
      const preloadCode = readFileSync(preloadPath, 'utf8')
      const requires = [...preloadCode.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
      record(
        requires.every((r) => r === 'electron'),
        'Sandboxed preload requires only electron',
        `requires=[${requires.join(', ')}]`
      )

      const mod = requireFromRoot(classifyModulePath)
      const { AppWorkerBudget, DocumentClassificationWorkerRunner, DETERMINISTIC_RULE_VERSION } =
        mod

      // 2. Synchronous spawn-failure reservation release
      const budget = new AppWorkerBudget(3)
      const failRunner = new DocumentClassificationWorkerRunner({
        workerBudget: budget,
        isPackaged: true,
        workerScriptPath: join(appRoot, 'out', 'main', 'missing_classify_worker.js')
      })
      let spawnFailedCleanly = false
      try {
        await failRunner.classifyDocument({
          fileName: 'note.txt',
          extension: '.txt',
          relativePath: 'note.txt',
          textSourceKind: 'native',
          text: 'General prose text with sufficient length to avoid short-text abstention.'
        })
      } catch {
        spawnFailedCleanly =
          budget.getLiveCount() === 0 && failRunner.getDiagnostics().liveWorkers === 0
      }
      await failRunner.shutdown()
      record(spawnFailedCleanly, 'Synchronous spawn-failure reservation release (0 leaks)')

      // 3. Worker classification (native, OCR caps, unknown vs other, clutter)
      const runner = new DocumentClassificationWorkerRunner({
        workerBudget: budget,
        appPath: appRoot,
        isPackaged: isUnpackedMode
      })

      try {
        const licenseRes = await runner.classifyDocument({
          fileName: 'LICENSE.txt',
          extension: '.txt',
          relativePath: 'repos/app/LICENSE.txt',
          extractionStatus: 'extracted',
          textSourceKind: 'native',
          text:
            'SPDX-License-Identifier: MIT\n' +
            'Permission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\n' +
            'WITHOUT WARRANTY OF ANY KIND.\n'
        })
        record(
          licenseRes.ruleVersion === DETERMINISTIC_RULE_VERSION &&
            licenseRes.classifierKind === 'deterministic_rules' &&
            licenseRes.isClutterCandidate === true &&
            licenseRes.originLabels.includes('software_project'),
          'Real-Electron worker classifies strong-evidence boilerplate clutter'
        )

        const batchRes = await runner.classifyBatch([
          {
            fileName: 'scan-low-ocr.pdf',
            extension: '.pdf',
            relativePath: 'Scans/scan-low-ocr.pdf',
            extractionStatus: 'extracted',
            textSourceKind: 'ocr',
            ocrMeanConfidence: 55,
            text: 'SPDX-License-Identifier: MIT\nPermission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\n'
          },
          {
            fileName: 'encrypted.pdf',
            extension: '.pdf',
            relativePath: 'Scans/encrypted.pdf',
            extractionStatus: 'password_protected',
            textSourceKind: 'none',
            text: null
          }
        ])
        record(
          batchRes.length === 2 &&
            batchRes[0].confidenceBand === 'low' &&
            batchRes[0].isClutterCandidate === false &&
            batchRes[1].purposeStatus === 'unknown',
          'Real-Electron worker enforces OCR confidence cap & unknown status'
        )

        // 4. Cancellation & clean recovery
        const pCancel = runner
          .classifyDocument({
            fileName: 'cancel-me.txt',
            extension: '.txt',
            relativePath: 'cancel-me.txt',
            textSourceKind: 'native',
            text: 'General prose document queued prior to active cancellation in real Electron.'
          })
          .catch((err) => err)
        await runner.cancelActiveRequests('CANCELLED: Electron smoke cancel')
        const cancelResult = await pCancel
        assertCondition(cancelResult instanceof Error, 'Expected cancelled request to reject')
        const recovered = await runner.classifyDocument({
          fileName: 'after-cancel.txt',
          extension: '.txt',
          relativePath: 'after-cancel.txt',
          textSourceKind: 'native',
          text: 'General prose document executed after worker cancellation recovery with sufficient length.'
        })
        record(
          recovered.purposeStatus === 'other' && recovered.isClutterCandidate === false,
          'Active cancellation & clean worker recovery'
        )

        // 5. Tier 3 sustained main-loop responsiveness on 500k docs + zero network/nested workers
        const MIN_EVENT_LOOP_SAMPLES = 15
        const MIN_WORKLOAD_DURATION_MS = 200
        const MAX_WORKLOAD_ITERATIONS = 100
        const large500k = 'General archival line for Electron responsiveness verification.\n'
          .repeat(9000)
          .slice(0, 500_000)

        // Explicit warm-up before sampling
        for (let w = 0; w < 2; w += 1) {
          await runner.classifyDocument({
            fileName: `warmup-${w}.txt`,
            extension: '.txt',
            relativePath: `warmup-${w}.txt`,
            textSourceKind: 'native',
            text: large500k
          })
        }

        const histogram = monitorEventLoopDelay({ resolution: 10 })
        histogram.enable()
        const t0 = performance.now()
        let iterations = 0
        while (
          iterations < MAX_WORKLOAD_ITERATIONS &&
          (iterations < 20 || performance.now() - t0 < MIN_WORKLOAD_DURATION_MS)
        ) {
          const r = await runner.classifyDocument({
            fileName: `large-${iterations}.txt`,
            extension: '.txt',
            relativePath: `large-${iterations}.txt`,
            textSourceKind: 'native',
            text: large500k
          })
          assertCondition(r.totalNormalizedChars > 400_000, 'Expected 500k char classification')
          iterations += 1
        }
        const elapsedMs = performance.now() - t0
        histogram.disable()

        const sampleCount = histogram.count
        const p95Ms = histogram.percentile(95) / 1e6
        const maxMs = histogram.max / 1e6
        const diag = runner.getDiagnostics()
        const sufficientSamples = sampleCount >= MIN_EVENT_LOOP_SAMPLES && elapsedMs >= 150
        record(
          sufficientSamples &&
            p95Ms < 100 &&
            diag.nestedWorkerAttempts === 0 &&
            diag.outboundNetworkAttempts === 0,
          'Tier 3 sustained responsiveness (< 100 ms p95), 0 nested workers, 0 network',
          `method=monitorEventLoopDelay(10ms) post-warmup, iterations=${iterations}, samples=${sampleCount}, duration=${elapsedMs.toFixed(1)}ms, p95=${p95Ms.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms`
        )
      } finally {
        await runner.shutdown()
      }

      // 6. Clean resource shutdown
      record(
        budget.getLiveCount() === 0 && runner.getDiagnostics().liveWorkers === 0,
        'Clean shutdown leaves 0 live workers and 0 leaked budget reservations'
      )
    } catch (err) {
      failed += 1
      console.error('[FAIL] Unexpected verification error:', err)
    }

    console.log(
      `[verify-doc-classify-foundation] Summary (${isUnpackedMode ? 'unpacked' : 'built'}): ${passed} passed, ${failed} failed`
    )
    process.exitCode = failed === 0 ? 0 : 1
  })()
}
