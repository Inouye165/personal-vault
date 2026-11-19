import { mkdir, rm, stat, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const rootRequire = createRequire(path.join(repoRoot, 'package.json'))
const esbuild = rootRequire('esbuild')

const EXTERNALS = [
  'electron',
  'esbuild',
  'sharp',
  '@napi-rs/canvas',
  'pdfjs-dist',
  'pdfjs-dist/legacy/build/pdf.mjs',
  'tesseract.js-core',
  'tesseract.js-core/tesseract-core-simd-lstm.js',
  'tesseract.js-core/tesseract-core-lstm.js'
]

export async function buildSpikeBundles() {
  const outMain = path.join(__dirname, 'out', 'main')
  await rm(path.join(__dirname, 'out'), { recursive: true, force: true })
  await mkdir(outMain, { recursive: true })

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'electron-main-spike.ts')],
    outfile: path.join(outMain, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: EXTERNALS
  })

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'ocr-worker.mjs')],
    outfile: path.join(outMain, 'ocr-worker.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: EXTERNALS
  })

  return { outMain }
}

async function computeDirectoryBytes(dirPath) {
  let total = 0
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += await computeDirectoryBytes(full)
    } else if (entry.isFile()) {
      total += (await stat(full)).size
    }
  }
  return total
}

export async function buildSpikeUnpackedExecutable() {
  await buildSpikeBundles()
  const distOut = path.join(__dirname, '.dist-unpacked')
  await rm(distOut, { recursive: true, force: true })

  const electronBuilder = rootRequire('electron-builder')
  const electronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist')

  const electronVersion = rootRequire('electron/package.json').version

  const builderConfig = {
    appId: 'com.personalvault.ocrspike',
    productName: 'Personal Vault OCR Spike',
    electronDist,
    electronVersion,
    directories: {
      output: '.dist-unpacked'
    },
    files: [
      'out/**/*',
      'package.json',
      'node_modules/@napi-rs/**/*',
      'node_modules/sharp/**/*',
      'node_modules/@img/**/*',
      'node_modules/detect-libc/**/*',
      'node_modules/semver/**/*',
      'node_modules/pdfjs-dist/package.json',
      'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      '!node_modules/tesseract.js-core/**/*',
      'node_modules/tesseract.js-core/package.json',
      'node_modules/tesseract.js-core/LICENSE',
      'node_modules/tesseract.js-core/tesseract-core-simd-lstm.js',
      'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm',
      'node_modules/tesseract.js-core/tesseract-core-lstm.js',
      'node_modules/tesseract.js-core/tesseract-core-lstm.wasm'
    ],
    asarUnpack: [
      'node_modules/sharp/**/*',
      'node_modules/@img/**/*',
      'node_modules/@napi-rs/**/*',
      'node_modules/tesseract.js-core/*.wasm'
    ],
    win: {
      target: [{ target: 'dir', arch: ['x64'] }],
      signAndEditExecutable: false
    }
  }

  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  await electronBuilder.build({
    projectDir: __dirname,
    config: builderConfig
  })

  const winUnpackedDir = path.join(distOut, 'win-unpacked')
  const exePath = path.join(winUnpackedDir, 'Personal Vault OCR Spike.exe')
  const asarPath = path.join(winUnpackedDir, 'resources', 'app.asar')
  const unpackedDir = path.join(winUnpackedDir, 'resources', 'app.asar.unpacked')

  const asarBytes = (await stat(asarPath)).size
  const unpackedBytes = await computeDirectoryBytes(unpackedDir)

  return {
    exePath,
    asarPath,
    unpackedDir,
    asarMiB: Number((asarBytes / (1024 * 1024)).toFixed(2)),
    unpackedMiB: Number((unpackedBytes / (1024 * 1024)).toFixed(2))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--unpack')) {
    const info = await buildSpikeUnpackedExecutable()
    console.log(JSON.stringify(info, null, 2))
  } else {
    const info = await buildSpikeBundles()
    console.log(JSON.stringify(info, null, 2))
  }
}
