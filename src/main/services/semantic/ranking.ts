/**
 * Personal Vault — Semantic Search Ranking Engine (Stage 6D)
 *
 * Implements bounded cosine similarity ranking over 512-d unit-normalized Float32Array vectors.
 * Strict deterministic ordering: score DESC, fileLocationId ASC.
 * Bounded auxiliary heap / top-K list with constant memory guarantees.
 */

import { SEMANTIC_EMBEDDING_DIMENSIONS } from './manifest'

export interface RankCandidate {
  readonly fileLocationId: number
  readonly vector: Float32Array
}

export interface RankOptions {
  readonly limit?: number
  readonly offset?: number
  readonly minScore?: number
}

export interface RankedItem {
  readonly fileLocationId: number
  readonly score: number
}

export interface RankResult {
  readonly items: readonly RankedItem[]
  readonly totalMatched: number
  readonly hasMore: boolean
}

/**
 * Computes exact dot product (cosine similarity for unit-normalized L2 vectors).
 * Throws on dimension mismatch or non-finite values (NaN, +/- Infinity).
 */
export function cosineSimilarity(
  vecA: Float32Array,
  vecB: Float32Array,
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): number {
  if (vecA.length !== vecB.length) {
    throw new RangeError(
      `Dimension mismatch for cosine similarity: ${vecA.length} vs ${vecB.length}`
    )
  }
  if (expectedDimensions > 0 && vecA.length !== expectedDimensions) {
    throw new RangeError(`Expected ${expectedDimensions} vector dimensions, got ${vecA.length}`)
  }

  let dot = 0
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i]!
    const b = vecB[i]!
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new RangeError(`Non-finite value encountered in embedding vector at index ${i}`)
    }
    dot += a * b
  }

  return dot
}

/**
 * Compares two ranked entries deterministically:
 * Primary: score DESC
 * Secondary: fileLocationId ASC (stable tie-breaker)
 */
function compareRankedEntries(aScore: number, aId: number, bScore: number, bId: number): number {
  // Score DESC
  if (aScore !== bScore) {
    return bScore - aScore
  }
  // ID ASC
  return aId - bId
}

/**
 * Ranks an iterable/stream of candidates against a query vector.
 * Retains at most maxRetained = min(offset + limit, 1000) candidates in bounded memory.
 */
export function rankCandidates(
  queryVector: Float32Array,
  candidates: Iterable<RankCandidate>,
  options: RankOptions = {}
): RankResult {
  const limit = Math.max(1, options.limit ?? 50)
  const offset = Math.max(0, options.offset ?? 0)
  const minScore = options.minScore ?? 0.0
  const maxRetained = Math.max(offset + limit, 1000)

  // Validate query vector
  if (!(queryVector instanceof Float32Array) || queryVector.length === 0) {
    throw new TypeError('Query vector must be a non-empty Float32Array')
  }

  let totalMatched = 0
  const topList: Array<{ fileLocationId: number; score: number }> = []

  for (const candidate of candidates) {
    const score = cosineSimilarity(queryVector, candidate.vector)
    if (score < minScore) {
      continue
    }

    totalMatched++

    // Insertion into sorted topList (bounded to maxRetained)
    // Binary search for insertion point
    let low = 0
    let high = topList.length

    while (low < high) {
      const mid = (low + high) >>> 1
      const item = topList[mid]!
      if (
        compareRankedEntries(score, candidate.fileLocationId, item.score, item.fileLocationId) < 0
      ) {
        high = mid
      } else {
        low = mid + 1
      }
    }

    // Insert at low
    if (low < maxRetained) {
      topList.splice(low, 0, { fileLocationId: candidate.fileLocationId, score })
      if (topList.length > maxRetained) {
        topList.pop()
      }
    }
  }

  const paginated = topList.slice(offset, offset + limit)
  const hasMore = offset + paginated.length < totalMatched

  return {
    items: paginated,
    totalMatched,
    hasMore
  }
}
