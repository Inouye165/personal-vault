/**
 * Personal Vault — Stage 7C OCR Worker Runner Primitive
 *
 * Manages at most 1 dedicated `document_ocr_worker` thread under the shared
 * application-wide `AppWorkerBudget`, guaranteeing:
 * - Synchronous reservation release (`try / catch`) if worker path resolution or
 *   `new Worker(...)` throws (zero leaked reservations).
 * - Optional bounded worker-budget admission polling (`admissionWaitTimeoutMs`)
 *   when sharing `AppWorkerBudget(3)` with concurrent coordinators.
 * - Terminating workers remain counted in `AppWorkerBudget` until confirmed `'exit'`.
 * - Active cancellation (`cancelActiveRequests`) terminates the in-flight worker
 *   promptly, rejects pending requests with `CANCELLED`, and allows clean recovery.
 */

import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../../worker-budget'
import { resolveMainWorkerScriptPath } from '../../worker-path'
import {
  DOCUMENT_OCR_LIMITS,
  type DocumentOcrOptions,
  type DocumentOcrOutcome,
  type DocumentOcrWorkerResponseMessage,
  type OcrModelArtifactSpec,
  type OcrRuntimeEngineTelemetry
} from './types'

const OCR_ESBUILD_EXTERNALS = [
  'electron',
  'esbuild',
  'sharp',
  '@napi-rs/canvas',
  'onnxruntime-node',
  'pdfjs-dist',
  'pdfjs-dist/legacy/build/pdf.mjs',
  'tesseract.js-core',
  'tesseract.js-core/tesseract-core-simd-lstm.js',
  'tesseract.js-core/tesseract-core-lstm.js'
] as const

export interface DocumentOcrWorkerRunnerOptions {
  readonly workerBudget?: AppWorkerBudget
  readonly maxAppLiveWorkers?: number
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly admissionWaitTimeoutMs?: number
  readonly shouldCancelAdmission?: () => boolean
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly workerTimeoutMs?: number
}

export interface RunDocumentOcrInput {
  readonly sourcePath: string
  readonly extension: string
  readonly approvedRoots: readonly string[]
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly modelDir: string
  readonly artifacts?: readonly OcrModelArtifactSpec[]
  readonly maxInputBytes?: number
  readonly maxPdfPages?: number
  readonly maxExtractedChars?: number
  readonly perPageTimeoutMs?: number
  readonly pageDelayMs?: number
}

export interface VerifyDocumentOcrSourceInput {
  readonly sourcePath: string
  readonly approvedRoots: readonly string[]
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly maxInputBytes?: number
}

export type RunDocumentOcrResult =
  | {
      readonly ok: true
      readonly observedSha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number | null
      readonly maxInputBytesUsed: number
      readonly outcome: DocumentOcrOutcome
      readonly engineTelemetry: OcrRuntimeEngineTelemetry | null
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
      readonly durationMs: number
    }
  | {
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }

export type VerifyDocumentOcrSourceResult =
  | {
      readonly ok: true
      readonly observedSha256: string
      readonly observedByteSize: number
      readonly observedMtimeMs: number | null
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
      readonly durationMs: number
    }
  | {
      readonly ok: false
      readonly errorCode: string
      readonly errorMessage: string
      readonly nestedWorkerAttempts: number
      readonly outboundNetworkAttempts: number
    }

type PendingRunnerRequest =
  | {
      readonly kind: 'ocr'
      readonly id: number
      readonly worker: Worker
      readonly timer: NodeJS.Timeout
      readonly resolve: (res: RunDocumentOcrResult) => void
    }
  | {
      readonly kind: 'verify'
      readonly id: number
      readonly worker: Worker
      readonly timer: NodeJS.Timeout
      readonly resolve: (res: VerifyDocumentOcrSourceResult) => void
    }

export class DocumentOcrWorkerRunner {
  private readonly workerBudget: AppWorkerBudget
  private readonly getExternalLiveWorkers?: () => number
  private readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  private readonly admissionWaitTimeoutMs: number
  private readonly shouldCancelAdmission?: () => boolean
  private readonly customWorkerScriptPath?: string
  private readonly appPathOverride?: string | null
  private readonly isPackagedOverride?: boolean
  private readonly workerTimeoutMs: number

  private worker: Worker | null = null
  private readonly terminatingWorkers = new Set<Worker>()
  private readonly exitedWorkers = new WeakSet<Worker>()
  private spawningPromise: Promise<Worker> | null = null
  private activeRequest: PendingRunnerRequest | null = null
  private nextRequestId = 1
  private isShutdown = false

