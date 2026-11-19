/**
 * Personal Vault — Stage 7D Provisional Document Text-Embedding Model Manifest
 *
 * Provisional model: `Xenova/bge-small-en-v1.5` (MIT License), pinned at commit
 * `ea104dacec62c0de699686887e3f920caeb4f3e3` (384-d Float32, 512-token window).
 * Kept provisional until confirmed against expanded retrieval evaluation or swapped
 * prior to production index commitment.
 */

import { createHash } from 'node:crypto'
import type { DocSemanticModelArtifactSpec } from './types'

export const DOC_SEMANTIC_MODEL_ID = 'Xenova/bge-small-en-v1.5' as const
export const DOC_SEMANTIC_MODEL_REPO = 'Xenova/bge-small-en-v1.5' as const
export const DOC_SEMANTIC_MODEL_COMMIT = 'ea104dacec62c0de699686887e3f920caeb4f3e3' as const
export const DOC_SEMANTIC_MODEL_LICENSE = 'MIT' as const
export const DOC_SEMANTIC_MODEL_PROVISIONAL = true as const
export const DOC_SEMANTIC_EMBEDDING_DIMENSIONS = 384 as const
export const DOC_SEMANTIC_EMBEDDING_BYTE_LENGTH = DOC_SEMANTIC_EMBEDDING_DIMENSIONS * 4
export const DOC_SEMANTIC_MAX_SEQ_LENGTH = 512 as const
export const DOC_SEMANTIC_QUERY_PREFIX =
  'Represent this sentence for searching relevant passages: ' as const

export const REQUIRED_DOC_SEMANTIC_ARTIFACTS: readonly DocSemanticModelArtifactSpec[] = [
  {
    relativePath: 'config.json',
    byteSize: 683,
    sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350'
  },
  {
    relativePath: 'tokenizer.json',
    byteSize: 711_396,
    sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66'
  },
  {
    relativePath: 'tokenizer_config.json',
    byteSize: 366,
    sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
  },
  {
    relativePath: 'special_tokens_map.json',
    byteSize: 125,
    sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3'
  },
  {
    relativePath: 'onnx/model_quantized.onnx',
    byteSize: 34_014_426,
    sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4'
  }
] as const

export const DOC_SEMANTIC_MODEL_TOTAL_BYTES = REQUIRED_DOC_SEMANTIC_ARTIFACTS.reduce(
  (acc, item) => acc + item.byteSize,
  0
)

export const APPROVED_DOC_SEMANTIC_DOWNLOAD_HOSTS: readonly string[] = [
  'huggingface.co',
  'cas-bridge.xethub.hf.co',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
  'us.aws.cdn.hf.co'
] as const

export function computeDocSemanticManifestSha256(
  artifacts: readonly DocSemanticModelArtifactSpec[] = REQUIRED_DOC_SEMANTIC_ARTIFACTS
): string {
  const canonical = artifacts
    .slice()
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((a) => `${a.relativePath}:${a.byteSize}:${a.sha256.toLowerCase()}`)
    .join('\n')
  return createHash('sha256')
    .update(
      `${DOC_SEMANTIC_MODEL_ID}|${DOC_SEMANTIC_MODEL_COMMIT}|${DOC_SEMANTIC_EMBEDDING_DIMENSIONS}\n${canonical}`,
      'utf8'
    )
    .digest('hex')
}

export const PINNED_DOC_SEMANTIC_MANIFEST_SHA256: string = computeDocSemanticManifestSha256(
  REQUIRED_DOC_SEMANTIC_ARTIFACTS
)

export function getPinnedDocSemanticArtifactDownloadUrl(
  relativePath: string,
  baseDownloadUrl = `https://huggingface.co/${DOC_SEMANTIC_MODEL_REPO}/resolve/${DOC_SEMANTIC_MODEL_COMMIT}`
): string {
  const normalizedBase = baseDownloadUrl.replace(/\/+$/, '')
  const cleanRel = relativePath.replace(/^\/+/, '')
  return `${normalizedBase}/${cleanRel}`
}
