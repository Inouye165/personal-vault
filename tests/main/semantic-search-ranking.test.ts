// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  cosineSimilarity,
  rankCandidates,
  rankCandidatesWithBoundedPaging,
  validateQueryVector,
  type RankCandidate
} from '../../src/main/services/semantic/ranking'
import { SEMANTIC_EMBEDDING_DIMENSIONS } from '../../src/main/services/semantic/manifest'
import {
  normalizeEmbeddingVector,
  tryDeserializeEmbeddingVector,
  validateAndSerializeEmbeddingVector
} from '../../src/main/services/semantic/vector'

describe('Stage 6D: Semantic Search Ranking & Bounded Heap', () => {
  function makeUnitVector(seed: number, dims = SEMANTIC_EMBEDDING_DIMENSIONS): Float32Array {
    const raw = new Float32Array(dims)
    for (let i = 0; i < dims; i++) {
      raw[i] = Math.sin(seed * (i + 1))
    }
    return normalizeEmbeddingVector(raw, dims)
  }

  describe('cosineSimilarity', () => {
    it('computes exact dot product for unit-normalized vectors', () => {
      const v1 = makeUnitVector(1)
      const v2 = makeUnitVector(1)
      // Identical vectors -> similarity ~ 1.0
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5)

      // Orthogonal vectors
      const o1 = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      const o2 = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      o1[0] = 1.0
      o2[1] = 1.0
      expect(cosineSimilarity(o1, o2)).toBeCloseTo(0.0, 5)

      // Opposite vectors
      const opp = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      opp[0] = -1.0
      expect(cosineSimilarity(o1, opp)).toBeCloseTo(-1.0, 5)
    })

    it('rejects dimension mismatches or malformed vectors', () => {
      const v512 = makeUnitVector(1, 512)
      const v256 = makeUnitVector(1, 256)
      expect(() => cosineSimilarity(v512, v256)).toThrow(/dimension/i)

      const badVec = new Float32Array(512)
      badVec[0] = Number.NaN
      expect(() => cosineSimilarity(v512, badVec)).toThrow(/non-finite|nan/i)

      const infVec = new Float32Array(512)
      infVec[0] = Number.POSITIVE_INFINITY
      expect(() => cosineSimilarity(v512, infVec)).toThrow(/non-finite|infinity/i)
    })
  })

  describe('rankCandidates with deterministic ordering and stable tie-breaking', () => {
    it('ranks candidates by score DESC and breaks ties deterministically by fileLocationId ASC', () => {
      const queryVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      queryVec[0] = 1.0 // Unit vector along axis 0

      // Create candidates:
      // Candidate 1: score = 0.5, id = 10
      // Candidate 2: score = 0.8, id = 20
      // Candidate 3: score = 0.8, id = 15 (tied with Candidate 2 on score, lower id)
      // Candidate 4: score = 0.8, id = 30 (tied with Candidate 2 on score, higher id)
      // Candidate 5: score = 0.2, id = 5
      const makeVectorWithAxis0 = (score: number) => {
        const v = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
        v[0] = score
        v[1] = Math.sqrt(Math.max(0, 1 - score * score))
        return v
      }

      const candidates: RankCandidate[] = [
        { fileLocationId: 10, vector: makeVectorWithAxis0(0.5) },
        { fileLocationId: 20, vector: makeVectorWithAxis0(0.8) },
        { fileLocationId: 15, vector: makeVectorWithAxis0(0.8) },
        { fileLocationId: 30, vector: makeVectorWithAxis0(0.8) },
        { fileLocationId: 5, vector: makeVectorWithAxis0(0.2) }
      ]

      const result = rankCandidates(queryVec, candidates, { limit: 10, offset: 0, minScore: 0.0 })

      expect(result.totalMatched).toBe(5)
      expect(result.items.map((i) => i.fileLocationId)).toEqual([15, 20, 30, 10, 5])
      // Tied scores must maintain strict id ASC
      expect(result.items[0]?.score).toBeCloseTo(0.8, 5)
      expect(result.items[1]?.score).toBeCloseTo(0.8, 5)
      expect(result.items[2]?.score).toBeCloseTo(0.8, 5)
      expect(result.items[0]?.fileLocationId).toBe(15)
      expect(result.items[1]?.fileLocationId).toBe(20)
      expect(result.items[2]?.fileLocationId).toBe(30)
    })

    it('enforces minScore cutoff and honest match counting', () => {
      const queryVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      queryVec[0] = 1.0

      const makeVectorWithAxis0 = (score: number) => {
        const v = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
        v[0] = score
        v[1] = Math.sqrt(Math.max(0, 1 - score * score))
        return v
      }

      const candidates: RankCandidate[] = [
        { fileLocationId: 1, vector: makeVectorWithAxis0(0.35) },
        { fileLocationId: 2, vector: makeVectorWithAxis0(0.25) },
        { fileLocationId: 3, vector: makeVectorWithAxis0(0.15) },
        { fileLocationId: 4, vector: makeVectorWithAxis0(0.05) }
      ]

      const result = rankCandidates(queryVec, candidates, { limit: 10, offset: 0, minScore: 0.2 })

      expect(result.totalMatched).toBe(2) // only candidates 1 and 2 meet minScore 0.2
      expect(result.items.map((i) => i.fileLocationId)).toEqual([1, 2])
    })

    it('honors pagination offset and limit correctly', () => {
      const queryVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      queryVec[0] = 1.0

      const makeVectorWithAxis0 = (score: number) => {
        const v = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
        v[0] = score
        v[1] = Math.sqrt(Math.max(0, 1 - score * score))
        return v
      }

      const candidates: RankCandidate[] = []
      for (let i = 1; i <= 20; i++) {
        // Decreasing scores from 0.90 down to 0.71
        candidates.push({
          fileLocationId: i,
          vector: makeVectorWithAxis0(0.9 - (i - 1) * 0.01)
        })
      }

      // Page 1: 5 items, offset 0
      const page1 = rankCandidates(queryVec, candidates, { limit: 5, offset: 0 })
      expect(page1.items.map((i) => i.fileLocationId)).toEqual([1, 2, 3, 4, 5])
      expect(page1.totalMatched).toBe(20)
      expect(page1.hasMore).toBe(true)

      // Page 2: 5 items, offset 5
      const page2 = rankCandidates(queryVec, candidates, { limit: 5, offset: 5 })
      expect(page2.items.map((i) => i.fileLocationId)).toEqual([6, 7, 8, 9, 10])
      expect(page2.totalMatched).toBe(20)
      expect(page2.hasMore).toBe(true)

      // Page 4: 5 items, offset 15
      const page4 = rankCandidates(queryVec, candidates, { limit: 5, offset: 15 })
      expect(page4.items.map((i) => i.fileLocationId)).toEqual([16, 17, 18, 19, 20])
      expect(page4.totalMatched).toBe(20)
      expect(page4.hasMore).toBe(false)
    })
  })

  describe('Scale test with bounded memory over >50,000 synthetic embeddings', () => {
    it('ranks 50,001 candidates with bounded auxiliary heap and exact top results', () => {
      const queryVec = makeUnitVector(99999)

      // Generator function producing 50,001 candidates as a stream/iterable
      // without materializing a 50,001-element array
      function* generate50001Candidates(): Generator<RankCandidate> {
        // Target top item at index 34567 with high similarity
        for (let i = 1; i <= 50001; i++) {
          if (i === 34567) {
            yield { fileLocationId: i, vector: queryVec } // exact match: score 1.0
          } else if (i === 12345) {
            // Second highest: score ~0.99
            const v = new Float32Array(queryVec)
            v[0] = (v[0] ?? 0) * 0.99
            yield { fileLocationId: i, vector: normalizeEmbeddingVector(v) }
          } else {
            // Background noise vectors
            yield { fileLocationId: i, vector: makeUnitVector(i) }
          }
        }
      }

      const memBefore = process.memoryUsage().heapUsed
      const t0 = performance.now()

      const result = rankCandidates(queryVec, generate50001Candidates(), {
        limit: 10,
        offset: 0,
        minScore: 0.2
      })

      const elapsedMs = performance.now() - t0
      const memDelta = process.memoryUsage().heapUsed - memBefore

      expect(result.items.length).toBe(10)
      // Top 1 must be fileLocationId 34567 with score 1.0
      expect(result.items[0]?.fileLocationId).toBe(34567)
      expect(result.items[0]?.score).toBeCloseTo(1.0, 5)
      expect(result.items[1]?.fileLocationId).toBe(12345)

      // Bounded processing time and memory
      expect(elapsedMs).toBeLessThan(3000) // fast linear scan
      // Memory delta must not exceed 20 MiB for ranking 50,001 streamed candidates
      expect(memDelta).toBeLessThan(20 * 1024 * 1024)
    })
  })

  describe('validateQueryVector at ranking boundary', () => {
    it('validates and accepts finite unit-normalized Float32Array', () => {
      const validVec = makeUnitVector(42)
      const res = validateQueryVector(validVec)
      expect(res).toBe(validVec)
    })

    it('rejects non-Float32Array', () => {
      expect(() => validateQueryVector([1, 2, 3])).toThrow(TypeError)
      expect(() => validateQueryVector(null)).toThrow(TypeError)
    })

    it('rejects dimension mismatch', () => {
      const shortVec = new Float32Array(256)
      expect(() => validateQueryVector(shortVec)).toThrow(RangeError)
    })

    it('rejects non-finite values (NaN / Infinity)', () => {
      const nanVec = makeUnitVector(1)
      nanVec[10] = Number.NaN
      expect(() => validateQueryVector(nanVec)).toThrow(RangeError)

      const infVec = makeUnitVector(1)
      infVec[20] = Number.POSITIVE_INFINITY
      expect(() => validateQueryVector(infVec)).toThrow(RangeError)
    })

    it('rejects zero or unnormalized vectors', () => {
      const zeroVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      expect(() => validateQueryVector(zeroVec)).toThrow(RangeError)

      const unnormVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      unnormVec[0] = 5.0 // norm is 5.0, not 1.0
      expect(() => validateQueryVector(unnormVec)).toThrow(RangeError)
    })
  })

  describe('tryDeserializeEmbeddingVector per-candidate corruption isolation', () => {
    it('successfully deserializes valid serialized vector', () => {
      const validVec = makeUnitVector(77)
      const blob = validateAndSerializeEmbeddingVector(validVec)
      const parsed = tryDeserializeEmbeddingVector(blob)
      expect(parsed).not.toBeNull()
      expect(parsed!.length).toBe(SEMANTIC_EMBEDDING_DIMENSIONS)
      expect(cosineSimilarity(validVec, parsed!)).toBeCloseTo(1.0, 5)
    })

    it('returns null on invalid input types or wrong byte lengths without throwing', () => {
      expect(tryDeserializeEmbeddingVector(null)).toBeNull()
      expect(tryDeserializeEmbeddingVector(undefined)).toBeNull()
      expect(tryDeserializeEmbeddingVector('not-a-buffer')).toBeNull()
      expect(tryDeserializeEmbeddingVector(Buffer.alloc(100))).toBeNull() // wrong size (expected 2048)
      expect(tryDeserializeEmbeddingVector(Buffer.alloc(4096))).toBeNull()
    })

    it('returns null for blobs containing NaN or Infinity', () => {
      const raw = makeUnitVector(1)
      raw[5] = Number.NaN
      const blob = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      expect(tryDeserializeEmbeddingVector(blob)).toBeNull()

      const rawInf = makeUnitVector(1)
      rawInf[5] = Number.POSITIVE_INFINITY
      const blobInf = Buffer.from(rawInf.buffer, rawInf.byteOffset, rawInf.byteLength)
      expect(tryDeserializeEmbeddingVector(blobInf)).toBeNull()
    })

    it('returns null for zero vectors or non-unit norm blobs', () => {
      const zeroBlob = Buffer.alloc(SEMANTIC_EMBEDDING_DIMENSIONS * 4) // all zeroes
      expect(tryDeserializeEmbeddingVector(zeroBlob)).toBeNull()

      const unnorm = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      unnorm[0] = 2.5
      const unnormBlob = Buffer.from(unnorm.buffer, unnorm.byteOffset, unnorm.byteLength)
      expect(tryDeserializeEmbeddingVector(unnormBlob)).toBeNull()
    })
  })

  describe('Deep jumps and deep pagination bounds in ranking', () => {
    it('enforces maximum offset bound (offset <= 10,000)', () => {
      const queryVec = makeUnitVector(1)
      expect(() => rankCandidates(queryVec, [], { offset: 10_001, limit: 50 })).toThrow(RangeError)
    })

    it('ranks correctly at maximum supported deep offset (offset = 10,000, limit = 50)', () => {
      const queryVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      queryVec[0] = 1.0
      // Stream 10,100 candidates with known scores
      function* generateCandidates(): Generator<RankCandidate> {
        for (let i = 1; i <= 10_100; i++) {
          const v = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
          // Scores strictly decreasing from 1.0 down
          const score = 1.0 - (i - 1) * 0.00005
          v[0] = score
          v[1] = Math.sqrt(Math.max(0, 1 - score * score))
          yield { fileLocationId: i, vector: v }
        }
      }

      const result = rankCandidates(queryVec, generateCandidates(), {
        offset: 10_000,
        limit: 50
      })

      expect(result.totalMatched).toBe(10_100)
      expect(result.items.length).toBe(50)
      // Items should start at fileLocationId 10,001 through 10,050
      expect(result.items[0]?.fileLocationId).toBe(10_001)
      expect(result.items[49]?.fileLocationId).toBe(10_050)
      expect(result.hasMore).toBe(true)
    })

    it('ranks beyond offset 10,000 via rankCandidatesWithBoundedPaging with deterministic tie-breaking', () => {
      const queryVec = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
      queryVec[0] = 1.0

      // Stream 10,200 candidates in reverse ID order with tied score pairs to test disk-backed tie-breaking
      function* generateDeepCandidates(): Generator<RankCandidate> {
        for (let i = 10_200; i >= 1; i--) {
          const v = new Float32Array(SEMANTIC_EMBEDDING_DIMENSIONS)
          // Pair up (1,2), (3,4), ... with identical scores so tie-breaking by fileLocationId ASC is exercised
          const pairIndex = Math.floor((i - 1) / 2)
          const score = 0.99 - pairIndex * 0.0001
          v[0] = score
          v[1] = Math.sqrt(Math.max(0, 1 - score * score))
          yield {
            fileLocationId: i,
            vector: v,
            identity: {
              discoveryObservationId: i * 10,
              contentSha256: 'a'.repeat(64),
              contentRevision: `rev:${i * 10}:2048:1700000000000:${'a'.repeat(64)}`,
              observedByteSize: 2048,
              observedMtimeMs: 1700000000000
            }
          }
        }
      }

      const result = rankCandidatesWithBoundedPaging(queryVec, generateDeepCandidates(), {
        offset: 10_050,
        limit: 50
      })

      expect(result.totalMatched).toBe(10_200)
      expect(result.items.length).toBe(50)
      // Because candidates were yielded in reverse ID order (10,200 down to 1) with tied pairs,
      // deterministic tie-breaking (score DESC, fileLocationId ASC) must order 10,051 before 10,052
      expect(result.items[0]?.fileLocationId).toBe(10_051)
      expect(result.items[1]?.fileLocationId).toBe(10_052)
      expect(result.items[49]?.fileLocationId).toBe(10_100)
      expect(result.items[0]?.identity?.discoveryObservationId).toBe(100_510)
      expect(result.hasMore).toBe(true)
    })
  })
})
