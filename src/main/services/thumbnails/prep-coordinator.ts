/**
 * Personal Vault — Background Thumbnail Preparation Coordinator
 *
 * Pre-generates and disk-caches WebP thumbnails in the background for existing
 * cataloged photos and newly scanned or imported photos, using the shared
 * ThumbnailCoordinator at low priority so interactive browsing, scrolling,
 * and search always take precedence.
 */

import { existsSync } from 'node:fs'
import type { CatalogDatabase } from '../catalog/database'
import type { PhotoThumbnailPrepCandidate } from '../catalog/types'
import { resolveReadableFileLocation } from '../backup/recovered-file-resolver'
import { THUMBNAIL_LIMITS } from './types'
import type { ThumbnailCoordinator } from './coordinator'
import type { ThumbnailPrepProgress } from '../../../shared/validation/ipc-schemas'

export interface ThumbnailPrepCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly thumbnailCoordinator: ThumbnailCoordinator
  readonly shouldYieldToInteractiveSearch?: () => boolean
  readonly startupDelayMs?: number
  readonly scanSettleDelayMs?: number
  readonly batchSize?: number
  readonly maxConcurrency?: number
  readonly log?: (message: string) => void
}

const DEFAULT_STARTUP_DELAY_MS = 2000
const DEFAULT_SCAN_SETTLE_DELAY_MS = 1500
const DEFAULT_BATCH_SIZE = 24
const DEFAULT_CONCURRENCY = 2
const PROGRESS_THROTTLE_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export class ThumbnailPrepCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly thumbnailCoordinator: ThumbnailCoordinator
  private readonly shouldYieldToInteractiveSearch?: () => boolean
  private readonly startupDelayMs: number
  private readonly scanSettleDelayMs: number
  private readonly batchSize: number
  private readonly maxConcurrency: number
  private readonly log?: (message: string) => void
  private readonly recipeVersion = THUMBNAIL_LIMITS.RECIPE_VERSION

  private readonly listeners = new Set<(progress: ThumbnailPrepProgress) => void>()
  private startupTimer: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private loopPromise: Promise<ThumbnailPrepProgress> | null = null
  private rerunRequested = false
  private isRunning = false
  private isShutdown = false
  private lastEmitMs = 0
  private lastScanHashedTrigger = 0

  constructor(options: ThumbnailPrepCoordinatorOptions) {
    this.catalog = options.catalog
    this.thumbnailCoordinator = options.thumbnailCoordinator
    this.shouldYieldToInteractiveSearch = options.shouldYieldToInteractiveSearch
    this.startupDelayMs = Math.max(0, options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS)
    this.scanSettleDelayMs = Math.max(0, options.scanSettleDelayMs ?? DEFAULT_SCAN_SETTLE_DELAY_MS)
    this.batchSize = Math.max(1, Math.min(100, options.batchSize ?? DEFAULT_BATCH_SIZE))
    this.maxConcurrency = Math.max(1, Math.min(2, options.maxConcurrency ?? DEFAULT_CONCURRENCY))
    this.log = options.log
  }

  public initialize(): void {
    if (this.isShutdown || this.catalog.isClosed()) return
    if (this.startupDelayMs === 0) {
      this.triggerPreparation()
      return
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.triggerPreparation()
    }, this.startupDelayMs)
    this.startupTimer.unref?.()
  }

  public onProgress(listener: (progress: ThumbnailPrepProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public getProgress(): ThumbnailPrepProgress {
    if (this.catalog.isClosed()) {
      return {
        status: 'idle',
        totalPhotos: 0,
        preparedPhotos: 0,
        unsupportedPhotos: 0,
        unavailablePhotos: 0,
        failedPhotos: 0,
        pendingPhotos: 0
      }
    }
    const summary = this.catalog.getThumbnailPrepSummary(this.recipeVersion)
    const status: ThumbnailPrepProgress['status'] = this.isRunning
      ? 'running'
      : summary.totalPhotos === 0
        ? 'idle'
        : summary.pendingPhotos === 0
          ? 'completed'
          : 'idle'

    return {
      status,
      totalPhotos: summary.totalPhotos,
      preparedPhotos: summary.preparedPhotos,
      unsupportedPhotos: summary.unsupportedPhotos,
      unavailablePhotos: summary.unavailablePhotos,
      failedPhotos: summary.failedPhotos,
      pendingPhotos: summary.pendingPhotos
    }
  }

  public triggerPreparation(): void {
    if (this.isShutdown || this.catalog.isClosed()) return
    if (this.loopPromise) {
      this.rerunRequested = true
      return
    }
    this.isRunning = true
    this.emitProgress(true)
    const run = async (): Promise<ThumbnailPrepProgress> => {
      try {
        await this.runLoop()
      } finally {
        this.isRunning = false
        this.loopPromise = null
        this.emitProgress(true)
        if (this.rerunRequested && !this.isShutdown && !this.catalog.isClosed()) {
          this.rerunRequested = false
          this.triggerPreparation()
        }
      }
      return this.getProgress()
    }
    this.loopPromise = run()
  }

  public onScanProgress(progress: {
    readonly jobId: number
    readonly status: string
    readonly phase?: string
    readonly hashedCount?: number
  }): void {
    if (this.isShutdown || this.catalog.isClosed()) return
    const hashed = progress.hashedCount ?? 0
    if (progress.status === 'running' && progress.phase === 'hashing') {
      // Begin warming hashed photos incrementally once a large scan has hashed >= 50 items
      if (hashed >= 50 && hashed - this.lastScanHashedTrigger >= 50) {
        this.lastScanHashedTrigger = hashed
        this.triggerPreparation()
      }
      return
    }

    if (progress.status === 'completed') {
      this.lastScanHashedTrigger = 0
      if (hashed >= 50 || this.scanSettleDelayMs === 0) {
        this.triggerPreparation()
      } else {
        if (this.settleTimer) clearTimeout(this.settleTimer)
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null
          this.triggerPreparation()
        }, this.scanSettleDelayMs)
        this.settleTimer.unref?.()
      }
    }
  }

  public onVaultImportProgress(progress: { readonly status: string }): void {
    if (this.isShutdown || this.catalog.isClosed()) return
    if (progress.status === 'completed') {
      this.triggerPreparation()
    }
  }

  public async waitForCompletion(): Promise<ThumbnailPrepProgress> {
    while (this.loopPromise) {
      await this.loopPromise
    }
    return this.getProgress()
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.rerunRequested = false
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }
  }

  private emitProgress(force = false): void {
    if (this.catalog.isClosed()) return
    const now = Date.now()
    if (!force && now - this.lastEmitMs < PROGRESS_THROTTLE_MS) {
      return
    }
    this.lastEmitMs = now
    const snapshot = this.getProgress()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore listener errors
      }
    }
  }

  private async reconcileExistingStates(): Promise<void> {
    const cache = this.thumbnailCoordinator.getCache()

    // 1. Re-queue any 'ready' rows whose disk cache file was evicted or removed
    let afterId = 0
    while (!this.isShutdown && !this.catalog.isClosed()) {
      const rows = this.catalog.getReadyThumbnailStateRowsBatch({
        recipeVersion: this.recipeVersion,
        limit: 500,
        afterLocationId: afterId
      })
      if (rows.length === 0) break
      const missingIds: number[] = []
      for (const row of rows) {
        afterId = row.fileLocationId
        if (!row.cacheKey || !cache.has(row.cacheKey)) {
          missingIds.push(row.fileLocationId)
        }
      }
      if (missingIds.length > 0) {
        this.catalog.deletePhotoThumbnailStatesByIds(missingIds)
      }
      await yieldToEventLoop()
    }

    // 2. If an unplugged source root has come back online, allow re-checking its ROOT_UNAVAILABLE photos
    if (!this.isShutdown && !this.catalog.isClosed()) {
      const unavailableRoots = this.catalog.getUnavailableThumbnailSourceRoots(this.recipeVersion)
      for (const rootPath of unavailableRoots) {
        if (this.isShutdown || this.catalog.isClosed()) break
        if (existsSync(rootPath)) {
          this.catalog.resetUnavailableThumbnailStatesForRoot(rootPath, this.recipeVersion)
        }
      }
    }
  }

  private async runLoop(): Promise<ThumbnailPrepProgress> {
    try {
      await this.reconcileExistingStates()
      this.emitProgress(true)

      let afterId = 0
      while (!this.isShutdown && !this.catalog.isClosed()) {
        const batch = this.catalog.getNextPendingThumbnailPrepBatch({
          recipeVersion: this.recipeVersion,
          limit: this.batchSize,
          afterLocationId: afterId
        })
        if (batch.length === 0) {
          break
        }

        for (let i = 0; i < batch.length; i += this.maxConcurrency) {
          if (this.isShutdown || this.catalog.isClosed()) break

          while (
            !this.isShutdown &&
            !this.catalog.isClosed() &&
            (this.thumbnailCoordinator.hasInteractiveWorkPending() ||
              Boolean(this.shouldYieldToInteractiveSearch?.()) ||
              this.thumbnailCoordinator.getQueuedJobCount() >= 16)
          ) {
            await sleep(25)
          }

          if (this.isShutdown || this.catalog.isClosed()) break

          const slice = batch.slice(i, i + this.maxConcurrency)
          for (const candidate of slice) {
            afterId = Math.max(afterId, candidate.fileLocationId)
          }
          await Promise.all(slice.map((candidate) => this.processCandidate(candidate)))
          this.emitProgress(false)
        }

        await yieldToEventLoop()
      }
    } catch (err) {
      this.log?.(
        `Background thumbnail preparation paused on error: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return this.getProgress()
  }

  private async processCandidate(candidate: PhotoThumbnailPrepCandidate): Promise<void> {
    if (this.isShutdown || this.catalog.isClosed()) return

    const resolved = resolveReadableFileLocation(this.catalog, candidate.fileLocationId, {
      verifyPayloadHash: false,
      allowVaultCopyFallbackForUnavailableSource: true
    })

    if (!resolved.ok) {
      if (resolved.errorCode === 'VAULT_UNAVAILABLE') {
        return
      }
      const rootOffline = candidate.sourceKind === 'user' && !existsSync(candidate.sourceRootPath)
      this.catalog.upsertPhotoThumbnailState({
        fileLocationId: candidate.fileLocationId,
        discoveryObservationId: candidate.discoveryObservationId,
        contentSha256: candidate.activeHash,
        observedByteSize: candidate.byteSize,
        observedMtimeMs: candidate.filesystemMtimeMs,
        recipeVersion: this.recipeVersion,
        cacheKey: null,
        status: 'unavailable',
        errorCode: rootOffline ? 'ROOT_UNAVAILABLE' : resolved.errorCode,
        errorMessage: resolved.errorMessage
      })
      return
    }

    const res = await this.thumbnailCoordinator.prepareThumbnailIfNeeded({
      locationId: candidate.fileLocationId,
      sourcePath: resolved.filePath,
      expectedByteSize: resolved.expectedByteSize,
      expectedMtimeMs: resolved.expectedMtimeMs,
      expectedSha256: resolved.expectedSha256,
      approvedRootsOverride: resolved.mode === 'vault_copy' ? resolved.approvedRoots : undefined,
      verifySourceBeforeCacheHit: resolved.mode === 'vault_copy'
    })

    if (this.isShutdown || this.catalog.isClosed()) return

    if (res.status === 'deferred') {
      return
    }

    if (res.status === 'ready') {
      this.catalog.upsertPhotoThumbnailState({
        fileLocationId: candidate.fileLocationId,
        discoveryObservationId: candidate.discoveryObservationId,
        contentSha256: candidate.activeHash,
        observedByteSize: candidate.byteSize,
        observedMtimeMs: candidate.filesystemMtimeMs,
        recipeVersion: this.recipeVersion,
        cacheKey: res.cacheKey,
        status: 'ready'
      })
      return
    }

    if (res.status === 'unsupported') {
      this.catalog.upsertPhotoThumbnailState({
        fileLocationId: candidate.fileLocationId,
        discoveryObservationId: candidate.discoveryObservationId,
        contentSha256: candidate.activeHash,
        observedByteSize: candidate.byteSize,
        observedMtimeMs: candidate.filesystemMtimeMs,
        recipeVersion: this.recipeVersion,
        cacheKey: null,
        status: 'unsupported',
        errorCode: 'UNSUPPORTED_FORMAT',
        errorMessage: res.reason
      })
      return
    }

    if (res.status === 'unavailable') {
      const rootOffline = candidate.sourceKind === 'user' && !existsSync(candidate.sourceRootPath)
      this.catalog.upsertPhotoThumbnailState({
        fileLocationId: candidate.fileLocationId,
        discoveryObservationId: candidate.discoveryObservationId,
        contentSha256: candidate.activeHash,
        observedByteSize: candidate.byteSize,
        observedMtimeMs: candidate.filesystemMtimeMs,
        recipeVersion: this.recipeVersion,
        cacheKey: null,
        status: 'unavailable',
        errorCode: rootOffline ? 'ROOT_UNAVAILABLE' : res.code,
        errorMessage: res.message
      })
      return
    }

    this.catalog.upsertPhotoThumbnailState({
      fileLocationId: candidate.fileLocationId,
      discoveryObservationId: candidate.discoveryObservationId,
      contentSha256: candidate.activeHash,
      observedByteSize: candidate.byteSize,
      observedMtimeMs: candidate.filesystemMtimeMs,
      recipeVersion: this.recipeVersion,
      cacheKey: null,
      status: 'failed',
      errorCode: res.code,
      errorMessage: res.message
    })
  }
}
