/**
 * Personal Vault — Pinned English OCR Model Manifest (`tesseract-ocr/tessdata_fast`)
 *
 * Pinned to immutable upstream tag `4.1.0` (`65727574dfcd264acbb0c3e07860e4e9e9b22185`),
 * licensed under Apache License 2.0.
 */

import { createHash } from 'node:crypto'
import type { OcrModelArtifactSpec } from './types'

export const OCR_MODEL_ID = 'tesseract-ocr/tessdata_fast:eng@65727574' as const
export const OCR_MODEL_REPO = 'tesseract-ocr/tessdata_fast' as const
export const OCR_MODEL_TAG = '4.1.0' as const
export const OCR_MODEL_COMMIT = '65727574dfcd264acbb0c3e07860e4e9e9b22185' as const
export const OCR_MODEL_LICENSE = 'Apache-2.0' as const
export const OCR_MODEL_LANGUAGE = 'eng' as const
export const OCR_ENGINE_PACKAGE = 'tesseract.js-core@7.0.0' as const
export const OCR_ENGINE_OEM = 1 as const // LSTM_ONLY

export const REQUIRED_OCR_MODEL_ARTIFACTS: readonly OcrModelArtifactSpec[] = [
  {
    relativePath: 'eng.traineddata',
    byteSize: 4_113_088,
    sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
  }
] as const

export const OCR_MODEL_TOTAL_BYTES = REQUIRED_OCR_MODEL_ARTIFACTS.reduce(
  (acc, item) => acc + item.byteSize,
  0
)

export const APPROVED_OCR_DOWNLOAD_HOSTS: readonly string[] = [
  'raw.githubusercontent.com',
  'objects.githubusercontent.com'
] as const

export function computeOcrManifestSha256(
  artifacts: readonly OcrModelArtifactSpec[] = REQUIRED_OCR_MODEL_ARTIFACTS
): string {
  const canonical = artifacts
    .slice()
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((a) => `${a.relativePath}:${a.byteSize}:${a.sha256.toLowerCase()}`)
    .join('\n')
  return createHash('sha256')
    .update(
      `${OCR_MODEL_ID}|${OCR_MODEL_COMMIT}|${OCR_MODEL_LANGUAGE}|${OCR_ENGINE_OEM}\n${canonical}`,
      'utf8'
    )
    .digest('hex')
}

export const PINNED_OCR_MANIFEST_SHA256: string = computeOcrManifestSha256(
  REQUIRED_OCR_MODEL_ARTIFACTS
)

export function getPinnedOcrArtifactDownloadUrl(
  relativePath: string,
  baseDownloadUrl = `https://raw.githubusercontent.com/${OCR_MODEL_REPO}/${OCR_MODEL_COMMIT}`
): string {
  const normalizedBase = baseDownloadUrl.replace(/\/+$/, '')
  const cleanRel = relativePath.replace(/^\/+/, '')
  return `${normalizedBase}/${cleanRel}`
}
