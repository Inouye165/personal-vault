export const CLIP_MODEL_ID: string
export const CLIP_PREPROCESSING_VERSION: string
export const CLIP_EMBEDDING_DIMENSIONS: number
export const CLIP_IMAGE_MEAN: readonly number[]
export const CLIP_IMAGE_STD: readonly number[]

export function l2NormalizeFloat32(input: Float32Array): {
  vector: Float32Array
  rawNorm: number
}

export function rgb224ToClipPlanarFloat32(
  rgbBuffer: Uint8Array | Buffer,
  width?: number,
  height?: number
): Float32Array

export function cosineSimilarityNormalized(vecA: Float32Array, vecB: Float32Array): number

export interface VersionedEmbeddingRecord {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly contentSha256: string
  readonly byteSize: number
  readonly contentRevision: string
  readonly modelId: string
  readonly preprocessingVersion: string
  readonly dimensions: number
  readonly vectorBuffer: Buffer
  readonly vector: Float32Array
  readonly createdAtMs: number
  readonly isCurrent: boolean
}

export function createVersionedEmbeddingRecord(params: {
  fileLocationId: number
  discoveryObservationId: number
  sha256: string
  byteSize: number
  mtimeMs: number | null
  modelId?: string
  preprocessingVersion?: string
  dimensions?: number
  vector: Float32Array
  createdAtMs?: number
}): VersionedEmbeddingRecord

export function isEmbeddingRecordCurrent(
  record: VersionedEmbeddingRecord | null | undefined,
  currentState: {
    discoveryObservationId: number
    byteSize: number
    mtimeMs: number | null
    sha256: string
    modelId?: string
    preprocessingVersion?: string
    dimensions?: number
  }
): boolean

export interface SemanticIndexEntry {
  readonly fileLocationId: number
  readonly id: string
  readonly fileName: string
  readonly category: string
  readonly vector: Float32Array
}

export interface RankedSemanticMatch {
  readonly fileLocationId: number
  readonly id: string
  readonly fileName: string
  readonly category: string
  readonly score: number
}

export function rankSemanticMatches(
  queryVector: Float32Array,
  indexEntries: readonly SemanticIndexEntry[],
  options?: {
    topK?: number
    minScore?: number
    maxIndexedItems?: number
  }
): RankedSemanticMatch[]
