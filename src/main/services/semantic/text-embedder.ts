/**
 * Personal Vault — CLIP Text Tokenizer & Text Embedder (Stage 6D)
 *
 * Implements production offline text tokenization via @huggingface/tokenizers
 * and CPU ONNX inference using text_model_quantized.onnx.
 *
 * Strict context window: 77 tokens (BOS 49406 ... EOS 49407).
 * Queries exceeding 77 tokens are truncated honestly with truncated: true.
 * Output vectors are 512-d unit-normalized Float32Array.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import type * as OrtType from 'onnxruntime-node'
import { SEMANTIC_EMBEDDING_DIMENSIONS, SEMANTIC_MODEL_ID } from './manifest'
import { normalizeEmbeddingVector } from './vector'

export interface TokenizeResult {
  readonly ids: bigint[]
  readonly tokenCount: number
  readonly truncated: boolean
}

export type TextEmbedResult =
  | {
      readonly status: 'ready'
      readonly vector: Float32Array
      readonly dimensions: number
      readonly modelId: string
      readonly truncated: boolean
      readonly tokenCount: number
      readonly inferMs: number
    }
  | {
      readonly status: 'error'
      readonly code: 'MISSING_MODEL' | 'EMPTY_QUERY' | 'INFERENCE_FAILED' | 'TOKENIZER_FAILED'
      readonly message: string
    }

let cachedOrtModule: typeof OrtType | null = null
let cachedTextSession: OrtType.InferenceSession | null = null
let cachedTextModelPath: string | null = null
let cachedTokenizer: Tokenizer | null = null
let cachedTokenizerDir: string | null = null

export function createClipTokenizer(modelDir: string): Tokenizer {
  if (cachedTokenizer && cachedTokenizerDir === modelDir) {
    return cachedTokenizer
  }

  const tokJsonPath = join(modelDir, 'tokenizer.json')
  const tokCfgPath = join(modelDir, 'tokenizer_config.json')

  if (!existsSync(tokJsonPath) || !existsSync(tokCfgPath)) {
    throw new Error(`Missing tokenizer files in ${modelDir}`)
  }

  const tokJson = JSON.parse(readFileSync(tokJsonPath, 'utf8'))
  const tokCfg = JSON.parse(readFileSync(tokCfgPath, 'utf8'))

  const tokenizer = new Tokenizer(tokJson, tokCfg)
  cachedTokenizer = tokenizer
  cachedTokenizerDir = modelDir
  return tokenizer
}

export function tokenizeQuery(tokenizer: Tokenizer, queryText: string): TokenizeResult {
  if (typeof queryText !== 'string') {
    throw new TypeError('Query text must be a string')
  }

  const trimmed = queryText.trim()
  if (!trimmed) {
    throw new Error('EMPTY_QUERY: Query text cannot be empty')
  }

  const encoded = tokenizer.encode(trimmed)
  const rawIds = encoded.ids

  // CLIP context window is 77 tokens (BOS=49406 ... EOS=49407)
  const isTruncated = rawIds.length > 77
  const idsToUse = rawIds.slice(0, 77)

  // Ensure last token is EOS (49407)
  if (idsToUse.length === 0) {
    idsToUse.push(49406, 49407)
  } else if (idsToUse[idsToUse.length - 1] !== 49407) {
    idsToUse[idsToUse.length - 1] = 49407
  }

  return {
    ids: idsToUse.map((id) => BigInt(id)),
    tokenCount: idsToUse.length,
    truncated: isTruncated
  }
}

async function getOrLoadTextSession(modelDir: string): Promise<OrtType.InferenceSession> {
  const textModelPath = join(modelDir, 'onnx', 'text_model_quantized.onnx')
  if (!existsSync(textModelPath)) {
    throw new Error(`Missing text model ONNX artifact: ${textModelPath}`)
  }

  if (cachedTextSession && cachedTextModelPath === textModelPath) {
    return cachedTextSession
  }

  if (cachedTextSession) {
    try {
      await cachedTextSession.release()
    } catch {
      // ignore
    }
    cachedTextSession = null
  }

  if (!cachedOrtModule) {
    cachedOrtModule = await import('onnxruntime-node')
  }

  cachedTextSession = await cachedOrtModule.InferenceSession.create(textModelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 2,
    interOpNumThreads: 1
  })
  cachedTextModelPath = textModelPath
  return cachedTextSession
}

export async function releaseTextSession(): Promise<void> {
  if (cachedTextSession) {
    try {
      await cachedTextSession.release()
    } catch {
      // ignore
    }
    cachedTextSession = null
    cachedTextModelPath = null
  }
  cachedTokenizer = null
  cachedTokenizerDir = null
}

export async function embedQueryText(params: {
  modelDir: string
  queryText: string
}): Promise<TextEmbedResult> {
  const { modelDir, queryText } = params

  if (typeof queryText !== 'string' || !queryText.trim()) {
    return {
      status: 'error',
      code: 'EMPTY_QUERY',
      message: 'Query text cannot be empty or whitespace'
    }
  }

  // Check required model artifacts
  const requiredArtifacts = [
    join(modelDir, 'tokenizer.json'),
    join(modelDir, 'tokenizer_config.json'),
    join(modelDir, 'onnx', 'text_model_quantized.onnx')
  ]
  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      return {
        status: 'error',
        code: 'MISSING_MODEL',
        message: `Offline semantic model artifact is missing (${artifact}). Install model before searching.`
      }
    }
  }

  const t0 = performance.now()
  let tokenized: TokenizeResult
  try {
    const tokenizer = createClipTokenizer(modelDir)
    tokenized = tokenizeQuery(tokenizer, queryText)
  } catch (err: unknown) {
    return {
      status: 'error',
      code: 'TOKENIZER_FAILED',
      message: err instanceof Error ? err.message : 'Failed to tokenize query'
    }
  }

  try {
    const session = await getOrLoadTextSession(modelDir)
    const ort = cachedOrtModule!

    const inputIds = new BigInt64Array(tokenized.ids)
    const inputTensor = new ort.Tensor('int64', inputIds, [1, inputIds.length])

    const outputs = await session.run({ input_ids: inputTensor })
    const outputTensor = outputs.text_embeds ?? Object.values(outputs)[0]

    if (!outputTensor || !(outputTensor.data instanceof Float32Array)) {
      return {
        status: 'error',
        code: 'INFERENCE_FAILED',
        message: 'ONNX text session did not return Float32Array text_embeds'
      }
    }

    const rawData = outputTensor.data
    if (rawData.length !== SEMANTIC_EMBEDDING_DIMENSIONS) {
      return {
        status: 'error',
        code: 'INFERENCE_FAILED',
        message: `Unexpected text embedding dimensions: ${rawData.length}`
      }
    }

    const vector = normalizeEmbeddingVector(rawData, SEMANTIC_EMBEDDING_DIMENSIONS)
    const inferMs = performance.now() - t0

    return {
      status: 'ready',
      vector,
      dimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
      modelId: SEMANTIC_MODEL_ID,
      truncated: tokenized.truncated,
      tokenCount: tokenized.tokenCount,
      inferMs
    }
  } catch (err: unknown) {
    return {
      status: 'error',
      code: 'INFERENCE_FAILED',
      message: err instanceof Error ? err.message : 'ONNX text inference failed'
    }
  }
}
