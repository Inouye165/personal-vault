/**
 * Personal Vault — Stage 7C Bounded Document OCR Coordinator (`DocumentOcrCoordinator`)
 *
 * Connects `OcrModelManager`, `DocumentOcrRepository`, and `DocumentOcrWorkerRunner`
 * under the shared application-wide `AppWorkerBudget` (`<= 3` total live workers).
 *
 * Guarantees:
 * - Explicit model verification via `OcrModelManager` before creating or resuming any job
 *   (zero automatic downloads, fail-closed `OcrModelUnavailableError`).
 * - Consistent point-in-time job snapshots (`ocr_needed`, `filtered`, `all`, `selected`).
 * - Never bulk-OCRs ordinary `category = 'photo'` items; only explicit `ocrSelected`
 *   (`fileLocationIds`) processes user-chosen document images.
 * - Pause, resume, active cancellation, per-item worker timeout recovery, format-compatible
 *   verified hash reuse, and atomic `REVISION_MISMATCH` stale-commit rejection.
 */

import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import type { CatalogDatabase } from '../../catalog/database'
import { resolveReadableFileLocation } from '../../backup/recovered-file-resolver'
import {
  EMPTY_DOCUMENT_OCR_COVERAGE,
  type DocumentOcrCoverage,
  type DocumentOcrJobStatus,
  type DocumentOcrPreviewPayload,
  type DocumentOcrStateItem
} from '../../catalog/document-ocr-repository'
import type {
  DocumentOcrJobScopeKind,
  OcrCompatibilitySpec
} from '../../catalog/document-ocr-snapshot-query'
import { DOCUMENT_EXTRACTION_LIMITS } from '../types'
import { AppWorkerBudget, type WorkerBudgetReservation } from '../../worker-budget'
import type { OcrModelManager } from './model-manager'
import {
  DOCUMENT_OCR_LIMITS,
  DOCUMENT_OCR_RECIPE_VERSION,
  type DocumentOcrOptions,
  type OcrModelStatus
} from './types'
import { DocumentOcrWorkerRunner } from './worker-runner'

export type OcrModelUnavailableCode =
  'OCR_MODEL_MISSING' | 'OCR_MODEL_INVALID' | 'OCR_MODEL_MISMATCH'

export class OcrModelUnavailableError extends Error {
  public readonly code: OcrModelUnavailableCode

  public constructor(code: OcrModelUnavailableCode, message: string) {
    super(message)
    this.name = 'OcrModelUnavailableError'
    this.code = code
  }
}

export interface DocumentOcrProgress {
  readonly jobId: string | null
  readonly status: 'idle' | DocumentOcrJobStatus
  readonly scopeKind: DocumentOcrJobScopeKind | null
  readonly recipeVersion: string
  readonly ocrModelId: string
  readonly ocrModelManifestSha256: string
  readonly ocrLanguage: string
  readonly totalItems: number
  readonly processedItems: number
  readonly extractedItems: number
  readonly noTextItems: number
  readonly passwordProtectedItems: number
  readonly unsupportedItems: number
  readonly failedItems: number
  readonly truncatedItems: number
  readonly reusedItems: number
  readonly skippedStaleItems: number
  readonly pendingItems: number
  readonly activeFileLocationId: number | null
  readonly startedAtMs: number | null
  readonly updatedAtMs: number | null
  readonly completedAtMs: number | null
  readonly lastError: string | null
  readonly coverage: DocumentOcrCoverage
  readonly coverageReady: boolean
  readonly coverageRefreshing: boolean
}

export interface DocumentOcrCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly modelManager: OcrModelManager
  readonly workerRunner?: DocumentOcrWorkerRunner
  readonly workerBudget?: AppWorkerBudget
  readonly maxAppLiveWorkers?: number
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly workerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly workerTimeoutMs?: number
  readonly ocrOptions?: DocumentOcrOptions
  readonly batchSize?: number
}

