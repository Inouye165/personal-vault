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

export function tryDeserializeEmbeddingVector(
  blob: unknown,
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): Float32Array | null {
  if (!blob || !(blob instanceof Uint8Array || Buffer.isBuffer(blob))) {
    return null
  }

  const expectedByteLength =
    expectedDimensions === SEMANTIC_EMBEDDING_DIMENSIONS
      ? SEMANTIC_EMBEDDING_BYTE_LENGTH
      : expectedDimensions * 4

  if (blob.byteLength !== expectedByteLength) {
    return null
  }

  try {
    const copy = new Uint8Array(blob.byteLength)
    copy.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength))
    const vector = new Float32Array(copy.buffer, copy.byteOffset, expectedDimensions)

    let sumSq = 0
    for (let i = 0; i < expectedDimensions; i++) {
      const v = vector[i]
      if (v === undefined || !Number.isFinite(v)) {
        return null
      }
      sumSq += v * v
    }

    const norm = Math.sqrt(sumSq)
    if (!Number.isFinite(norm) || norm <= 1e-12) {
      return null
    }

    if (Math.abs(norm - 1.0) > NORM_TOLERANCE) {
      return null
    }

    return vector
  } catch {
    return null
  }
}

export function deserializeEmbeddingVector(
  blob: Buffer | Uint8Array,
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): Float32Array {
  const result = tryDeserializeEmbeddingVector(blob, expectedDimensions)
  if (!result) {
    const expectedByteLength =
      expectedDimensions === SEMANTIC_EMBEDDING_DIMENSIONS
        ? SEMANTIC_EMBEDDING_BYTE_LENGTH
        : expectedDimensions * 4
    if (blob.byteLength !== expectedByteLength) {
      throw new Error(
        `Corrupt embedding blob byte length: expected ${expectedByteLength} bytes, got ${blob.byteLength}`
      )
    }
    // Re-run validate to produce exact error for tests expecting throw
    const copy = new Uint8Array(blob.byteLength)
    copy.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength))
    const vector = new Float32Array(copy.buffer, copy.byteOffset, expectedDimensions)
    validateEmbeddingVector(vector, expectedDimensions)
    return vector
  }
  return result
}

export function isObservationTimestampMatching(
  observedMtimeMs: number | null,
  recordedMtimeMs: number | null
): boolean {
  if (observedMtimeMs === null && recordedMtimeMs === null) {
    return true
  }
  if (observedMtimeMs === null || recordedMtimeMs === null) {
    // Conservative null matching: one null and one non-null is an unambiguous mismatch
    return false
  }
  // Stage 2B precision contract:
  // If discovery expectation was recorded as an integer (e.g. truncated precision),
  // tolerate differences strictly within 1.0 ms (|observed - recorded| < 1.0 ms).
  // If recorded has fractional milliseconds, exact comparison is enforced.
  if (Number.isInteger(recordedMtimeMs)) {
    return Math.abs(observedMtimeMs - recordedMtimeMs) < 1.0
  }
  return observedMtimeMs === recordedMtimeMs
}

const CANONICAL_REVISION_REGEX = /^(semrev|rev):(\d+):(\d+):([^:]+):([0-9a-f]{64})$/i

export interface SemanticEmbeddingCompatibilityRecord {
  readonly discoveryObservationId: number
  readonly discoveryByteSize: number
  readonly filesystemMtimeMs: number | null
  readonly activeHash: string | null
  readonly contentSha256: string
  readonly contentRevision: string
  readonly observedByteSize: number
  readonly observedMtimeMs: number | null
}

/**
 * Canonically validates a semantic embedding record's provenance, byte size,
 * Stage 2B timestamp precision policy, content_revision structure, and active hash.
 */
export function isSemanticEmbeddingRecordCompatible(
  record: SemanticEmbeddingCompatibilityRecord
): boolean {
  if (record.observedByteSize !== record.discoveryByteSize) {
    return false
  }
  if (!isObservationTimestampMatching(record.observedMtimeMs, record.filesystemMtimeMs)) {
    return false
  }
  if (
    record.activeHash !== null &&
    record.activeHash.toLowerCase() !== record.contentSha256.toLowerCase()
  ) {
    return false
  }

  const match = CANONICAL_REVISION_REGEX.exec(record.contentRevision)
  if (!match) {
    return false
  }

  const [, , obsIdStr, byteSizeStr, mtimeStr, sha256Str] = match
  if (obsIdStr !== String(record.discoveryObservationId)) {
    return false
  }
  if (byteSizeStr !== String(record.observedByteSize)) {
    return false
  }
  if (sha256Str?.toLowerCase() !== record.contentSha256.toLowerCase()) {
    return false
  }

  if (record.observedMtimeMs === null) {
    if (mtimeStr !== 'null') {
      return false
    }
  } else {
    if (!mtimeStr || mtimeStr === 'null') {
      return false
    }
    const parsedMtime = Number(mtimeStr)
    if (!Number.isFinite(parsedMtime) || parsedMtime !== record.observedMtimeMs) {
      return false
    }
    if (!isObservationTimestampMatching(parsedMtime, record.filesystemMtimeMs)) {
      return false
    }
  }

  return true
}
