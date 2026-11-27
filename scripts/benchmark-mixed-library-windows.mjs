import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  buildDisposableFixtures,
  launchInstalledApp,
  sha256File
} from './verify-installer-windows.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const exe = resolve(process.argv[2] ?? join(root, 'dist', 'win-unpacked', 'Personal Vault.exe'))
const output = resolve(process.argv[3] ?? join(tmpdir(), 'pv-mixed-library-baseline.json'))
const deadlineMs = 10 * 60 * 1000
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

function stats(values) {
  if (!values.length) return { samples: 0, p50Ms: null, p95Ms: null, maxMs: null }
  const sorted = [...values].sort((left, right) => left - right)
  const at = (p) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(1))
  return { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) }
}

async function prepare(work) {
  const base = await buildDisposableFixtures(join(work, 'templates'))
  const seed = join(work, 'seed')
  const incoming = join(work, 'incoming')
  mkdirSync(seed)
  mkdirSync(incoming)
  const files = []
  const copy = (from, to) => {
    copyFileSync(from, to)
    files.push(to)
  }
  copy(base.pdfPath, join(seed, 'scanned-invoice.pdf'))
  copy(base.txtPath, join(seed, 'tax-receipt-2025.txt'))
  const fixtures = join(root, 'tests', 'fixtures', 'heic')
  for (const name of ['landscape.heic', 'portrait_exif6.heic', 'sunset_heic.heic']) {
    copy(join(fixtures, name), join(seed, name))
  }
  for (let i = 0; i < 360; i++) {
    const path = join(i < 24 ? seed : incoming, `landscape-${i}.jpg`)
    const accent = Buffer.from(
      `<svg width="64" height="44"><rect width="64" height="44" fill="white"/><text x="4" y="26" font-size="20">${i}</text></svg>`
    )
    await sharp(base.photoPath)
      .resize(1200, 900)
      .composite([{ input: accent, left: 10, top: 10 }])
      .jpeg({ quality: 86 })
      .toFile(path)
    files.push(path)
  }
  for (let i = 0; i < 12; i++) {
    copy(base.pdfPath, join(incoming, `scanned-invoice-${i}.pdf`))
    const path = join(incoming, `receipt-${i}.txt`)
    writeFileSync(path, `Municipal property tax receipt for parcel ${i}. Paid in full.\n`)
    files.push(path)
  }
  return { seed, incoming, hashes: new Map(files.map((path) => [path, sha256File(path)])) }
}

function summarizeProgress(value) {
  const fields = [
    'status',
    'discoveredCount',
    'hashedCount',
    'errorCount',
    'processedPhotos',
    'unsupportedPhotos',
    'failedPhotos',
    'currentIndexedPhotos',
    'lastError'
  ]
  return Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]))
}

