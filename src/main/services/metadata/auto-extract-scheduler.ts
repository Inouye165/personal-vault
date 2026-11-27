/**
 * Personal Vault — Auto Metadata Extraction Scheduler
 *
 * Automatically starts metadata extraction after catalog scans finish, catches up
 * on startup or catalog upgrade when unextracted/stale records exist, and queues
 * follow-up passes whenever another scan or import completes while a job is already
 * processing a fixed snapshot of files. Respects explicit user pause, cancellation,
 * and shutdown signals.
 */

import type { PhotoMetadataExtractionProgress } from './types'

export interface AutoMetadataScanProgressEvent {
  readonly jobId: number
  readonly status: string
}

export interface AutoMetadataImportProgressEvent {
  readonly status: string
}

export interface AutoMetadataCoordinatorPort {
  getProgress(): PhotoMetadataExtractionProgress
  onProgress(listener: (progress: PhotoMetadataExtractionProgress) => void): () => void
  startExtraction(options?: {
    retryFailed?: boolean
    retryUnavailable?: boolean
  }): Promise<PhotoMetadataExtractionProgress>
  resumeExtraction?(): Promise<PhotoMetadataExtractionProgress>
  waitForCompletion?(): Promise<PhotoMetadataExtractionProgress>
}

export interface AutoMetadataExtractionSchedulerOptions {
  readonly photoMetadataCoordinator: AutoMetadataCoordinatorPort
  readonly isCatalogClosed: () => boolean
  readonly isDisabled?: () => boolean
  readonly startupDelayMs?: number
  readonly log?: (message: string) => void
}

const DEFAULT_STARTUP_DELAY_MS = 2_500

export class AutoMetadataExtractionScheduler {
  private readonly coordinator: AutoMetadataCoordinatorPort
  private readonly isCatalogClosed: () => boolean
  private readonly isDisabled: () => boolean
  private readonly startupDelayMs: number
  private readonly log?: (message: string) => void

  private readonly scanJobLastStatus = new Map<number, string>()
  private readonly unsubscribeMetaProgress: () => void

  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private queuedFollowUp = false
  private queuedFollowUpRetryUnavailable = false
  private starting = false
  private flushingFollowUp = false
  private disposed = false

  constructor(options: AutoMetadataExtractionSchedulerOptions) {
    this.coordinator = options.photoMetadataCoordinator
    this.isCatalogClosed = options.isCatalogClosed
    this.isDisabled = options.isDisabled ?? (() => false)
    this.startupDelayMs = Math.max(0, options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS)
    this.log = options.log

    this.unsubscribeMetaProgress = this.coordinator.onProgress((metaProgress) => {
      if (this.disposed) {
        return
      }

      if (
        metaProgress.status === 'paused' ||
        metaProgress.status === 'cancelled' ||
        metaProgress.status === 'interrupted' ||
        metaProgress.status === 'failed'
      ) {
        this.queuedFollowUp = false
        this.queuedFollowUpRetryUnavailable = false
        return
      }

      if (metaProgress.status === 'completed' && this.queuedFollowUp && !this.flushingFollowUp) {
        const retryUnavailable = this.queuedFollowUpRetryUnavailable
        this.queuedFollowUp = false
        this.queuedFollowUpRetryUnavailable = false
        this.scheduleFollowUpStart(retryUnavailable)
      }
    })
  }

