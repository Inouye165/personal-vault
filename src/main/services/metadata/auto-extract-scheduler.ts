/**
 * Personal Vault — Auto Metadata Extraction Scheduler
 *
 * Automatically starts metadata extraction after catalog scans finish, and queues a
 * follow-up pass whenever another scan completes while an extraction job is already
 * processing a fixed snapshot of files. Respects pause/cancel/shutdown signals so
 * explicit user pauses or cancellations are never overridden.
 */

import type { PhotoMetadataExtractionProgress } from './types'

export interface AutoMetadataScanProgressEvent {
  readonly jobId: number
  readonly status: string
}

export interface AutoMetadataCoordinatorPort {
  getProgress(): PhotoMetadataExtractionProgress
  onProgress(listener: (progress: PhotoMetadataExtractionProgress) => void): () => void
  startExtraction(options?: { retryFailed?: boolean }): Promise<PhotoMetadataExtractionProgress>
  waitForCompletion?(): Promise<PhotoMetadataExtractionProgress>
}

export interface AutoMetadataExtractionSchedulerOptions {
  readonly photoMetadataCoordinator: AutoMetadataCoordinatorPort
  readonly isCatalogClosed: () => boolean
  readonly isDisabled?: () => boolean
  readonly log?: (message: string) => void
}

export class AutoMetadataExtractionScheduler {
  private readonly coordinator: AutoMetadataCoordinatorPort
  private readonly isCatalogClosed: () => boolean
  private readonly isDisabled: () => boolean
  private readonly log?: (message: string) => void

  private readonly scanJobLastStatus = new Map<number, string>()
  private readonly unsubscribeMetaProgress: () => void

  private queuedFollowUp = false
  private starting = false
  private flushingFollowUp = false
  private disposed = false

  constructor(options: AutoMetadataExtractionSchedulerOptions) {
    this.coordinator = options.photoMetadataCoordinator
    this.isCatalogClosed = options.isCatalogClosed
    this.isDisabled = options.isDisabled ?? (() => false)
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
        return
      }

      if (metaProgress.status === 'completed' && this.queuedFollowUp && !this.flushingFollowUp) {
        this.queuedFollowUp = false
        this.scheduleFollowUpStart()
      }
    })
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
    const needed = metaProgress.coverage.unprocessedCount + metaProgress.coverage.staleCount

    if (metaProgress.status === 'running' || this.starting || this.flushingFollowUp) {
      this.queuedFollowUp = true
      this.log?.(
        `Queued follow-up metadata extraction pass after overlapping scan job #${scanProgress.jobId} (${needed} photos currently pending/stale)`
      )
      return
    }

    if (metaProgress.status === 'paused') {
      return
    }

    if (needed > 0) {
      this.startExtractionSafely(
        `Auto-starting metadata extraction after scan job #${scanProgress.jobId} (${needed} photos pending)`
      )
    }
  }

  public dispose(): void {
    this.disposed = true
    this.queuedFollowUp = false
    this.unsubscribeMetaProgress()
  }

  private scheduleFollowUpStart(): void {
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
        const needed = metaProgress.coverage.unprocessedCount + metaProgress.coverage.staleCount
        if (metaProgress.status === 'running' || this.starting) {
          if (needed > 0) {
            this.queuedFollowUp = true
          }
          return
        }
        if (metaProgress.status === 'paused') {
          return
        }
        if (needed > 0) {
          await this.startExtractionSafelyAsync(
            `Auto-starting queued follow-up metadata extraction (${needed} photos pending)`
          )
        }
      })
      .finally(() => {
        this.flushingFollowUp = false
      })
  }

  private startExtractionSafely(reason: string): void {
    void this.startExtractionSafelyAsync(reason)
  }

  private async startExtractionSafelyAsync(reason: string): Promise<void> {
    if (this.disposed || this.isDisabled() || this.isCatalogClosed() || this.starting) {
      return
    }
    this.starting = true
    try {
      this.log?.(reason)
      await this.coordinator.startExtraction()
    } catch (err) {
      this.log?.(
        `Auto metadata extraction failed to start: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.starting = false
      // If a scan completed during the async start window and queued a follow-up while starting,
      // and extraction already returned completed (e.g., 0 items), flush now.
      if (this.queuedFollowUp && !this.flushingFollowUp && !this.disposed) {
        const metaProgress = this.coordinator.getProgress()
        if (metaProgress.status !== 'running' && metaProgress.status !== 'paused') {
          this.queuedFollowUp = false
          this.scheduleFollowUpStart()
        }
      }
    }
  }
}

export interface ScanProgressSource {
  onProgress(listener: (progress: AutoMetadataScanProgressEvent) => void): () => void
}

export function attachAutoMetadataExtractionScheduler(options: {
  readonly scanCoordinator: ScanProgressSource
  readonly photoMetadataCoordinator: AutoMetadataCoordinatorPort
  readonly isCatalogClosed: () => boolean
  readonly isDisabled?: () => boolean
  readonly log?: (message: string) => void
}): { scheduler: AutoMetadataExtractionScheduler; dispose: () => void } {
  const scheduler = new AutoMetadataExtractionScheduler({
    photoMetadataCoordinator: options.photoMetadataCoordinator,
    isCatalogClosed: options.isCatalogClosed,
    isDisabled: options.isDisabled,
    log: options.log
  })
  const unsubscribeScan = options.scanCoordinator.onProgress((progress) => {
    scheduler.onScanProgress(progress)
  })
  return {
    scheduler,
    dispose: () => {
      unsubscribeScan()
      scheduler.dispose()
    }
  }
}