async function run(cdp, fixtures, report) {
  const call = (name, ...args) =>
    cdp.evaluate(`window.api[${JSON.stringify(name)}](...${JSON.stringify(args)})`)
  const getScan = async () => (await call('getLatestScanJob'))?.job
  const getIndex = () => call('getSemanticIndexProgress')
  const terminal = new Set(['paused', 'cancelled', 'interrupted', 'failed'])

  async function waitFor(label, check) {
    const until = Date.now() + deadlineMs
    while (Date.now() < until) {
      const result = await check()
      if (result?.status === 'completed' || result?.state === 'ready') return result
      if (terminal.has(result?.status)) throw new Error(`${label}: ${JSON.stringify(result)}`)
      await pause(150)
    }
    throw new Error(`${label} timed out`)
  }

  async function startScan(path) {
    const previous = (await getScan())?.jobId
    const response = await call('startScan', { roots: [path] })
    assert(response.success, JSON.stringify(response))
    return async () => {
      const current = await getScan()
      return current?.jobId !== previous ? current : null
    }
  }

  let ownerGen = 0
  async function sample() {
    const generation = ++ownerGen
    const offset = generation % 2 === 0 ? 12 : 0
    return cdp.evaluate(`(async () => {
      const frames = [];
      const start = performance.now();
      let previousFrame;
      let frameId;
      function frame(at) {
        if (previousFrame !== undefined) frames.push(at - previousFrame);
        previousFrame = at;
        frameId = requestAnimationFrame(frame);
      }
      frameId = requestAnimationFrame(frame);
      try {
        const page = await window.api.getPhotosPage({limit: 24, offset: ${offset}});
        const browseMs = performance.now() - start;
        const query = 'mountain landscape';
        const searchStart = performance.now();
        const search = await window.api.searchUnifiedPhotos({query, ownerSurface: 'unified', ownerGen: ${generation}, offset: 0, limit: 10});
        const searchMs = performance.now() - searchStart;
        const documentStart = performance.now();
        const documentSearch = await window.api.searchUnifiedDocuments({query: 'municipal property tax receipt', ownerSurface: 'unified', ownerGen: ${generation}, offset: 0, limit: 10});
        return {browseMs, searchMs, photos: page.items.length,
          searchItems: search.result?.items?.length ?? 0, searchState: search.status,
          documentMs: performance.now() - documentStart, documentItems: documentSearch.result?.items?.length ?? 0,
          documentState: documentSearch.status, frames};
      } finally {
        cancelAnimationFrame(frameId);
      }
    })()`)
  }

  async function measure(name, getJob) {
    const started = performance.now()
    const samples = []
    let boundarySamples = 0
    let result
    do {
      const before = getJob ? await getJob() : { status: 'running' }
      if (!before || before.status === 'idle') {
        await pause(100)
        continue
      }
      result = before
      if (terminal.has(before.status) || before.status === 'completed') break
      const observation = await sample()
      const after = getJob ? await getJob() : before
      if (before.status === 'running' && after?.status === 'running') samples.push(observation)
      else boundarySamples++
      result = after
      if (!getJob && samples.length >= 20) break
      await pause(75)
    } while (performance.now() - started < deadlineMs)
    const withResults = samples.filter((row) => row.searchItems > 0)
    const withDocuments = samples.filter((row) => row.documentItems > 0)
    report.phases[name] = {
      elapsedMs: Math.round(performance.now() - started),
      photoPageIpc: stats(samples.map((row) => row.browseMs)),
      semanticSearchIpc: stats(withResults.map((row) => row.searchMs)),
      documentSearchIpc: stats(withDocuments.map((row) => row.documentMs)),
      rendererFrameGap: stats(samples.flatMap((row) => row.frames)),
      emptyPhotoPages: samples.filter((row) => row.photos === 0).length,
      searchesWithoutResults: samples.length - withResults.length,
      documentSearchesWithoutResults: samples.length - withDocuments.length,
      searchStates: [...new Set(samples.map((row) => row.searchState))],
      documentSearchStates: [...new Set(samples.map((row) => row.documentState))],
      boundarySamples,
      ...(getJob && result ? { job: summarizeProgress(result) } : {})
    }
    if (getJob) assert.equal(result?.status, 'completed', `${name} did not complete`)
  }

  await waitFor('seed scan', await startScan(fixtures.seed))
  await call('importSemanticModelFromFolder')
  await waitFor('CLIP model', () => call('getSemanticModelStatus'))
  await call('startSemanticIndexing')
  await waitFor('seed index', getIndex)
  await call('startDocumentExtraction')
  await waitFor('seed extraction', () => call('getDocumentExtractionProgress'))
  await call('importDocSemanticModel')
  await waitFor('BGE model', () => call('getDocSemanticModelStatus'))
  await call('startDocumentSemanticIndexing')
  await waitFor('seed document index', () => call('getDocumentSemanticProgress'))
  await measure('idle', null)

  await measure('scan', await startScan(fixtures.incoming))
  const previous = (await getIndex()).jobId
  await call('startSemanticIndexing')
  await measure('index', async () => {
    const current = await getIndex()
    return current?.jobId !== previous ? current : null
  })

  const photos = await call('getPhotosPage', {
    limit: 24,
    offset: 0,
    fileTypeBasis: 'filename_extension',
    fileTypeValue: 'heic'
  })
  const heic = photos.items.filter((item) => /\.heic$/i.test(item.fileName))
  report.heicThumbnails = []
  for (const item of heic) {
    const thumbnail = await call('getThumbnail', { locationId: item.id })
    report.heicThumbnails.push({ file: item.fileName, status: thumbnail.status })
  }
  await call('startDocumentExtraction')
  report.documentExtraction = await waitFor('document extraction', () =>
    call('getDocumentExtractionProgress')
  )
  await call('importOcrModel')
  await waitFor('OCR model', () => call('getOcrModelStatus'))
  await call('startDocumentOcr')
  report.ocr = await waitFor('document OCR', () => call('getDocumentOcrProgress'))
  report.runtimeErrors = cdp.runtimeErrors.length
  assert.equal(report.runtimeErrors, 0, 'Renderer exceptions occurred during the baseline')
}

const tempRoot = resolve(tmpdir())
const work = mkdtempSync(join(tempRoot, 'pv-8c2-'))
const report = {
  host: { cpu: cpus()[0]?.model, ramGiB: Math.round(totalmem() / 2 ** 30), osRelease: release() },
  executable: exe,
  phases: {}
}
let session
let fixtures
try {
  assert.equal(process.platform, 'win32', 'This baseline requires Windows')
  report.executableSha256 = sha256File(exe)
  fixtures = await prepare(work)
  report.fixtureFiles = fixtures.hashes.size
  report.fixtureBytes = [...fixtures.hashes.keys()].reduce(
    (sum, path) => sum + statSync(path).size,
    0
  )
  console.log(`Prepared ${report.fixtureFiles} disposable fixtures. Launching Electron…`)
  session = await launchInstalledApp(exe, join(work, 'profile'), work)
  await run(session.cdp, fixtures, report)
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (session) await session.shutdown()
  if (fixtures) {
    report.sourceHashesUnchanged = [...fixtures.hashes].every(
      ([path, hash]) => existsSync(path) && sha256File(path) === hash
    )
    if (!report.sourceHashesUnchanged) process.exitCode = 1
  }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  if (resolve(work).startsWith(`${tempRoot}${sep}pv-8c2-`)) {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  console.log(JSON.stringify(report, null, 2))
  console.log(`Report saved to ${output}`)
}
