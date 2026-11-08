/**
 * Personal Vault — Thumbnail Worker Thread (Stage 5A)
 */

import { parentPort } from 'node:worker_threads'
import { decodeThumbnail, type DecodeInputParams } from './decoder'
import { validateWebPIntegrity } from './cache'

if (parentPort) {
  parentPort.on(
    'message',
    async (message: {
      id: number
      action?: 'decode' | 'validate_cache'
      params?: DecodeInputParams
      buffer?: Buffer | Uint8Array
      maxBytes?: number
      stuck?: boolean
    }) => {
      try {
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
