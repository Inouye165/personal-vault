import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PINNED_OCR_MANIFEST_SHA256,
  PINNED_OCR_MODEL_MANIFEST,
  verifyPinnedTrainedData
} from './ocr-core.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_OCR_MODEL_DIR = path.join(
  __dirname,
  '.model-cache',
  `tessdata_fast_${PINNED_OCR_MODEL_MANIFEST.language}@${PINNED_OCR_MODEL_MANIFEST.pinnedCommit.slice(0, 8)}`
)

export async function ensurePinnedOcrModel(modelDir = DEFAULT_OCR_MODEL_DIR, options = {}) {
  const { allowDownload = true } = options
  const existing = await verifyPinnedTrainedData(modelDir)
  if (existing.valid) {
    return {
      status: 'verified_cached',
      downloaded: false,
      modelDir,
      trainedDataPath: existing.trainedDataPath,
      byteSize: existing.byteSize,
      sha256: existing.sha256,
      manifestSha256: PINNED_OCR_MANIFEST_SHA256
    }
  }

  if (!allowDownload) {
    throw new Error(`Offline OCR model check failed (${existing.code}): ${existing.message}`)
  }

  await mkdir(modelDir, { recursive: true })
  const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${PINNED_OCR_MODEL_MANIFEST.pinnedCommit}/eng.traineddata`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch pinned eng.traineddata: HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const targetPath = path.join(modelDir, 'eng.traineddata')
  await writeFile(targetPath, bytes)

  const verified = await verifyPinnedTrainedData(modelDir)
  if (!verified.valid) {
    throw new Error(
      `Downloaded eng.traineddata failed pinned integrity check (${verified.code}): ${verified.message}`
    )
  }

  return {
    status: 'downloaded_and_verified',
    downloaded: true,
    modelDir,
    trainedDataPath: verified.trainedDataPath,
    byteSize: verified.byteSize,
    sha256: verified.sha256,
    manifestSha256: PINNED_OCR_MANIFEST_SHA256
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await ensurePinnedOcrModel()
  console.log(
    JSON.stringify(
      {
        status: result.status,
        downloaded: result.downloaded,
        modelDir: result.modelDir,
        byteSize: result.byteSize,
        sha256: result.sha256,
        manifestSha256: result.manifestSha256
      },
      null,
      2
    )
  )
}
