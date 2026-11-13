/**
 * Personal Vault — Semantic Search Ranking Engine (Stage 6D)
 *
 * Implements bounded cosine similarity ranking over 512-d unit-normalized Float32Array vectors.
 * Strict deterministic ordering: score DESC, fileLocationId ASC.
 * Bounded auxiliary heap / top-K list with constant memory guarantees.
 */

import { DatabaseSync } from 'node:sqlite'
import { SEMANTIC_EMBEDDING_DIMENSIONS } from './manifest'

export const RANKING_LIMITS = {
  MAX_OFFSET: 10_000,
  MAX_LIMIT: 100,
  MAX_RETAINED_K: 10_100
} as const

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
 * Validates a query vector at the ranking boundary.
 * Throws TypeError if not a Float32Array, RangeError on dimension mismatch,
 * non-finite elements, or unnormalized/zero vectors.
 */
export function validateQueryVector(
  vector: unknown,
  expectedDimensions = SEMANTIC_EMBEDDING_DIMENSIONS
): Float32Array {
  if (!(vector instanceof Float32Array)) {
    throw new TypeError('Query vector must be a Float32Array')
  }
  if (expectedDimensions > 0 && vector.length !== expectedDimensions) {
    throw new RangeError(
      `Query vector dimension mismatch: expected ${expectedDimensions}, got ${vector.length}`
    )
  }
  let sumSq = 0
  for (let i = 0; i < vector.length; i++) {
    const val = vector[i]
    if (val === undefined || !Number.isFinite(val)) {
      throw new RangeError(`Query vector contains non-finite value at index ${i}`)
    }
    sumSq += val * val
  }
  const norm = Math.sqrt(sumSq)
  if (!Number.isFinite(norm) || norm <= 1e-12) {
    throw new RangeError('Query vector has zero or degenerate magnitude')
  }
  if (Math.abs(norm - 1.0) > 1e-2) {
    throw new RangeError(`Query vector is not unit-normalized: norm is ${norm.toFixed(6)}`)
  }
  return vector
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
export function compareRankedEntries(
  aScore: number,
  aId: number,
  bScore: number,
  bId: number
): number {
  // Score DESC
  if (aScore !== bScore) {
    return bScore - aScore
  }
  // ID ASC
  return aId - bId
}

/**
 * Determines whether candidate A is "worse" than candidate B in a Top-K Min-Heap.
 * In a Min-Heap of top results, the root is the worst item of the retained set.
 * A is worse than B if A has a lower score, or the same score with a higher ID.
 */
function isWorse(aScore: number, aId: number, bScore: number, bId: number): boolean {
  if (aScore !== bScore) {
    return aScore < bScore
  }
  return aId > bId
}

interface HeapNode {
  readonly fileLocationId: number
  readonly score: number
}

/**
 * Bounded Top-K Min-Heap maintaining at most `capacity` best candidates.
 * Root element at index 0 is always the worst of the top K.
 * Amortized O(1) rejection for candidates worse than the current K-th best.
 * O(log K) insertion/sift-down when a better candidate is admitted.
 */
export class TopKMinHeap {
  private readonly items: HeapNode[] = []
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  public get size(): number {
    return this.items.length
  }

  public push(fileLocationId: number, score: number): void {
    if (this.capacity <= 0) return

    if (this.items.length < this.capacity) {
      this.items.push({ fileLocationId, score })
      this.siftUp(this.items.length - 1)
      return
    }

    // Capacity is full. Root is the worst item in top K.
    const root = this.items[0]!
    if (isWorse(root.score, root.fileLocationId, score, fileLocationId)) {
      this.items[0] = { fileLocationId, score }
      this.siftDown(0)
    }
  }

  private siftUp(index: number): void {
    let curr = index
    while (curr > 0) {
      const parent = (curr - 1) >>> 1
      const pItem = this.items[parent]!
      const cItem = this.items[curr]!
      if (isWorse(cItem.score, cItem.fileLocationId, pItem.score, pItem.fileLocationId)) {
        this.items[parent] = cItem
        this.items[curr] = pItem
        curr = parent
      } else {
        break
      }
    }
  }

  private siftDown(index: number): void {
    const len = this.items.length
    let curr = index
    while (true) {
      const left = (curr << 1) + 1
      const right = left + 1
      let smallest = curr

      if (
        left < len &&
        isWorse(
          this.items[left]!.score,
          this.items[left]!.fileLocationId,
          this.items[smallest]!.score,
          this.items[smallest]!.fileLocationId
        )
      ) {
        smallest = left
      }

      if (
        right < len &&
        isWorse(
          this.items[right]!.score,
          this.items[right]!.fileLocationId,
          this.items[smallest]!.score,
          this.items[smallest]!.fileLocationId
        )
      ) {
        smallest = right
      }

      if (smallest !== curr) {
        const temp = this.items[curr]!
        this.items[curr] = this.items[smallest]!
        this.items[smallest] = temp
        curr = smallest
      } else {
        break
      }
    }
  }

  public toSortedArray(): HeapNode[] {
    return this.items
      .slice()
      .sort((a, b) => compareRankedEntries(a.score, a.fileLocationId, b.score, b.fileLocationId))
  }
}

/**
 * Ranks an iterable/stream of candidates against a query vector.
 * Retains at most K = min(offset + limit, RANKING_LIMITS.MAX_RETAINED_K) candidates
 * in a bounded binary Top-K Min-Heap with constant memory guarantees.
 */
export function rankCandidates(
  queryVector: Float32Array,
  candidates: Iterable<RankCandidate>,
  options: RankOptions = {}
): RankResult {
  const limit = Math.min(Math.max(1, options.limit ?? 50), RANKING_LIMITS.MAX_LIMIT)
  const offset = Math.max(0, options.offset ?? 0)
  const minScore = options.minScore ?? 0.0

  if (offset > RANKING_LIMITS.MAX_OFFSET) {
    throw new RangeError(
      `Offset ${offset} exceeds maximum deep ranking limit of ${RANKING_LIMITS.MAX_OFFSET}`
    )
  }

  validateQueryVector(queryVector)

  const neededK = Math.min(offset + limit, RANKING_LIMITS.MAX_RETAINED_K)
  const heap = new TopKMinHeap(neededK)
  let totalMatched = 0

  for (const candidate of candidates) {
    const score = cosineSimilarity(queryVector, candidate.vector)
    if (score < minScore) {
      continue
    }

    totalMatched++
    heap.push(candidate.fileLocationId, score)
  }

  const sorted = heap.toSortedArray()
  const paginated = sorted.slice(offset, offset + limit)
  const hasMore = offset + paginated.length < totalMatched

  return {
    items: paginated,
    totalMatched,
    hasMore
  }
}

export const IN_MEMORY_HEAP_PAGING_THRESHOLD = 1_000

/**
 * Ranks an iterable/stream of candidates against a query vector with no artificial
 * offset cap while keeping memory strictly bounded:
 * - For offset + limit <= 1,000, uses TopKMinHeap in-memory (<= 1,000 retained entries).
 * - For offset + limit > 1,000, streams into a private disk-backed temporary SQLite
 *   database with cache_size capped to 2 MiB and temp_store = FILE.
 */
export function rankCandidatesWithBoundedPaging(
  queryVector: Float32Array,
  candidates: Iterable<RankCandidate>,
  options: RankOptions = {}
): RankResult {
  const limit = Math.min(Math.max(1, options.limit ?? 50), RANKING_LIMITS.MAX_LIMIT)
  const offset = Math.max(0, options.offset ?? 0)
  const minScore = options.minScore ?? 0.0

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid offset: ${offset}`)
  }

  validateQueryVector(queryVector)

  if (offset + limit <= IN_MEMORY_HEAP_PAGING_THRESHOLD) {
    return rankCandidates(queryVector, candidates, { limit, offset, minScore })
  }

  const scratchDb = new DatabaseSync('')
  try {
    scratchDb.exec(`
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -2000;
      PRAGMA synchronous = OFF;
      PRAGMA journal_mode = OFF;
      CREATE TABLE ranked_candidates (
        file_location_id INTEGER NOT NULL,
        score REAL NOT NULL
      );
    `)

    const insertStmt = scratchDb.prepare(
      'INSERT INTO ranked_candidates (file_location_id, score) VALUES (?, ?);'
    )
    let totalMatched = 0

    scratchDb.exec('BEGIN TRANSACTION;')
    try {
      for (const candidate of candidates) {
        const score = cosineSimilarity(queryVector, candidate.vector)
        if (score < minScore) {
          continue
        }
        totalMatched++
        insertStmt.run(candidate.fileLocationId, score)
      }
      scratchDb.exec('COMMIT;')
    } catch (err) {
      try {
        scratchDb.exec('ROLLBACK;')
      } catch {
        // ignore rollback error
      }
      throw err
    }

    scratchDb.exec(
      'CREATE INDEX idx_ranked_candidates_order ON ranked_candidates (score DESC, file_location_id ASC);'
    )

    const rows = scratchDb
      .prepare(
        'SELECT file_location_id, score FROM ranked_candidates ORDER BY score DESC, file_location_id ASC LIMIT ? OFFSET ?;'
      )
      .all(limit, offset) as Array<{ file_location_id: number; score: number }>

    const items: RankedItem[] = rows.map((r) => ({
      fileLocationId: r.file_location_id,
      score: r.score
    }))
    const hasMore = offset + items.length < totalMatched

    return {
      items,
      totalMatched,
      hasMore
    }
  } finally {
    try {
      scratchDb.close()
    } catch {
      // ignore close error
    }
  }
}
