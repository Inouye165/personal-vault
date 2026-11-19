/**
 * Personal Vault — Stage 7D Bounded Document-Level Max-Chunk Ranking Engine
 *
 * Implements Section 4.3 of `docs/stage-7d-document-semantic-evaluation.md`:
 * - Contiguous streaming over `ORDER BY c.file_location_id ASC, c.id ASC`
 * - Single `currentDoc` accumulator in JS memory (O(1) doc state, no unbounded doc Map)
 * - Per-chunk corrupt vector isolation via `tryDeserializeDocEmbeddingVector`
 * - Deterministic winning-chunk tie-breaking:
 *     higher score -> 'native' before 'ocr' -> lower chunkIndex -> lower chunkId
 * - Bounded document pagination:
 *     - `offset + limit <= 1_000`: `DocTopKMinHeap` in JS memory
 *     - `offset + limit > 1_000`: private disk-backed `new DatabaseSync('')`
 *       with `PRAGMA temp_store = FILE; PRAGMA cache_size = -2000;` (2 MiB cap)
 *       closed deterministically in `finally`
 * - Deterministic document ordering: `score DESC, fileLocationId ASC`.
 */

import { DatabaseSync } from 'node:sqlite'
import { DOC_SEMANTIC_EMBEDDING_DIMENSIONS } from './manifest'
import { tryDeserializeDocEmbeddingVector, validateDocQueryVector } from './vector'

export const DOC_RANKING_LIMITS = {
  HEAP_THRESHOLD_K: 1_000,
  MAX_LIMIT: 100
} as const

export type DocTextSourceKind = 'native' | 'ocr'

export interface StreamedDocChunkCandidate {
  readonly chunkId: number
  readonly fileLocationId: number
  readonly textSourceKind: DocTextSourceKind
  readonly chunkIndex: number
  readonly charOffsetStart: number
  readonly charOffsetEnd: number
  readonly vectorDimensions: number
  readonly embeddingBlob: Uint8Array | Buffer
  readonly truncated: boolean
  readonly normalizedCharCount: number
  readonly indexedCharCount: number
  readonly coverageRatio: number
}

export interface RankedDocResult {
  readonly fileLocationId: number
  readonly score: number
  readonly winningChunkId: number
  readonly winningChunkIndex: number
  readonly textSourceKind: DocTextSourceKind
  readonly charOffsetStart: number
  readonly charOffsetEnd: number
  readonly truncated: boolean
  readonly normalizedCharCount: number
  readonly indexedCharCount: number
  readonly coverageRatio: number
}

export interface DocRankOptions {
  readonly limit?: number
  readonly offset?: number
  readonly minScore?: number
}

export interface DocRankResult {
  readonly items: readonly RankedDocResult[]
  readonly totalMatched: number
  readonly hasMore: boolean
  readonly eligibleChunkCount: number
  readonly corruptChunkCount: number
}

export function computeDocCosineSimilarity(
  vecA: Float32Array,
  vecB: Float32Array,
  expectedDimensions = DOC_SEMANTIC_EMBEDDING_DIMENSIONS
): number {
  if (vecA.length !== vecB.length || vecA.length !== expectedDimensions) {
    throw new RangeError(
      `Document embedding dimension mismatch: expected ${expectedDimensions}, got ${vecA.length} and ${vecB.length}`
    )
  }
  let dot = 0
  for (let i = 0; i < expectedDimensions; i += 1) {
    dot += vecA[i]! * vecB[i]!
  }
  if (!Number.isFinite(dot)) {
    throw new RangeError('Non-finite dot product encountered during document ranking')
  }
  return dot
}

/**
 * Min-heap of size K retaining the best K documents ordered by:
 *   higher score wins; on equal score, smaller fileLocationId wins.
 * The heap root is the WORST of the retained top K so O(1) rejection works.
 */
class DocTopKMinHeap {
  private readonly heap: RankedDocResult[] = []

  public constructor(private readonly capacity: number) {}

  private static isBetter(a: RankedDocResult, b: RankedDocResult): boolean {
    if (a.score !== b.score) return a.score > b.score
    return a.fileLocationId < b.fileLocationId
  }

  public push(item: RankedDocResult): void {
    if (this.capacity <= 0) return
    if (this.heap.length < this.capacity) {
      this.heap.push(item)
      this.siftUp(this.heap.length - 1)
      return
    }
    const root = this.heap[0]!
    if (DocTopKMinHeap.isBetter(item, root)) {
      this.heap[0] = item
      this.siftDown(0)
    }
  }

