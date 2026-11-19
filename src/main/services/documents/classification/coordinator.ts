/**
 * Personal Vault — Stage 7E Slice 2: Bounded Document Classification Coordinator
 *
 * Connects `DocumentClassificationRepository` and `DocumentClassificationWorkerRunner`
 * under the shared application-wide `AppWorkerBudget(3)`.
 *
 * Guarantees:
 * - Zero source-file disk reads: operates strictly on persisted catalog metadata & extracted/OCR text.
 * - Point-in-time 250-row batched scope snapshots (`document_snapshot_worker` `kind: 'doc_classify'`),
 *   startup `interrupted` recovery, and incomplete-snapshot cleanup.
 * - Pause, resume, active cancellation, atomic `REVISION_MISMATCH` stale-write rejection,
 *   and preservation of durable `AnnotationJournal` user overrides across reclassification.
 * - Non-blocking async coverage cache with `PRAGMA data_version` + mutation-seq race protection.
 */

import { randomUUID } from 'node:crypto'
import type { CatalogDatabase } from '../../catalog/database'
import {
  EMPTY_DOC_CLASSIFICATION_COVERAGE,
  type DocClassificationCoverage,
  type DocClassificationJobRecord,
  type DocClassificationJobStatus
} from '../../catalog/document-classification-repository'
import type { DocClassificationJobScopeKind } from '../../catalog/document-classification-snapshot-query'
import { AppWorkerBudget } from '../../worker-budget'
import { DETERMINISTIC_RULE_VERSION } from './rules'
import { DocumentClassificationWorkerRunner } from './worker-runner'

export interface DocumentClassificationProgress {
  readonly jobId: string | null
  readonly status: 'idle' | DocClassificationJobStatus
  readonly scopeKind: DocClassificationJobScopeKind | null
  readonly ruleVersion: string
  readonly totalItems: number
  readonly processedItems: number
  readonly classifiedItems: number
  readonly otherItems: number
  readonly unknownItems: number
  readonly clutterItems: number
  readonly reusedItems: number
  readonly skippedStaleItems: number
  readonly failedItems: number
  readonly pendingItems: number
  readonly activeFileLocationId: number | null
  readonly startedAtMs: number | null
  readonly updatedAtMs: number | null
  readonly completedAtMs: number | null
  readonly lastError: string | null
  readonly coverage: DocClassificationCoverage
  readonly coverageReady: boolean
  readonly coverageRefreshing: boolean
}

export interface DocumentClassificationCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly workerRunner?: DocumentClassificationWorkerRunner
  readonly workerBudget?: AppWorkerBudget
  readonly maxAppLiveWorkers?: number
  readonly getExternalLiveWorkers?: () => number
  readonly tryReleaseExternalIdleWorker?: () => Promise<boolean>
  readonly workerScriptPath?: string
  readonly snapshotWorkerScriptPath?: string
  readonly appPath?: string | null
  readonly isPackaged?: boolean
  readonly workerTimeoutMs?: number
}

export interface StartDocClassificationOptions {
  readonly scopeKind: DocClassificationJobScopeKind
  readonly fileLocationIds?: readonly number[]
  readonly extensionFilter?: string | null
  readonly filenameQuery?: string
  readonly forceReclassify?: boolean
}

