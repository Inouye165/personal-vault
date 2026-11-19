/**
 * Personal Vault — Stage 7D Bounded Document Semantic Coordinator (`DocumentSemanticCoordinator`)
 *
 * Connects `DocSemanticModelManager`, `DocumentSemanticRepository`, and `DocumentSemanticWorkerRunner`
 * under the shared application-wide `AppWorkerBudget(3)`.
 *
 * Guarantees:
 * - Off-main model integrity verification via `DocumentSemanticWorkerRunner.verifyModelDirectory`
 *   before creating, resuming, or searching (zero automatic downloads).
 * - Point-in-time scope snapshots (`document_snapshot_worker` `kind: 'doc_semantic'`),
 *   startup `interrupted` recovery, and incomplete-snapshot cleanup.
 * - Pause, resume, active cancellation (including during admission/snapshot/embedding),
 *   exact `normalized_text_sha256` non-reuse across re-extractions, and atomic
 *   `REVISION_MISMATCH` stale-commit rejection.
 * - Non-blocking async coverage cache with `PRAGMA data_version` race protection.
 */

import { randomUUID } from 'node:crypto'
import type { CatalogDatabase } from '../../catalog/database'
import {
  EMPTY_DOC_SEMANTIC_COVERAGE,
  type DocSemanticCoverage,
  type DocSemanticJobRecord,
  type DocSemanticJobStatus,
  type DocSemanticSearchResult,
  type DocSemanticTrackStatus
} from '../../catalog/document-semantic-repository'
import type {
  DocSemanticCompatibilitySpec,
  DocSemanticJobScopeKind,
  DocTextSourceKind
} from '../../catalog/document-semantic-snapshot-query'
import { AppWorkerBudget } from '../../worker-budget'
import { DocSemanticModelUnavailableError, type DocSemanticModelManager } from './model-manager'
import type { DocRankOptions } from './ranking'
import {
  DOC_CHUNKING_RECIPE_VERSION,
  DOC_SEMANTIC_LIMITS,
  type DocChunk,
  type DocChunkingOptions
} from './types'
import { DocumentSemanticWorkerRunner } from './worker-runner'

export interface DocumentSemanticProgress {
  readonly jobId: string | null
  readonly status: 'idle' | DocSemanticJobStatus
  readonly scopeKind: DocSemanticJobScopeKind | null
  readonly docModelId: string
  readonly docModelCommit: string
  readonly docModelManifestSha256: string
  readonly chunkingRecipeVersion: string
  readonly totalItems: number
  readonly processedItems: number
  readonly indexedItems: number
  readonly truncatedItems: number
  readonly emptyTextItems: number
  readonly failedItems: number
  readonly reusedItems: number
  readonly skippedStaleItems: number
  readonly pendingItems: number
  readonly activeFileLocationId: number | null
  readonly activeTextSourceKind: DocTextSourceKind | null
  readonly startedAtMs: number | null
  readonly updatedAtMs: number | null
  readonly completedAtMs: number | null
  readonly lastError: string | null
  readonly coverage: DocSemanticCoverage
  readonly coverageReady: boolean
  readonly coverageRefreshing: boolean
}

export interface DocumentSemanticCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly modelManager: DocSemanticModelManager
  readonly workerRunner?: DocumentSemanticWorkerRunner
  readonly workerBudget?: AppWorkerBudget
  readonly maxAppLiveWorkers?: number
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly workerScriptPath?: string
  readonly snapshotWorkerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly workerTimeoutMs?: number
  readonly chunkingOptions?: DocChunkingOptions
}

export interface StartDocSemanticIndexOptions {
  readonly scopeKind: DocSemanticJobScopeKind
  readonly fileLocationIds?: readonly number[]
  readonly extensionFilter?: string | null
  readonly filenameQuery?: string
  readonly retryFailed?: boolean
  readonly forceReindex?: boolean
}