export class DocumentOcrCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly modelManager: OcrModelManager
  private readonly workerBudget: AppWorkerBudget
  private readonly maxAppLiveWorkers: number
  private readonly getExternalLiveWorkers?: () => number
  private readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  private readonly workerTimeoutMs: number
  private readonly ocrOptions?: DocumentOcrOptions
  private readonly batchSize: number
  private readonly runner: DocumentOcrWorkerRunner
  private readonly ownsRunner: boolean

  private snapshotWorker: Worker | null = null
  private readonly terminatingSnapshotWorkers = new Set<Worker>()

  private activeJobId: string | null = null
  private activeFileLocationId: number | null = null
  private isStarting = false
  private pauseRequested = false
  private cancelRequested = false
  private isShutdown = false
  private startPromise: Promise<DocumentOcrProgress> | null = null
  private loopPromise: Promise<DocumentOcrProgress> | null = null
  private readonly listeners = new Set<(progress: DocumentOcrProgress) => void>()

  private readonly previewCache = new Map<string, DocumentOcrPreviewPayload>()
  private cachedCoverage: DocumentOcrCoverage | null = null
  private cachedCoverageSpecKey: string | null = null
  private cachedCatalogGeneration: string | null = null
  private coverageRefreshPromise: Promise<DocumentOcrCoverage> | null = null
  private coverageEpoch = 0

  public constructor(options: DocumentOcrCoordinatorOptions) {
    this.catalog = options.catalog
    this.modelManager = options.modelManager
    this.maxAppLiveWorkers = Math.max(1, options.maxAppLiveWorkers ?? 3)
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(this.maxAppLiveWorkers)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.tryReleaseExternalIdleWorker = options.tryReleaseExternalIdleWorker
    this.workerTimeoutMs = options.workerTimeoutMs ?? DOCUMENT_OCR_LIMITS.WORKER_TIMEOUT_MS
    this.ocrOptions = options.ocrOptions
    this.batchSize = Math.max(
      1,
      Math.min(32, Math.floor(options.batchSize ?? DOCUMENT_EXTRACTION_LIMITS.JOB_FETCH_BATCH_SIZE))
    )

    if (options.workerRunner) {
      this.runner = options.workerRunner
      this.ownsRunner = false
    } else {
      this.runner = new DocumentOcrWorkerRunner({
        workerBudget: this.workerBudget,
        maxAppLiveWorkers: this.maxAppLiveWorkers,
        getExternalLiveWorkers: this.getExternalLiveWorkers,
        tryReleaseExternalIdleWorker: this.tryReleaseExternalIdleWorker,
        admissionWaitTimeoutMs: this.workerTimeoutMs,
        shouldCancelAdmission: () =>
          this.cancelRequested || this.pauseRequested || this.isShutdown || this.catalog.isClosed(),
        workerScriptPath: options.workerScriptPath,
        appPath: options.appPath,
        isPackaged: options.isPackaged,
        workerTimeoutMs: this.workerTimeoutMs
      })
      this.ownsRunner = true
    }
  }

  private getModelCompatibilitySpec(): OcrCompatibilitySpec {
    const st = this.modelManager.getStatus()
    return {
      recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
      ocrModelId: st.modelId,
      ocrModelManifestSha256: st.modelManifestSha256,
      ocrLanguage: st.language
    }
  }

  private formatSpecKey(spec: OcrCompatibilitySpec): string {
    return `${spec.recipeVersion}:${spec.ocrModelId}:${spec.ocrModelManifestSha256}:${spec.ocrLanguage}`
  }

  public initialize(): DocumentOcrProgress {
    const repo = this.catalog.getDocumentOcrRepository()
    repo.markRunningDocumentOcrJobsAsInterrupted()
    void this.scheduleCoverageRefresh()
    return this.getProgress()
  }

  private isCoverageCacheFresh(specKey: string): boolean {
    if (this.cachedCoverage === null || this.cachedCoverageSpecKey !== specKey) {
      return false
    }
    if (this.isShutdown || this.catalog.isClosed()) {
      return true
    }
    return this.cachedCatalogGeneration === this.catalog.getDocumentOcrCoverageGeneration()
  }

  public async refreshCoverage(): Promise<DocumentOcrCoverage> {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.isShutdown || this.catalog.isClosed()) {
        break
      }
      const result = await this.scheduleCoverageRefresh()
      const specKey = this.formatSpecKey(this.getModelCompatibilitySpec())
      if (this.isCoverageCacheFresh(specKey)) {
        return result
      }
    }
    return this.cachedCoverage ?? EMPTY_DOCUMENT_OCR_COVERAGE
  }

  private scheduleCoverageRefresh(): Promise<DocumentOcrCoverage> {
    if (this.isShutdown || this.catalog.isClosed()) {
      return Promise.resolve(this.cachedCoverage ?? EMPTY_DOCUMENT_OCR_COVERAGE)
    }
    if (this.coverageRefreshPromise) {
      return this.coverageRefreshPromise
    }
    const spec = this.getModelCompatibilitySpec()
    const specKey = this.formatSpecKey(spec)
    const startEpoch = this.coverageEpoch
    const startGen = this.catalog.getDocumentOcrCoverageGeneration()
    let op: Promise<DocumentOcrCoverage> | null = null
    op = (async (): Promise<DocumentOcrCoverage> => {
      try {
        const repo = this.catalog.getDocumentOcrRepository()
        const fresh = await repo.getDocumentOcrCoverageAsync({
          ...spec,
          shouldAbort: () =>
            this.isShutdown ||
            this.catalog.isClosed() ||
            this.coverageEpoch !== startEpoch ||
            this.catalog.getDocumentOcrCoverageGeneration() !== startGen
        })
        if (!fresh) {
          return this.cachedCoverage ?? EMPTY_DOCUMENT_OCR_COVERAGE
        }
        const currentSpecKey = this.formatSpecKey(this.getModelCompatibilitySpec())
        if (
          this.coverageEpoch === startEpoch &&
          currentSpecKey === specKey &&
          !this.isShutdown &&
          !this.catalog.isClosed() &&
          this.catalog.getDocumentOcrCoverageGeneration() === startGen
        ) {
          this.cachedCoverage = fresh
          this.cachedCoverageSpecKey = specKey
          this.cachedCatalogGeneration = startGen
          if (this.activeJobId === null) {
            this.emitProgress()
          }
        }
        return this.cachedCoverage ?? fresh
      } catch {
        return this.cachedCoverage ?? EMPTY_DOCUMENT_OCR_COVERAGE
      } finally {
        if (this.coverageRefreshPromise === op) {
          this.coverageRefreshPromise = null
          const latestSpecKey = this.formatSpecKey(this.getModelCompatibilitySpec())
          if (
            !this.isShutdown &&
            !this.catalog.isClosed() &&
            !this.isCoverageCacheFresh(latestSpecKey)
          ) {
            queueMicrotask(() => {
              if (!this.isShutdown && !this.catalog.isClosed()) {
                void this.scheduleCoverageRefresh()
              }
            })
          }
        }
      }
    })()
    this.coverageRefreshPromise = op
    return op
  }

  private async ensureCoverageWarm(): Promise<void> {
    const specKey = this.formatSpecKey(this.getModelCompatibilitySpec())
    if (!this.coverageRefreshPromise && this.isCoverageCacheFresh(specKey)) {
      return
    }
    await this.refreshCoverage()
  }

  public onProgress(listener: (progress: DocumentOcrProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitProgress(): void {
    if (this.catalog.isClosed()) return
    const snapshot = this.getProgress()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Ignore listener error
      }
    }
  }

  public getProcessingFileLocationIds(): ReadonlySet<number> {
    if (this.activeFileLocationId === null) {
      return new Set<number>()
    }
    return new Set<number>([this.activeFileLocationId])
  }

  public getDiagnostics(): {
    readonly activeWorkers: number
    readonly liveWorkers: number
    readonly terminatingWorkers: number
    readonly budgetLiveCount: number
    readonly budgetReservedCount: number
    readonly activeJobId: string | null
    readonly activeFileLocationId: number | null
  } {
    const runnerDiag = this.runner.getDiagnostics()
    const snapActive = this.snapshotWorker ? 1 : 0
    const snapTerm = this.terminatingSnapshotWorkers.size
    return {
      activeWorkers: runnerDiag.ocrActiveWorkers + snapActive,
      liveWorkers: runnerDiag.ocrLiveWorkers + snapActive + snapTerm,
      terminatingWorkers: runnerDiag.ocrTerminatingWorkers + snapTerm,
      budgetLiveCount: runnerDiag.budgetLiveCount,
      budgetReservedCount: runnerDiag.budgetReservedCount,
      activeJobId: this.activeJobId,
      activeFileLocationId: this.activeFileLocationId
    }
  }

  public async tryReleaseIdleWorker(): Promise<boolean> {
    return this.runner.retireIdleWorker()
  }

  public getOcrState(fileLocationId: number): DocumentOcrStateItem | null {
    const repo = this.catalog.getDocumentOcrRepository()
    return repo.getDocumentOcrState(fileLocationId, {
      ...this.getModelCompatibilitySpec(),
      processingFileLocationIds: this.getProcessingFileLocationIds()
    })
  }

  public getOcrPreview(fileLocationId: number): DocumentOcrPreviewPayload | null {
    const repo = this.catalog.getDocumentOcrRepository()
    const spec = this.getModelCompatibilitySpec()
    const fresh = repo.getDocumentOcrPreview(fileLocationId, {
      ...spec,
      processingFileLocationIds: this.getProcessingFileLocationIds()
    })
    if (!fresh) {
      this.invalidatePreviewCacheForFile(fileLocationId)
      return null
    }
    if (fresh.previewStatus !== 'ready' && fresh.previewStatus !== 'truncated') {
      return fresh
    }
    const cacheKey = `${fileLocationId}:${fresh.contentRevision ?? 'none'}:${fresh.recipeVersion ?? 'none'}:${fresh.ocrModelManifestSha256 ?? 'none'}`
    const cached = this.previewCache.get(cacheKey)
    if (cached) {
      this.previewCache.delete(cacheKey)
      this.previewCache.set(cacheKey, cached)
      return cached
    }
    this.setPreviewCache(cacheKey, fresh)
    return fresh
  }

  private setPreviewCache(key: string, value: DocumentOcrPreviewPayload): void {
    if (this.previewCache.has(key)) {
      this.previewCache.delete(key)
    } else if (this.previewCache.size >= DOCUMENT_EXTRACTION_LIMITS.PREVIEW_CACHE_MAX_ENTRIES) {
      const oldest = this.previewCache.keys().next().value
      if (oldest !== undefined) {
        this.previewCache.delete(oldest)
      }
    }
    this.previewCache.set(key, value)
  }

  private invalidatePreviewCacheForFile(fileLocationId: number): void {
    const prefix = `${fileLocationId}:`
    for (const key of this.previewCache.keys()) {
      if (key.startsWith(prefix)) {
        this.previewCache.delete(key)
      }
    }
  }

  public getProgress(): DocumentOcrProgress {
    const repo = this.catalog.getDocumentOcrRepository()
    const spec = this.getModelCompatibilitySpec()
    const specKey = this.formatSpecKey(spec)
    if (!this.isCoverageCacheFresh(specKey) && !this.isShutdown && !this.catalog.isClosed()) {
      void this.scheduleCoverageRefresh()
    }
    const coverageReady = this.cachedCoverage !== null
    const coverageRefreshing =
      this.coverageRefreshPromise !== null || !this.isCoverageCacheFresh(specKey)
    const coverage = this.cachedCoverage ?? EMPTY_DOCUMENT_OCR_COVERAGE
    const job = this.activeJobId
      ? repo.getDocumentOcrJob(this.activeJobId)
      : repo.getLatestDocumentOcrJob()

    if (!job) {
      return {
        jobId: null,
        status: 'idle',
        scopeKind: null,
        recipeVersion: spec.recipeVersion,
        ocrModelId: spec.ocrModelId,
        ocrModelManifestSha256: spec.ocrModelManifestSha256,
        ocrLanguage: spec.ocrLanguage,
        totalItems: 0,
        processedItems: 0,
        extractedItems: 0,
        noTextItems: 0,
        passwordProtectedItems: 0,
        unsupportedItems: 0,
        failedItems: 0,
        truncatedItems: 0,
        reusedItems: 0,
        skippedStaleItems: 0,
        pendingItems: 0,
        activeFileLocationId: null,
        startedAtMs: null,
        updatedAtMs: null,
        completedAtMs: null,
        lastError: null,
        coverage,
        coverageReady,
        coverageRefreshing
      }
    }

    return {
      jobId: job.id,
      status: job.status,
      scopeKind: job.scopeKind,
      recipeVersion: job.recipeVersion,
      ocrModelId: job.ocrModelId,
      ocrModelManifestSha256: job.ocrModelManifestSha256,
      ocrLanguage: job.ocrLanguage,
      totalItems: job.totalItems,
      processedItems: job.processedItems,
      extractedItems: job.extractedItems,
      noTextItems: job.noTextItems,
      passwordProtectedItems: job.passwordProtectedItems,
      unsupportedItems: job.unsupportedItems,
      failedItems: job.failedItems,
      truncatedItems: job.truncatedItems,
      reusedItems: job.reusedItems,
      skippedStaleItems: job.skippedStaleItems,
      pendingItems: job.pendingItems,
      activeFileLocationId: this.activeFileLocationId,
      startedAtMs: job.startedAtMs,
      updatedAtMs: job.updatedAtMs,
      completedAtMs: job.completedAtMs,
      lastError: job.lastError,
      coverage,
      coverageReady,
      coverageRefreshing
    }
  }

  private async ensureVerifiedActiveModel(): Promise<{
    readonly modelDir: string
    readonly status: OcrModelStatus
  }> {
    const validation = await this.modelManager.revalidateForLoading()
    const modelDir = this.modelManager.getActiveModelInstallDir()
    if (!validation.ok || !modelDir) {
      throw new OcrModelUnavailableError(
        validation.code ?? 'OCR_MODEL_INVALID',
        validation.error ?? 'Pinned English OCR model is not installed or failed integrity check'
      )
    }
    return {
      modelDir,
      status: this.modelManager.getStatus()
    }
  }

  public ocrSelected(input: {
    fileLocationIds: readonly number[]
    forceReocr?: boolean
  }): Promise<DocumentOcrProgress> {
    if (this.isShutdown) {
      return Promise.reject(new Error('Document OCR coordinator is shut down'))
    }
    if (this.isStarting || this.startPromise || (this.activeJobId && this.loopPromise)) {
      return Promise.resolve(this.getProgress())
    }

    this.isStarting = true
    this.cancelRequested = false
    this.pauseRequested = false

    let startOp: Promise<DocumentOcrProgress> | null = null
    startOp = (async () => {
      try {
        const verifiedModel = await this.ensureVerifiedActiveModel()
        await this.ensureCoverageWarm()
        const repo = this.catalog.getDocumentOcrRepository()
        const jobId = `doc-ocr-${randomUUID()}`

        const job = await repo.createDocumentOcrJob({
          jobId,
          scopeKind: 'selected',
          recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
          ocrModelId: verifiedModel.status.modelId,
          ocrModelManifestSha256: verifiedModel.status.modelManifestSha256,
          ocrLanguage: verifiedModel.status.language,
          fileLocationIds: input.fileLocationIds,
          forceReocr: input.forceReocr === true,
          shouldCancel: () => this.cancelRequested || this.isShutdown || this.catalog.isClosed(),
          awaitWorkerAdmission: () => this.waitForSnapshotWorkerAdmission(),
          snapshotWorkerHooks: this.createSnapshotWorkerHooks()
        })

        if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
          if (job.status === 'running' && !this.catalog.isClosed()) {
            repo.updateDocumentOcrJobStatus(job.id, 'cancelled')
          }
          this.emitProgress()
          return this.getProgress()
        }

        if (this.pauseRequested && job.status === 'running') {
          repo.updateDocumentOcrJobStatus(job.id, 'paused')
          this.emitProgress()
          return this.getProgress()
        }

        if (job.status === 'running') {
          this.launchJobLoop(job.id, verifiedModel.modelDir)
        }
        this.emitProgress()
        return this.getProgress()
      } finally {
        this.isStarting = false
        if (this.startPromise === startOp) {
          this.startPromise = null
        }
      }
    })()

    this.startPromise = startOp
    return startOp
  }

  public startOcr(input?: {
    scope?: 'ocr_needed' | 'filtered' | 'all'
    extensionFilter?: string | null
    filenameQuery?: string
    retryFailed?: boolean
    forceReocr?: boolean
  }): Promise<DocumentOcrProgress> {
    if (this.isShutdown) {
      return Promise.reject(new Error('Document OCR coordinator is shut down'))
    }
    if (this.isStarting || this.startPromise || (this.activeJobId && this.loopPromise)) {
      return Promise.resolve(this.getProgress())
    }

    this.isStarting = true
    this.cancelRequested = false
    this.pauseRequested = false

    let startOp: Promise<DocumentOcrProgress> | null = null
    startOp = (async () => {
      try {
        const verifiedModel = await this.ensureVerifiedActiveModel()
        await this.ensureCoverageWarm()
        const repo = this.catalog.getDocumentOcrRepository()
        const jobId = `doc-ocr-${randomUUID()}`
        const scopeKind = input?.scope ?? 'ocr_needed'

        const job = await repo.createDocumentOcrJob({
          jobId,
          scopeKind,
          recipeVersion: DOCUMENT_OCR_RECIPE_VERSION,
          ocrModelId: verifiedModel.status.modelId,
          ocrModelManifestSha256: verifiedModel.status.modelManifestSha256,
          ocrLanguage: verifiedModel.status.language,
          extensionFilter: input?.extensionFilter,
          filenameQuery: input?.filenameQuery,
          retryFailed: input?.retryFailed,
          forceReocr: input?.forceReocr === true,
          shouldCancel: () => this.cancelRequested || this.isShutdown || this.catalog.isClosed(),
          awaitWorkerAdmission: () => this.waitForSnapshotWorkerAdmission(),
          snapshotWorkerHooks: this.createSnapshotWorkerHooks()
        })

        if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
          if (job.status === 'running' && !this.catalog.isClosed()) {
            repo.updateDocumentOcrJobStatus(job.id, 'cancelled')
          }
          this.emitProgress()
          return this.getProgress()
        }

        if (this.pauseRequested && job.status === 'running') {
          repo.updateDocumentOcrJobStatus(job.id, 'paused')
          this.emitProgress()
          return this.getProgress()
        }

        if (job.status === 'running') {
          this.launchJobLoop(job.id, verifiedModel.modelDir)
        }
        this.emitProgress()
        return this.getProgress()
      } finally {
        this.isStarting = false
        if (this.startPromise === startOp) {
          this.startPromise = null
        }
      }
    })()

    this.startPromise = startOp
    return startOp
  }

  public pauseOcr(): DocumentOcrProgress {
    if (this.isStarting || this.startPromise || (this.activeJobId && this.loopPromise)) {
      this.pauseRequested = true
    }
    return this.getProgress()
  }

  public async resumeOcr(): Promise<DocumentOcrProgress> {
    if (this.isShutdown) {
      throw new Error('Document OCR coordinator is shut down')
    }
    if (this.isStarting || this.startPromise || (this.activeJobId && this.loopPromise)) {
      return this.getProgress()
    }

    this.isStarting = true
    try {
      const repo = this.catalog.getDocumentOcrRepository()
      const latest = repo.getLatestDocumentOcrJob()
      if (!latest || (latest.status !== 'paused' && latest.status !== 'interrupted')) {
        return this.getProgress()
      }

      const verifiedModel = await this.ensureVerifiedActiveModel()
      if (
        latest.ocrModelId !== verifiedModel.status.modelId ||
        latest.ocrModelManifestSha256 !== verifiedModel.status.modelManifestSha256 ||
        latest.ocrLanguage !== verifiedModel.status.language
      ) {
        throw new OcrModelUnavailableError(
          'OCR_MODEL_MISMATCH',
          `Cannot resume OCR job ${latest.id}: job was snapshotted under model manifest ${latest.ocrModelManifestSha256}, active manifest is ${verifiedModel.status.modelManifestSha256}`
        )
      }

      await this.ensureCoverageWarm()

      if (latest.pendingItems === 0) {
        repo.updateDocumentOcrJobStatus(latest.id, 'completed')
        this.emitProgress()
        return this.getProgress()
      }

      repo.updateDocumentOcrJobStatus(latest.id, 'running')
      this.launchJobLoop(latest.id, verifiedModel.modelDir)
      this.emitProgress()
      return this.getProgress()
    } finally {
      this.isStarting = false
    }
  }

  public async cancelOcr(): Promise<DocumentOcrProgress> {
    this.cancelRequested = true
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // Ignore start failure on cancel
      }
    }

    if (!this.activeJobId || !this.loopPromise) {
      const repo = this.catalog.getDocumentOcrRepository()
      const latest = repo.getLatestDocumentOcrJob()
      if (latest && (latest.status === 'paused' || latest.status === 'interrupted')) {
        repo.updateDocumentOcrJobStatus(latest.id, 'cancelled')
        this.emitProgress()
      }
      return this.getProgress()
    }

    await this.runner.cancelActiveRequests()
    try {
      await this.loopPromise
    } catch {
      // Loop handles cancellation cleanly
    }
    return this.getProgress()
  }

  public async waitForIdle(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // Let startPromise settle
      }
    }
    if (this.loopPromise) {
      await this.loopPromise
    }
    if (this.coverageRefreshPromise) {
      await this.coverageRefreshPromise
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.cancelRequested = true
    if (this.coverageRefreshPromise) {
      try {
        await this.coverageRefreshPromise
      } catch {
        // Ignore on shutdown
      }
    }
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // Ignore on shutdown
      }
    }
    await this.runner.cancelActiveRequests()
    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // Ignore on shutdown
      }
    }
    if (this.ownsRunner) {
      await this.runner.shutdown()
    }
    await Promise.all(
      Array.from(this.terminatingSnapshotWorkers).map(
        (w) =>
          new Promise<void>((resolveExit) => {
            w.once('exit', () => resolveExit())
            setTimeout(resolveExit, 500)
          })
      )
    )
    this.previewCache.clear()
    this.listeners.clear()
  }

  private launchJobLoop(jobId: string, modelDir: string): void {
    this.activeJobId = jobId
    this.pauseRequested = false
    this.cancelRequested = false
    this.loopPromise = this.runJobLoop(jobId, modelDir).finally(() => {
      this.activeFileLocationId = null
      this.activeJobId = null
      this.loopPromise = null
      this.emitProgress()
    })
  }

  private async runJobLoop(jobId: string, modelDir: string): Promise<DocumentOcrProgress> {
    const repo = this.catalog.getDocumentOcrRepository()
    const initialJob = repo.getDocumentOcrJob(jobId)
    if (!initialJob) {
      return this.getProgress()
    }
    const forceReocr = initialJob.forceReocr
    const artifacts = this.modelManager.getArtifacts()

    try {
      while (!this.cancelRequested && !this.pauseRequested && !this.isShutdown) {
        if (this.catalog.isClosed()) {
          break
        }
        const pending = repo.getNextPendingDocumentOcrJobItems(jobId, this.batchSize)
        if (pending.length === 0) {
          repo.updateDocumentOcrJobStatus(jobId, 'completed')
          break
        }

        for (const item of pending) {
          if (
            this.cancelRequested ||
            this.pauseRequested ||
            this.isShutdown ||
            this.catalog.isClosed()
          ) {
            break
          }

          const candidate = repo.getDocumentOcrCandidate(item.fileLocationId)
          if (
            !candidate ||
            candidate.discoveryObservationId !== item.discoveryObservationId ||
            candidate.contentRevision !== item.contentRevision
          ) {
            repo.recordDocumentOcrJobItemResult({
              jobId,
              fileLocationId: item.fileLocationId,
              status: 'skipped_stale',
              errorMessage: 'Catalog observation changed before OCR'
            })
            this.emitProgress()
            continue
          }

          this.activeFileLocationId = candidate.fileLocationId
          this.emitProgress()

          const resolved = resolveReadableFileLocation(this.catalog, candidate.fileLocationId, {
            verifyPayloadHash: false
          })
          if (!resolved.ok) {
            this.activeFileLocationId = null
            const failCommit = this.commitExtractionAndUpdateCoverage(repo, {
              fileLocationId: candidate.fileLocationId,
              expectedDiscoveryObservationId: candidate.discoveryObservationId,
              expectedContentRevision: candidate.contentRevision,
              contentSha256: candidate.activeHash ?? '0'.repeat(64),
              observedByteSize: candidate.byteSize,
              observedMtimeMs: candidate.filesystemMtimeMs,
              recipeVersion: initialJob.recipeVersion,
              ocrModelId: initialJob.ocrModelId,
              ocrModelManifestSha256: initialJob.ocrModelManifestSha256,
              ocrLanguage: initialJob.ocrLanguage,
              extractionMethod: 'none',
              ocrStatus: 'corrupt_or_failed',
              statusDetail: resolved.errorMessage,
              extractedText: null,
              extractedCharCount: 0,
              pageCount: null,
              ocrPageCount: 0,
              nativeOnlyPageCount: 0,
              skippedBlankPageCount: 0,
              meanConfidence: null,
              truncated: false,
              truncationReason: null
            })
            this.invalidatePreviewCacheForFile(candidate.fileLocationId)
            repo.recordDocumentOcrJobItemResult({
              jobId,
              fileLocationId: candidate.fileLocationId,
              status: failCommit.committed ? 'corrupt_or_failed' : 'skipped_stale',
              errorMessage: resolved.errorMessage
            })
            this.emitProgress()
            continue
          }

          const effectiveRoots = resolved.approvedRoots

          const reusableCandidate =
            !forceReocr && candidate.activeHash !== null
              ? repo.findReusableDocumentOcrExtraction({
                  contentSha256: candidate.activeHash,
                  recipeVersion: initialJob.recipeVersion,
                  ocrModelId: initialJob.ocrModelId,
                  ocrModelManifestSha256: initialJob.ocrModelManifestSha256,
                  ocrLanguage: initialJob.ocrLanguage,
                  targetExtension: candidate.extension
                })
              : null

          if (reusableCandidate && candidate.activeHash !== null) {
            const verifyRes = await this.runner.verifySource({
              sourcePath: resolved.filePath,
              approvedRoots: effectiveRoots,
              expectedByteSize: resolved.expectedByteSize,
              expectedMtimeMs: resolved.expectedMtimeMs,
              expectedSha256: resolved.expectedSha256 ?? candidate.activeHash,
              maxInputBytes: this.ocrOptions?.maxInputBytes ?? DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES
            })

            this.activeFileLocationId = null

            if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
              break
            }

            if (verifyRes.ok && verifyRes.observedSha256 === candidate.activeHash) {
              const commitRes = this.commitExtractionAndUpdateCoverage(repo, {
                fileLocationId: candidate.fileLocationId,
                expectedDiscoveryObservationId: candidate.discoveryObservationId,
                expectedContentRevision: candidate.contentRevision,
                contentSha256: verifyRes.observedSha256,
                observedByteSize: verifyRes.observedByteSize,
                observedMtimeMs:
                  resolved.mode === 'vault_copy'
                    ? candidate.filesystemMtimeMs
                    : verifyRes.observedMtimeMs,
                recipeVersion: initialJob.recipeVersion,
                ocrModelId: initialJob.ocrModelId,
                ocrModelManifestSha256: initialJob.ocrModelManifestSha256,
                ocrLanguage: initialJob.ocrLanguage,
                extractionMethod: reusableCandidate.extractionMethod,
                ocrStatus: reusableCandidate.ocrStatus,
                statusDetail: reusableCandidate.statusDetail,
                extractedText: reusableCandidate.extractedText,
                extractedCharCount: reusableCandidate.extractedCharCount,
                pageCount: reusableCandidate.pageCount,
                ocrPageCount: reusableCandidate.ocrPageCount,
                nativeOnlyPageCount: reusableCandidate.nativeOnlyPageCount,
                skippedBlankPageCount: reusableCandidate.skippedBlankPageCount,
                meanConfidence: reusableCandidate.meanConfidence,
                truncated: reusableCandidate.truncated,
                truncationReason: reusableCandidate.truncationReason
              })
              this.invalidatePreviewCacheForFile(candidate.fileLocationId)
              repo.recordDocumentOcrJobItemResult({
                jobId,
                fileLocationId: candidate.fileLocationId,
                status: commitRes.committed ? 'reused' : 'skipped_stale',
                errorMessage: commitRes.committed
                  ? null
                  : 'Catalog revision changed during OCR verification'
              })
              this.emitProgress()
              continue
            }

            if (!verifyRes.ok && verifyRes.errorCode === 'FILE_CHANGED') {
              repo.recordDocumentOcrJobItemResult({
                jobId,
                fileLocationId: candidate.fileLocationId,
                status: 'skipped_stale',
                errorMessage: verifyRes.errorMessage
              })
              this.emitProgress()
              continue
            }

            if (
              !verifyRes.ok &&
              (verifyRes.errorCode === 'CANCELLED' || verifyRes.errorCode === 'SHUTDOWN')
            ) {
              break
            }
          }

          this.activeFileLocationId = candidate.fileLocationId
          const ocrRes = await this.runner.runOcr({
            sourcePath: resolved.filePath,
            extension: candidate.extension,
            approvedRoots: effectiveRoots,
            expectedByteSize: resolved.expectedByteSize,
            expectedMtimeMs: resolved.expectedMtimeMs,
            expectedSha256: resolved.expectedSha256 ?? candidate.activeHash,
            modelDir,
            artifacts,
            maxInputBytes: this.ocrOptions?.maxInputBytes ?? DOCUMENT_OCR_LIMITS.MAX_INPUT_BYTES,
            maxPdfPages: this.ocrOptions?.maxPdfPages,
            maxExtractedChars: this.ocrOptions?.maxExtractedChars,
            perPageTimeoutMs: this.ocrOptions?.perPageTimeoutMs,
            pageDelayMs: this.ocrOptions?.pageDelayMs
          })

          this.activeFileLocationId = null

          if (this.cancelRequested || this.isShutdown || this.catalog.isClosed()) {
            break
          }

          if (!ocrRes.ok) {
            if (ocrRes.errorCode === 'CANCELLED' || ocrRes.errorCode === 'SHUTDOWN') {
              break
            }
            if (ocrRes.errorCode === 'FILE_CHANGED') {
              repo.recordDocumentOcrJobItemResult({
                jobId,
                fileLocationId: candidate.fileLocationId,
                status: 'skipped_stale',
                errorMessage: ocrRes.errorMessage
              })
              this.emitProgress()
              continue
            }

            const failCommit = this.commitExtractionAndUpdateCoverage(repo, {
              fileLocationId: candidate.fileLocationId,
              expectedDiscoveryObservationId: candidate.discoveryObservationId,
              expectedContentRevision: candidate.contentRevision,
              contentSha256: candidate.activeHash ?? '0'.repeat(64),
              observedByteSize: candidate.byteSize,
              observedMtimeMs: candidate.filesystemMtimeMs,
              recipeVersion: initialJob.recipeVersion,
              ocrModelId: initialJob.ocrModelId,
              ocrModelManifestSha256: initialJob.ocrModelManifestSha256,
              ocrLanguage: initialJob.ocrLanguage,
              extractionMethod: 'none',
              ocrStatus: 'corrupt_or_failed',
              statusDetail: ocrRes.errorMessage,
              extractedText: null,
              extractedCharCount: 0,
              pageCount: null,
              ocrPageCount: 0,
              nativeOnlyPageCount: 0,
              skippedBlankPageCount: 0,
              meanConfidence: null,
              truncated: false,
              truncationReason: null
            })
            this.invalidatePreviewCacheForFile(candidate.fileLocationId)
            repo.recordDocumentOcrJobItemResult({
              jobId,
              fileLocationId: candidate.fileLocationId,
              status: failCommit.committed ? 'corrupt_or_failed' : 'skipped_stale',
              errorMessage: ocrRes.errorMessage
            })
            this.emitProgress()
            continue
          }

          const commitRes = this.commitExtractionAndUpdateCoverage(repo, {
            fileLocationId: candidate.fileLocationId,
            expectedDiscoveryObservationId: candidate.discoveryObservationId,
            expectedContentRevision: candidate.contentRevision,
            contentSha256: ocrRes.observedSha256,
            observedByteSize: ocrRes.observedByteSize,
            observedMtimeMs:
              resolved.mode === 'vault_copy' ? candidate.filesystemMtimeMs : ocrRes.observedMtimeMs,
            recipeVersion: initialJob.recipeVersion,
            ocrModelId: initialJob.ocrModelId,
            ocrModelManifestSha256: initialJob.ocrModelManifestSha256,
            ocrLanguage: initialJob.ocrLanguage,
            extractionMethod: ocrRes.outcome.extractionMethod,
            ocrStatus: ocrRes.outcome.status,
            statusDetail: ocrRes.outcome.statusDetail,
            extractedText: ocrRes.outcome.text,
            extractedCharCount: ocrRes.outcome.extractedCharCount,
            pageCount: ocrRes.outcome.pageCount,
            ocrPageCount: ocrRes.outcome.ocrPageCount,
            nativeOnlyPageCount: ocrRes.outcome.nativeOnlyPageCount,
            skippedBlankPageCount: ocrRes.outcome.skippedBlankPageCount,
            meanConfidence: ocrRes.outcome.meanConfidence,
            truncated: ocrRes.outcome.truncated,
            truncationReason: ocrRes.outcome.truncationReason
          })

          this.invalidatePreviewCacheForFile(candidate.fileLocationId)
          repo.recordDocumentOcrJobItemResult({
            jobId,
            fileLocationId: candidate.fileLocationId,
            status: commitRes.committed ? ocrRes.outcome.status : 'skipped_stale',
            errorMessage: commitRes.committed
              ? ocrRes.outcome.status === 'corrupt_or_failed'
                ? ocrRes.outcome.statusDetail
                : null
              : 'Catalog revision changed during OCR extraction'
          })
          this.emitProgress()
        }
      }

      if (!this.catalog.isClosed()) {
        if (this.cancelRequested) {
          repo.updateDocumentOcrJobStatus(jobId, 'cancelled')
        } else if (this.pauseRequested) {
          repo.updateDocumentOcrJobStatus(jobId, 'paused')
        }
      }
    } catch (err: unknown) {
      if (!this.catalog.isClosed()) {
        const msg = err instanceof Error ? err.message : String(err)
        repo.updateDocumentOcrJobStatus(jobId, 'failed', msg)
      }
    } finally {
      await this.runner.retireIdleWorker()
    }

    return this.getProgress()
  }

  private createSnapshotWorkerHooks(): {
    onSpawn: (worker: Worker, reservation?: WorkerBudgetReservation) => void
    onSpawnFailure: (reservation: WorkerBudgetReservation) => void
    onTerminating: (worker: Worker) => void
    onExit: (worker: Worker) => void
  } {
    return {
      onSpawn: (worker, reservation) => {
        if (reservation) {
          this.workerBudget.promote(reservation, worker)
        }
        this.snapshotWorker = worker
      },
      onSpawnFailure: (reservation) => {
        this.workerBudget.releaseReservation(reservation)
      },
      onTerminating: (worker) => {
        if (this.snapshotWorker === worker) {
          this.snapshotWorker = null
        }
        this.terminatingSnapshotWorkers.add(worker)
      },
      onExit: (worker) => {
        this.terminatingSnapshotWorkers.delete(worker)
        if (this.snapshotWorker === worker) {
          this.snapshotWorker = null
        }
      }
    }
  }

  private async waitForSnapshotWorkerAdmission(): Promise<WorkerBudgetReservation> {
    while (this.terminatingSnapshotWorkers.size > 0) {
      if (this.isShutdown) {
        throw new Error('Document OCR coordinator is shut down')
      }
      await Promise.all(
        Array.from(this.terminatingSnapshotWorkers).map(
          (w) =>
            new Promise<void>((resolveExit) => {
              w.once('exit', () => resolveExit())
              setTimeout(resolveExit, 50)
            })
        )
      )
    }

    const deadline = Date.now() + this.workerTimeoutMs
    while (true) {
      if (this.isShutdown || this.cancelRequested || this.pauseRequested) {
        throw new Error('Document OCR cancelled before snapshot worker admission')
      }
      let reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
      if (reservation) {
        return reservation
      }
      const released = await this.tryReleaseExternalIdleWorker?.()
      if (released) {
        reservation = this.workerBudget.tryReserve(this.getExternalLiveWorkers)
        if (reservation) {
          return reservation
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Application worker budget (${this.maxAppLiveWorkers} live workers) is exhausted`
        )
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  private commitExtractionAndUpdateCoverage(
    repo: ReturnType<CatalogDatabase['getDocumentOcrRepository']>,
    input: Parameters<
      ReturnType<CatalogDatabase['getDocumentOcrRepository']>['upsertDocumentOcrExtraction']
    >[0]
  ): { committed: true } | { committed: false; reason: 'REVISION_MISMATCH' } {
    const spec = this.getModelCompatibilitySpec()
    const specKey = this.formatSpecKey(spec)
    const beforeGen = !this.catalog.isClosed()
      ? this.catalog.getDocumentOcrCoverageGeneration()
      : null
    const beforeSeq = this.catalog.getDocumentOcrMutationSeq()
    const beforeDataVersion = beforeGen ? beforeGen.split(':')[1] : null
    const canUpdateCache =
      this.cachedCoverage !== null &&
      this.cachedCoverageSpecKey === specKey &&
      beforeGen !== null &&
      beforeDataVersion !== null &&
      this.cachedCatalogGeneration === beforeGen
    const before = canUpdateCache
      ? repo.getDocumentOcrCoverageContribution(input.fileLocationId, spec)
      : null

    const commitRes = repo.upsertDocumentOcrExtraction(input)
    if (commitRes.committed) {
      this.coverageEpoch++
      const expectedNextGen =
        beforeDataVersion !== null ? `${beforeSeq + 1}:${beforeDataVersion}` : null
      const afterCommitGen = !this.catalog.isClosed()
        ? this.catalog.getDocumentOcrCoverageGeneration()
        : null
      if (
        canUpdateCache &&
        this.cachedCoverage !== null &&
        before !== null &&
        expectedNextGen !== null &&
        afterCommitGen === expectedNextGen
      ) {
        const after = repo.getDocumentOcrCoverageContribution(input.fileLocationId, spec)
        const finalGen = !this.catalog.isClosed()
          ? this.catalog.getDocumentOcrCoverageGeneration()
          : null
        if (after !== null && finalGen === expectedNextGen) {
          this.cachedCoverage = applyCoverageContributionDelta(this.cachedCoverage, before, after)
          this.cachedCatalogGeneration = finalGen
        } else {
          this.cachedCatalogGeneration = null
          if (!this.isShutdown && !this.catalog.isClosed()) {
            void this.scheduleCoverageRefresh()
          }
        }
      } else {
        this.cachedCatalogGeneration = null
        if (!this.isShutdown && !this.catalog.isClosed()) {
          void this.scheduleCoverageRefresh()
        }
      }
    }
    return commitRes
  }
}

function applyCoverageContributionDelta(
  current: DocumentOcrCoverage,
  before: DocumentOcrCoverage,
  after: DocumentOcrCoverage
): DocumentOcrCoverage {
  return {
    totalDocuments: Math.max(
      0,
      current.totalDocuments + after.totalDocuments - before.totalDocuments
    ),
    ocrNeededDocuments: Math.max(
      0,
      current.ocrNeededDocuments + after.ocrNeededDocuments - before.ocrNeededDocuments
    ),
    notProcessedDocuments: Math.max(
      0,
      current.notProcessedDocuments + after.notProcessedDocuments - before.notProcessedDocuments
    ),
    extractedDocuments: Math.max(
      0,
      current.extractedDocuments + after.extractedDocuments - before.extractedDocuments
    ),
    noTextDocuments: Math.max(
      0,
      current.noTextDocuments + after.noTextDocuments - before.noTextDocuments
    ),
    passwordProtectedDocuments: Math.max(
      0,
      current.passwordProtectedDocuments +
        after.passwordProtectedDocuments -
        before.passwordProtectedDocuments
    ),
    unsupportedDocuments: Math.max(
      0,
      current.unsupportedDocuments + after.unsupportedDocuments - before.unsupportedDocuments
    ),
    failedDocuments: Math.max(
      0,
      current.failedDocuments + after.failedDocuments - before.failedDocuments
    ),
    truncatedDocuments: Math.max(
      0,
      current.truncatedDocuments + after.truncatedDocuments - before.truncatedDocuments
    ),
    staleDocuments: Math.max(
      0,
      current.staleDocuments + after.staleDocuments - before.staleDocuments
    ),
    selectedImageOcrCount: Math.max(
      0,
      current.selectedImageOcrCount + after.selectedImageOcrCount - before.selectedImageOcrCount
    )
  }
}