  public toSortedDescending(): RankedDocResult[] {
    return this.heap.slice().sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return a.fileLocationId - b.fileLocationId
    })
  }

  private siftUp(idx: number): void {
    let i = idx
    while (i > 0) {
      const parent = (i - 1) >> 1
      // Keep worst at root: if child is worse than parent, swap child up
      if (DocTopKMinHeap.isBetter(this.heap[parent]!, this.heap[i]!)) {
        const tmp = this.heap[parent]!
        this.heap[parent] = this.heap[i]!
        this.heap[i] = tmp
        i = parent
      } else {
        break
      }
    }
  }

  private siftDown(idx: number): void {
    let i = idx
    const n = this.heap.length
    while (true) {
      const left = i * 2 + 1
      const right = left + 1
      let worst = i
      if (left < n && DocTopKMinHeap.isBetter(this.heap[worst]!, this.heap[left]!)) {
        worst = left
      }
      if (right < n && DocTopKMinHeap.isBetter(this.heap[worst]!, this.heap[right]!)) {
        worst = right
      }
      if (worst === i) break
      const tmp = this.heap[i]!
      this.heap[i] = this.heap[worst]!
      this.heap[worst] = tmp
      i = worst
    }
  }
}

class DocDiskBackedRanker {
  private readonly db: DatabaseSync
  private readonly insertStmt: ReturnType<DatabaseSync['prepare']>

