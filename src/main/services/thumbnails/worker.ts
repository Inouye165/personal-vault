/**
 * Personal Vault — Thumbnail Worker Thread (Stage 5A)
 */

import { parentPort } from 'node:worker_threads'
import { decodeThumbnail, type DecodeInputParams } from './decoder'

if (parentPort) {
  parentPort.on('message', async (message: { id: number; params: DecodeInputParams }) => {
    try {
      const result = await decodeThumbnail(message.params)
      parentPort!.postMessage({ id: message.id, ...result })
    } catch (err: unknown) {
      parentPort!.postMessage({
        id: message.id,
        status: 'error',
        code: 'WORKER_INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'Worker failure'
      })
    }
  })
}