  public constructor(options: DocumentOcrWorkerRunnerOptions = {}) {
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(options.maxAppLiveWorkers ?? 3)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.tryReleaseExternalIdleWorker = options.tryReleaseExternalIdleWorker
    this.admissionWaitTimeoutMs = Math.max(0, options.admissionWaitTimeoutMs ?? 0)
    this.shouldCancelAdmission = options.shouldCancelAdmission
    this.customWorkerScriptPath = options.workerScriptPath
    this.appPathOverride = options.appPath
    this.isPackagedOverride = options.isPackaged
    this.workerTimeoutMs = options.workerTimeoutMs ?? DOCUMENT_OCR_LIMITS.WORKER_TIMEOUT_MS
  }

  public getDiagnostics(): {
    readonly ocrActiveWorkers: number
    readonly ocrTerminatingWorkers: number
    readonly ocrLiveWorkers: number
    readonly budgetLiveCount: number
    readonly budgetReservedCount: number
  } {
    const active = this.worker !== null ? 1 : 0
    const terminating = this.terminatingWorkers.size
    return {
      ocrActiveWorkers: active,
      ocrTerminatingWorkers: terminating,
      ocrLiveWorkers: active + terminating,
      budgetLiveCount: this.workerBudget.getLiveCount(this.getExternalLiveWorkers),
      budgetReservedCount: this.workerBudget.getReservedCount()
    }
  }

  private resolveWorkerPath(): string {
    return resolveMainWorkerScriptPath({
      workerFileName: 'document_ocr_worker.js',
      sourceEntryPath: resolve(process.cwd(), 'src/main/services/documents/ocr/worker.ts'),
      customPath: this.customWorkerScriptPath,
      moduleDir: __dirname,
      appPath: this.appPathOverride,
      isPackaged: this.isPackagedOverride,
      esbuildExternals: OCR_ESBUILD_EXTERNALS
    })
  }

  private async reserveBudgetSlot(): Promise<WorkerBudgetReservation> {
    while (this.terminatingWorkers.size > 0) {
      if (this.isShutdown || this.shouldCancelAdmission?.()) {
        throw new Error('CANCELLED: OCR worker admission cancelled')
      }
      await Promise.all(
        Array.from(this.terminatingWorkers).map((tw) => {
          if (this.exitedWorkers.has(tw)) {
            this.terminatingWorkers.delete(tw)
            return Promise.resolve()
          }
          return new Promise<void>((resolveExit) => {
            let settled = false
            const done = (): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              tw.off('exit', done)
              resolveExit()
            }
            const timer = setTimeout(done, 50)
            tw.once('exit', done)
          })
        })
      )
    }

