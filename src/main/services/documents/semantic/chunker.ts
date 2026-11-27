/**
 * Personal Vault — Stage 7D Deterministic Tokenizer-Aware Document Chunker (`doc_tok_chunk_v1`)
 *
 * Normalizes line endings (`\r\n?` -> `\n`) and outer whitespace, splits strictly
 * by model token budget using `@huggingface/tokenizers` so token-dense tails are
 * never dropped, preserves exact UTF-16 code-unit offsets into `normalizedText`,
 * and separates unique covered tokens from total emitted chunk tokens (including overlap).
 */

import { createHash } from 'node:crypto'
import {
  DOC_CHUNKING_RECIPE_VERSION,
  DOC_SEMANTIC_LIMITS,
  type DocChunk,
  type DocChunkTruncationReason,
  type DocChunkingOptions,
  type DocChunkingResult
} from './types'

export interface MinimalTokenizer {
  encode(
    text: string,
    options?: { add_special_tokens?: boolean }
  ): { ids: readonly number[] | number[] }
}

interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly tokenCount: number
}

export function normalizeDocumentText(text: string): string {
  if (typeof text !== 'string') return ''
  return text.replace(/\r\n?/g, '\n').trim()
}

export function computeNormalizedTextSha256(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex')
}

function encodeContentTokenCount(tokenizer: MinimalTokenizer, text: string): number {
  return tokenizer.encode(text, { add_special_tokens: false }).ids.length
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Adjusts a candidate split index inside `text` so it never splits a UTF-16 surrogate pair.
 */
function snapSplitWithoutBreakingSurrogate(
  text: string,
  candidateEnd: number,
  minEnd: number,
  maxEnd: number
): number {
  if (candidateEnd <= minEnd || candidateEnd >= maxEnd) {
    return candidateEnd
  }
  const prevCode = text.charCodeAt(candidateEnd - 1)
  const nextCode = text.charCodeAt(candidateEnd)
  if (isHighSurrogate(prevCode) && isLowSurrogate(nextCode)) {
    if (candidateEnd - 1 >= minEnd) {
      return candidateEnd - 1
    }
    if (candidateEnd + 1 <= maxEnd) {
      return candidateEnd + 1
    }
  }
  return candidateEnd
}

function buildTokenBudgetedSpans(
  boundedText: string,
  tokenizer: MinimalTokenizer,
  maxContentTokensPerChunk: number
): TokenSpan[] {
  const spans: TokenSpan[] = []
  const re = /\S+/g
  let match: RegExpExecArray | null

  while ((match = re.exec(boundedText)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const tokenCount = encodeContentTokenCount(tokenizer, match[0])

    if (tokenCount <= maxContentTokensPerChunk) {
      spans.push({ start, end, tokenCount })
      continue
    }

    // Binary-split oversized unspaced runs (e.g., long hex/base64/CJK/URL runs)
    // without breaking UTF-16 surrogate pairs or dropping any tail.
    let pos = start
    while (pos < end) {
      const minStepEnd = snapSplitWithoutBreakingSurrogate(boundedText, pos + 1, pos + 1, end)
      let lo = minStepEnd
      let hi = end
      let bestEnd = minStepEnd
      let bestTokens = encodeContentTokenCount(tokenizer, boundedText.slice(pos, bestEnd))

      while (lo <= hi) {
        const rawMid = (lo + hi) >> 1
        const mid = snapSplitWithoutBreakingSurrogate(boundedText, rawMid, minStepEnd, end)
        const subTokens = encodeContentTokenCount(tokenizer, boundedText.slice(pos, mid))
        if (subTokens <= maxContentTokensPerChunk) {
          bestEnd = mid
          bestTokens = subTokens
          lo = Math.max(rawMid + 1, mid + 1)
        } else {
          hi = Math.min(rawMid - 1, mid - 1)
        }
      }

      spans.push({ start: pos, end: bestEnd, tokenCount: bestTokens })
      pos = bestEnd
    }
  }

  return spans
}

export function chunkDocumentTextTokenizerAware(
  text: string,
  tokenizer: MinimalTokenizer,
  options: DocChunkingOptions = {}
): DocChunkingResult {
  const maxContentTokensPerChunk = Math.max(
    1,
    Math.floor(options.maxContentTokensPerChunk ?? DOC_SEMANTIC_LIMITS.MAX_CONTENT_TOKENS_PER_CHUNK)
  )
  const overlapTokens = Math.min(
    Math.max(0, Math.floor(options.overlapTokens ?? DOC_SEMANTIC_LIMITS.OVERLAP_TOKENS)),
    Math.max(0, maxContentTokensPerChunk - 1)
  )
  const maxChunksPerDocument = Math.max(
    1,
    Math.floor(options.maxChunksPerDocument ?? DOC_SEMANTIC_LIMITS.MAX_CHUNKS_PER_DOCUMENT)
  )
  const maxTextCharsForIndexing = Math.max(
    1,
    Math.floor(options.maxTextCharsForIndexing ?? DOC_SEMANTIC_LIMITS.MAX_TEXT_CHARS_FOR_INDEXING)
  )

  const normalized = normalizeDocumentText(text)
  const normalizedTextSha256 = computeNormalizedTextSha256(normalized)
  const normalizedCharCount = normalized.length

  if (normalizedCharCount === 0) {
    return {
      recipeVersion: DOC_CHUNKING_RECIPE_VERSION,
      chunks: [],
      normalizedTextSha256,
      normalizedCharCount: 0,
      indexedCharCount: 0,
      coverageRatio: 1,
      truncated: false,
      truncationReason: null,
      totalTokenCount: 0,
      uniqueIndexedTokenCount: 0,
      emittedChunkTokenSum: 0,
      maxChunksPerDocument,
      maxTextCharsForIndexing,
      maxContentTokensPerChunk,
      overlapTokens
    }
  }

  const charTruncated = normalizedCharCount > maxTextCharsForIndexing
  let boundedEnd = charTruncated ? maxTextCharsForIndexing : normalizedCharCount
  if (charTruncated) {
    boundedEnd = snapSplitWithoutBreakingSurrogate(normalized, boundedEnd, 1, normalizedCharCount)
  }
  const boundedText =
    boundedEnd < normalizedCharCount ? normalized.slice(0, boundedEnd) : normalized

  const spans = buildTokenBudgetedSpans(boundedText, tokenizer, maxContentTokensPerChunk)
  const totalTokenCount = spans.reduce((acc, s) => acc + s.tokenCount, 0)

  if (spans.length === 0) {
    return {
      recipeVersion: DOC_CHUNKING_RECIPE_VERSION,
      chunks: [],
      normalizedTextSha256,
      normalizedCharCount,
      indexedCharCount: 0,
      coverageRatio: 0,
      truncated: charTruncated,
      truncationReason: charTruncated ? 'max_chars_exceeded' : null,
      totalTokenCount: 0,
      uniqueIndexedTokenCount: 0,
      emittedChunkTokenSum: 0,
      maxChunksPerDocument,
      maxTextCharsForIndexing,
      maxContentTokensPerChunk,
      overlapTokens
    }
  }

  const chunks: DocChunk[] = []
  let spanIdx = 0
  let chunkIndex = 0
  let chunkTruncated = false
  let highestCoveredSpanEnd = 0

  while (spanIdx < spans.length) {
    if (chunkIndex >= maxChunksPerDocument) {
      chunkTruncated = true
      break
    }

    const startSpanIdx = spanIdx
    let endSpanIdx = startSpanIdx
    let runningTokens = 0

    while (endSpanIdx < spans.length) {
      const nextTokens = runningTokens + spans[endSpanIdx]!.tokenCount
      if (nextTokens > maxContentTokensPerChunk && endSpanIdx > startSpanIdx) {
        break
      }
      runningTokens = nextTokens
      endSpanIdx += 1
    }

    const charOffsetStart = spans[startSpanIdx]!.start
    let charOffsetEnd = spans[endSpanIdx - 1]!.end
    let chunkText = boundedText.slice(charOffsetStart, charOffsetEnd)
    let actualTokens = encodeContentTokenCount(tokenizer, chunkText)

    while (actualTokens > maxContentTokensPerChunk && endSpanIdx - startSpanIdx > 1) {
      endSpanIdx -= 1
      charOffsetEnd = spans[endSpanIdx - 1]!.end
      chunkText = boundedText.slice(charOffsetStart, charOffsetEnd)
      actualTokens = encodeContentTokenCount(tokenizer, chunkText)
    }

    highestCoveredSpanEnd = Math.max(highestCoveredSpanEnd, endSpanIdx)

    chunks.push({
      chunkIndex,
      charOffsetStart,
      charOffsetEnd,
      contentTokenCount: actualTokens,
      text: chunkText
    })
    chunkIndex += 1

    if (endSpanIdx >= spans.length) {
      break
    }

    let backTokens = 0
    let nextStartSpanIdx = endSpanIdx
    while (nextStartSpanIdx > startSpanIdx + 1) {
      const prevSpanTokens = spans[nextStartSpanIdx - 1]!.tokenCount
      if (backTokens + prevSpanTokens > overlapTokens) {
        break
      }
      backTokens += prevSpanTokens
      nextStartSpanIdx -= 1
    }
    spanIdx = Math.max(startSpanIdx + 1, nextStartSpanIdx)
  }

  const lastChunk = chunks[chunks.length - 1]
  const indexedCharCount = lastChunk ? lastChunk.charOffsetEnd : 0
  let uniqueIndexedTokenCount = 0
  for (let i = 0; i < highestCoveredSpanEnd; i += 1) {
    uniqueIndexedTokenCount += spans[i]!.tokenCount
  }
  const emittedChunkTokenSum = chunks.reduce((acc, c) => acc + c.contentTokenCount, 0)

  const truncated = charTruncated || chunkTruncated
  const truncationReason: DocChunkTruncationReason =
    charTruncated && chunkTruncated
      ? 'both'
      : charTruncated
        ? 'max_chars_exceeded'
        : chunkTruncated
          ? 'max_chunks_reached'
          : null

  return {
    recipeVersion: DOC_CHUNKING_RECIPE_VERSION,
    chunks,
    normalizedTextSha256,
    normalizedCharCount,
    indexedCharCount,
    coverageRatio:
      normalizedCharCount > 0 ? Number((indexedCharCount / normalizedCharCount).toFixed(4)) : 1,
    truncated,
    truncationReason,
    totalTokenCount,
    uniqueIndexedTokenCount,
    emittedChunkTokenSum,
    maxChunksPerDocument,
    maxTextCharsForIndexing,
    maxContentTokensPerChunk,
    overlapTokens
  }
}
