// @vitest-environment node
// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import { describe, expect, it } from 'vitest'
import {
  DOC_CHUNKING_RECIPE_VERSION,
  DOC_SEMANTIC_EMBEDDING_BYTE_LENGTH,
  DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
  chunkDocumentTextTokenizerAware,
  computeNormalizedTextSha256,
  l2NormalizeDocVector,
  normalizeDocumentText,
  tryDeserializeDocEmbeddingVector,
  validateAndSerializeDocEmbeddingVector,
  validateDocEmbeddingVector,
  validateDocQueryVector,
  type MinimalTokenizer
} from '../../src/main/services/documents/semantic'

const CACHED_BGE_DIR = resolve(
  process.cwd(),
  'spikes',
  'doc-semantic-eval',
  '.model-cache',
  'bge-small-en-v1.5'
)
const HAS_CACHED_BGE = existsSync(join(CACHED_BGE_DIR, 'tokenizer.json'))

/**
 * Deterministic character-pair mock tokenizer (1 token per 2 UTF-16 code units, min 1)
 * so chunker invariants run unconditionally even without cached model files.
 */
const mockTokenizer: MinimalTokenizer = {
  encode(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return { ids: [] }
    const count = Math.max(1, Math.ceil(trimmed.length / 2))
    return { ids: Array.from({ length: count }, (_, i) => i + 10) }
  }
}

function assertAllOffsetsAndNonWhitespaceCoverage(
  normalized: string,
  result: ReturnType<typeof chunkDocumentTextTokenizerAware>
): void {
  for (const ch of result.chunks) {
    expect(normalized.slice(ch.charOffsetStart, ch.charOffsetEnd)).toBe(ch.text)
    expect(ch.contentTokenCount).toBeLessThanOrEqual(result.maxContentTokensPerChunk)
  }

  if (!result.truncated) {
    const re = /\S+/g
    let match: RegExpExecArray | null
    while ((match = re.exec(normalized)) !== null) {
      const s = match.index
      const e = s + match[0].length
      for (let i = s; i < e; i += 1) {
        const covered = result.chunks.some((c) => c.charOffsetStart <= i && i < c.charOffsetEnd)
        expect(covered).toBe(true)
      }
    }
  }
}