    const deadline = Date.now() + this.admissionWaitTimeoutMs
    while (true) {
      if (this.isShutdown || this.shouldCancelAdmission?.()) {
        throw new Error('CANCELLED: OCR worker admission cancelled')
      }

      let reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
      if (reservation) {
        return reservation
      }
      if (this.tryReleaseExternalIdleWorker) {
        const released = await this.tryReleaseExternalIdleWorker()
        if (released) {
          reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
          if (reservation) {
            return reservation
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('WORKER_BUDGET_EXHAUSTED: Unable to reserve AppWorkerBudget slot for OCR')
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.isShutdown) {
      throw new Error('DocumentOcrWorkerRunner is shut down')
    }
    if (this.worker) {
      return this.worker
    }
    if (this.spawningPromise) {
      return this.spawningPromise
    }

    const spawnTask = (async (): Promise<Worker> => {
      const reservation = await this.reserveBudgetSlot()

      let spawned: Worker
      try {
        if (this.isShutdown || this.shouldCancelAdmission?.()) {
          throw new Error('CANCELLED: OCR worker spawn cancelled')
        }
        const scriptPath = this.resolveWorkerPath()
        spawned = new Worker(scriptPath)
      } catch (err) {
        this.workerBudget.releaseReservation(reservation)
        throw err
      }

      this.workerBudget.promote(reservation, spawned)
      this.attachWorkerListeners(spawned)
      this.worker = spawned
      return spawned
    })()

    this.spawningPromise = spawnTask
    try {
      return await spawnTask
    } finally {
      if (this.spawningPromise === spawnTask) {
        this.spawningPromise = null
      }
    }
  }

  private attachWorkerListeners(w: Worker): void {
    w.on('message', (msg: DocumentOcrWorkerResponseMessage) => {
      if (!msg || typeof msg !== 'object') return

      const pending = this.activeRequest
      if (!pending || pending.worker !== w || pending.id !== msg.id) {
        return
      }

      if (msg.type === 'ocr_result' && pending.kind === 'ocr') {
        clearTimeout(pending.timer)
        this.activeRequest = null

        if (msg.ok) {
          pending.resolve({
            ok: true,
            observedSha256: msg.observedSha256,
            observedByteSize: msg.observedByteSize,
            observedMtimeMs: msg.observedMtimeMs,
            maxInputBytesUsed: msg.maxInputBytesUsed,
            outcome: msg.outcome,
            engineTelemetry: msg.engineTelemetry,
            nestedWorkerAttempts: msg.nestedWorkerAttempts,
            outboundNetworkAttempts: msg.outboundNetworkAttempts,
            durationMs: msg.durationMs
          })
        } else {
          pending.resolve({
            ok: false,
            errorCode: msg.errorCode,
            errorMessage: msg.errorMessage,
            nestedWorkerAttempts: msg.nestedWorkerAttempts,
            outboundNetworkAttempts: msg.outboundNetworkAttempts
          })
        }
        return
      }

      if (msg.type === 'verify_result' && pending.kind === 'verify') {
        clearTimeout(pending.timer)
        this.activeRequest = null

        if (msg.ok) {
          pending.resolve({
            ok: true,
            observedSha256: msg.observedSha256,
            observedByteSize: msg.observedByteSize,
            observedMtimeMs: msg.observedMtimeMs,
            nestedWorkerAttempts: msg.nestedWorkerAttempts,
            outboundNetworkAttempts: msg.outboundNetworkAttempts,
            durationMs: msg.durationMs
          })
        } else {
          pending.resolve({
            ok: false,
            errorCode: msg.errorCode,
            errorMessage: msg.errorMessage,
            nestedWorkerAttempts: msg.nestedWorkerAttempts,
            outboundNetworkAttempts: msg.outboundNetworkAttempts
          })
        }
      }
    })

    w.on('error', (err) => {
      const pending = this.activeRequest
      if (pending && pending.worker === w) {
        clearTimeout(pending.timer)
        this.activeRequest = null
        pending.resolve({
          ok: false,
          errorCode: 'WORKER_CRASHED',
          errorMessage: err instanceof Error ? err.message : String(err),
          nestedWorkerAttempts: 0,
          outboundNetworkAttempts: 0
        })
      }
      void this.retireWorker(w, false)
    })

    w.on('exit', (code) => {
      this.exitedWorkers.add(w)
      this.terminatingWorkers.delete(w)
      if (this.worker === w) {
        this.worker = null
      }
      const pending = this.activeRequest
      if (pending && pending.worker === w) {
        clearTimeout(pending.timer)
        this.activeRequest = null
        pending.resolve({
          ok: false,
          errorCode: 'WORKER_EXITED',
          errorMessage: `OCR worker exited unexpectedly with code ${code}`,
          nestedWorkerAttempts: 0,
          outboundNetworkAttempts: 0
        })
      }
    })
  }

  private async retireWorker(w: Worker, graceful: boolean): Promise<void> {
    if (this.worker === w) {
      this.worker = null
    }
    if (this.exitedWorkers.has(w)) {
      this.terminatingWorkers.delete(w)
      return
    }
    this.terminatingWorkers.add(w)

    if (graceful) {
      try {
        const shutdownId = this.nextRequestId++
        await new Promise<void>((resolveAck) => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            w.off('message', onMsg)
            w.off('exit', finish)
            resolveAck()
          }
          const timer = setTimeout(finish, 1500)
          const onMsg = (msg: DocumentOcrWorkerResponseMessage): void => {
            if (msg?.type === 'shutdown_ack' && msg.id === shutdownId) {
              finish()
            }
          }
          w.on('message', onMsg)
          w.once('exit', finish)
          w.postMessage({ id: shutdownId, type: 'shutdown' })
        })
      } catch {
        // Proceed to terminate
      }
    }

    if (this.exitedWorkers.has(w)) {
      this.terminatingWorkers.delete(w)
      return
    }

    try {
      await w.terminate()
    } catch {
      // Retain w in terminatingWorkers until actual 'exit' event confirms exit
    }
  }

  public async retireIdleWorker(): Promise<boolean> {
    if (this.activeRequest !== null || this.worker === null) {
      return false
    }
    await this.retireWorker(this.worker, true)
    return true
  }

  public async verifySource(
    input: VerifyDocumentOcrSourceInput
  ): Promise<VerifyDocumentOcrSourceResult> {
    if (this.isShutdown) {
      return {
        ok: false,
        errorCode: 'SHUTDOWN',
        errorMessage: 'DocumentOcrWorkerRunner is shut down',
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      }
    }
    if (this.activeRequest !== null) {
      return {
        ok: false,
        errorCode: 'WORKER_BUSY',
        errorMessage: 'DocumentOcrWorkerRunner already has an active in-flight OCR request',
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      }
    }

    let w: Worker
    try {
      w = await this.ensureWorker()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        errorCode: msg.startsWith('WORKER_BUDGET_EXHAUSTED')
          ? 'WORKER_BUDGET_EXHAUSTED'
          : msg.startsWith('CANCELLED')
            ? 'CANCELLED'
            : 'WORKER_SPAWN_FAILED',
        errorMessage: msg,
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      }
    }