export class DocumentSemanticCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly modelManager: DocSemanticModelManager
  private readonly runner: DocumentSemanticWorkerRunner
  private readonly ownsRunner: boolean
  private readonly workerBudget: AppWorkerBudget
  private readonly getExternalLiveWorkers?: () => number
  private readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  private readonly snapshotWorkerScriptPath?: string
  private readonly appPath?: string | null
  private readonly isPackaged?: boolean
  private readonly chunkingOptions: DocChunkingOptions

  private activeRunPromise: Promise<DocSemanticJobRecord | null> | null = null
  private activeJobId: string | null = null
  private activeFileLocationId: number | null = null
  private activeTextSourceKind: DocTextSourceKind | null = null
  private pauseRequested = false
  private cancelRequested = false
  private isShutdown = false

  private cachedCoverage: DocSemanticCoverage | null = null
  private cachedCoverageSpecKey: string | null = null
  private cachedCatalogGeneration: string | null = null
  private coverageRefreshPromise: Promise<DocSemanticCoverage> | null = null
  private coverageEpoch = 0

  public constructor(options: DocumentSemanticCoordinatorOptions) {
    this.catalog = options.catalog
    this.modelManager = options.modelManager
    const maxAppLiveWorkers = Math.max(1, options.maxAppLiveWorkers ?? 3)
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(maxAppLiveWorkers)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.tryReleaseExternalIdleWorker = options.tryReleaseExternalIdleWorker
    this.snapshotWorkerScriptPath = options.snapshotWorkerScriptPath
    this.appPath = options.appPath
    this.isPackaged = options.isPackaged
    this.chunkingOptions = options.chunkingOptions ?? {}

    if (options.workerRunner) {
      this.runner = options.workerRunner
      this.ownsRunner = false
    } else {
      this.runner = new DocumentSemanticWorkerRunner({
        workerBudget: this.workerBudget,
        maxAppLiveWorkers,
        getExternalLiveWorkers: this.getExternalLiveWorkers,
        tryReleaseExternalIdleWorker: this.tryReleaseExternalIdleWorker,
        admissionWaitTimeoutMs: options.workerTimeoutMs ?? DOC_SEMANTIC_LIMITS.WORKER_TIMEOUT_MS,
        shouldCancelAdmission: () =>
          this.cancelRequested || this.pauseRequested || this.isShutdown || this.catalog.isClosed(),
        workerScriptPath: options.workerScriptPath,
        appPath: options.appPath,
        isPackaged: options.isPackaged,
        workerTimeoutMs: options.workerTimeoutMs
      })
      this.ownsRunner = true
    }
  }

  private getCompatibilitySpec(): DocSemanticCompatibilitySpec {
    const st = this.modelManager.getStatus()
    return {
      docModelId: st.modelId,
      docModelCommit: st.modelCommit,
      docModelManifestSha256: st.manifestSha256,
      chunkingRecipeVersion: DOC_CHUNKING_RECIPE_VERSION,
      maxContentTokensPerChunk: Math.max(
        1,
        Math.floor(
          this.chunkingOptions.maxContentTokensPerChunk ??
            DOC_SEMANTIC_LIMITS.MAX_CONTENT_TOKENS_PER_CHUNK
        )
      ),
      overlapTokens: Math.max(
        0,
        Math.floor(this.chunkingOptions.overlapTokens ?? DOC_SEMANTIC_LIMITS.OVERLAP_TOKENS)
      ),
      maxChunksPerDocument: Math.max(
        1,
        Math.floor(
          this.chunkingOptions.maxChunksPerDocument ?? DOC_SEMANTIC_LIMITS.MAX_CHUNKS_PER_DOCUMENT
        )
      ),
      maxTextCharsForIndexing: Math.max(
        1,
        Math.floor(
          this.chunkingOptions.maxTextCharsForIndexing ??
            DOC_SEMANTIC_LIMITS.MAX_TEXT_CHARS_FOR_INDEXING
        )
      )
    }
  }

  private formatSpecKey(spec: DocSemanticCompatibilitySpec): string {
    return [
      spec.docModelId,
      spec.docModelCommit,
      spec.docModelManifestSha256,
      spec.chunkingRecipeVersion,
      spec.maxContentTokensPerChunk,
      spec.overlapTokens,
      spec.maxChunksPerDocument,
      spec.maxTextCharsForIndexing
    ].join(':')
  }

  public initialize(): DocumentSemanticProgress {
    const repo = this.catalog.getDocumentSemanticRepository()
    repo.markRunningDocumentSemanticJobsAsInterrupted()
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
    return this.cachedCatalogGeneration === this.catalog.getDocumentSemanticCoverageGeneration()
  }

  public async refreshCoverage(): Promise<DocSemanticCoverage> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (this.isShutdown || this.catalog.isClosed()) {
        break
      }
      const result = await this.scheduleCoverageRefresh()
      const specKey = this.formatSpecKey(this.getCompatibilitySpec())
      if (this.isCoverageCacheFresh(specKey)) {
        return result
      }
    }
    return this.cachedCoverage ?? EMPTY_DOC_SEMANTIC_COVERAGE
  }

  private scheduleCoverageRefresh(): Promise<DocSemanticCoverage> {
    if (this.isShutdown || this.catalog.isClosed()) {
      return Promise.resolve(this.cachedCoverage ?? EMPTY_DOC_SEMANTIC_COVERAGE)
    }

    const spec = this.getCompatibilitySpec()
    const specKey = this.formatSpecKey(spec)
    if (this.isCoverageCacheFresh(specKey)) {
      return Promise.resolve(this.cachedCoverage!)
    }
    if (this.coverageRefreshPromise) {
      return this.coverageRefreshPromise
    }

    const epochAtStart = this.coverageEpoch
    const promise = new Promise<DocSemanticCoverage>((resolvePromise) => {
      setImmediate(() => {
        try {
          if (this.isShutdown || this.catalog.isClosed()) {
            resolvePromise(this.cachedCoverage ?? EMPTY_DOC_SEMANTIC_COVERAGE)
            return
          }
          const genBefore = this.catalog.getDocumentSemanticCoverageGeneration()
          const computed = this.catalog.getDocumentSemanticRepository().getCoverage(spec)
          const genAfter = this.catalog.getDocumentSemanticCoverageGeneration()
          if (
            epochAtStart === this.coverageEpoch &&
            genBefore === genAfter &&
            !this.isShutdown &&
            !this.catalog.isClosed()
          ) {
            this.cachedCoverage = computed
            this.cachedCoverageSpecKey = specKey
            this.cachedCatalogGeneration = genAfter
          }
          resolvePromise(computed)
        } catch {
          resolvePromise(this.cachedCoverage ?? EMPTY_DOC_SEMANTIC_COVERAGE)
        } finally {
          if (this.coverageRefreshPromise === promise) {
            this.coverageRefreshPromise = null
          }
        }
      })
    })

    this.coverageRefreshPromise = promise
    return promise
  }

  private invalidateCoverageCache(): void {
    this.coverageEpoch += 1
    this.cachedCatalogGeneration = null
    this.catalog.bumpDocumentSemanticMutationSeq()
  }

  /**
   * Verifies that the pinned model is installed and intact using the off-main
   * `DocumentSemanticWorkerRunner.verifyModelDirectory` worker path.
   */
  public async verifyModelReadyOffMain(): Promise<{
    readonly installDir: string
    readonly compat: DocSemanticCompatibilitySpec
  }> {
    const ready = await this.modelManager.verifyInstalledIntegrity()
    const check = await this.runner.verifyModelDirectory(
      ready.installDir,
      this.modelManager.getArtifacts()
    )
    if (!check.ok) {
      throw new DocSemanticModelUnavailableError(
        check.code === 'DOC_MODEL_MISSING' ? 'DOC_MODEL_MISSING' : 'DOC_MODEL_INVALID',
        check.error ?? 'Off-main worker model verification failed'
      )
    }
    return {
      installDir: ready.installDir,
      compat: this.getCompatibilitySpec()
    }
  }

  public async startIndexing(
    options: StartDocSemanticIndexOptions
  ): Promise<DocSemanticJobRecord | null> {
    if (this.isShutdown) {
      throw new Error('DocumentSemanticCoordinator is shut down')
    }
    if (this.activeRunPromise) {
      throw new Error('Document semantic indexing job is already running')
    }

    this.pauseRequested = false
    this.cancelRequested = false

    const run = async (): Promise<DocSemanticJobRecord | null> => {
      const { installDir, compat } = await this.verifyModelReadyOffMain()
      if (
        this.pauseRequested ||
        this.cancelRequested ||
        this.isShutdown ||
        this.catalog.isClosed()
      ) {
        return null
      }

      const repo = this.catalog.getDocumentSemanticRepository()
      const jobId = randomUUID()

      const job = await repo.createSnapshotJob({
        jobId,
        input: {
          scopeKind: options.scopeKind,
          compat,
          fileLocationIds: options.fileLocationIds,
          extensionFilter: options.extensionFilter,
          filenameQuery: options.filenameQuery,
          retryFailed: options.retryFailed,
          forceReindex: options.forceReindex
        },
        workerBudget: this.workerBudget,
        getExternalLiveWorkers: this.getExternalLiveWorkers,
        tryReleaseExternalIdleWorker: this.tryReleaseExternalIdleWorker,
        shouldCancel: () =>
          this.cancelRequested || this.pauseRequested || this.isShutdown || this.catalog.isClosed(),
        workerScriptPath: this.snapshotWorkerScriptPath,
        appPath: this.appPath,
        isPackaged: this.isPackaged
      })

      this.activeJobId = job.id
      this.invalidateCoverageCache()

      if (job.totalItems === 0) {
        repo.updateJobStatus(job.id, 'completed')
        this.activeJobId = null
        void this.scheduleCoverageRefresh()
        return repo.getJob(job.id)
      }

      if (
        this.pauseRequested ||
        this.cancelRequested ||
        this.isShutdown ||
        this.catalog.isClosed()
      ) {
        const finalStatus: DocSemanticJobStatus = this.isShutdown
          ? 'interrupted'
          : this.cancelRequested
            ? 'cancelled'
            : 'paused'
        repo.updateJobStatus(job.id, finalStatus)
        this.activeJobId = null
        void this.scheduleCoverageRefresh()
        return repo.getJob(job.id)
      }

      return await this.processJobLoop(job.id, installDir, compat)
    }

    const promise = run().finally(() => {
      if (this.activeRunPromise === promise) {
        this.activeRunPromise = null
      }
    })
    this.activeRunPromise = promise
    return await promise
  }

  public async resumeIndexing(jobId?: string): Promise<DocSemanticJobRecord | null> {
    if (this.isShutdown) {
      throw new Error('DocumentSemanticCoordinator is shut down')
    }
    if (this.activeRunPromise) {
      throw new Error('Document semantic indexing job is already running')
    }

    this.pauseRequested = false
    this.cancelRequested = false

    const run = async (): Promise<DocSemanticJobRecord | null> => {
      const { installDir, compat } = await this.verifyModelReadyOffMain()
      const repo = this.catalog.getDocumentSemanticRepository()
      const target = jobId ? repo.getJob(jobId) : repo.getLatestJob()
      if (!target) return null
      if (
        target.status !== 'paused' &&
        target.status !== 'interrupted' &&
        target.status !== 'running'
      ) {
        return target
      }
      if (
        this.pauseRequested ||
        this.cancelRequested ||
        this.isShutdown ||
        this.catalog.isClosed()
      ) {
        return target
      }

      repo.updateJobStatus(target.id, 'running')
      this.activeJobId = target.id
      return await this.processJobLoop(target.id, installDir, compat)
    }

    const promise = run().finally(() => {
      if (this.activeRunPromise === promise) {
        this.activeRunPromise = null
      }
    })
    this.activeRunPromise = promise
    return await promise
  }

  public async pauseIndexing(): Promise<DocumentSemanticProgress> {
    this.pauseRequested = true
    await this.runner.cancelActiveRequests('CANCELLED: Document semantic indexing paused')
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {})
    }
    return this.getProgress()
  }

  public async cancelIndexing(): Promise<DocumentSemanticProgress> {
    this.cancelRequested = true
    await this.runner.cancelActiveRequests('CANCELLED: Document semantic indexing cancelled')
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {})
    }
    return this.getProgress()
  }

  private async processJobLoop(
    jobId: string,
    modelDir: string,
    compat: DocSemanticCompatibilitySpec
  ): Promise<DocSemanticJobRecord | null> {
    const repo = this.catalog.getDocumentSemanticRepository()
    const artifacts = this.modelManager.getArtifacts()
    const shouldStop = (): boolean =>
      this.cancelRequested || this.pauseRequested || this.isShutdown || this.catalog.isClosed()

    try {
      const job = repo.getJob(jobId)
      if (!job) return null

      while (!shouldStop()) {
        const pending = repo.listPendingJobItems(jobId, 16)
        if (pending.length === 0) {
          break
        }

        for (const item of pending) {
          if (shouldStop()) break

          this.activeFileLocationId = item.fileLocationId
          this.activeTextSourceKind = item.textSourceKind

          try {
            const source = repo.loadTrackSource(item.fileLocationId, item.textSourceKind)
            if (
              !source ||
              source.discoveryObservationId !== item.discoveryObservationId ||
              source.contentRevision !== item.contentRevision ||
              source.sourceExtractionId !== item.sourceExtractionId ||
              source.normalizedTextSha256 !== item.normalizedTextSha256
            ) {
              repo.markJobItemSkippedStale(jobId, item.fileLocationId, item.textSourceKind)
              this.invalidateCoverageCache()
              continue
            }

            if (source.normalizedText.length === 0) {
              repo.commitTrackChunks({
                jobId,
                fileLocationId: source.fileLocationId,
                textSourceKind: source.textSourceKind,
                discoveryObservationId: source.discoveryObservationId,
                observedByteSize: source.observedByteSize,
                observedMtimeMs: source.observedMtimeMs,
                contentSha256: source.contentSha256,
                contentRevision: source.contentRevision,
                sourceExtractionId: source.sourceExtractionId,
                sourceRecipeVersion: source.sourceRecipeVersion,
                sourceOcrModelId: source.sourceOcrModelId,
                sourceOcrModelManifestSha256: source.sourceOcrModelManifestSha256,
                sourceOcrLanguage: source.sourceOcrLanguage,
                normalizedTextSha256: source.normalizedTextSha256,
                compat,
                status: 'empty_text',
                normalizedCharCount: 0,
                indexedCharCount: 0,
                coverageRatio: 1,
                truncated: false,
                truncationReason: null,
                totalTokenCount: 0,
                uniqueIndexedTokenCount: 0,
                emittedChunkTokenSum: 0,
                chunks: []
              })
              this.invalidateCoverageCache()
              continue
            }

            if (!job.forceReindex) {
              const reusable = repo.findReusableTrackChunks({
                compat,
                textSourceKind: source.textSourceKind,
                normalizedTextSha256: source.normalizedTextSha256,
                sourceRecipeVersion: source.sourceRecipeVersion,
                sourceOcrModelId: source.sourceOcrModelId,
                sourceOcrModelManifestSha256: source.sourceOcrModelManifestSha256,
                sourceOcrLanguage: source.sourceOcrLanguage
              })
              if (reusable && !shouldStop()) {
                repo.commitTrackChunks({
                  jobId,
                  fileLocationId: source.fileLocationId,
                  textSourceKind: source.textSourceKind,
                  discoveryObservationId: source.discoveryObservationId,
                  observedByteSize: source.observedByteSize,
                  observedMtimeMs: source.observedMtimeMs,
                  contentSha256: source.contentSha256,
                  contentRevision: source.contentRevision,
                  sourceExtractionId: source.sourceExtractionId,
                  sourceRecipeVersion: source.sourceRecipeVersion,
                  sourceOcrModelId: source.sourceOcrModelId,
                  sourceOcrModelManifestSha256: source.sourceOcrModelManifestSha256,
                  sourceOcrLanguage: source.sourceOcrLanguage,
                  normalizedTextSha256: source.normalizedTextSha256,
                  compat,
                  status: reusable.status,
                  normalizedCharCount: reusable.normalizedCharCount,
                  indexedCharCount: reusable.indexedCharCount,
                  coverageRatio: reusable.coverageRatio,
                  truncated: reusable.truncated,
                  truncationReason: reusable.truncationReason,
                  totalTokenCount: reusable.totalTokenCount,
                  uniqueIndexedTokenCount: reusable.uniqueIndexedTokenCount,
                  emittedChunkTokenSum: reusable.emittedChunkTokenSum,
                  chunks: reusable.chunks,
                  reused: true
                })
                this.invalidateCoverageCache()
                continue
              }
            }

            const chunkResult = await this.runner.chunkText(
              modelDir,
              source.rawText,
              {
                maxContentTokensPerChunk: compat.maxContentTokensPerChunk,
                overlapTokens: compat.overlapTokens,
                maxChunksPerDocument: compat.maxChunksPerDocument,
                maxTextCharsForIndexing: compat.maxTextCharsForIndexing
              },
              artifacts
            )

            if (shouldStop()) break

            const embeddedChunks: Array<{ chunk: DocChunk; vector: Float32Array }> = []
            for (const chunk of chunkResult.chunks) {
              if (shouldStop()) break
              const embedRes = await this.runner.embedChunk(modelDir, chunk.text, { artifacts })
              if (shouldStop()) break
              embeddedChunks.push({ chunk, vector: embedRes.vector })
            }

            if (shouldStop()) break

            const status: DocSemanticTrackStatus =
              chunkResult.chunks.length === 0
                ? 'empty_text'
                : chunkResult.truncated
                  ? 'truncated'
                  : 'indexed'

            repo.commitTrackChunks({
              jobId,
              fileLocationId: source.fileLocationId,
              textSourceKind: source.textSourceKind,
              discoveryObservationId: source.discoveryObservationId,
              observedByteSize: source.observedByteSize,
              observedMtimeMs: source.observedMtimeMs,
              contentSha256: source.contentSha256,
              contentRevision: source.contentRevision,
              sourceExtractionId: source.sourceExtractionId,
              sourceRecipeVersion: source.sourceRecipeVersion,
              sourceOcrModelId: source.sourceOcrModelId,
              sourceOcrModelManifestSha256: source.sourceOcrModelManifestSha256,
              sourceOcrLanguage: source.sourceOcrLanguage,
              normalizedTextSha256: source.normalizedTextSha256,
              compat,
              status,
              normalizedCharCount: chunkResult.normalizedCharCount,
              indexedCharCount: chunkResult.indexedCharCount,
              coverageRatio: chunkResult.coverageRatio,
              truncated: chunkResult.truncated,
              truncationReason: chunkResult.truncationReason,
              totalTokenCount: chunkResult.totalTokenCount,
              uniqueIndexedTokenCount: chunkResult.uniqueIndexedTokenCount,
              emittedChunkTokenSum: chunkResult.emittedChunkTokenSum,
              chunks: embeddedChunks
            })
            this.invalidateCoverageCache()
          } catch (err) {
            const code = (err as { code?: string } | null)?.code
            if (code === 'CANCELLED' || shouldStop()) {
              break
            }
            const msg = err instanceof Error ? err.message : String(err)
            repo.commitTrackFailure({
              jobId,
              fileLocationId: item.fileLocationId,
              textSourceKind: item.textSourceKind,
              errorMessage: msg
            })
            this.invalidateCoverageCache()
          } finally {
            this.activeFileLocationId = null
            this.activeTextSourceKind = null
          }
        }
      }

      if (!this.catalog.isClosed()) {
        const finalStatus: DocSemanticJobStatus = this.isShutdown
          ? 'interrupted'
          : this.cancelRequested
            ? 'cancelled'
            : this.pauseRequested
              ? 'paused'
              : 'completed'
        repo.updateJobStatus(jobId, finalStatus)
        this.invalidateCoverageCache()
        void this.scheduleCoverageRefresh()
        return repo.getJob(jobId)
      }
      return null
    } finally {
      this.activeFileLocationId = null
      this.activeTextSourceKind = null
      this.activeJobId = null
      this.activeRunPromise = null
      await this.runner.releaseIdleWorker().catch(() => {})
    }
  }

  public async searchDocuments(
    query: string,
    options: DocRankOptions & {
      readonly extensionFilter?: string | null
      readonly filenameQuery?: string
      readonly textSourceKindFilter?: DocTextSourceKind | null
      readonly purposeFilter?:
        'legal' | 'lists' | 'instructions' | 'receipts' | 'recipes' | 'other' | 'unknown' | null
      readonly originFilter?:
        'personal' | 'software_project' | 'application_system' | 'unknown' | null
      readonly clutterFilter?: 'show_all' | 'hide_clutter' | 'only_clutter'
    } = {}
  ): Promise<DocSemanticSearchResult> {
    const trimmed = query.trim()
    if (!trimmed) {
      return {
        items: [],
        totalMatched: 0,
        hasMore: false,
        eligibleChunkCount: 0,
        corruptChunkCount: 0
      }
    }

    const { installDir, compat } = await this.verifyModelReadyOffMain()
    const embed = await this.runner.embedQuery(installDir, trimmed, {
      artifacts: this.modelManager.getArtifacts()
    })

    return this.catalog.getDocumentSemanticRepository().searchDocumentChunksBounded(embed.vector, {
      ...options,
      compat
    })
  }

  public getProgress(): DocumentSemanticProgress {
    const spec = this.getCompatibilitySpec()
    const specKey = this.formatSpecKey(spec)
    const repo = !this.catalog.isClosed() ? this.catalog.getDocumentSemanticRepository() : null
    const job =
      repo && this.activeJobId ? repo.getJob(this.activeJobId) : repo ? repo.getLatestJob() : null

    if (repo && !this.isCoverageCacheFresh(specKey) && !this.coverageRefreshPromise) {
      void this.scheduleCoverageRefresh()
    }

    return {
      jobId: job?.id ?? null,
      status: job?.status ?? 'idle',
      scopeKind: job?.scopeKind ?? null,
      docModelId: spec.docModelId,
      docModelCommit: spec.docModelCommit,
      docModelManifestSha256: spec.docModelManifestSha256,
      chunkingRecipeVersion: spec.chunkingRecipeVersion,
      totalItems: job?.totalItems ?? 0,
      processedItems: job?.processedItems ?? 0,
      indexedItems: job?.indexedItems ?? 0,
      truncatedItems: job?.truncatedItems ?? 0,
      emptyTextItems: job?.emptyTextItems ?? 0,
      failedItems: job?.failedItems ?? 0,
      reusedItems: job?.reusedItems ?? 0,
      skippedStaleItems: job?.skippedStaleItems ?? 0,
      pendingItems: job ? Math.max(0, job.totalItems - job.processedItems) : 0,
      activeFileLocationId: this.activeFileLocationId,
      activeTextSourceKind: this.activeTextSourceKind,
      startedAtMs: job?.startedAtMs ?? null,
      updatedAtMs: job?.updatedAtMs ?? null,
      completedAtMs: job?.completedAtMs ?? null,
      lastError: job?.lastError ?? null,
      coverage: this.cachedCoverage ?? EMPTY_DOC_SEMANTIC_COVERAGE,
      coverageReady: this.cachedCoverage !== null,
      coverageRefreshing: this.coverageRefreshPromise !== null
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.cancelRequested = true
    await this.runner.cancelActiveRequests('CANCELLED: DocumentSemanticCoordinator shut down')
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {})
    }
    if (this.ownsRunner) {
      await this.runner.shutdown()
    }
  }
}