describe('Stage 7D Slice 1: Tokenizer-Aware Chunker & 384-d Vector Validation', () => {
  it('normalizes CRLF/CR and outer whitespace, computes deterministic normalizedTextSha256, and handles empty text', () => {
    const raw = '  \r\nHello\r\nWorld\r  '
    const normalized = normalizeDocumentText(raw)
    expect(normalized).toBe('Hello\nWorld')
    expect(computeNormalizedTextSha256(normalized)).toBe(
      computeNormalizedTextSha256('Hello\nWorld')
    )
    expect(computeNormalizedTextSha256('Hello\nWorld')).not.toBe(
      computeNormalizedTextSha256('Hello\nWorld!')
    )

    const emptyRes = chunkDocumentTextTokenizerAware('   \r\n\t  ', mockTokenizer)
    expect(emptyRes.recipeVersion).toBe(DOC_CHUNKING_RECIPE_VERSION)
    expect(emptyRes.chunks).toEqual([])
    expect(emptyRes.normalizedCharCount).toBe(0)
    expect(emptyRes.indexedCharCount).toBe(0)
    expect(emptyRes.truncated).toBe(false)
    expect(emptyRes.truncationReason).toBeNull()
    expect(emptyRes.totalTokenCount).toBe(0)
    expect(emptyRes.uniqueIndexedTokenCount).toBe(0)
    expect(emptyRes.emittedChunkTokenSum).toBe(0)
  })

  it('preserves token-dense tails, separates unique vs overlapping token counts, and covers all non-whitespace', () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `TXN-${1000 + i} $${(10 + i).toFixed(2)} CLEARED`
    )
    lines.push('TAIL-MARKER-88412 CASCADE ROOFING $14250.00')
    const raw = `\r\n  ${lines.join('\r\n')}  \r\n`
    const normalized = normalizeDocumentText(raw)

    const res = chunkDocumentTextTokenizerAware(raw, mockTokenizer, {
      maxContentTokensPerChunk: 60,
      overlapTokens: 12,
      maxChunksPerDocument: 128
    })

    expect(res.truncated).toBe(false)
    expect(res.truncationReason).toBeNull()
    expect(res.chunks.length).toBeGreaterThan(2)
    expect(res.chunks[res.chunks.length - 1]!.text).toContain('TAIL-MARKER-88412')
    expect(res.uniqueIndexedTokenCount).toBe(res.totalTokenCount)
    expect(res.emittedChunkTokenSum).toBeGreaterThan(res.uniqueIndexedTokenCount)
    expect(res.indexedCharCount).toBe(res.normalizedCharCount)
    expect(res.coverageRatio).toBe(1)

    assertAllOffsetsAndNonWhitespaceCoverage(normalized, res)
  })

  it('splits long unspaced runs and Unicode surrogate pairs without breaking surrogates or dropping tails', () => {
    const emojiRun = '📄'.repeat(30) // 60 UTF-16 code units, 30 surrogate pairs
    const hexRun = 'a1b2c3d4e5f6'.repeat(12) // 144 chars unspaced
    const text = `Prefix café naïve 日本語 ${emojiRun} ${hexRun} TAIL_END`
    const normalized = normalizeDocumentText(text)

    const res = chunkDocumentTextTokenizerAware(text, mockTokenizer, {
      maxContentTokensPerChunk: 10,
      overlapTokens: 2,
      maxChunksPerDocument: 128
    })

    expect(res.truncated).toBe(false)
    expect(res.chunks[res.chunks.length - 1]!.text).toContain('TAIL_END')

    // Verify no lone surrogates were created in any chunk
    for (const ch of res.chunks) {
      expect(ch.text.isWellFormed()).toBe(true)
    }
    assertAllOffsetsAndNonWhitespaceCoverage(normalized, res)
  })

  it('reports explicit truncation metadata for max_chars_exceeded, max_chunks_reached, and both', () => {
    const longText = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')

    const charsCap = chunkDocumentTextTokenizerAware(longText, mockTokenizer, {
      maxContentTokensPerChunk: 50,
      overlapTokens: 5,
      maxChunksPerDocument: 128,
      maxTextCharsForIndexing: 120
    })
    expect(charsCap.truncated).toBe(true)
    expect(charsCap.truncationReason).toBe('max_chars_exceeded')
    expect(charsCap.indexedCharCount).toBeLessThanOrEqual(120)
    expect(charsCap.coverageRatio).toBeLessThan(1)

    const chunksCap = chunkDocumentTextTokenizerAware(longText, mockTokenizer, {
      maxContentTokensPerChunk: 15,
      overlapTokens: 3,
      maxChunksPerDocument: 3,
      maxTextCharsForIndexing: 10_000
    })
    expect(chunksCap.truncated).toBe(true)
    expect(chunksCap.truncationReason).toBe('max_chunks_reached')
    expect(chunksCap.chunks).toHaveLength(3)
    expect(chunksCap.uniqueIndexedTokenCount).toBeLessThan(chunksCap.totalTokenCount)
    expect(chunksCap.emittedChunkTokenSum).toBeGreaterThanOrEqual(chunksCap.uniqueIndexedTokenCount)

    const bothCap = chunkDocumentTextTokenizerAware(longText, mockTokenizer, {
      maxContentTokensPerChunk: 10,
      overlapTokens: 2,
      maxChunksPerDocument: 2,
      maxTextCharsForIndexing: 200
    })
    expect(bothCap.truncated).toBe(true)
    expect(bothCap.truncationReason).toBe('both')
    expect(bothCap.chunks).toHaveLength(2)
  })

  it.skipIf(!HAS_CACHED_BGE)(
    'matches real Xenova/bge-small-en-v1.5 tokenizer with exact offsets and complete coverage',
    () => {
      const tokJson = JSON.parse(readFileSync(join(CACHED_BGE_DIR, 'tokenizer.json'), 'utf8'))
      const tokCfg = JSON.parse(readFileSync(join(CACHED_BGE_DIR, 'tokenizer_config.json'), 'utf8'))
      const tokenizer = new Tokenizer(tokJson, tokCfg)

      const text = [
        '  \r\nRESIDENTIAL LEASE — café & résumé €450 📄',
        '1234567890'.repeat(40),
        Array.from({ length: 150 }, (_, i) => `Clause-${i}: payable on day ${(i % 28) + 1}.`).join(
          ' '
        )
      ].join('\n\n')
      const normalized = normalizeDocumentText(text)

      const res = chunkDocumentTextTokenizerAware(text, tokenizer, {
        maxContentTokensPerChunk: 120,
        overlapTokens: 16,
        maxChunksPerDocument: 128
      })

      expect(res.truncated).toBe(false)
      expect(res.uniqueIndexedTokenCount).toBe(res.totalTokenCount)
      expect(res.emittedChunkTokenSum).toBeGreaterThan(res.uniqueIndexedTokenCount)
      assertAllOffsetsAndNonWhitespaceCoverage(normalized, res)
    }
  )

  it('validates, normalizes, serializes, and isolates corrupt 384-dimensional vectors', () => {
    const raw = new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    raw[0] = 3
    raw[1] = 4

    const norm = l2NormalizeDocVector(raw)
    expect(norm.length).toBe(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    expect(norm[0]).toBeCloseTo(0.6, 5)
    expect(norm[1]).toBeCloseTo(0.8, 5)
    expect(() => validateDocEmbeddingVector(norm)).not.toThrow()
    expect(() => validateDocQueryVector(norm)).not.toThrow()

    const blob = validateAndSerializeDocEmbeddingVector(norm)
    expect(blob.byteLength).toBe(DOC_SEMANTIC_EMBEDDING_BYTE_LENGTH)

    const roundTrip = tryDeserializeDocEmbeddingVector(blob)
    expect(roundTrip).not.toBeNull()
    expect(roundTrip![0]).toBeCloseTo(0.6, 5)

    // Corrupt cases return null cleanly without throwing
    expect(tryDeserializeDocEmbeddingVector(Buffer.alloc(100))).toBeNull()
    expect(
      tryDeserializeDocEmbeddingVector(Buffer.alloc(DOC_SEMANTIC_EMBEDDING_BYTE_LENGTH))
    ).toBeNull()

    const nanBlob = Buffer.from(blob)
    nanBlob.writeFloatLE(Number.NaN, 0)
    expect(tryDeserializeDocEmbeddingVector(nanBlob)).toBeNull()

    const nonUnit = new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS)
    nonUnit[0] = 2.5
    expect(() => validateDocEmbeddingVector(nonUnit)).toThrow(/not unit-normalized/i)
    expect(() => l2NormalizeDocVector(new Float32Array(10))).toThrow(/expected 384/i)
  })
})
