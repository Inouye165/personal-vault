/**
 * Personal Vault — Stage 6A Semantic Evaluation Spike: Pure Semantic Core
 *
 * Pure, deterministic helpers for:
 * - L2 vector normalization (Float32Array)
 * - Exact cosine similarity dot product and bounded top-K ranking
 * - CLIP 224x224 RGB planar CHW tensor normalization from raw RGB bytes
 * - Content-revision and model-version binding for embedding records
 */

export const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32@6b7c5237'
export const CLIP_PREPROCESSING_VERSION = 'clip_vit_b32_224_bilinear_center_rgb_v1'
export const CLIP_EMBEDDING_DIMENSIONS = 512

export const CLIP_IMAGE_MEAN = [0.48145466, 0.4578275, 0.40821073]
export const CLIP_IMAGE_STD = [0.26862954, 0.26130258, 0.27577711]

/**
 * Normalizes a Float32Array to unit L2 norm (||v||_2 = 1.0).
 * Rejects empty, non-finite, or zero-norm vectors so corrupt outputs never silently persist.
 */
export function l2NormalizeFloat32(input) {
  if (!(input instanceof Float32Array) || input.length === 0) {
    throw new TypeError('Embedding input must be a non-empty Float32Array')
  }
  let sumSq = 0
  for (let i = 0; i < input.length; i++) {
    const val = input[i]
    if (!Number.isFinite(val)) {
      throw new RangeError(`Non-finite embedding value at index ${i}`)
    }
    sumSq += val * val
  }
  const norm = Math.sqrt(sumSq)
  if (norm <= 1e-12) {
    throw new RangeError('Cannot L2-normalize a zero-magnitude vector')
  }
  const normalized = new Float32Array(input.length)
  const invNorm = 1.0 / norm
  for (let i = 0; i < input.length; i++) {
    normalized[i] = input[i] * invNorm
  }
  return { vector: normalized, rawNorm: norm }
}

/**
 * Converts interleaved 224x224x3 uint8 RGB pixels into a planar CHW [1, 3, 224, 224]
 * Float32Array normalized with CLIP's exact channel mean and standard deviation.
 */
export function rgb224ToClipPlanarFloat32(rgbBuffer, width = 224, height = 224) {
  const expectedLength = width * height * 3
  if (!rgbBuffer || rgbBuffer.length !== expectedLength) {
    throw new RangeError(
      `Expected RGB buffer of length ${expectedLength} (${width}x${height}x3), got ${rgbBuffer?.length ?? 0}`
    )
  }

  const numPixels = width * height
  const tensorData = new Float32Array(3 * numPixels)
  const [meanR, meanG, meanB] = CLIP_IMAGE_MEAN
  const [stdR, stdG, stdB] = CLIP_IMAGE_STD

  const chGOffset = numPixels
  const chBOffset = 2 * numPixels

  for (let i = 0; i < numPixels; i++) {
    const base = i * 3
    const r = rgbBuffer[base] / 255.0
    const g = rgbBuffer[base + 1] / 255.0
    const b = rgbBuffer[base + 2] / 255.0

    tensorData[i] = (r - meanR) / stdR
    tensorData[chGOffset + i] = (g - meanG) / stdG
    tensorData[chBOffset + i] = (b - meanB) / stdB
  }

  return tensorData
}

/**
 * Computes exact dot product (cosine similarity for L2-normalized vectors).
 */
export function cosineSimilarityNormalized(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    throw new RangeError(`Dimension mismatch: ${vecA.length} vs ${vecB.length}`)
  }
  let dot = 0
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i]
  }
  return dot
}

/**
 * Constructs a versioned embedding record tied to source content revision and model identity.
 */
export function createVersionedEmbeddingRecord({
  fileLocationId,
  discoveryObservationId,
  sha256,
  byteSize,
  mtimeMs,
  modelId = CLIP_MODEL_ID,
  preprocessingVersion = CLIP_PREPROCESSING_VERSION,
  dimensions = CLIP_EMBEDDING_DIMENSIONS,
  vector,
  createdAtMs = Date.now()
}) {
  if (!sha256 || typeof sha256 !== 'string' || sha256.length !== 64) {
    throw new RangeError('Valid 64-character verified SHA-256 hash is required')
  }
  if (!Number.isInteger(byteSize) || byteSize < 0) {
    throw new RangeError('Valid non-negative integer byteSize is required')
  }
  if (!(vector instanceof Float32Array) || vector.length !== dimensions) {
    throw new RangeError(`Vector must be Float32Array of length ${dimensions}`)
  }

  const contentRevision = `rev:${discoveryObservationId}:${byteSize}:${mtimeMs ?? 'null'}:${sha256}`
  return {
    fileLocationId,
    discoveryObservationId,
    contentSha256: sha256,
    byteSize,
    contentRevision,
    modelId,
    preprocessingVersion,
    dimensions,
    vectorBuffer: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    vector,
    createdAtMs,
    isCurrent: true
  }
}

/**
 * Verifies whether a persisted embedding record remains valid for the current file state
 * and active model/preprocessing configuration.
 */
export function isEmbeddingRecordCurrent(record, currentState) {
  if (!record || !record.isCurrent) return false
  const expectedRevision = `rev:${currentState.discoveryObservationId}:${currentState.byteSize}:${currentState.mtimeMs ?? 'null'}:${currentState.sha256}`
  return (
    record.contentRevision === expectedRevision &&
    record.contentSha256 === currentState.sha256 &&
    record.byteSize === currentState.byteSize &&
    record.modelId === (currentState.modelId ?? CLIP_MODEL_ID) &&
    record.preprocessingVersion ===
      (currentState.preprocessingVersion ?? CLIP_PREPROCESSING_VERSION) &&
    record.dimensions === (currentState.dimensions ?? CLIP_EMBEDDING_DIMENSIONS)
  )
}

/**
 * Bounded exact linear scan over normalized Float32 vectors with deterministic tie-breaking
 * (score DESC, fileLocationId ASC).
 */
export function rankSemanticMatches(queryVector, indexEntries, options = {}) {
  const { topK = 50, minScore = -1.0, maxIndexedItems = 50_000 } = options
  if (indexEntries.length > maxIndexedItems) {
    throw new RangeError(
      `Index size (${indexEntries.length}) exceeds declared cap (${maxIndexedItems})`
    )
  }

  const scored = []
  for (let i = 0; i < indexEntries.length; i++) {
    const entry = indexEntries[i]
    const score = cosineSimilarityNormalized(queryVector, entry.vector)
    if (score >= minScore) {
      scored.push({
        fileLocationId: entry.fileLocationId,
        id: entry.id,
        fileName: entry.fileName,
        category: entry.category,
        score
      })
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.fileLocationId - b.fileLocationId
  })

  return scored.slice(0, topK)
}
