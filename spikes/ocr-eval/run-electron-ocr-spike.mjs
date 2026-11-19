import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSpikeBundles, buildSpikeUnpackedExecutable } from './build-spike.mjs'
import { ensurePinnedOcrModel } from './fetch-ocr-model.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const rootRequire = createRequire(path.join(repoRoot, 'package.json'))

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))
const mode = modeArg ? modeArg.slice('--mode='.length) : 'built'
if (mode !== 'built' && mode !== 'unpacked') {
  throw new Error(`Unsupported --mode=${mode} (expected built or unpacked)`)
}

// Ensure pinned eng.traineddata is cached & SHA-256 verified BEFORE launching offline Electron
const modelStatus = await ensurePinnedOcrModel(undefined, { allowDownload: false })

let binaryPath
let binaryArgs = []
let packageStats = null

if (mode === 'built') {
  await buildSpikeBundles()
  binaryPath = rootRequire('electron')
  binaryArgs = [path.join(__dirname, 'out', 'main', 'index.js')]
} else {
  const exeCandidate = path.join(
    __dirname,
    '.dist-unpacked',
    'win-unpacked',
    'Personal Vault OCR Spike.exe'
  )
  const rebuildRequested = process.argv.includes('--rebuild')
  const exists = await stat(exeCandidate)
    .then(() => true)
    .catch(() => false)
  if (!exists || rebuildRequested) {
    packageStats = await buildSpikeUnpackedExecutable()
    binaryPath = packageStats.exePath
  } else {
    binaryPath = exeCandidate
  }
}

const neutralCwd = await mkdtemp(path.join(os.tmpdir(), `pv-ocr-neutral-cwd-${mode}-`))
const reportDir = await mkdtemp(path.join(os.tmpdir(), `pv-ocr-report-${mode}-`))
const reportPath = path.join(reportDir, 'ocr-spike-report.json')

try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      binaryPath,
      [...binaryArgs, `--model-dir=${modelStatus.modelDir}`, `--report-path=${reportPath}`],
      {
        cwd: neutralCwd,
        env,
        stdio: 'inherit'
      }
    )
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })

  const rawReport = await readFile(reportPath, 'utf8')
  const parsed = JSON.parse(rawReport)
  if (packageStats) {
    parsed.packageFootprint = packageStats
  }

  console.log(JSON.stringify({ mode, modelStatus, ...parsed }, null, 2))
  if (exitCode !== 0 || !parsed.passed) {
    process.exit(1)
  }
} finally {
  await rm(neutralCwd, { recursive: true, force: true }).catch(() => {})
  await rm(reportDir, { recursive: true, force: true }).catch(() => {})
}