  public constructor() {
    this.db = new DatabaseSync('')
    this.db.exec('PRAGMA temp_store = FILE;')
    this.db.exec('PRAGMA cache_size = -2000;')
    this.db.exec(`
      CREATE TABLE ranked_docs (
        file_location_id INTEGER PRIMARY KEY,
        score REAL NOT NULL,
        winning_chunk_id INTEGER NOT NULL,
        winning_chunk_index INTEGER NOT NULL,
        text_source_kind TEXT NOT NULL,
        char_offset_start INTEGER NOT NULL,
        char_offset_end INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        normalized_char_count INTEGER NOT NULL,
        indexed_char_count INTEGER NOT NULL,
        coverage_ratio REAL NOT NULL
      );
      CREATE INDEX idx_ranked_docs_order ON ranked_docs(score DESC, file_location_id ASC);
    `)
    this.insertStmt = this.db.prepare(`
      INSERT INTO ranked_docs (
        file_location_id,
        score,
        winning_chunk_id,
        winning_chunk_index,
        text_source_kind,
        char_offset_start,
        char_offset_end,
        truncated,
        normalized_char_count,
        indexed_char_count,
        coverage_ratio
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  public insert(item: RankedDocResult): void {
    this.insertStmt.run(
      item.fileLocationId,
      item.score,
      item.winningChunkId,
      item.winningChunkIndex,
      item.textSourceKind,
      item.charOffsetStart,
      item.charOffsetEnd,
      item.truncated ? 1 : 0,
      item.normalizedCharCount,
      item.indexedCharCount,
      item.coverageRatio
    )
  }

  public queryPage(offset: number, limit: number): RankedDocResult[] {
    const rows = this.db
      .prepare(
        `
      SELECT
        file_location_id,
        score,
        winning_chunk_id,
        winning_chunk_index,
        text_source_kind,
        char_offset_start,
        char_offset_end,
        truncated,
        normalized_char_count,
        indexed_char_count,
        coverage_ratio
      FROM ranked_docs
      ORDER BY score DESC, file_location_id ASC
      LIMIT ? OFFSET ?
    `
      )
      .all(limit, offset) as Array<{
      file_location_id: number
      score: number
      winning_chunk_id: number
      winning_chunk_index: number
      text_source_kind: DocTextSourceKind
      char_offset_start: number
      char_offset_end: number
      truncated: number
      normalized_char_count: number
      indexed_char_count: number
      coverage_ratio: number
    }>

    return rows.map((r) => ({
      fileLocationId: r.file_location_id,
      score: r.score,
      winningChunkId: r.winning_chunk_id,
      winningChunkIndex: r.winning_chunk_index,
      textSourceKind: r.text_source_kind,
      charOffsetStart: r.char_offset_start,
      charOffsetEnd: r.char_offset_end,
      truncated: r.truncated === 1,
      normalizedCharCount: r.normalized_char_count,
      indexedCharCount: r.indexed_char_count,
      coverageRatio: r.coverage_ratio
    }))
  }

  public close(): void {
    try {
      this.db.close()
    } catch {
      // ignore close errors on temp ranking db
    }
  }
}

function isCandidateChunkBetter(
  score: number,
  chunk: StreamedDocChunkCandidate,
  current: RankedDocResult
): boolean {
  if (score !== current.score) {
    return score > current.score
  }
  if (chunk.textSourceKind !== current.textSourceKind) {
    return chunk.textSourceKind === 'native'
  }
  if (chunk.chunkIndex !== current.winningChunkIndex) {
    return chunk.chunkIndex < current.winningChunkIndex
  }
  return chunk.chunkId < current.winningChunkId
}

/**
 * Ranks streamed chunks ordered by `(file_location_id ASC, chunk_id ASC)` using
 * one `currentDoc` accumulator in O(1) memory, aggregating max-chunk score per document.
 */
export function rankDocumentChunksStreaming(
  queryVector: Float32Array,
  orderedChunks: Iterable<StreamedDocChunkCandidate>,
  options: DocRankOptions = {}
): DocRankResult {
  validateDocQueryVector(queryVector, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
  const validQuery = queryVector
  const limit = Math.min(DOC_RANKING_LIMITS.MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? 50)))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const minScore = options.minScore ?? -Infinity
  const k = offset + limit
  const useHeap = k <= DOC_RANKING_LIMITS.HEAP_THRESHOLD_K

  const heap = useHeap ? new DocTopKMinHeap(k) : null
  const diskRanker = useHeap ? null : new DocDiskBackedRanker()

  let eligibleChunkCount = 0
  let corruptChunkCount = 0
  let totalMatched = 0
  let currentDoc: RankedDocResult | null = null
  let prevFileLocationId = -Infinity

  const flushCurrentDoc = (): void => {
    if (!currentDoc) return
    if (currentDoc.score >= minScore) {
      totalMatched += 1
      if (heap) {
        heap.push(currentDoc)
      } else if (diskRanker) {
        diskRanker.insert(currentDoc)
      }
    }
    currentDoc = null
  }

  try {
    for (const chunk of orderedChunks) {
      if (chunk.fileLocationId < prevFileLocationId) {
        throw new Error(
          `Expected chunks ordered by fileLocationId ASC, saw ${chunk.fileLocationId} after ${prevFileLocationId}`
        )
      }

      if (chunk.vectorDimensions !== DOC_SEMANTIC_EMBEDDING_DIMENSIONS) {
        corruptChunkCount += 1
        continue
      }

      const vec = tryDeserializeDocEmbeddingVector(
        chunk.embeddingBlob,
        DOC_SEMANTIC_EMBEDDING_DIMENSIONS
      )
      if (!vec) {
        corruptChunkCount += 1
        continue
      }

      eligibleChunkCount += 1
      const score = computeDocCosineSimilarity(validQuery, vec, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)

      if (currentDoc !== null && chunk.fileLocationId !== currentDoc.fileLocationId) {
        flushCurrentDoc()
      }
      prevFileLocationId = chunk.fileLocationId

      if (currentDoc === null) {
        currentDoc = {
          fileLocationId: chunk.fileLocationId,
          score,
          winningChunkId: chunk.chunkId,
          winningChunkIndex: chunk.chunkIndex,
          textSourceKind: chunk.textSourceKind,
          charOffsetStart: chunk.charOffsetStart,
          charOffsetEnd: chunk.charOffsetEnd,
          truncated: chunk.truncated,
          normalizedCharCount: chunk.normalizedCharCount,
          indexedCharCount: chunk.indexedCharCount,
          coverageRatio: chunk.coverageRatio
        }
      } else if (isCandidateChunkBetter(score, chunk, currentDoc)) {
        currentDoc = {
          fileLocationId: chunk.fileLocationId,
          score,
          winningChunkId: chunk.chunkId,
          winningChunkIndex: chunk.chunkIndex,
          textSourceKind: chunk.textSourceKind,
          charOffsetStart: chunk.charOffsetStart,
          charOffsetEnd: chunk.charOffsetEnd,
          truncated: chunk.truncated,
          normalizedCharCount: chunk.normalizedCharCount,
          indexedCharCount: chunk.indexedCharCount,
          coverageRatio: chunk.coverageRatio
        }
      }
    }

    flushCurrentDoc()

    const items = heap
      ? heap.toSortedDescending().slice(offset, offset + limit)
      : diskRanker!.queryPage(offset, limit)

    return {
      items,
      totalMatched,
      hasMore: offset + items.length < totalMatched,
      eligibleChunkCount,
      corruptChunkCount
    }
  } finally {
    diskRanker?.close()
  }
}
