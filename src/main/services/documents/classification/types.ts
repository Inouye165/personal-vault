/**
 * Personal Vault — Stage 7E Document Classification Types & Bounds
 */

import type {
  DocumentClassificationInput,
  DocumentClassificationResult
} from '../../../../shared/validation/document-schemas'

export const DOC_CLASSIFY_LIMITS = {
  MAX_INSPECTED_HEAD_CHARS: 64_000,
  MAX_INSPECTED_TAIL_CHARS: 16_000,
  MIN_SUBSTANTIVE_PROSE_CHARS: 80,
  MAX_TEXT_INPUT_CHARS: 500_000,
  WORKER_TIMEOUT_MS: 15_000,
  MAX_QUEUED_REQUESTS: 64,
  MAX_BATCH_SIZE: 100
} as const

export interface DocClassifyRuntimeDiagnostics {
  readonly activeWorkers: number
  readonly terminatingWorkers: number
  readonly liveWorkers: number
  readonly queuedRequests: number
  readonly activeRequests: number
  readonly nestedWorkerAttempts: number
  readonly outboundNetworkAttempts: number
}

export type DocClassifyWorkerRequestMessage =
  | {
      readonly id: number
      readonly type: 'classify'
      readonly input: DocumentClassificationInput
    }
  | {
      readonly id: number
      readonly type: 'classify_batch'
      readonly inputs: readonly DocumentClassificationInput[]
    }

export type DocClassifyWorkerResponseMessage =
  | {
      readonly id: number
      readonly ok: true
      readonly result?: DocumentClassificationResult
      readonly results?: readonly DocumentClassificationResult[]
      readonly durationMs: number
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }
  | {
      readonly id: number
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }
