/**
 * Personal Vault — Stage 7D 384-Dimensional Document Embedding Vector Validation
 */

import { DOC_SEMANTIC_EMBEDDING_DIMENSIONS } from './manifest'

const NORM_TOLERANCE = 1e-2

export function l2NormalizeDocVector(
  raw: Float32Array | readonly number[],
  expectedDimensions = DOC_SEMANTIC_EMBEDDING_DIMENSIONS
): Float32Array {
  if (raw.length !== expectedDimensions) {
    throw new Error(
      `Invalid document embedding dimensions: expected ${expectedDimensions}, got ${raw.length}`
    )
  }

  let sumSq = 0
  for (let i = 0; i < expectedDimensions; i += 1) {
    const val = raw[i]
    if (val === undefined || !Number.isFinite(val)) {
      throw new Error(`Invalid non-finite value at index ${i}: ${val}`)
    }
    sumSq += val * val
  }

  const norm = Math.sqrt(sumSq)
  if (!Number.isFinite(norm) || norm <= 1e-12) {
    throw new Error('Cannot normalize zero or degenerate document embedding vector')
  }

  const normalized = new Float32Array(expectedDimensions)
  for (let i = 0; i < expectedDimensions; i += 1) {
    normalized[i] = (raw[i] ?? 0) / norm
  }
  return normalized
}

export function validateDocEmbeddingVector(
  vector: Float32Array,
  expectedDimensions = DOC_SEMANTIC_EMBEDDING_DIMENSIONS
): void {
  if (!(vector instanceof Float32Array)) {
    throw new Error('Document embedding vector must be a Float32Array')
  }
  if (vector.length !== expectedDimensions) {
    throw new Error(
      `Invalid document embedding dimension: expected ${expectedDimensions}, got ${vector.length}`
    )
  }

  let sumSq = 0
  for (let i = 0; i < expectedDimensions; i += 1) {
    const v = vector[i]
    if (v === undefined || !Number.isFinite(v)) {
      throw new Error(`Document embedding vector contains non-finite value at index ${i}`)
    }
    sumSq += v * v
  }

  const norm = Math.sqrt(sumSq)
  if (Math.abs(norm - 1.0) > NORM_TOLERANCE) {
    throw new Error(
      `Document embedding vector is not unit-normalized: L2 norm is ${norm.toFixed(6)} (expected ~1.0)`
    )
  }
}

export function validateAndSerializeDocEmbeddingVector(
  vector: Float32Array,
  expectedDimensions = DOC_SEMANTIC_EMBEDDING_DIMENSIONS
): Buffer {
  validateDocEmbeddingVector(vector, expectedDimensions)
  const expectedByteLength = expectedDimensions * 4
  const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  if (buf.byteLength !== expectedByteLength) {
    throw new Error(
      `Serialized document embedding byte length mismatch: expected ${expectedByteLength}, got ${buf.byteLength}`
    )
  }
  return Buffer.from(buf)
}

export function tryDeserializeDocEmbeddingVector(
  blob: unknown,
  expectedDimensions = DOC_SEMANTIC_EMBEDDING_DIMENSIONS
): Float32Array | null {
  if (!blob || !(blob instanceof Uint8Array || Buffer.isBuffer(blob))) {
    return null
  }

  const expectedByteLength = expectedDimensions * 4
  if (blob.byteLength !== expectedByteLength) {
    return null
  }

  const out = new Float32Array(expectedDimensions)
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  let sumSq = 0
  for (let i = 0; i < expectedDimensions; i += 1) {
    const v = view.getFloat32(i * 4, true)
    if (!Number.isFinite(v)) {
      return null
    }
    out[i] = v
    sumSq += v * v
  }

  const norm = Math.sqrt(sumSq)
  if (!Number.isFinite(norm) || norm <= 1e-12 || Math.abs(norm - 1.0) > NORM_TOLERANCE) {
    return null
  }

  return out
}

export function validateDocQueryVector(
  vector: Float32Array,
  expectedDimensions = DOC_SEMANTIC_EMBEDDING_DIMENSIONS
): void {
  validateDocEmbeddingVector(vector, expectedDimensions)
}
