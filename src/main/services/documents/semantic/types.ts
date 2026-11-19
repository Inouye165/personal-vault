/**
 * Personal Vault — Stage 7D Slice 1 Document Semantic Foundation Types & Limits
 */

export const DOC_SEMANTIC_LIMITS = Object.freeze({
  MAX_TEXT_CHARS_FOR_INDEXING: 500_000,
  MAX_CHUNKS_PER_DOCUMENT: 128,
  MAX_CONTENT_TOKENS_PER_CHUNK: 510, // reserves [CLS] + [SEP] in 512-token window
  OVERLAP_TOKENS: 64,
  MAX_SEQUENCE_LENGTH: 512,
  MAX_QUERY_CHARS: 500,
  WORKER_TIMEOUT_MS: 15_000,
  MAX_QUEUED_REQUESTS: 64
})

export const DOC_CHUNKING_RECIPE_VERSION = 'doc_tok_chunk_v1' as const

export type DocChunkTruncationReason = 'max_chars_exceeded' | 'max_chunks_reached' | 'both' | null

export interface DocSemanticModelArtifactSpec {
  readonly relativePath: string
  readonly byteSize: number
  readonly sha256: string
}

export type DocSemanticModelProvisionState =
  | 'unprovisioned'
  | 'downloading'
  | 'importing'
  | 'verifying'
  | 'ready'
  | 'corrupt'
  | 'error'
  | 'cancelled'

export interface DocSemanticModelStatus {
  readonly state: DocSemanticModelProvisionState
  readonly modelId: string
  readonly modelCommit: string
  readonly manifestSha256: string
  readonly totalBytes: number
  readonly downloadedBytes: number
  readonly currentFile: string | null
  readonly installDir: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly updatedAtMs: number
}

export interface DocChunk {
  readonly chunkIndex: number
  readonly charOffsetStart: number
  readonly charOffsetEnd: number
  readonly contentTokenCount: number
  readonly text: string
}

export interface DocChunkingOptions {
  readonly maxContentTokensPerChunk?: number
  readonly overlapTokens?: number
  readonly maxChunksPerDocument?: number
  readonly maxTextCharsForIndexing?: number
}

export interface DocChunkingResult {
  readonly recipeVersion: typeof DOC_CHUNKING_RECIPE_VERSION
  readonly chunks: readonly DocChunk[]
  readonly normalizedTextSha256: string
  readonly normalizedCharCount: number
  readonly indexedCharCount: number
  readonly coverageRatio: number
  readonly truncated: boolean
  readonly truncationReason: DocChunkTruncationReason
  /** Total non-special content tokens in the character-bounded normalized text. */
  readonly totalTokenCount: number
  /** Unique non-overlapping content tokens covered by the emitted chunks (<= totalTokenCount). */
  readonly uniqueIndexedTokenCount: number
  /** Sum of contentTokenCount across all emitted chunks (explicitly includes overlap tokens). */
  readonly emittedChunkTokenSum: number
  readonly maxChunksPerDocument: number
  readonly maxTextCharsForIndexing: number
  readonly maxContentTokensPerChunk: number
  readonly overlapTokens: number
}

export interface DocSemanticEmbedResult {
  readonly vector: Float32Array
  readonly dimensions: number
  readonly tokenCount: number
  readonly rawTokenCount: number
  readonly truncated: boolean
  readonly embedMs: number
}

export interface DocSemanticRuntimeDiagnostics {
  readonly activeWorkers: number
  readonly terminatingWorkers: number
  readonly liveWorkers: number
  readonly queuedRequests: number
  readonly activeRequests: number
  readonly nestedWorkerAttempts: number
  readonly outboundNetworkAttempts: number
}

export type DocSemanticWorkerRequestMessage =
  | {
      readonly id: number
      readonly type: 'verify_model'
      readonly modelDir: string
      readonly artifacts: readonly DocSemanticModelArtifactSpec[]
    }
  | {
      readonly id: number
      readonly type: 'load_model'
      readonly modelDir: string
      readonly artifacts: readonly DocSemanticModelArtifactSpec[]
    }
  | {
      readonly id: number
      readonly type: 'chunk_text'
      readonly modelDir: string
      readonly artifacts: readonly DocSemanticModelArtifactSpec[]
      readonly text: string
      readonly options?: DocChunkingOptions
    }
  | {
      readonly id: number
      readonly type: 'embed_chunk'
      readonly modelDir: string
      readonly artifacts: readonly DocSemanticModelArtifactSpec[]
      readonly text: string
      readonly delayMs?: number
      readonly notifyInferenceStart?: boolean
      readonly repeatCount?: number
    }
  | {
      readonly id: number
      readonly type: 'embed_query'
      readonly modelDir: string
      readonly artifacts: readonly DocSemanticModelArtifactSpec[]
      readonly query: string
      readonly delayMs?: number
      readonly notifyInferenceStart?: boolean
      readonly repeatCount?: number
    }
  | {
      readonly id: number
      readonly type: 'unload'
    }
  | {
      readonly id: number
      readonly type: 'abort_and_exit'
    }

export type DocSemanticWorkerResponseMessage =
  | {
      readonly type: 'inference_started'
      readonly id: number
      readonly seqLen: number
    }
  | {
      readonly id: number
      readonly ok: true
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
      readonly verifyResult?: {
        readonly ok: boolean
        readonly code?: string
        readonly error?: string
      }
      readonly loadResult?: {
        readonly loaded: true
        readonly loadMs: number
        readonly inputNames: readonly string[]
        readonly outputNames: readonly string[]
      }
      readonly chunkResult?: DocChunkingResult
      readonly embedResult?: {
        readonly vector: readonly number[]
        readonly dimensions: number
        readonly tokenCount: number
        readonly rawTokenCount: number
        readonly truncated: boolean
        readonly embedMs: number
      }
    }
  | {
      readonly id: number
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }
