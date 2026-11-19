// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  computeDocCosineSimilarity,
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  l2NormalizeDocVector,
  rankDocumentChunksStreaming,
  validateAndSerializeDocEmbeddingVector,
  type DocTextSourceKind,
  type StreamedDocChunkCandidate
} from '../../src/main/services/documents/semantic'

function makeUnitVec(angleSeed: number): Float32Array {
  const raw = new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
  raw[0] = Math.cos(angleSeed)
  raw[1] = Math.sin(angleSeed)
  raw[2] = ((angleSeed * 7) % 1) * 0.25
  return l2NormalizeDocVector(raw, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
}

function exhaustiveReferenceRanker(
  query: Float32Array,
  chunks: readonly StreamedDocChunkCandidate[],
  options: { offset?: number; limit?: number; minScore?: number } = {}
) {
  const offset = options.offset ?? 0
  const limit = options.limit ?? 50
  const minScore = options.minScore ?? -Infinity

  const byDoc = new Map<
    number,
    {
      fileLocationId: number
      score: number
      winningChunkId: number
      winningChunkIndex: number
      textSourceKind: DocTextSourceKind
      charOffsetStart: number
      charOffsetEnd: number
    }
  >()

  let corrupt = 0
  for (const ch of chunks) {
    if (
      ch.vectorDimensions !== DOC_SEMANTIC_EMBEDDING_DIMENSIONS ||
      ch.embeddingBlob.byteLength !== DOC_SEMANTIC_EMBEDDING_DIMENSIONS * 4
    ) {
      corrupt += 1
      continue
    }
    const view = new Float32Array(
      ch.embeddingBlob.buffer,
      ch.embeddingBlob.byteOffset,
      DOC_SEMANTIC_EMBEDDING_DIMENSIONS
    )
    let normSq = 0
    let finite = true
    for (let i = 0; i < view.length; i += 1) {
      if (!Number.isFinite(view[i]!)) {
        finite = false
        break
      }
      normSq += view[i]! * view[i]!
    }
    if (!finite || Math.abs(Math.sqrt(normSq) - 1) > 1e-3) {
      corrupt += 1
      continue
    }

    const score = computeDocCosineSimilarity(query, view, DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    const prev = byDoc.get(ch.fileLocationId)
    const better =
      !prev ||
      score > prev.score ||
      (score === prev.score &&
        (ch.textSourceKind !== prev.textSourceKind
          ? ch.textSourceKind === 'native'
          : ch.chunkIndex !== prev.winningChunkIndex
            ? ch.chunkIndex < prev.winningChunkIndex
            : ch.chunkId < prev.winningChunkId))

    if (better) {
      byDoc.set(ch.fileLocationId, {
        fileLocationId: ch.fileLocationId,
        score,
        winningChunkId: ch.chunkId,
        winningChunkIndex: ch.chunkIndex,
        textSourceKind: ch.textSourceKind,
        charOffsetStart: ch.charOffsetStart,
        charOffsetEnd: ch.charOffsetEnd
      })
    }
  }

  const allDocs = Array.from(byDoc.values())
    .filter((d) => d.score >= minScore)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.fileLocationId - b.fileLocationId))

  const page = allDocs.slice(offset, offset + limit)
  return {
    items: page,
    totalMatched: allDocs.length,
    hasMore: offset + page.length < allDocs.length,
    corruptChunkCount: corrupt
  }
}

