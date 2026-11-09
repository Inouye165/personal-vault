import { describe, expect, it } from 'vitest'
import {
  CLIP_EMBEDDING_DIMENSIONS,
  CLIP_MODEL_ID,
  CLIP_PREPROCESSING_VERSION,
  cosineSimilarityNormalized,
  createVersionedEmbeddingRecord,
  isEmbeddingRecordCurrent,
  l2NormalizeFloat32,
  rankSemanticMatches,
  rgb224ToClipPlanarFloat32
} from '../../spikes/semantic-eval/semantic-core.mjs'

describe('Stage 6A Semantic Evaluation Spike — Core Logic', () => {
  describe('l2NormalizeFloat32', () => {
    it('normalizes a Float32Array to unit L2 length', () => {
      const input = new Float32Array([3, 4, 0])
      const { vector, rawNorm } = l2NormalizeFloat32(input)
      expect(rawNorm).toBeCloseTo(5.0, 6)
      expect(vector[0]).toBeCloseTo(0.6, 6)
      expect(vector[1]).toBeCloseTo(0.8, 6)
      expect(vector[2]).toBeCloseTo(0.0, 6)

      let sumSq = 0
      for (const v of vector) sumSq += v * v
      expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 6)
    })

    it('rejects empty, non-finite, or zero-magnitude vectors', () => {
      expect(() => l2NormalizeFloat32(new Float32Array(0))).toThrow(TypeError)
      expect(() => l2NormalizeFloat32(new Float32Array([0, 0, 0]))).toThrow(RangeError)
      expect(() => l2NormalizeFloat32(new Float32Array([1, Number.NaN, 2]))).toThrow(RangeError)
      expect(() => l2NormalizeFloat32(new Float32Array([1, Number.POSITIVE_INFINITY]))).toThrow(
        RangeError
      )
    })
  })

  describe('rgb224ToClipPlanarFloat32', () => {
    it('converts interleaved 224x224x3 uint8 RGB pixels into CLIP-normalized CHW planar Float32', () => {
      const width = 224
      const height = 224
      const rgb = new Uint8Array(width * height * 3)
      // Set pixel 0 to pure red (255, 0, 0)
      rgb[0] = 255
      rgb[1] = 0
      rgb[2] = 0

      const planar = rgb224ToClipPlanarFloat32(rgb, width, height)
      expect(planar.length).toBe(3 * 224 * 224)

      // Channel R at pixel 0: (1.0 - 0.48145466) / 0.26862954
      expect(planar[0]).toBeCloseTo((1.0 - 0.48145466) / 0.26862954, 5)
      // Channel G at pixel 0: (0.0 - 0.4578275) / 0.26130258
      expect(planar[224 * 224]).toBeCloseTo((0.0 - 0.4578275) / 0.26130258, 5)
      // Channel B at pixel 0: (0.0 - 0.40821073) / 0.27577711
      expect(planar[2 * 224 * 224]).toBeCloseTo((0.0 - 0.40821073) / 0.27577711, 5)
    })

    it('rejects buffers with unexpected byte length', () => {
      expect(() => rgb224ToClipPlanarFloat32(new Uint8Array(100), 224, 224)).toThrow(RangeError)
    })
  })

  describe('Versioned embedding records and revision invalidation', () => {
    const sampleVec = new Float32Array(CLIP_EMBEDDING_DIMENSIONS)
    sampleVec[0] = 1.0

    it('creates a versioned record tied to SHA-256, byte size, mtime, model id, preprocessing version, and dimensions', () => {
      const sha = 'a'.repeat(64)
      const rec = createVersionedEmbeddingRecord({
        fileLocationId: 42,
        discoveryObservationId: 7,
        sha256: sha,
        byteSize: 204800,
        mtimeMs: 1700000000000,
        vector: sampleVec
      })

      expect(rec.fileLocationId).toBe(42)
      expect(rec.contentRevision).toBe(`rev:7:204800:1700000000000:${sha}`)
      expect(rec.modelId).toBe(CLIP_MODEL_ID)
      expect(rec.preprocessingVersion).toBe(CLIP_PREPROCESSING_VERSION)
      expect(rec.dimensions).toBe(CLIP_EMBEDDING_DIMENSIONS)
      expect(rec.vectorBuffer.byteLength).toBe(512 * 4)

      expect(
        isEmbeddingRecordCurrent(rec, {
          discoveryObservationId: 7,
          byteSize: 204800,
          mtimeMs: 1700000000000,
          sha256: sha
        })
      ).toBe(true)
    })

    it('invalidates the record when SHA-256, byteSize, observationId, modelId, or preprocessingVersion changes', () => {
      const sha = 'b'.repeat(64)
      const rec = createVersionedEmbeddingRecord({
        fileLocationId: 10,
        discoveryObservationId: 3,
        sha256: sha,
        byteSize: 4096,
        mtimeMs: 1700000000000,
        vector: sampleVec
      })

      // Changed SHA-256
      expect(
        isEmbeddingRecordCurrent(rec, {
          discoveryObservationId: 3,
          byteSize: 4096,
          mtimeMs: 1700000000000,
          sha256: 'c'.repeat(64)
        })
      ).toBe(false)

      // Changed byte size
      expect(
        isEmbeddingRecordCurrent(rec, {
          discoveryObservationId: 3,
          byteSize: 8192,
          mtimeMs: 1700000000000,
          sha256: sha
        })
      ).toBe(false)

      // Changed model ID
      expect(
        isEmbeddingRecordCurrent(rec, {
          discoveryObservationId: 3,
          byteSize: 4096,
          mtimeMs: 1700000000000,
          sha256: sha,
          modelId: 'Xenova/siglip-base-patch16-224@46490526'
        })
      ).toBe(false)

      // Changed preprocessing version
      expect(
        isEmbeddingRecordCurrent(rec, {
          discoveryObservationId: 3,
          byteSize: 4096,
          mtimeMs: 1700000000000,
          sha256: sha,
          preprocessingVersion: 'clip_v2'
        })
      ).toBe(false)
    })
  })

  describe('rankSemanticMatches and cosineSimilarityNormalized', () => {
    it('ranks entries by cosine similarity descending with deterministic fileLocationId tie-breaking', () => {
      const q = new Float32Array([1, 0, 0, 0])
      const entries = [
        {
          fileLocationId: 5,
          id: 'item_5',
          fileName: 'b.jpg',
          category: 'test',
          vector: new Float32Array([0.8, 0.6, 0, 0])
        },
        {
          fileLocationId: 2,
          id: 'item_2',
          fileName: 'a.jpg',
          category: 'test',
          vector: new Float32Array([0.8, 0.6, 0, 0])
        },
        {
          fileLocationId: 9,
          id: 'item_9',
          fileName: 'top.jpg',
          category: 'test',
          vector: new Float32Array([1, 0, 0, 0])
        }
      ]

      const ranked = rankSemanticMatches(q, entries, { topK: 3 })
      expect(ranked.map((r) => r.fileLocationId)).toEqual([9, 2, 5])
      expect(cosineSimilarityNormalized(q, entries[2]!.vector)).toBeCloseTo(1.0, 6)
    })

    it('enforces the declared maximum indexed items cap', () => {
      const q = new Float32Array([1, 0])
      const entries = [
        {
          fileLocationId: 1,
          id: '1',
          fileName: '1.jpg',
          category: 't',
          vector: new Float32Array([1, 0])
        },
        {
          fileLocationId: 2,
          id: '2',
          fileName: '2.jpg',
          category: 't',
          vector: new Float32Array([0, 1])
        }
      ]
      expect(() => rankSemanticMatches(q, entries, { maxIndexedItems: 1 })).toThrow(RangeError)
    })
  })
})