    const requestId = this.nextRequestId++
    return new Promise<VerifyDocumentOcrSourceResult>((resolveResult) => {
      const timer = setTimeout(() => {
        if (this.activeRequest?.id === requestId && this.activeRequest.worker === w) {
          this.activeRequest = null
          void this.retireWorker(w, false)
          resolveResult({
            ok: false,
            errorCode: 'WORKER_TIMEOUT',
            errorMessage: `OCR source verification exceeded ${this.workerTimeoutMs} ms timeout`,
            nestedWorkerAttempts: 0,
            outboundNetworkAttempts: 0
          })
        }
      }, this.workerTimeoutMs)

      this.activeRequest = {
        kind: 'verify',
        id: requestId,
        worker: w,
        timer,
        resolve: resolveResult
      }

      w.postMessage({
        id: requestId,
        type: 'verify_source',
        sourcePath: input.sourcePath,
        approvedRoots: input.approvedRoots,
        expectedByteSize: input.expectedByteSize,
        expectedMtimeMs: input.expectedMtimeMs,
        expectedSha256: input.expectedSha256,
        maxInputBytes: input.maxInputBytes ?? DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
      })
    })
  }

  public async runOcr(input: RunDocumentOcrInput): Promise<RunDocumentOcrResult> {
    if (this.isShutdown) {
      return {
        ok: false,
        errorCode: 'SHUTDOWN',
        errorMessage: 'DocumentOcrWorkerRunner is shut down',
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      }
    }
    if (this.activeRequest !== null) {
      return {
        ok: false,
        errorCode: 'WORKER_BUSY',
        errorMessage: 'DocumentOcrWorkerRunner already has an active in-flight OCR request',
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      }
    }

    let w: Worker
    try {
      w = await this.ensureWorker()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        errorCode: msg.startsWith('WORKER_BUDGET_EXHAUSTED')
          ? 'WORKER_BUDGET_EXHAUSTED'
          : msg.startsWith('CANCELLED')
            ? 'CANCELLED'
            : 'WORKER_SPAWN_FAILED',
        errorMessage: msg,
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      }
    }

    const requestId = this.nextRequestId++
    const options: DocumentOcrOptions = {
      maxInputBytes: input.maxInputBytes ?? DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES,
      maxPdfPages: input.maxPdfPages,
      maxExtractedChars: input.maxExtractedChars,
      perPageTimeoutMs: input.perPageTimeoutMs,
      pageDelayMs: input.pageDelayMs
    }

    return new Promise<RunDocumentOcrResult>((resolveResult) => {
      const timer = setTimeout(() => {
        if (this.activeRequest?.id === requestId && this.activeRequest.worker === w) {
          this.activeRequest = null
          void this.retireWorker(w, false)
          resolveResult({
            ok: false,
            errorCode: 'WORKER_TIMEOUT',
            errorMessage: `OCR worker exceeded ${this.workerTimeoutMs} ms timeout`,
            nestedWorkerAttempts: 0,
            outboundNetworkAttempts: 0
          })
        }
      }, this.workerTimeoutMs)

      this.activeRequest = {
        kind: 'ocr',
        id: requestId,
        worker: w,
        timer,
        resolve: resolveResult
      }

      w.postMessage({
        id: requestId,
        type: 'ocr_file',
        sourcePath: input.sourcePath,
        extension: input.extension,
        approvedRoots: input.approvedRoots,
        expectedByteSize: input.expectedByteSize,
        expectedMtimeMs: input.expectedMtimeMs,
        expectedSha256: input.expectedSha256,
        modelDir: input.modelDir,
        artifacts: input.artifacts,
        options
      })
    })
  }

  public async cancelActiveRequests(): Promise<void> {
    const pending = this.activeRequest
    if (pending) {
      clearTimeout(pending.timer)
      this.activeRequest = null
      pending.resolve({
        ok: false,
        errorCode: 'CANCELLED',
        errorMessage: 'OCR request cancelled by caller',
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      })
      await this.retireWorker(pending.worker, false)
      return
    }
    if (this.worker) {
      await this.retireWorker(this.worker, false)
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    const pending = this.activeRequest
    if (pending) {
      clearTimeout(pending.timer)
      this.activeRequest = null
      pending.resolve({
        ok: false,
        errorCode: 'SHUTDOWN',
        errorMessage: 'OCR worker runner shut down during active request',
        nestedWorkerAttempts: 0,
        outboundNetworkAttempts: 0
      })
      await this.retireWorker(pending.worker, false)
    } else if (this.worker) {
      await this.retireWorker(this.worker, true)
    }

    if (this.terminatingWorkers.size > 0) {
      await Promise.allSettled(Array.from(this.terminatingWorkers).map((tw) => tw.terminate()))
    }
  }
}
