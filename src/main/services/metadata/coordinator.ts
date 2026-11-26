/**
 * Personal Vault — Stage 6C Bounded Photo Metadata Extraction Coordinator
 *
 * Orchestrates explicit, resumable, cancelable photo technical metadata extraction
 * across the shared ThumbnailCoordinator worker pool without requiring a semantic model.
 */

import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { CatalogDatabase } from '../catalog/database'
import { resolveReadableFileLocation } from '../backup/recovered-file-resolver'
import type { PhotoMetadataJobItemRecord, PhotoMetadataJobRecord } from '../catalog/types'
import type { ThumbnailCoordinator } from '../thumbnails/coordinator'
import { computeExtensionFormatMismatch, normalizeRecordedExtension } from './normalize'
import {
  METADATA_LIMITS,
  METADATA_PARSER_RECIPE_VERSION,
  type PhotoMetadataExtractionProgress
} from './types'

export interface PhotoMetadataCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly thumbnailCoordinator: ThumbnailCoordinator
  readonly parserRecipeVersion?: string
  readonly batchSize?: number
  readonly itemDelayMs?: number
}

export class PhotoMetadataCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly thumbnailCoordinator: ThumbnailCoordinator
  private readonly parserRecipeVersion: string
  private readonly batchSize: number
  private readonly itemDelayMs: number

  private activeJobId: string | null = null
  private isStarting = false
  private abortController: AbortController | null = null
  private pauseRequested = false
  private cancelRequested = false
  private isShutdown = false
  private loopPromise: Promise<PhotoMetadataExtractionProgress> | null = null
  private listeners = new Set<(progress: PhotoMetadataExtractionProgress) => void>()

  constructor(options: PhotoMetadataCoordinatorOptions) {
    this.catalog = options.catalog
    this.thumbnailCoordinator = options.thumbnailCoordinator
    this.parserRecipeVersion = options.parserRecipeVersion ?? METADATA_PARSER_RECIPE_VERSION
    this.batchSize = Math.max(
      1,
      Math.min(32, Math.floor(options.batchSize ?? METADATA_LIMITS.JOB_FETCH_BATCH_SIZE))
    )
    this.itemDelayMs = Math.max(0, Math.floor(options.itemDelayMs ?? 0))
  }

  public getParserRecipeVersion(): string {
    return this.parserRecipeVersion
  }

  public initialize(): PhotoMetadataExtractionProgress {
    this.catalog.markRunningPhotoMetadataJobsAsInterrupted()
    return this.getProgress()
  }

  public onProgress(listener: (progress: PhotoMetadataExtractionProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitProgress(): void {
    if (this.catalog.isClosed()) {
      return
    }
    const snapshot = this.getProgress()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore listener errors
      }
    }
  }

  public getProgress(): PhotoMetadataExtractionProgress {
    const coverage = this.catalog.getPhotoMetadataCoverage(this.parserRecipeVersion)
    const job: PhotoMetadataJobRecord | null = this.activeJobId
      ? this.catalog.getPhotoMetadataJob(this.activeJobId)
      : this.catalog.getLatestPhotoMetadataJob()

    if (!job) {
      return {
        jobId: null,
        status: 'idle',
        parserRecipeVersion: this.parserRecipeVersion,
        totalPhotos: 0,
        processedPhotos: 0,
        extractedPhotos: 0,
        absentMetadataPhotos: 0,
        reusedPhotos: 0,
        unsupportedPhotos: 0,
        failedPhotos: 0,
        unavailablePhotos: 0,
        pendingPhotos: 0,
        startedAtMs: null,
        updatedAtMs: null,
        completedAtMs: null,
        lastError: null,
        coverage
      }
    }

    return {
      jobId: job.id,
      status: job.status,
      parserRecipeVersion: job.parserRecipeVersion,
      totalPhotos: job.totalPhotos,
      processedPhotos: job.processedPhotos,
      extractedPhotos: job.extractedPhotos,
      absentMetadataPhotos: job.absentMetadataPhotos,
      reusedPhotos: job.reusedPhotos,
      unsupportedPhotos: job.unsupportedPhotos,
      failedPhotos: job.failedPhotos,
      unavailablePhotos: job.unavailablePhotos,
      pendingPhotos: job.pendingPhotos,
      startedAtMs: job.startedAtMs,
      updatedAtMs: job.updatedAtMs,
      completedAtMs: job.completedAtMs,
      lastError: job.lastError,
      coverage
    }
  }

  public async startExtraction(options?: {
    retryFailed?: boolean
  }): Promise<PhotoMetadataExtractionProgress> {
    if (this.isShutdown) {
      throw new Error('Photo metadata coordinator is shut down')
    }

    if (this.isStarting || (this.activeJobId && this.loopPromise)) {
      return this.getProgress()
    }

    this.isStarting = true
    try {
      const job = this.catalog.createPhotoMetadataJob({
        parserRecipeVersion: this.parserRecipeVersion,
        retryFailed: Boolean(options?.retryFailed)
      })

      if (job.totalPhotos === 0 || job.status === 'completed') {
        this.activeJobId = null
        this.emitProgress()
        return this.getProgress()
      }

      this.activeJobId = job.id
      this.pauseRequested = false
      this.cancelRequested = false
      const controller = new AbortController()
      this.abortController = controller

      this.loopPromise = this.runJobLoop(job.id, controller.signal).finally(() => {
        if (this.activeJobId === job.id) {
          this.activeJobId = null
          this.abortController = null
          this.loopPromise = null
        }
      })

      this.emitProgress()
      return this.getProgress()
    } finally {
      this.isStarting = false
    }
  }

  public async pauseExtraction(): Promise<PhotoMetadataExtractionProgress> {
    const jobId = this.activeJobId ?? this.catalog.getLatestPhotoMetadataJob()?.id ?? null
    if (!jobId) {
      return this.getProgress()
    }

    const job = this.catalog.getPhotoMetadataJob(jobId)
    if (!job || job.status !== 'running') {
      return this.getProgress()
    }

    this.pauseRequested = true
    this.catalog.updatePhotoMetadataJobStatus(jobId, 'paused')
    this.emitProgress()

    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }

    this.emitProgress()
    return this.getProgress()
  }

  public async resumeExtraction(): Promise<PhotoMetadataExtractionProgress> {
    if (this.isShutdown) {
      throw new Error('Photo metadata coordinator is shut down')
    }

    if (this.isStarting || (this.activeJobId && this.loopPromise)) {
      return this.getProgress()
    }

    this.isStarting = true
    try {
      const latest = this.catalog.getLatestPhotoMetadataJob()
      if (!latest || (latest.status !== 'paused' && latest.status !== 'interrupted')) {
        throw new Error('No paused or interrupted metadata extraction job to resume')
      }

      if (latest.parserRecipeVersion !== this.parserRecipeVersion) {
        this.catalog.updatePhotoMetadataJobStatus(
          latest.id,
          'failed',
          'Parser recipe version changed since job scope was created'
        )
        this.emitProgress()
        throw new Error('Cannot resume metadata job created under a different parser recipe')
      }

      this.catalog.updatePhotoMetadataJobStatus(latest.id, 'running')
      this.activeJobId = latest.id
      this.pauseRequested = false
      this.cancelRequested = false
      const controller = new AbortController()
      this.abortController = controller

      this.loopPromise = this.runJobLoop(latest.id, controller.signal).finally(() => {
        if (this.activeJobId === latest.id) {
          this.activeJobId = null
          this.abortController = null
          this.loopPromise = null
        }
      })

      this.emitProgress()
      return this.getProgress()
    } finally {
      this.isStarting = false
    }
  }

  public async cancelExtraction(): Promise<PhotoMetadataExtractionProgress> {
    const jobId = this.activeJobId ?? this.catalog.getLatestPhotoMetadataJob()?.id ?? null
    if (!jobId) {
      return this.getProgress()
    }

    const job = this.catalog.getPhotoMetadataJob(jobId)
    if (
      !job ||
      (job.status !== 'running' && job.status !== 'paused' && job.status !== 'interrupted')
    ) {
      return this.getProgress()
    }

    this.cancelRequested = true
    if (this.abortController) {
      this.abortController.abort()
    }

    await this.thumbnailCoordinator.cancelMetadataRequests()
    this.catalog.updatePhotoMetadataJobStatus(jobId, 'cancelled')
    this.emitProgress()

    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }

    this.emitProgress()
    return this.getProgress()
  }

  public async waitForCompletion(): Promise<PhotoMetadataExtractionProgress> {
    if (this.loopPromise) {
      return await this.loopPromise
    }
    return this.getProgress()
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.pauseRequested = true
    if (this.abortController) {
      this.abortController.abort()
    }
    await this.thumbnailCoordinator.cancelMetadataRequests()
    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }
  }

  private async runJobLoop(
    jobId: string,
    signal: AbortSignal
  ): Promise<PhotoMetadataExtractionProgress> {
    const crashAfterRaw =
      process.env.PV_TEST_CRASH_METADATA_AFTER_N ?? process.env.PV_METADATA_CRASH_AFTER_PROCESSED
    const crashAfter = crashAfterRaw ? Number(crashAfterRaw) : 0
    const envDelayMs = process.env.PV_METADATA_ITEM_DELAY_MS
      ? Number(process.env.PV_METADATA_ITEM_DELAY_MS)
      : 0
    const effectiveDelayMs = Math.max(this.itemDelayMs, envDelayMs)

    try {
      while (!signal.aborted && !this.pauseRequested && !this.cancelRequested && !this.isShutdown) {
        const pendingBatch = this.catalog.getNextPendingPhotoMetadataJobItems(jobId, this.batchSize)
        if (pendingBatch.length === 0) {
          break
        }

        for (const item of pendingBatch) {
          if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
            break
          }

          if (effectiveDelayMs > 0) {
            await sleep(effectiveDelayMs)
            if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
              break
            }
          }

          // Yield to high-priority interactive browsing thumbnail work
          while (
            this.thumbnailCoordinator.hasInteractiveWorkPending() &&
            !signal.aborted &&
            !this.pauseRequested &&
            !this.cancelRequested &&
            !this.isShutdown
          ) {
            await sleep(15)
          }

          if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
            break
          }

          await this.processSingleJobItem(jobId, item, signal)
          this.emitProgress()

          if (crashAfter > 0) {
            const currentJob = this.catalog.getPhotoMetadataJob(jobId)
            const handled = currentJob
              ? currentJob.processedPhotos + currentJob.unsupportedPhotos + currentJob.failedPhotos
              : 0
            if (handled >= crashAfter) {
              process.exit(99)
            }
          }
        }
      }

      if (!this.catalog.isClosed()) {
        const latest = this.catalog.getPhotoMetadataJob(jobId)
        if (latest) {
          if (this.cancelRequested) {
            this.catalog.updatePhotoMetadataJobStatus(jobId, 'cancelled')
          } else if (this.pauseRequested && !this.isShutdown) {
            this.catalog.updatePhotoMetadataJobStatus(jobId, 'paused')
          } else if (
            !this.isShutdown &&
            latest.pendingPhotos === 0 &&
            latest.status === 'running'
          ) {
            this.catalog.updatePhotoMetadataJobStatus(jobId, 'completed')
          }
        }
      }
    } catch (err) {
      if (
        !this.cancelRequested &&
        !this.pauseRequested &&
        !this.isShutdown &&
        !this.catalog.isClosed()
      ) {
        this.catalog.updatePhotoMetadataJobStatus(
          jobId,
          'failed',
          err instanceof Error ? err.message : String(err)
        )
      }
    } finally {
      this.emitProgress()
    }

    return this.catalog.isClosed()
      ? {
          jobId,
          status: 'cancelled',
          parserRecipeVersion: this.parserRecipeVersion,
          totalPhotos: 0,
          processedPhotos: 0,
          extractedPhotos: 0,
          absentMetadataPhotos: 0,
          reusedPhotos: 0,
          unsupportedPhotos: 0,
          failedPhotos: 0,
          unavailablePhotos: 0,
          pendingPhotos: 0,
          startedAtMs: null,
          updatedAtMs: null,
          completedAtMs: null,
          lastError: null,
          coverage: {
            parserRecipeVersion: this.parserRecipeVersion,
            totalPhotos: 0,
            extractedCount: 0,
            noMetadataCount: 0,
            unsupportedCount: 0,
            failedCount: 0,
            unavailableCount: 0,
            staleCount: 0,
            unprocessedCount: 0
          }
        }
      : this.getProgress()
  }

  private async processSingleJobItem(
    jobId: string,
    item: PhotoMetadataJobItemRecord,
    signal: AbortSignal
  ): Promise<void> {
    const job = this.catalog.getPhotoMetadataJob(jobId)
    if (!job || job.status !== 'running') {
      return
    }

    const loc = this.catalog.getFileLocationById(item.fileLocationId)
    if (!loc) {
      this.catalog.recordPhotoMetadataJobItemTransientFailure({
        jobId,
        itemId: item.id,
        errorCode: 'LOCATION_MISSING',
        errorMessage: 'Catalog file location no longer exists'
      })
      return
    }

    if (
      loc.discoveryObservationId !== item.discoveryObservationId ||
      loc.byteSize !== item.expectedByteSize ||
      (loc.filesystemMtimeMs !== null &&
        item.expectedMtimeMs !== null &&
        Math.abs(loc.filesystemMtimeMs - item.expectedMtimeMs) > 1.0)
    ) {
      this.catalog.recordPhotoMetadataJobItemTransientFailure({
        jobId,
        itemId: item.id,
        errorCode: 'SOURCE_REVISION_CHANGED',
        errorMessage: 'Catalog observation changed since job scope was snapshotted'
      })
      return
    }

    const recordedExt = normalizeRecordedExtension(
      item.recordedExtension || loc.extension || extname(item.originalPath)
    )

    const resolved = resolveReadableFileLocation(this.catalog, item.fileLocationId, {
      verifyPayloadHash: false,
      allowVaultCopyFallbackForUnavailableSource: true
    })
    if (!resolved.ok) {
      if (resolved.errorCode === 'VAULT_UNAVAILABLE') {
        this.catalog.recordPhotoMetadataJobItemTransientFailure({
          jobId,
          itemId: item.id,
          errorCode: resolved.errorCode,
          errorMessage: resolved.errorMessage
        })
        return
      }
      const isUnavailable =
        resolved.errorCode === 'FILE_UNAVAILABLE' || resolved.errorCode === 'VAULT_COPY_MISSING'
      const contentRevision = `metarev:${item.discoveryObservationId}:${item.expectedByteSize}:${item.expectedMtimeMs ?? 'null'}:${loc.activeHash ?? 'unhashed'}`
      try {
        this.catalog.completePhotoMetadataJobItem({
          jobId,
          itemId: item.id,
          reused: false,
          metadata: {
            fileLocationId: loc.id,
            discoveryObservationId: item.discoveryObservationId,
            parserRecipeVersion: job.parserRecipeVersion,
            extractionStatus: isUnavailable ? 'unavailable' : 'failed',
            contentSha256: null,
            contentRevision,
            observedByteSize: item.expectedByteSize,
            observedMtimeMs: item.expectedMtimeMs,
            recordedExtension: recordedExt,
            detectedFormat: null,
            extensionFormatMismatch: false,
            encodedWidthPx: null,
            encodedHeightPx: null,
            exifOrientation: null,
            displayWidthPx: null,
            displayHeightPx: null,
            captureDateSourceTag: null,
            rawCaptureDateText: null,
            captureSubseconds: null,
            captureOffsetMinutes: null,
            captureOffsetText: null,
            captureTimezoneStatus: 'unknown',
            captureCalendarDate: null,
            captureYear: null,
            captureMonth: null,
            captureDay: null,
            captureLocalIso: null,
            captureUtcEpochMs: null,
            captureDateParseError: null,
            captureDateConflict: null,
            gpsStatus: 'absent',
            gpsLatitude: null,
            gpsLongitude: null,
            gpsAltitudeM: null,
            gpsParseError: null,
            cameraMakeRaw: null,
            cameraModelRaw: null,
            cameraDisplay: null,
            cameraNormalized: null,
            lensMakeRaw: null,
            lensModelRaw: null,
            lensDisplay: null,
            lensNormalized: null,
            unknownTagCount: 0,
            parserLimitsNote: null,
            rawMetadataJson: null,
            errorCode: resolved.errorCode,
            errorMessage: resolved.errorMessage
          }
        })
      } catch (err) {
        this.catalog.recordPhotoMetadataJobItemTransientFailure({
          jobId,
          itemId: item.id,
          errorCode: 'COMMIT_REJECTED',
          errorMessage: err instanceof Error ? err.message : String(err)
        })
      }
      return
    }

    // 1. Content-addressed reuse check: ONLY if a previous verified extraction exists with the same byte size & recipe.
    // Even if a catalog hash exists, we ALWAYS compute live SHA-256 off-main in the worker before reusing!
    const mayReuse = this.catalog.hasReusablePhotoTechnicalMetadataCandidate({
      observedByteSize: resolved.expectedByteSize,
      parserRecipeVersion: job.parserRecipeVersion
    })

    if (mayReuse) {
      const liveVerified = await this.verifySourceWithBackpressure(
        {
          sourcePath: resolved.filePath,
          expectedByteSize: resolved.expectedByteSize,
          expectedMtimeMs: resolved.expectedMtimeMs,
          expectedSha256: resolved.expectedSha256,
          approvedRootsOverride: resolved.approvedRoots
        },
        signal
      )

      if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
        return
      }

      if (!liveVerified.ok) {
        if (
          liveVerified.errorCode === 'CANCELLED' ||
          liveVerified.errorCode === 'ABORTED' ||
          liveVerified.errorCode === 'SHUTTING_DOWN'
        ) {
          return
        }
        this.catalog.recordPhotoMetadataJobItemTransientFailure({
          jobId,
          itemId: item.id,
          errorCode: liveVerified.errorCode,
          errorMessage: liveVerified.errorMessage
        })
        return
      }

      const reusable = this.catalog.findReusablePhotoTechnicalMetadata({
        contentSha256: liveVerified.sha256,
        observedByteSize: liveVerified.observedByteSize,
        parserRecipeVersion: job.parserRecipeVersion
      })

      if (
        reusable &&
        (reusable.extractionStatus === 'extracted' || reusable.extractionStatus === 'no_metadata')
      ) {
        if (
          !this.verifyPreCommitLiveStat(
            resolved.filePath,
            liveVerified.observedByteSize,
            liveVerified.observedMtimeMs
          )
        ) {
          this.catalog.recordPhotoMetadataJobItemTransientFailure({
            jobId,
            itemId: item.id,
            errorCode: 'SOURCE_MODIFIED',
            errorMessage: 'Source file changed on disk before metadata reuse commit'
          })
          return
        }

        const observedMtimeForCommit =
          resolved.mode === 'vault_copy' ? item.expectedMtimeMs : liveVerified.observedMtimeMs
        const contentRevision = `metarev:${item.discoveryObservationId}:${liveVerified.observedByteSize}:${observedMtimeForCommit}:${liveVerified.sha256}`
        const mismatch = computeExtensionFormatMismatch(recordedExt, reusable.detectedFormat)

        try {
          this.catalog.completePhotoMetadataJobItem({
            jobId,
            itemId: item.id,
            reused: true,
            metadata: {
              fileLocationId: loc.id,
              discoveryObservationId: item.discoveryObservationId,
              parserRecipeVersion: job.parserRecipeVersion,
              extractionStatus: reusable.extractionStatus,
              contentSha256: liveVerified.sha256,
              contentRevision,
              observedByteSize: liveVerified.observedByteSize,
              observedMtimeMs: observedMtimeForCommit,
              recordedExtension: recordedExt,
              detectedFormat: reusable.detectedFormat,
              extensionFormatMismatch: mismatch,
              encodedWidthPx: reusable.encodedWidthPx,
              encodedHeightPx: reusable.encodedHeightPx,
              exifOrientation: reusable.exifOrientation,
              displayWidthPx: reusable.displayWidthPx,
              displayHeightPx: reusable.displayHeightPx,
              captureDateSourceTag: reusable.captureDateSourceTag,
              rawCaptureDateText: reusable.rawCaptureDateText,
              captureSubseconds: reusable.captureSubseconds,
              captureOffsetMinutes: reusable.captureOffsetMinutes,
              captureOffsetText: reusable.captureOffsetText,
              captureTimezoneStatus: reusable.captureTimezoneStatus,
              captureCalendarDate: reusable.captureCalendarDate,
              captureYear: reusable.captureYear,
              captureMonth: reusable.captureMonth,
              captureDay: reusable.captureDay,
              captureLocalIso: reusable.captureLocalIso,
              captureUtcEpochMs: reusable.captureUtcEpochMs,
              captureDateParseError: reusable.captureDateParseError,
              captureDateConflict: reusable.captureDateConflict,
              gpsStatus: reusable.gpsStatus,
              gpsLatitude: reusable.gpsLatitude,
              gpsLongitude: reusable.gpsLongitude,
              gpsAltitudeM: reusable.gpsAltitudeM,
              gpsParseError: reusable.gpsParseError,
              cameraMakeRaw: reusable.cameraMakeRaw,
              cameraModelRaw: reusable.cameraModelRaw,
              cameraDisplay: reusable.cameraDisplay,
              cameraNormalized: reusable.cameraNormalized,
              lensMakeRaw: reusable.lensMakeRaw,
              lensModelRaw: reusable.lensModelRaw,
              lensDisplay: reusable.lensDisplay,
              lensNormalized: reusable.lensNormalized,
              unknownTagCount: reusable.unknownTagCount,
              parserLimitsNote: reusable.parserLimitsNote,
              rawMetadataJson: reusable.rawMetadataJson,
              errorCode: null,
              errorMessage: null
            }
          })
        } catch (err) {
          this.catalog.recordPhotoMetadataJobItemTransientFailure({
            jobId,
            itemId: item.id,
            errorCode: 'COMMIT_REJECTED',
            errorMessage: err instanceof Error ? err.message : String(err)
          })
        }
        return
      }
    }

    // 2. Full bounded read-only metadata extraction in worker
    const workerRes = await this.extractMetadataWithBackpressure(
      {
        locationId: item.fileLocationId,
        sourcePath: resolved.filePath,
        recordedExtension: recordedExt,
        expectedByteSize: resolved.expectedByteSize,
        expectedMtimeMs: resolved.expectedMtimeMs,
        expectedSha256: resolved.expectedSha256 ?? loc.activeHash,
        priority: 'low',
        approvedRootsOverride: resolved.approvedRoots
      },
      signal
    )

    if (signal.aborted || this.pauseRequested || this.cancelRequested || this.isShutdown) {
      return
    }

    if (workerRes.status === 'error') {
      if (
        workerRes.code === 'CANCELLED' ||
        workerRes.code === 'ABORTED' ||
        workerRes.code === 'SHUTTING_DOWN'
      ) {
        return
      }

      if (
        (workerRes.code === 'TIMEOUT' || workerRes.code === 'WORKER_CRASHED') &&
        this.verifyPreCommitLiveStat(
          resolved.filePath,
          resolved.expectedByteSize,
          resolved.expectedMtimeMs
        )
      ) {
        const contentRevision = `metarev:${item.discoveryObservationId}:${item.expectedByteSize}:${item.expectedMtimeMs ?? 'null'}:${loc.activeHash ?? 'unhashed'}`
        try {
          this.catalog.completePhotoMetadataJobItem({
            jobId,
            itemId: item.id,
            reused: false,
            metadata: {
              fileLocationId: loc.id,
              discoveryObservationId: item.discoveryObservationId,
              parserRecipeVersion: job.parserRecipeVersion,
              extractionStatus: 'failed',
              contentSha256: null,
              contentRevision,
              observedByteSize: item.expectedByteSize,
              observedMtimeMs: item.expectedMtimeMs,
              recordedExtension: recordedExt,
              detectedFormat: null,
              extensionFormatMismatch: false,
              encodedWidthPx: null,
              encodedHeightPx: null,
              exifOrientation: null,
              displayWidthPx: null,
              displayHeightPx: null,
              captureDateSourceTag: null,
              rawCaptureDateText: null,
              captureSubseconds: null,
              captureOffsetMinutes: null,
              captureOffsetText: null,
              captureTimezoneStatus: 'unknown',
              captureCalendarDate: null,
              captureLocalIso: null,
              captureUtcEpochMs: null,
              captureDateParseError: null,
              captureDateConflict: null,
              cameraMakeRaw: null,
              cameraModelRaw: null,
              cameraDisplay: null,
              cameraNormalized: null,
              lensMakeRaw: null,
              lensModelRaw: null,
              lensDisplay: null,
              lensNormalized: null,
              rawMetadataJson: null,
              errorCode: workerRes.code,
              errorMessage: workerRes.message
            }
          })
        } catch (err) {
          this.catalog.recordPhotoMetadataJobItemTransientFailure({
            jobId,
            itemId: item.id,
            errorCode: 'COMMIT_REJECTED',
            errorMessage: err instanceof Error ? err.message : String(err)
          })
        }
        return
      }

      this.catalog.recordPhotoMetadataJobItemTransientFailure({
        jobId,
        itemId: item.id,
        errorCode: workerRes.code,
        errorMessage: workerRes.message
      })
      return
    }

    const extracted = workerRes.extracted
    if (
      extracted.extractionStatus === 'failed' &&
      extracted.errorCode === 'READ_FAILED' &&
      !existsSync(resolved.filePath)
    ) {
      const contentRevision = `metarev:${item.discoveryObservationId}:${item.expectedByteSize}:${item.expectedMtimeMs ?? 'null'}:${loc.activeHash ?? 'unhashed'}`
      try {
        this.catalog.completePhotoMetadataJobItem({
          jobId,
          itemId: item.id,
          reused: false,
          metadata: {
            fileLocationId: loc.id,
            discoveryObservationId: item.discoveryObservationId,
            parserRecipeVersion: job.parserRecipeVersion,
            extractionStatus: 'unavailable',
            contentSha256: null,
            contentRevision,
            observedByteSize: item.expectedByteSize,
            observedMtimeMs: item.expectedMtimeMs,
            recordedExtension: recordedExt,
            detectedFormat: null,
            extensionFormatMismatch: false,
            encodedWidthPx: null,
            encodedHeightPx: null,
            exifOrientation: null,
            displayWidthPx: null,
            displayHeightPx: null,
            captureDateSourceTag: null,
            rawCaptureDateText: null,
            captureSubseconds: null,
            captureOffsetMinutes: null,
            captureOffsetText: null,
            captureTimezoneStatus: 'unknown',
            captureCalendarDate: null,
            captureYear: null,
            captureMonth: null,
            captureDay: null,
            captureLocalIso: null,
            captureUtcEpochMs: null,
            captureDateParseError: null,
            captureDateConflict: null,
            gpsStatus: 'absent',
            gpsLatitude: null,
            gpsLongitude: null,
            gpsAltitudeM: null,
            gpsParseError: null,
            cameraMakeRaw: null,
            cameraModelRaw: null,
            cameraDisplay: null,
            cameraNormalized: null,
            lensMakeRaw: null,
            lensModelRaw: null,
            lensDisplay: null,
            lensNormalized: null,
            unknownTagCount: 0,
            parserLimitsNote: null,
            rawMetadataJson: null,
            errorCode: 'FILE_UNAVAILABLE',
            errorMessage: extracted.errorMessage ?? 'Source file is unavailable on disk'
          }
        })
      } catch (err) {
        this.catalog.recordPhotoMetadataJobItemTransientFailure({
          jobId,
          itemId: item.id,
          errorCode: 'COMMIT_REJECTED',
          errorMessage: err instanceof Error ? err.message : String(err)
        })
      }
      return
    }

    if (
      extracted.extractionStatus === 'failed' &&
      (extracted.errorCode === 'SOURCE_MODIFIED' ||
        extracted.errorCode === 'ACCESS_DENIED' ||
        extracted.errorCode === 'READ_FAILED' ||
        extracted.errorCode === 'NOT_A_REGULAR_FILE')
    ) {
      this.catalog.recordPhotoMetadataJobItemTransientFailure({
        jobId,
        itemId: item.id,
        errorCode: extracted.errorCode,
        errorMessage: extracted.errorMessage ?? 'Source verification failed'
      })
      return
    }

    const checkSize = extracted.observedByteSize ?? resolved.expectedByteSize
    const checkMtime = extracted.observedMtimeMs ?? resolved.expectedMtimeMs
    if (!this.verifyPreCommitLiveStat(resolved.filePath, checkSize, checkMtime)) {
      this.catalog.recordPhotoMetadataJobItemTransientFailure({
        jobId,
        itemId: item.id,
        errorCode: 'SOURCE_MODIFIED',
        errorMessage: 'Source file changed on disk during metadata extraction'
      })
      return
    }

    const observedMtimeForCommit =
      resolved.mode === 'vault_copy' ? item.expectedMtimeMs : extracted.observedMtimeMs
    const contentRevision = `metarev:${item.discoveryObservationId}:${checkSize}:${observedMtimeForCommit ?? 'null'}:${extracted.contentSha256 ?? 'unhashed'}`

    try {
      this.catalog.completePhotoMetadataJobItem({
        jobId,
        itemId: item.id,
        reused: false,
        metadata: {
          fileLocationId: loc.id,
          discoveryObservationId: item.discoveryObservationId,
          parserRecipeVersion: job.parserRecipeVersion,
          extractionStatus: extracted.extractionStatus,
          contentSha256: extracted.contentSha256,
          contentRevision,
          observedByteSize: extracted.observedByteSize,
          observedMtimeMs: observedMtimeForCommit,
          recordedExtension: extracted.recordedExtension,
          detectedFormat: extracted.detectedFormat,
          extensionFormatMismatch: extracted.extensionFormatMismatch,
          encodedWidthPx: extracted.encodedWidthPx,
          encodedHeightPx: extracted.encodedHeightPx,
          exifOrientation: extracted.exifOrientation,
          displayWidthPx: extracted.displayWidthPx,
          displayHeightPx: extracted.displayHeightPx,
          captureDateSourceTag: extracted.captureDateSourceTag,
          rawCaptureDateText: extracted.rawCaptureDateText,
          captureSubseconds: extracted.captureSubseconds,
          captureOffsetMinutes: extracted.captureOffsetMinutes,
          captureOffsetText: extracted.captureOffsetText,
          captureTimezoneStatus: extracted.captureTimezoneStatus,
          captureCalendarDate: extracted.captureCalendarDate,
          captureYear: extracted.captureYear,
          captureMonth: extracted.captureMonth,
          captureDay: extracted.captureDay,
          captureLocalIso: extracted.captureLocalIso,
          captureUtcEpochMs: extracted.captureUtcEpochMs,
          captureDateParseError: extracted.captureDateParseError,
          captureDateConflict: extracted.captureDateConflict,
          gpsStatus: extracted.gpsStatus,
          gpsLatitude: extracted.gpsLatitude,
          gpsLongitude: extracted.gpsLongitude,
          gpsAltitudeM: extracted.gpsAltitudeM,
          gpsParseError: extracted.gpsParseError,
          cameraMakeRaw: extracted.cameraMakeRaw,
          cameraModelRaw: extracted.cameraModelRaw,
          cameraDisplay: extracted.cameraDisplay,
          cameraNormalized: extracted.cameraNormalized,
          lensMakeRaw: extracted.lensMakeRaw,
          lensModelRaw: extracted.lensModelRaw,
          lensDisplay: extracted.lensDisplay,
          lensNormalized: extracted.lensNormalized,
          unknownTagCount: extracted.unknownTagCount,
          parserLimitsNote: extracted.parserLimitsNote,
          rawMetadataJson: extracted.rawMetadataJson,
          errorCode: extracted.errorCode,
          errorMessage: extracted.errorMessage
        }
      })
    } catch (err) {
      this.catalog.recordPhotoMetadataJobItemTransientFailure({
        jobId,
        itemId: item.id,
        errorCode: 'COMMIT_REJECTED',
        errorMessage: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private async verifySourceWithBackpressure(
    params: {
      sourcePath: string
      expectedByteSize: number
      expectedMtimeMs: number | null
      expectedSha256?: string | null
      approvedRootsOverride?: readonly string[]
    },
    signal: AbortSignal
  ): Promise<import('../thumbnails/types').MetadataSourceVerifyResult> {
    while (!signal.aborted && !this.pauseRequested && !this.cancelRequested && !this.isShutdown) {
      const res = await this.thumbnailCoordinator.verifySourceForMetadata(params)
      if (!res.ok && res.errorCode === 'QUEUE_FULL') {
        await sleep(25)
        continue
      }
      return res
    }
    return {
      ok: false,
      errorCode: 'CANCELLED',
      errorMessage: 'Metadata verification cancelled'
    }
  }

  private async extractMetadataWithBackpressure(
    params: import('../thumbnails/types').MetadataExtractRequestParams,
    signal: AbortSignal
  ): Promise<import('../thumbnails/types').MetadataExtractJobResult> {
    while (!signal.aborted && !this.pauseRequested && !this.cancelRequested && !this.isShutdown) {
      const res = await this.thumbnailCoordinator.requestMetadataExtraction(params)
      if (res.status === 'error' && res.code === 'QUEUE_FULL') {
        await sleep(25)
        continue
      }
      return res
    }
    return {
      status: 'error',
      locationId: params.locationId,
      code: 'CANCELLED',
      message: 'Metadata extraction cancelled'
    }
  }

  private verifyPreCommitLiveStat(
    sourcePath: string,
    expectedByteSize: number,
    expectedMtimeMs: number | null
  ): boolean {
    try {
      const st = statSync(sourcePath)
      if (!st.isFile() || st.size !== expectedByteSize) {
        return false
      }
      if (expectedMtimeMs !== null && Math.abs(st.mtimeMs - expectedMtimeMs) > 1.0) {
        return false
      }
      return true
    } catch {
      return false
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
