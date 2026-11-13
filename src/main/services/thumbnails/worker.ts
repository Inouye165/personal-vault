/**
 * Personal Vault — Thumbnail, Semantic & Metadata Worker Thread (Stages 5A, 5C, 6B, 6C)
 */

import { parentPort } from 'node:worker_threads'
import {
  decodeThumbnail,
  decodeFingerprint,
  decodeSemanticEmbedding,
  readAndVerifySourceFile,
  verifyModelArtifactsInWorker,
  releaseSemanticModelSessionInWorker,
  type DecodeInputParams,
  type SemanticDecodeInputParams
} from './decoder'
import { validateWebPIntegrity } from './cache'
import type { SemanticModelArtifactSpec } from '../semantic/manifest'
import {
  extractPhotoMetadataFromFile,
  readAndVerifySourceBytesForMetadata,
  type ExtractPhotoMetadataInput
} from '../metadata/extractor'

if (parentPort) {
  parentPort.on(
    'message',
    async (message: {
      id: number
      action?:
        | 'decode'
        | 'validate_cache'
        | 'fingerprint'
        | 'semantic_embed'
        | 'verify_source'
        | 'extract_metadata'
        | 'verify_metadata_source'
        | 'verify_model'
        | 'release_model'
        | 'worker_memory'
      params?: DecodeInputParams | SemanticDecodeInputParams | ExtractPhotoMetadataInput
      buffer?: Buffer | Uint8Array
      maxBytes?: number
      stuck?: boolean
      directoryPath?: string
      specs?: readonly SemanticModelArtifactSpec[]
    }) => {
      try {
        if (message.action === 'release_model') {
          await releaseSemanticModelSessionInWorker()
          parentPort!.postMessage({
            id: message.id,
            status: 'released'
          })
          return
        }

        if (message.action === 'worker_memory') {
          const mem = process.memoryUsage()
          parentPort!.postMessage({
            id: message.id,
            status: 'ok',
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
            rss: mem.rss
          })
          return
        }

        if (message.action === 'verify_model') {
          const res = await verifyModelArtifactsInWorker(
            message.directoryPath!,
            message.specs ?? []
          )
          parentPort!.postMessage({
            id: message.id,
            status: res.ok ? 'ok' : 'error',
            ok: res.ok,
            error: res.error
          })
          return
        }

        if (message.action === 'verify_source') {
          const verified = await readAndVerifySourceFile(message.params!)
          if (verified.status === 'success') {
            parentPort!.postMessage({
              id: message.id,
              status: 'ok',
              sha256: verified.computedSha256,
              observedByteSize: verified.observedByteSize,
              observedMtimeMs: verified.observedMtimeMs
            })
          } else if (verified.status === 'unsupported') {
            parentPort!.postMessage({
              id: message.id,
              status: 'unsupported',
              reason: verified.reason
            })
          } else {
            parentPort!.postMessage({
              id: message.id,
              status: 'error',
              code: verified.code,
              message: verified.message
            })
          }
          return
        }

        if (message.action === 'verify_metadata_source') {
          const verified = await readAndVerifySourceBytesForMetadata(
            message.params as ExtractPhotoMetadataInput
          )
          if (verified.status === 'success') {
            parentPort!.postMessage({
              id: message.id,
              status: 'ok',
              sha256: verified.computedSha256,
              observedByteSize: verified.observedByteSize,
              observedMtimeMs: verified.observedMtimeMs
            })
          } else {
            parentPort!.postMessage({
              id: message.id,
              status: 'error',
              code: verified.code,
              message: verified.message
            })
          }
          return
        }

        if (message.action === 'extract_metadata') {
          if (message.stuck || process.env.PV_TEST_STUCK_METADATA === '1') {
            return
          }
          const workerDelay = Number(process.env.PV_TEST_WORKER_METADATA_DELAY_MS ?? 0)
          if (workerDelay > 0) {
            await new Promise((r) => setTimeout(r, workerDelay))
          }
          const extracted = await extractPhotoMetadataFromFile(
            message.params as ExtractPhotoMetadataInput
          )
          const mem = process.memoryUsage()
          parentPort!.postMessage({
            id: message.id,
            status: 'ok',
            extracted,
            workerHeapUsedBytes: mem.heapUsed,
            workerExternalBytes: mem.external
          })
          return
        }

        if (message.action === 'semantic_embed') {
          if (message.stuck || process.env.PV_TEST_STUCK_SEMANTIC === '1') {
            return
          }
          const workerDelay = Number(process.env.PV_TEST_WORKER_SEMANTIC_DELAY_MS ?? 0)
          if (workerDelay > 0) {
            await new Promise((r) => setTimeout(r, workerDelay))
          }
          const result = await decodeSemanticEmbedding(message.params as SemanticDecodeInputParams)
          const mem = process.memoryUsage()
          parentPort!.postMessage({
            id: message.id,
            ...result,
            workerHeapUsedBytes: mem.heapUsed,
            workerExternalBytes: mem.external,
            workerRssBytes: mem.rss
          })
          return
        }

        if (message.action === 'validate_cache') {
          if (message.stuck || process.env.PV_TEST_STUCK_VALIDATION === '1') {
            // Intentionally do not respond to test coordinator timeout termination
            return
          }
          const buf = Buffer.isBuffer(message.buffer)
            ? message.buffer
            : Buffer.from(message.buffer!)
          const dims = await validateWebPIntegrity(buf, message.maxBytes)
          if (dims) {
            parentPort!.postMessage({
              id: message.id,
              status: 'valid',
              width: dims.width,
              height: dims.height
            })
          } else {
            parentPort!.postMessage({
              id: message.id,
              status: 'corrupt'
            })
          }
          return
        }

        if (message.action === 'fingerprint') {
          const result = await decodeFingerprint(message.params!)
          parentPort!.postMessage({ id: message.id, ...result })
          return
        }

        const workerThumbDelay = Number(process.env.PV_TEST_WORKER_THUMBNAIL_DELAY_MS ?? 0)
        if (Number.isFinite(workerThumbDelay) && workerThumbDelay > 0) {
          await new Promise((r) => setTimeout(r, workerThumbDelay))
        }
        const result = await decodeThumbnail(message.params!)
        parentPort!.postMessage({ id: message.id, ...result })
      } catch (err: unknown) {
        parentPort!.postMessage({
          id: message.id,
          status: 'error',
          code: 'WORKER_INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Worker failure'
        })
      }
    }
  )
}