describe('Stage 7D Slice 2: Bounded Document Max-Chunk Ranking', () => {
  it('matches exhaustive reference ranker across multi-chunk docs, dual native+OCR tracks, tied scores, and corrupt chunks (heap path)', () => {
    const query = makeUnitVec(0.2)
    const chunks: StreamedDocChunkCandidate[] = []
    let nextChunkId = 1

    // Doc 10: native chunk 0 tied with ocr chunk 0 -> native must win tie
    const tiedBlob = validateAndSerializeDocEmbeddingVector(makeUnitVec(0.35))
    chunks.push({
      chunkId: nextChunkId++,
      fileLocationId: 10,
      textSourceKind: 'ocr',
      chunkIndex: 0,
      charOffsetStart: 0,
      charOffsetEnd: 20,
      vectorDimensions: 384,
      embeddingBlob: tiedBlob,
      truncated: false,
      normalizedCharCount: 20,
      indexedCharCount: 20,
      coverageRatio: 1
    })
    chunks.push({
      chunkId: nextChunkId++,
      fileLocationId: 10,
      textSourceKind: 'native',
      chunkIndex: 0,
      charOffsetStart: 0,
      charOffsetEnd: 25,
      vectorDimensions: 384,
      embeddingBlob: tiedBlob,
      truncated: false,
      normalizedCharCount: 25,
      indexedCharCount: 25,
      coverageRatio: 1
    })

    // Doc 20: tied score with Doc 10 -> Doc 10 must rank before Doc 20 (fileLocationId ASC)
    chunks.push({
      chunkId: nextChunkId++,
      fileLocationId: 20,
      textSourceKind: 'native',
      chunkIndex: 1,
      charOffsetStart: 30,
      charOffsetEnd: 60,
      vectorDimensions: 384,
      embeddingBlob: tiedBlob,
      truncated: true,
      normalizedCharCount: 100,
      indexedCharCount: 60,
      coverageRatio: 0.6
    })

    // Doc 30: corrupt chunk + valid OCR chunk in tail
    chunks.push({
      chunkId: nextChunkId++,
      fileLocationId: 30,
      textSourceKind: 'native',
      chunkIndex: 0,
      charOffsetStart: 0,
      charOffsetEnd: 10,
      vectorDimensions: 384,
      embeddingBlob: Buffer.from([1, 2, 3, 4]), // corrupt length
      truncated: false,
      normalizedCharCount: 10,
      indexedCharCount: 10,
      coverageRatio: 1
    })
    chunks.push({
      chunkId: nextChunkId++,
      fileLocationId: 30,
      textSourceKind: 'ocr',
      chunkIndex: 2,
      charOffsetStart: 40,
      charOffsetEnd: 80,
      vectorDimensions: 384,
      embeddingBlob: validateAndSerializeDocEmbeddingVector(makeUnitVec(0.21)), // closest to query!
      truncated: false,
      normalizedCharCount: 80,
      indexedCharCount: 80,
      coverageRatio: 1
    })

    // Doc 40: lower score
    chunks.push({
      chunkId: nextChunkId,
      fileLocationId: 40,
      textSourceKind: 'native',
      chunkIndex: 0,
      charOffsetStart: 0,
      charOffsetEnd: 15,
      vectorDimensions: 384,
      embeddingBlob: validateAndSerializeDocEmbeddingVector(makeUnitVec(2.4)),
      truncated: false,
      normalizedCharCount: 15,
      indexedCharCount: 15,
      coverageRatio: 1
    })

    const expected = exhaustiveReferenceRanker(query, chunks, { offset: 0, limit: 10 })
    const actual = rankDocumentChunksStreaming(query, chunks, { offset: 0, limit: 10 })

    expect(actual.corruptChunkCount).toBe(1)
    expect(actual.totalMatched).toBe(expected.totalMatched)
    expect(actual.hasMore).toBe(expected.hasMore)
    expect(
      actual.items.map((i) => ({
        fileLocationId: i.fileLocationId,
        winningChunkId: i.winningChunkId,
        textSourceKind: i.textSourceKind,
        winningChunkIndex: i.winningChunkIndex
      }))
    ).toEqual(
      expected.items.map((i) => ({
        fileLocationId: i.fileLocationId,
        winningChunkId: i.winningChunkId,
        textSourceKind: i.textSourceKind,
        winningChunkIndex: i.winningChunkIndex
      }))
    )
    expect(actual.items[0]!.fileLocationId).toBe(30)
    expect(actual.items[1]!.fileLocationId).toBe(10)
    expect(actual.items[1]!.textSourceKind).toBe('native')
    expect(actual.items[2]!.fileLocationId).toBe(20)
  })

  it('matches exhaustive reference ranker on deep pagination (offset + limit > 1,000 disk-backed SQLite path)', () => {
    const query = makeUnitVec(0.1)
    const chunks: StreamedDocChunkCandidate[] = []
    let chunkId = 1

    for (let docId = 1; docId <= 1250; docId += 1) {
      // 2 chunks per doc, occasionally dual tracks
      const blob1 = validateAndSerializeDocEmbeddingVector(makeUnitVec((docId % 97) * 0.03))
      const blob2 = validateAndSerializeDocEmbeddingVector(makeUnitVec(((docId * 3) % 89) * 0.03))
      chunks.push({
        chunkId: chunkId++,
        fileLocationId: docId,
        textSourceKind: 'native',
        chunkIndex: 0,
        charOffsetStart: 0,
        charOffsetEnd: 10,
        vectorDimensions: 384,
        embeddingBlob: blob1,
        truncated: false,
        normalizedCharCount: 20,
        indexedCharCount: 20,
        coverageRatio: 1
      })
      chunks.push({
        chunkId: chunkId++,
        fileLocationId: docId,
        textSourceKind: docId % 3 === 0 ? 'ocr' : 'native',
        chunkIndex: 1,
        charOffsetStart: 10,
        charOffsetEnd: 20,
        vectorDimensions: 384,
        embeddingBlob: blob2,
        truncated: false,
        normalizedCharCount: 20,
        indexedCharCount: 20,
        coverageRatio: 1
      })
    }

    const opts = { offset: 1050, limit: 50 }
    const expected = exhaustiveReferenceRanker(query, chunks, opts)
    const actual = rankDocumentChunksStreaming(query, chunks, opts)

    expect(actual.totalMatched).toBe(1250)
    expect(actual.hasMore).toBe(true)
    expect(actual.items).toHaveLength(50)
    expect(
      actual.items.map((i) => ({
        fileLocationId: i.fileLocationId,
        winningChunkId: i.winningChunkId,
        textSourceKind: i.textSourceKind
      }))
    ).toEqual(
      expected.items.map((i) => ({
        fileLocationId: i.fileLocationId,
        winningChunkId: i.winningChunkId,
        textSourceKind: i.textSourceKind
      }))
    )
  })
})
