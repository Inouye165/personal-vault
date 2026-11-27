/**
 * Personal Vault — Similarity Analysis Coordinator (Stage 5C)
 *
 * Coordinates local perceptual fingerprinting and candidate similarity search.
 * Enforces:
 * - Truthful progress, cancellation, and unsupported/error counts.
 * - Resumable/restart-safe execution with exact job-scope preservation.
 * - Concurrency bound to existing image workers (shared with thumbnails, low priority).
 * - Interactive photo browsing remains responsive during analysis.
 * - Out-of-band change detection and revision invalidation.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { CatalogDatabase } from '../catalog/database'
import type { ThumbnailCoordinator } from '../thumbnails/coordinator'
import type { SimilarityJobRecord } from '../catalog/types'
import type { SimilarityAnalysisProgress } from '../../../shared/validation/ipc-schemas'
import { DHASH_ALGORITHM_VERSION } from './fingerprint'
import { findAndPersistCandidatePairs } from './candidate-search'

export interface SimilarityCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly thumbnailCoordinator: ThumbnailCoordinator
}

const BATCH_SIZE = 16

export class SimilarityCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly thumbnailCoordinator: ThumbnailCoordinator
  private readonly events = new EventEmitter()

  private activeJob: SimilarityJobRecord | null = null
  private abortController: AbortController | null = null
  private completionPromise: Promise<SimilarityJobRecord> | null = null
  private isStarting = false
  private isShutdown = false

  constructor(options: SimilarityCoordinatorOptions) {
    this.catalog = options.catalog
    this.thumbnailCoordinator = options.thumbnailCoordinator
  }

  public async initialize(): Promise<void> {
    this.catalog.markRunningSimilarityJobsAsInterrupted()
  }

  public hasActiveJob(): boolean {
    if (this.isStarting || this.activeJob !== null) {
      return true
    }
    const latest = this.catalog.getLatestSimilarityJob()
    return latest !== null && latest.status === 'running'
  }

  public getProgress(): SimilarityAnalysisProgress {
    if (this.activeJob) {
      return {
        jobId: this.activeJob.jobId,
        status: this.activeJob.status,
        algorithmVersion: this.activeJob.algorithmVersion,
        totalPhotos: this.activeJob.totalPhotos,
        processedPhotos: this.activeJob.processedPhotos,
        errorPhotos: this.activeJob.errorPhotos,
        unsupportedPhotos: this.activeJob.unsupportedPhotos,
        candidatePairsFound: this.activeJob.candidatePairsFound,
        startedAtMs: this.activeJob.startedAtMs,
        updatedAtMs: this.activeJob.updatedAtMs,
        completedAtMs: this.activeJob.completedAtMs
      }
    }

    const latest = this.catalog.getLatestSimilarityJob()
    if (latest) {
      return {
        jobId: latest.jobId,
        status: latest.status,
        algorithmVersion: latest.algorithmVersion,
        totalPhotos: latest.totalPhotos,
        processedPhotos: latest.processedPhotos,
        errorPhotos: latest.errorPhotos,
        unsupportedPhotos: latest.unsupportedPhotos,
        candidatePairsFound: latest.candidatePairsFound,
        startedAtMs: latest.startedAtMs,
        updatedAtMs: latest.updatedAtMs,
        completedAtMs: latest.completedAtMs
      }
    }

    return {
      jobId: null,
      status: 'idle',
      algorithmVersion: DHASH_ALGORITHM_VERSION,
      totalPhotos: 0,
      processedPhotos: 0,
      errorPhotos: 0,
      unsupportedPhotos: 0,
      candidatePairsFound: 0,
      startedAtMs: null,
      updatedAtMs: null,
      completedAtMs: null
    }
  }

  public onProgress(listener: (progress: SimilarityAnalysisProgress) => void): () => void {
    this.events.on('progress', listener)
    return () => this.events.off('progress', listener)
  }

  public async startAnalysis(
    algorithmVersion: string = DHASH_ALGORITHM_VERSION
  ): Promise<SimilarityJobRecord> {
    if (this.isShutdown) {
      throw new Error('Similarity coordinator is shut down')
    }
    if (this.hasActiveJob()) {
      throw new Error('Another similarity analysis job is already running')
    }

    this.isStarting = true
    try {
      // 1. Snapshot all current photos in catalog
      const firstPage = this.catalog.queryFileLocations({
        category: 'photo',
        offset: 0,
        limit: 500
      })
      const totalPhotosCount = firstPage.totalCount
      const photoLocations: number[] = firstPage.items.map((it) => it.id)

      let currentOffset = photoLocations.length
      while (currentOffset < totalPhotosCount) {
        const res = this.catalog.queryFileLocations({
          category: 'photo',
          offset: currentOffset,
          limit: 500
        })
        if (res.items.length === 0) break
        for (const item of res.items) {
          photoLocations.push(item.id)
        }
        currentOffset += res.items.length
      }

      const jobId = randomUUID()
      const job = this.catalog.createSimilarityJob({
        jobId,
        algorithmVersion,
        totalPhotos: photoLocations.length,
        photoLocationIds: photoLocations
      })

      this.activeJob = job
      this.abortController = new AbortController()

      this.completionPromise = this.runProcessingLoop(
        job,
        photoLocations,
        this.abortController.signal
      )
      this.emitProgress()
      return job
    } finally {
      this.isStarting = false
    }
  }

  public async resumeAnalysis(jobId?: string): Promise<SimilarityJobRecord> {
    if (this.isShutdown) {
      throw new Error('Similarity coordinator is shut down')
    }
    if (this.hasActiveJob()) {
      throw new Error('Another similarity analysis job is already running')
    }

    const job = jobId ? this.catalog.getSimilarityJob(jobId) : this.catalog.getLatestSimilarityJob()

    if (!job) {
      throw new Error('No similarity job found to resume')
    }
    if (job.status !== 'interrupted' && job.status !== 'paused') {
      throw new Error(`Cannot resume job with status "${job.status}"`)
    }

    // Load only the pending items authorized for this job
    const pendingItems = this.catalog.getSimilarityJobItems(job.jobId, 'pending')
    const allItems = this.catalog.getSimilarityJobItems(job.jobId)
    const allLocationIds = allItems.map((i) => i.fileLocationId)

    this.catalog.updateSimilarityJob(job.jobId, { status: 'running' })
    const runningJob: SimilarityJobRecord = {
      ...job,
      status: 'running',
      updatedAtMs: Date.now()
    }

    this.activeJob = runningJob
    this.abortController = new AbortController()

    const pendingLocationIds = pendingItems.map((i) => i.fileLocationId)
    this.completionPromise = this.runProcessingLoop(
      runningJob,
      allLocationIds,
      this.abortController.signal,
      pendingLocationIds
    )
    this.emitProgress()
    return runningJob
  }

  public cancelAnalysis(): boolean {
    if (!this.activeJob || this.activeJob.status !== 'running') {
      return false
    }

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    const now = Date.now()
    this.catalog.updateSimilarityJob(this.activeJob.jobId, {
      status: 'cancelled',
      completedAtMs: now
    })

    this.activeJob = {
      ...this.activeJob,
      status: 'cancelled',
      updatedAtMs: now,
      completedAtMs: now
    }

    this.emitProgress()
    return true
  }

  public async waitForCompletion(): Promise<SimilarityJobRecord> {
    if (this.completionPromise) {
      return await this.completionPromise
    }
    if (this.activeJob) {
      return this.activeJob
    }
    const latest = this.catalog.getLatestSimilarityJob()
    if (latest) {
      return latest
    }
    throw new Error('No similarity job in progress')
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.cancelAnalysis()
    if (this.completionPromise) {
      try {
        await this.completionPromise
      } catch {
        // ignore
      }
    }
  }

  private emitProgress(): void {
    this.events.emit('progress', this.getProgress())
  }

  private async runProcessingLoop(
    job: SimilarityJobRecord,
    allLocationIds: readonly number[],
    abortSignal: AbortSignal,
    itemsToProcess?: readonly number[]
  ): Promise<SimilarityJobRecord> {
    const locationsQueue = [...(itemsToProcess ?? allLocationIds)]
    let processed = job.processedPhotos
    let unsupported = job.unsupportedPhotos
    let errorCount = job.errorPhotos

    try {
      while (locationsQueue.length > 0) {
        if (abortSignal.aborted || this.isShutdown) {
          break
        }

        const batch = locationsQueue.splice(0, BATCH_SIZE)
        const promises = batch.map(async (locId) => {
          if (abortSignal.aborted || this.isShutdown) return

          const loc = this.catalog.getFileLocationById(locId)
          if (!loc) {
            this.catalog.updateSimilarityJobItem(
              job.jobId,
              locId,
              'error',
              'File location not found'
            )
            errorCount++
            return
          }

          const revision = `rev:${loc.discoveryObservationId}:${loc.byteSize}:${loc.filesystemMtimeMs ?? 'null'}:${loc.activeHash ?? 'unhashed'}`

          // Check if perceptual hash already exists and is current with matching revision
          const existingFp = this.catalog.getPhotoPerceptualHash(loc.id, job.algorithmVersion)
          if (existingFp && existingFp.isCurrent && existingFp.contentRevision === revision) {
            this.catalog.updateSimilarityJobItem(job.jobId, locId, 'processed')
            processed++
            return
          }

          // Request fingerprinting outside main thread in worker pool with low priority
          const fpRes = await this.thumbnailCoordinator.requestFingerprint({
            locationId: loc.id,
            sourcePath: loc.originalPath,
            expectedByteSize: loc.byteSize,
            expectedMtimeMs: loc.filesystemMtimeMs,
            expectedSha256: loc.activeHash,
            priority: 'low'
          })

          if (fpRes.status === 'ready') {
            this.catalog.savePhotoPerceptualHash({
              fileLocationId: loc.id,
              discoveryObservationId: loc.discoveryObservationId,
              contentSha256: fpRes.computedSha256,
              contentRevision: revision,
              algorithmVersion: fpRes.algorithmVersion,
              fingerprint: fpRes.fingerprint,
              bucket0: fpRes.bucket0,
              bucket1: fpRes.bucket1,
              bucket2: fpRes.bucket2,
              bucket3: fpRes.bucket3,
              width: fpRes.width,
              height: fpRes.height
            })
            this.catalog.updateSimilarityJobItem(job.jobId, locId, 'processed')
            processed++
          } else if (fpRes.status === 'unsupported') {
            this.catalog.updateSimilarityJobItem(job.jobId, locId, 'unsupported', fpRes.reason)
            unsupported++
          } else {
            this.catalog.updateSimilarityJobItem(job.jobId, locId, 'error', fpRes.message)
            errorCount++
          }
        })

        await Promise.all(promises)

        // Update progress in SQLite and memory
        const now = Date.now()
        this.catalog.updateSimilarityJob(job.jobId, {
          processedPhotos: processed,
          unsupportedPhotos: unsupported,
          errorPhotos: errorCount
        })

        if (this.activeJob && this.activeJob.jobId === job.jobId) {
          this.activeJob = {
            ...this.activeJob,
            processedPhotos: processed,
            unsupportedPhotos: unsupported,
            errorPhotos: errorCount,
            updatedAtMs: now
          }
          this.emitProgress()
        }
      }

      if (abortSignal.aborted || this.isShutdown) {
        const now = Date.now()
        this.catalog.updateSimilarityJob(job.jobId, {
          status: 'cancelled',
          completedAtMs: now
        })
        const cancelledJob: SimilarityJobRecord = {
          ...job,
          status: 'cancelled',
          processedPhotos: processed,
          unsupportedPhotos: unsupported,
          errorPhotos: errorCount,
          updatedAtMs: now,
          completedAtMs: now
        }
        this.activeJob = cancelledJob
        this.emitProgress()
        return cancelledJob
      }

      // Candidate generation phase
      const candidateCount = findAndPersistCandidatePairs(this.catalog, job.jobId, allLocationIds)

      const completedAtMs = Date.now()
      this.catalog.updateSimilarityJob(job.jobId, {
        status: 'completed',
        processedPhotos: processed,
        unsupportedPhotos: unsupported,
        errorPhotos: errorCount,
        candidatePairsFound: candidateCount,
        completedAtMs
      })

      const completedJob: SimilarityJobRecord = {
        ...job,
        status: 'completed',
        processedPhotos: processed,
        unsupportedPhotos: unsupported,
        errorPhotos: errorCount,
        candidatePairsFound: candidateCount,
        updatedAtMs: completedAtMs,
        completedAtMs
      }

      this.activeJob = completedJob
      this.emitProgress()
      return completedJob
    } catch (err: unknown) {
      const now = Date.now()
      this.catalog.updateSimilarityJob(job.jobId, {
        status: 'failed',
        completedAtMs: now
      })
      const failedJob: SimilarityJobRecord = {
        ...job,
        status: 'failed',
        updatedAtMs: now,
        completedAtMs: now
      }
      this.activeJob = failedJob
      this.emitProgress()
      throw err
    } finally {
      this.completionPromise = null
    }
  }
}
