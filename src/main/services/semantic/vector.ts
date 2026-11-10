import { SEMANTIC_EMBEDDING_DIMENSIONS, SEMANTIC_EMBEDDING_BYTE_LENGTH } from './manifest'

const NORM_TOLERANCE = 1e-2

export function normalizeEmbeddingVector(
  raw: Float32Array | readonly number[],
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): Float32Array {
  if (raw.length !== expectedDimensions) {
    throw new Error(
      `Invalid embedding vector dimensions: expected ${expectedDimensions}, got ${raw.length}`
    )
  }

  let sumSq = 0
  for (let i = 0; i < expectedDimensions; i++) {
    const val = raw[i]
    if (val === undefined || !Number.isFinite(val)) {
      throw new Error(`Invalid non-finite value at index ${i}: ${val}`)
    }
    sumSq += val * val
  }

  const norm = Math.sqrt(sumSq)
  if (!Number.isFinite(norm) || norm <= 1e-12) {
    throw new Error('Cannot normalize zero or degenerate embedding vector')
  }

  const normalized = new Float32Array(expectedDimensions)
  for (let i = 0; i < expectedDimensions; i++) {
    normalized[i] = (raw[i] ?? 0) / norm
  }
  return normalized
}

export function validateEmbeddingVector(
  vector: Float32Array,
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): void {
  if (!(vector instanceof Float32Array)) {
    throw new Error('Embedding vector must be a Float32Array')
  }
  if (vector.length !== expectedDimensions) {
    throw new Error(
      `Invalid embedding vector dimension: expected ${expectedDimensions}, got ${vector.length}`
    )
  }

  let sumSq = 0
  for (let i = 0; i < expectedDimensions; i++) {
    const v = vector[i]
    if (v === undefined || !Number.isFinite(v)) {
      throw new Error(`Embedding vector contains non-finite value at index ${i}`)
    }
    sumSq += v * v
  }

  const norm = Math.sqrt(sumSq)
  if (Math.abs(norm - 1.0) > NORM_TOLERANCE) {
    throw new Error(
      `Embedding vector is not unit-normalized: L2 norm is ${norm.toFixed(6)} (expected ~1.0)`
    )
  }
}

export function validateAndSerializeEmbeddingVector(
  vector: Float32Array,
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): Buffer {
  validateEmbeddingVector(vector, expectedDimensions)
  const expectedByteLength = expectedDimensions * 4
  const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  if (buf.byteLength !== expectedByteLength) {
    throw new Error(
      `Serialized embedding blob byte length mismatch: expected ${expectedByteLength}, got ${buf.byteLength}`
    )
  }
  // Return an independent Buffer copy so mutations to the underlying ArrayBuffer cannot corrupt it
  return Buffer.from(buf)
}

export function deserializeEmbeddingVector(
  blob: Buffer | Uint8Array,
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): Float32Array {
  const expectedByteLength =
    expectedDimensions === SEMANTIC_EMBEDDING_DIMENSIONS
      ? SEMANTIC_EMBEDDING_BYTE_LENGTH
      : expectedDimensions * 4

  if (blob.byteLength !== expectedByteLength) {
    throw new Error(
      `Corrupt embedding blob byte length: expected ${expectedByteLength} bytes, got ${blob.byteLength}`
    )
  }

  const copy = new Uint8Array(blob.byteLength)
  copy.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength))
  const vector = new Float32Array(copy.buffer, copy.byteOffset, expectedDimensions)
  validateEmbeddingVector(vector, expectedDimensions)
  return vector
}