  public initialize(): void {
    if (this.disposed || this.isDisabled() || this.isCatalogClosed()) {
      return
    }
    if (this.startupDelayMs === 0) {
      this.runStartupCatchUp()
      return
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.runStartupCatchUp()
    }, this.startupDelayMs)
    this.startupTimer.unref?.()
  }

  public hasQueuedFollowUp(): boolean {
    return this.queuedFollowUp
  }

  public onScanProgress(scanProgress: AutoMetadataScanProgressEvent): void {
    const prev = this.scanJobLastStatus.get(scanProgress.jobId)
    this.scanJobLastStatus.set(scanProgress.jobId, scanProgress.status)

    if (
      this.disposed ||
      this.isDisabled() ||
      prev === 'completed' ||
      scanProgress.status !== 'completed' ||
      this.isCatalogClosed()
    ) {
      return
    }

    const metaProgress = this.coordinator.getProgress()
    const needed =
      metaProgress.coverage.unprocessedCount +
      metaProgress.coverage.staleCount +
      (metaProgress.coverage.unavailableCount ?? 0)

    if (metaProgress.status === 'running' || this.starting || this.flushingFollowUp) {
      this.queuedFollowUp = true
      this.queuedFollowUpRetryUnavailable = true
      this.log?.(
        `Queued follow-up metadata extraction pass after overlapping scan job #${scanProgress.jobId} (${needed} photos pending/stale/unavailable)`
      )
      return
    }

    if (metaProgress.status === 'paused') {
      return
    }

    if (needed > 0) {
      this.startExtractionSafely(
        `Auto-starting metadata extraction after scan job #${scanProgress.jobId} (${needed} photos pending/stale/unavailable)`,
        { retryUnavailable: true }
      )
    }
  }

  public onVaultImportProgress(importProgress: AutoMetadataImportProgressEvent): void {
    if (
      this.disposed ||
      this.isDisabled() ||
      importProgress.status !== 'completed' ||
      this.isCatalogClosed()
    ) {
      return
    }

    const metaProgress = this.coordinator.getProgress()
    const needed = metaProgress.coverage.unprocessedCount + metaProgress.coverage.staleCount
    if (needed <= 0) {
      return
    }
    if (metaProgress.status === 'running' || this.starting || this.flushingFollowUp) {
      this.queuedFollowUp = true
      return
    }
    if (metaProgress.status === 'paused' || metaProgress.status === 'cancelled') {
      return
    }
    this.startExtractionSafely(
      `Auto-starting metadata extraction after vault import (${needed} photos pending)`
    )
  }

  public dispose(): void {
    this.disposed = true
    this.queuedFollowUp = false
    this.queuedFollowUpRetryUnavailable = false
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.unsubscribeMetaProgress()
  }

  private runStartupCatchUp(): void {
    if (this.disposed || this.isDisabled() || this.isCatalogClosed() || this.starting) {
      return
    }

    const metaProgress = this.coordinator.getProgress()
    if (
      metaProgress.status === 'running' ||
      metaProgress.status === 'paused' ||
      metaProgress.status === 'cancelled'
    ) {
      return
    }

    if (metaProgress.status === 'interrupted' && this.coordinator.resumeExtraction) {
      const neededAfterResume =
        metaProgress.coverage.unprocessedCount + metaProgress.coverage.staleCount
      if (neededAfterResume > 0) {
        this.queuedFollowUp = true
      }
      this.resumeExtractionSafely('Resuming interrupted metadata extraction on startup')
      return
    }

    const needed = metaProgress.coverage.unprocessedCount + metaProgress.coverage.staleCount
    if (needed > 0) {
      this.startExtractionSafely(
        `Catching up photo metadata extraction on startup (${needed} photos unprocessed/stale)`
      )
    }
  }

  private scheduleFollowUpStart(retryUnavailable = false): void {
    this.flushingFollowUp = true
    void Promise.resolve()
      .then(async () => {
        if (this.coordinator.waitForCompletion) {
          try {
            await this.coordinator.waitForCompletion()
          } catch {
            // ignore errors from preceding job
          }
        }
        if (this.disposed || this.isDisabled() || this.isCatalogClosed()) {
          return
        }
        const metaProgress = this.coordinator.getProgress()
        const needed =
          metaProgress.coverage.unprocessedCount +
          metaProgress.coverage.staleCount +
          (retryUnavailable ? (metaProgress.coverage.unavailableCount ?? 0) : 0)
        if (metaProgress.status === 'running' || this.starting) {
          if (needed > 0) {
            this.queuedFollowUp = true
            if (retryUnavailable) this.queuedFollowUpRetryUnavailable = true
          }
          return
        }
        if (metaProgress.status === 'paused') {
          return
        }
        if (needed > 0) {
          await this.startExtractionSafelyAsync(
            `Auto-starting queued follow-up metadata extraction (${needed} photos pending)`,
            { retryUnavailable }
          )
        }
      })
      .finally(() => {
        this.flushingFollowUp = false
      })
  }

  private startExtractionSafely(reason: string, options?: { retryUnavailable?: boolean }): void {
    void this.startExtractionSafelyAsync(reason, options)
  }

  private resumeExtractionSafely(reason: string): void {
    if (
      this.disposed ||
      this.isDisabled() ||
      this.isCatalogClosed() ||
      this.starting ||
      !this.coordinator.resumeExtraction
    ) {
      return
    }
    this.starting = true
    void (async () => {
      try {
        this.log?.(reason)
        await this.coordinator.resumeExtraction!()
      } catch (err) {
        this.log?.(
          `Auto metadata extraction resume failed: ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        this.starting = false
      }
    })()
  }

  private async startExtractionSafelyAsync(
    reason: string,
    options?: { retryUnavailable?: boolean }
  ): Promise<void> {
    if (this.disposed || this.isDisabled() || this.isCatalogClosed() || this.starting) {
      return
    }
    this.starting = true
    try {
      this.log?.(reason)
      await this.coordinator.startExtraction({
        retryUnavailable: Boolean(options?.retryUnavailable)
      })
    } catch (err) {
      this.log?.(
        `Auto metadata extraction failed to start: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.starting = false
      if (this.queuedFollowUp && !this.flushingFollowUp && !this.disposed) {
        const metaProgress = this.coordinator.getProgress()
        if (metaProgress.status !== 'running' && metaProgress.status !== 'paused') {
          const retryUnavailable = this.queuedFollowUpRetryUnavailable
          this.queuedFollowUp = false
          this.queuedFollowUpRetryUnavailable = false
          this.scheduleFollowUpStart(retryUnavailable)
        }
      }
    }
  }
}

export interface ScanProgressSource {
  onProgress(listener: (progress: AutoMetadataScanProgressEvent) => void): () => void
}

export interface VaultImportProgressSource {
  onProgress(listener: (progress: AutoMetadataImportProgressEvent) => void): () => void
}

export function attachAutoMetadataExtractionScheduler(options: {
  readonly scanCoordinator: ScanProgressSource
  readonly vaultImportCoordinator?: VaultImportProgressSource
  readonly photoMetadataCoordinator: AutoMetadataCoordinatorPort
  readonly isCatalogClosed: () => boolean
  readonly isDisabled?: () => boolean
  readonly startupDelayMs?: number
  readonly log?: (message: string) => void
}): { scheduler: AutoMetadataExtractionScheduler; dispose: () => void } {
  const scheduler = new AutoMetadataExtractionScheduler({
    photoMetadataCoordinator: options.photoMetadataCoordinator,
    isCatalogClosed: options.isCatalogClosed,
    isDisabled: options.isDisabled,
    startupDelayMs: options.startupDelayMs,
    log: options.log
  })
  const unsubscribeScan = options.scanCoordinator.onProgress((progress) => {
    scheduler.onScanProgress(progress)
  })
  const unsubscribeImport = options.vaultImportCoordinator?.onProgress((progress) => {
    scheduler.onVaultImportProgress(progress)
  })
  return {
    scheduler,
    dispose: () => {
      unsubscribeScan()
      unsubscribeImport?.()
      scheduler.dispose()
    }
  }
}
