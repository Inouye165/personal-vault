// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  tokenizeQuery,
  embedQueryText,
  createClipTokenizer,
  type TextEmbedResult
} from '../../src/main/services/semantic/text-embedder'
import {
  SEMANTIC_EMBEDDING_DIMENSIONS,
  SEMANTIC_MODEL_ID
} from '../../src/main/services/semantic/manifest'
import { validateEmbeddingVector } from '../../src/main/services/semantic/vector'

const MODEL_DIR = resolve(
  __dirname,
  '../../spikes/semantic-eval/.model-cache/Xenova--clip-vit-base-patch32'
)

describe('Stage 6D: Text Tokenization & Offline Query Embedding', () => {
  describe('tokenizeQuery', () => {
    it('tokenizes natural language queries to CLIP BPE token IDs with BOS and EOS', () => {
      const tokenizer = createClipTokenizer(MODEL_DIR)
      const res = tokenizeQuery(tokenizer, 'a warm orange sunset over the ocean horizon')

      expect(res.truncated).toBe(false)
      expect(res.tokenCount).toBeGreaterThan(0)
      expect(res.tokenCount).toBeLessThanOrEqual(77)
      // BOS token ID for CLIP is 49406
      expect(res.ids[0]).toBe(49406n)
      // EOS token ID for CLIP is 49407
      expect(res.ids[res.ids.length - 1]).toBe(49407n)
    })

    it('honestly truncates long queries exceeding 77 tokens with truncated: true', () => {
      const tokenizer = createClipTokenizer(MODEL_DIR)
      // Repeat word to exceed 77 tokens
      const longQuery = 'mountain forest ocean sunset sunrise river lake view '.repeat(15)
      const res = tokenizeQuery(tokenizer, longQuery)

      expect(res.truncated).toBe(true)
      expect(res.tokenCount).toBe(77)
      expect(res.ids.length).toBe(77)
      expect(res.ids[0]).toBe(49406n)
      // Last token must remain EOS 49407 even when truncated
      expect(res.ids[76]).toBe(49407n)
    })

    it('rejects empty or whitespace-only queries with EMPTY_QUERY', () => {
      const tokenizer = createClipTokenizer(MODEL_DIR)
      expect(() => tokenizeQuery(tokenizer, '')).toThrow(/EMPTY_QUERY|empty/i)
      expect(() => tokenizeQuery(tokenizer, '   \t\n  ')).toThrow(/EMPTY_QUERY|empty/i)
    })
  })

  describe('embedQueryText', () => {
    it('produces a 512-d unit-normalized Float32Array vector for a query', async () => {
      const res: TextEmbedResult = await embedQueryText({
        modelDir: MODEL_DIR,
        queryText: 'a warm orange sunset over the ocean horizon'
      })

      expect(res.status).toBe('ready')
      if (res.status !== 'ready') return

      expect(res.dimensions).toBe(SEMANTIC_EMBEDDING_DIMENSIONS)
      expect(res.vector).toBeInstanceOf(Float32Array)
      expect(res.vector.length).toBe(512)
      expect(res.modelId).toBe(SEMANTIC_MODEL_ID)
      expect(res.truncated).toBe(false)
      expect(res.tokenCount).toBeGreaterThan(0)
      expect(res.inferMs).toBeGreaterThan(0)

      // Vector must be strictly unit-normalized with finite values
      expect(() => validateEmbeddingVector(res.vector)).not.toThrow()
    })

    it('returns MISSING_MODEL when model artifacts are absent', async () => {
      const fakeDir = resolve(__dirname, '../../nonexistent-model-dir-12345')
      const res = await embedQueryText({
        modelDir: fakeDir,
        queryText: 'snowy mountain peaks'
      })

      expect(res.status).toBe('error')
      if (res.status === 'error') {
        expect(res.code).toBe('MISSING_MODEL')
      }
    })

    it('rejects empty queries with EMPTY_QUERY error code', async () => {
      const res = await embedQueryText({
        modelDir: MODEL_DIR,
        queryText: '   '
      })

      expect(res.status).toBe('error')
      if (res.status === 'error') {
        expect(res.code).toBe('EMPTY_QUERY')
      }
    })
  })
})