export class DocumentClassificationCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly runner: DocumentClassificationWorkerRunner
  private readonly ownsRunner: boolean
  private readonly workerBudget: AppWorkerBudget
  private readonly getExternalLiveWorkers?: () => number
  private readonly snapshotWorkerScriptPath?: string
  private readonly appPath?: string | null
  private readonly isPackaged?: boolean

  private activeRunPromise: Promise<DocClassificationJobRecord | null> | null = null
  private activeJobId: string | null = null
  private activeFileLocationId: number | null = null
  private pauseRequested = false
  private cancelRequested = false
  private isShutdown = false
  private hasStartedLifecycleJob = false
  private readonly progressListeners = new Set<(progress: DocumentClassificationProgress) => void>()

  private cachedCoverage: DocClassificationCoverage | null = null
  private cachedGeneration: string | null = null
  private coverageRefreshPromise: Promise<DocClassificationCoverage> | null = null
  private coverageEpoch = 0

  public constructor(options: DocumentClassificationCoordinatorOptions) {
    this.catalog = options.catalog
    const maxAppLiveWorkers = Math.max(1, options.maxAppLiveWorkers ?? 3)
    this.workerBudget = options.workerBudget ?? new AppWorkerBudget(maxAppLiveWorkers)
    this.getExternalLiveWorkers = options.getExternalLiveWorkers
    this.snapshotWorkerScriptPath = options.snapshotWorkerScriptPath
    this.appPath = options.appPath
    this.isPackaged = options.isPackaged

    if (options.workerRunner) {
      this.runner = options.workerRunner
      this.ownsRunner = false
    } else {
      this.runner = new DocumentClassificationWorkerRunner({
        workerBudget: this.workerBudget,
        maxAppLiveWorkers,
        getExternalLiveWorkers: options.getExternalLiveWorkers,
        tryReleaseExternalIdleWorker: options.tryReleaseExternalIdleWorker,
        shouldCancelAdmission: () => this.cancelRequested || this.pauseRequested || this.isShutdown,
        workerScriptPath: options.workerScriptPath,
        appPath: options.appPath,
        isPackaged: options.isPackaged,
        workerTimeoutMs: options.workerTimeoutMs
      })
      this.ownsRunner = true
    }

    this.runStartupRecovery()
  }

  public runStartupRecovery(): void {
    if (this.isShutdown) {
      throw new Error('SHUTDOWN: DocumentClassificationCoordinator is shut down')
    }
    if (this.hasStartedLifecycleJob || this.activeRunPromise) {
      throw new Error(
        'LIFECYCLE_ERROR: Startup snapshot cleanup cannot run after classification jobs have started'
      )
    }
    const repo = this.catalog.getDocumentClassificationRepository()
    repo.cleanupIncompleteSnapshots()
    repo.markRunningJobsAsInterrupted()
  }

  public onProgress(listener: (progress: DocumentClassificationProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => {
      this.progressListeners.delete(listener)
    }
  }

  private emitProgress(): void {
    if (this.progressListeners.size === 0) return
    const snapshot = this.getProgress()
    for (const listener of this.progressListeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore listener errors
      }
    }
  }

  public getRunner(): DocumentClassificationWorkerRunner {
    return this.runner
  }

  public async startClassification(
    options: StartDocClassificationOptions
  ): Promise<DocClassificationJobRecord | null> {
    if (this.isShutdown) {
      throw new Error('SHUTDOWN: DocumentClassificationCoordinator is shut down')
    }
    if (this.activeRunPromise) {
      return this.activeRunPromise
    }

    this.hasStartedLifecycleJob = true
    this.hasStartedLifecycleJob = true
    this.pauseRequested = false
    this.cancelRequested = false
    const jobId = randomUUID()
    const repo = this.catalog.getDocumentClassificationRepository()

    const run = async (): Promise<DocClassificationJobRecord | null> => {
      try {
        const job = await repo.captureAndCreateJob({
          jobId,
          scopeKind: options.scopeKind,
          ruleVersion: DETERMINISTIC_RULE_VERSION,
          fileLocationIds: options.fileLocationIds,
          extensionFilter: options.extensionFilter,
          filenameQuery: options.filenameQuery,
          forceReclassify: options.forceReclassify,
          workerBudget: this.workerBudget,
          getExternalLiveWorkers: this.getExternalLiveWorkers,
          shouldCancel: () => this.cancelRequested || this.pauseRequested || this.isShutdown,
          snapshotWorkerScriptPath: this.snapshotWorkerScriptPath,
          appPath: this.appPath,
          isPackaged: this.isPackaged
        })
        this.activeJobId = job.id
        return await this.processJob(job.id, Boolean(options.forceReclassify))
      } catch (err) {
        if (this.cancelRequested || this.pauseRequested || this.isShutdown) {
          return repo.getJobById(jobId)
        }
        throw err
      } finally {
        this.activeRunPromise = null
        this.activeJobId = null
        this.activeFileLocationId = null
        this.emitProgress()
        void this.refreshCoverageInBackground().then(() => this.emitProgress())
      }
    }

    this.activeRunPromise = run()
    return this.activeRunPromise
  }

  public async classifySelected(
    fileLocationIds: readonly number[],
    forceReclassify = false
  ): Promise<DocClassificationJobRecord | null> {
    return this.startClassification({
      scopeKind: 'selected',
      fileLocationIds,
      forceReclassify
    })
  }

  public async reclassify(): Promise<DocClassificationJobRecord | null> {
    return this.startClassification({
      scopeKind: 'all',
      forceReclassify: true
    })
  }

  public async resume(): Promise<DocClassificationJobRecord | null> {
    if (this.isShutdown) {
      throw new Error('SHUTDOWN: DocumentClassificationCoordinator is shut down')
    }
    if (this.activeRunPromise) {
      return this.activeRunPromise
    }

    const repo = this.catalog.getDocumentClassificationRepository()
    const latest = repo.getLatestJob()
    if (!latest || (latest.status !== 'paused' && latest.status !== 'interrupted')) {
      return latest
    }

    this.hasStartedLifecycleJob = true
    this.pauseRequested = false
    this.cancelRequested = false
    repo.updateJobStatus(latest.id, 'running')

    const run = async (): Promise<DocClassificationJobRecord | null> => {
      this.activeJobId = latest.id
      try {
        return await this.processJob(latest.id, latest.forceReclassify)
      } finally {
        this.activeRunPromise = null
        this.activeJobId = null
        this.activeFileLocationId = null
        this.emitProgress()
        void this.refreshCoverageInBackground().then(() => this.emitProgress())
      }
    }

    this.activeRunPromise = run()
    return this.activeRunPromise
  }

  public async pause(): Promise<void> {
    this.pauseRequested = true
    if (this.activeJobId) {
      this.catalog.getDocumentClassificationRepository().updateJobStatus(this.activeJobId, 'paused')
    }
    await this.runner.cancelActiveRequests('CANCELLED: Document classification paused')
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {})
    }
  }

  public async cancel(): Promise<void> {
    this.cancelRequested = true
    if (this.activeJobId) {
      this.catalog
        .getDocumentClassificationRepository()
        .updateJobStatus(this.activeJobId, 'cancelled')
    }
    await this.runner.cancelActiveRequests('CANCELLED: Document classification cancelled')
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {})
    }
  }

  public async getCoverage(): Promise<DocClassificationCoverage> {
    const gen = this.catalog.getDocumentClassificationCoverageGeneration()
    if (this.cachedCoverage && this.cachedGeneration === gen) {
      return this.cachedCoverage
    }
    return this.refreshCoverageInBackground()
  }

  public getProgress(): DocumentClassificationProgress {
    const repo = this.catalog.getDocumentClassificationRepository()
    const job = this.activeJobId ? repo.getJobById(this.activeJobId) : repo.getLatestJob()
    const gen = this.catalog.getDocumentClassificationCoverageGeneration()

    if (!this.cachedCoverage || this.cachedGeneration !== gen) {
      void this.refreshCoverageInBackground()
    }

    const totalItems = job?.totalItems ?? 0
    const processedItems = job?.processedItems ?? 0

    return {
      jobId: job?.id ?? null,
      status: job?.status ?? 'idle',
      scopeKind: job?.scopeKind ?? null,
      ruleVersion: job?.ruleVersion ?? DETERMINISTIC_RULE_VERSION,
      totalItems,
      processedItems,
      classifiedItems: job?.classifiedItems ?? 0,
      otherItems: job?.otherItems ?? 0,
      unknownItems: job?.unknownItems ?? 0,
      clutterItems: job?.clutterItems ?? 0,
      reusedItems: job?.reusedItems ?? 0,
      skippedStaleItems: job?.skippedStaleItems ?? 0,
      failedItems: job?.failedItems ?? 0,
      pendingItems: Math.max(0, totalItems - processedItems),
      activeFileLocationId: this.activeFileLocationId,
      startedAtMs: job?.startedAtMs ?? null,
      updatedAtMs: job?.updatedAtMs ?? null,
      completedAtMs: job?.completedAtMs ?? null,
      lastError: job?.lastError ?? null,
      coverage: this.cachedCoverage ?? EMPTY_DOC_CLASSIFICATION_COVERAGE,
      coverageReady: this.cachedCoverage !== null && this.cachedGeneration === gen,
      coverageRefreshing: this.coverageRefreshPromise !== null
    }
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.cancelRequested = true
    if (this.activeJobId) {
      try {
        this.catalog
          .getDocumentClassificationRepository()
          .updateJobStatus(this.activeJobId, 'interrupted')
      } catch {
        // ignore close/shutdown race
      }
    }
    if (this.ownsRunner) {
      await this.runner.shutdown()
    } else {
      await this.runner.cancelActiveRequests('CANCELLED: Coordinator shut down')
    }
    if (this.activeRunPromise) {
      await this.activeRunPromise.catch(() => {})
    }
  }

  private async processJob(
    jobId: string,
    forceReclassify: boolean
  ): Promise<DocClassificationJobRecord | null> {
    const repo = this.catalog.getDocumentClassificationRepository()

    for (;;) {
      if (this.cancelRequested) {
        repo.updateJobStatus(jobId, 'cancelled')
        return repo.getJobById(jobId)
      }
      if (this.pauseRequested) {
        repo.updateJobStatus(jobId, 'paused')
        return repo.getJobById(jobId)
      }
      if (this.isShutdown) {
        repo.updateJobStatus(jobId, 'interrupted')
        return repo.getJobById(jobId)
      }

      const batch = repo.getNextPendingBatch(jobId, 25)
      if (batch.length === 0) {
        repo.updateJobStatus(jobId, 'completed')
        return repo.getJobById(jobId)
      }

      for (const item of batch) {
        if (this.cancelRequested || this.pauseRequested || this.isShutdown) {
          break
        }
        this.activeFileLocationId = item.fileLocationId

        const candidate = repo.getCandidateForLocation(item.fileLocationId)
        if (
          !candidate ||
          candidate.row.discovery_observation_id !== item.discoveryObservationId ||
          candidate.resolved.contentRevision !== item.contentRevision ||
          candidate.resolved.nativeExtractionId !== item.nativeExtractionId ||
          candidate.resolved.ocrExtractionId !== item.ocrExtractionId ||
          candidate.resolved.normalizedInputSha256 !== item.normalizedInputSha256
        ) {
          repo.recordJobItemOutcome({
            jobId,
            fileLocationId: item.fileLocationId,
            status: 'skipped_stale'
          })
          continue
        }

        if (!forceReclassify && candidate.isCompatible) {
          repo.recordJobItemOutcome({
            jobId,
            fileLocationId: item.fileLocationId,
            status: 'reused'
          })
          continue
        }

        try {
          const result = await this.runner.classifyDocument({
            fileLocationId: item.fileLocationId,
            fileName: candidate.row.file_name,
            extension: candidate.row.extension,
            relativePath: candidate.resolved.relativePath,
            byteSize: candidate.row.byte_size,
            extractionStatus: candidate.resolved.extractionStatus,
            textSourceKind: candidate.resolved.textSourceKind,
            ocrMeanConfidence: candidate.resolved.ocrMeanConfidence,
            nativeTruncated: candidate.resolved.nativeTruncated,
            ocrTruncated: candidate.resolved.ocrTruncated,
            text: candidate.resolved.text
          })

          const commitRes = repo.commitClassificationResult({
            fileLocationId: item.fileLocationId,
            expectedDiscoveryObservationId: item.discoveryObservationId,
            expectedContentRevision: item.contentRevision,
            expectedNativeExtractionId: item.nativeExtractionId,
            expectedOcrExtractionId: item.ocrExtractionId,
            expectedNormalizedInputSha256: item.normalizedInputSha256,
            sourceRootPath: candidate.row.source_root_path,
            resolved: candidate.resolved,
            row: candidate.row,
            result
          })

          if (commitRes.status === 'revision_mismatch') {
            repo.recordJobItemOutcome({
              jobId,
              fileLocationId: item.fileLocationId,
              status: 'skipped_stale'
            })
          } else {
            const outcomeStatus =
              result.purposeStatus === 'classified'
                ? 'classified'
                : result.purposeStatus === 'other'
                  ? 'other'
                  : 'unknown'
            repo.recordJobItemOutcome({
              jobId,
              fileLocationId: item.fileLocationId,
              status: outcomeStatus,
              isClutter: result.isClutterCandidate
            })
          }
        } catch (err) {
          if (this.cancelRequested || this.pauseRequested || this.isShutdown) {
            break
          }
          repo.recordJobItemOutcome({
            jobId,
            fileLocationId: item.fileLocationId,
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }
  }

  private async refreshCoverageInBackground(): Promise<DocClassificationCoverage> {
    if (this.coverageRefreshPromise) {
      return this.coverageRefreshPromise
    }

    const epoch = ++this.coverageEpoch
    const genBefore = this.catalog.getDocumentClassificationCoverageGeneration()

    this.coverageRefreshPromise = Promise.resolve().then(() => {
      try {
        const cov = this.catalog.getDocumentClassificationRepository().getCoverage()
        const genAfter = this.catalog.getDocumentClassificationCoverageGeneration()
        if (epoch === this.coverageEpoch && genBefore === genAfter) {
          this.cachedCoverage = cov
          this.cachedGeneration = genAfter
        }
        return cov
      } finally {
        this.coverageRefreshPromise = null
      }
    })

    return this.coverageRefreshPromise
  }
}
