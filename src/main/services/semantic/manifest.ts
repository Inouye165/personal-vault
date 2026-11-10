import { createHash } from 'node:crypto'

export const SEMANTIC_MODEL_ID = 'Xenova/clip-vit-base-patch32@6b7c5237'
export const SEMANTIC_MODEL_REPO = 'Xenova/clip-vit-base-patch32'
export const SEMANTIC_MODEL_COMMIT = '6b7c523703ae26e39be4b03774966f8571c7f523'
export const SEMANTIC_PREPROCESSING_VERSION = 'clip_vit_b32_224_bicubic_center_rgb_v1'
export const SEMANTIC_EMBEDDING_DIMENSIONS = 512
export const SEMANTIC_EMBEDDING_BYTE_LENGTH = SEMANTIC_EMBEDDING_DIMENSIONS * 4

export const CLIP_IMAGE_SIZE = 224
export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const

export interface SemanticModelArtifactSpec {
  readonly relativePath: string
  readonly byteSize: number
  readonly sha256: string
}

export const REQUIRED_MODEL_ARTIFACTS: readonly SemanticModelArtifactSpec[] = [
  {
    relativePath: 'config.json',
    byteSize: 4524,
    sha256: '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495'
  },
  {
    relativePath: 'preprocessor_config.json',
    byteSize: 520,
    sha256: '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f'
  },
  {
    relativePath: 'tokenizer.json',
    byteSize: 2224119,
    sha256: 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd'
  },
  {
    relativePath: 'tokenizer_config.json',
    byteSize: 775,
    sha256: '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967'
  },
  {
    relativePath: 'special_tokens_map.json',
    byteSize: 472,
    sha256: 'c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac'
  },
  {
    relativePath: 'onnx/vision_model_quantized.onnx',
    byteSize: 89117001,
    sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299'
  },
  {
    relativePath: 'onnx/text_model_quantized.onnx',
    byteSize: 64504507,
    sha256: '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a'
  }
] as const

export const SEMANTIC_MODEL_TOTAL_BYTES = REQUIRED_MODEL_ARTIFACTS.reduce(
  (acc, item) => acc + item.byteSize,
  0
)

export const APPROVED_DOWNLOAD_HOSTS: readonly string[] = [
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
  'cas-bridge.xethub.hf.co'
] as const

export function computeManifestSha256(
  artifacts: readonly SemanticModelArtifactSpec[] = REQUIRED_MODEL_ARTIFACTS
): string {
  const canonical = artifacts
    .slice()
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((a) => `${a.relativePath}:${a.byteSize}:${a.sha256.toLowerCase()}`)
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function getPinnedArtifactDownloadUrl(
  relativePath: string,
  baseDownloadUrl = `https://huggingface.co/${SEMANTIC_MODEL_REPO}/resolve/${SEMANTIC_MODEL_COMMIT}`
): string {
  const normalizedBase = baseDownloadUrl.replace(/\/+$/, '')
  const cleanRel = relativePath.replace(/^\/+/, '')
  return `${normalizedBase}/${cleanRel}`
}
