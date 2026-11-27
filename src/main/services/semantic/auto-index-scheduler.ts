/**
 * Personal Vault — Auto Semantic Index Scheduler
 *
 * Automatically catches up missing visual-search embeddings when the verified local
 * model is ready: on startup/upgrade, after source scans (including unchanged rescans),
 * after vault imports, and when the model finishes provisioning. Respects explicit user
 * pause and cancellation signals and resumes interrupted jobs on restart.
 */

import type { CatalogDatabase } from '../catalog/database'
import type { SemanticIndexProgress, SemanticModelStatus } from './types'

export interface AutoSemanticScanProgressEvent {
  readonly jobId: number
  readonly status: string
}

export interface AutoSemanticImportProgressEvent {
  readonly status: string
}

export interface AutoSemanticIndexCoordinatorPort {
  getStatus(): SemanticIndexProgress
  onProgress(listener: (progress: SemanticIndexProgress) => void): () => void
  startIndexing(): Promise<SemanticIndexProgress>
  resumeIndexing?(): Promise<SemanticIndexProgress>
  waitForCompletion?(): Promise<SemanticIndexProgress>
}

export interface AutoSemanticModelManagerPort {
  getStatus(): SemanticModelStatus
  onStatusChange(listener: (status: SemanticModelStatus) => void): () => void
}

export interface AutoSemanticIndexSchedulerOptions {
  readonly catalog: CatalogDatabase
  readonly semanticIndexCoordinator: AutoSemanticIndexCoordinatorPort
  readonly semanticModelManager: AutoSemanticModelManagerPort
  readonly isCatalogClosed: () => boolean
  readonly isDisabled?: () => boolean
  readonly startupDelayMs?: number
  readonly settleDelayMs?: number
  readonly log?: (message: string) => void
}

const DEFAULT_STARTUP_DELAY_MS = 3_500
const DEFAULT_SETTLE_DELAY_MS = 1_000

export class AutoSemanticIndexScheduler {
  private readonly catalog: CatalogDatabase
  private readonly indexCoordinator: AutoSemanticIndexCoordinatorPort
  private readonly modelManager: AutoSemanticModelManagerPort
  private readonly isCatalogClosed: () => boolean
  private readonly isDisabled: () => boolean
  private readonly startupDelayMs: number
  private readonly settleDelayMs: number
  private readonly log?: (message: string) => void

  private readonly scanJobLastStatus = new Map<number, string>()
  private readonly unsubscribeIndexProgress: () => void
  private readonly unsubscribeModelStatus: () => void

  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private modelReadyTimer: ReturnType<typeof setTimeout> | null = null
  private prevModelState: SemanticModelStatus['state']
  private queuedFollowUp = false
  private queuedIncludePreviousFailures = false
  private starting = false
  private flushingFollowUp = false
  private disposed = false

  constructor(options: AutoSemanticIndexSchedulerOptions) {
    this.catalog = options.catalog
    this.indexCoordinator = options.semanticIndexCoordinator
    this.modelManager = options.semanticModelManager
    this.isCatalogClosed = options.isCatalogClosed
    this.isDisabled = options.isDisabled ?? (() => false)
    this.startupDelayMs = Math.max(0, options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS)
    this.settleDelayMs = Math.max(0, options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS)
    this.log = options.log
    this.prevModelState = this.modelManager.getStatus().state

    this.unsubscribeIndexProgress = this.indexCoordinator.onProgress((prog) => {
      if (this.disposed) return
      if (
        prog.status === 'paused' ||
        prog.status === 'cancelled' ||
        prog.status === 'interrupted' ||
        prog.status === 'failed'
      ) {
        this.queuedFollowUp = false
        this.queuedIncludePreviousFailures = false
        return
      }
      if (prog.status === 'completed' && this.queuedFollowUp && !this.flushingFollowUp) {
        const includePrev = this.queuedIncludePreviousFailures
        this.queuedFollowUp = false
        this.queuedIncludePreviousFailures = false
        this.scheduleFollowUpStart(includePrev)
      }
    })

    this.unsubscribeModelStatus = this.modelManager.onStatusChange((status) => {
      const prev = this.prevModelState
      this.prevModelState = status.state
      if (this.disposed || this.isDisabled() || this.isCatalogClosed()) {
        return
      }
      if (prev !== 'ready' && status.state === 'ready') {
        if (this.modelReadyTimer) clearTimeout(this.modelReadyTimer)
        const trigger = () => {
          this.modelReadyTimer = null
          this.maybeStartIndexing('Auto-starting visual indexing after model became ready', {
            respectExplicitStop: true,
            includePreviousFailures: false
          })
        }
        if (this.settleDelayMs === 0) {
          trigger()
        } else {
          this.modelReadyTimer = setTimeout(trigger, this.settleDelayMs)
          this.modelReadyTimer.unref?.()
        }
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

  public onScanProgress(scanProgress: AutoSemanticScanProgressEvent): void {
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

    if (this.modelManager.getStatus().state !== 'ready') {
      return
    }

    const current = this.indexCoordinator.getStatus()
    if (current.status === 'paused') {
      return
    }

    if (current.status === 'running' || this.starting || this.flushingFollowUp) {
      this.queuedFollowUp = true
      this.queuedIncludePreviousFailures = true
      return
    }

    this.maybeStartIndexing(
      `Auto-starting visual indexing catch-up after scan job #${scanProgress.jobId}`,
      { respectExplicitStop: false, includePreviousFailures: true }
    )
  }

  public onVaultImportProgress(importProgress: AutoSemanticImportProgressEvent): void {
    if (
      this.disposed ||
      this.isDisabled() ||
      importProgress.status !== 'completed' ||
      this.isCatalogClosed()
    ) {
      return
    }
    if (this.modelManager.getStatus().state !== 'ready') {
      return
    }
    const current = this.indexCoordinator.getStatus()
    if (current.status === 'paused' || current.status === 'cancelled') {
      return
    }
    if (current.status === 'running' || this.starting || this.flushingFollowUp) {
      this.queuedFollowUp = true
      return
    }
    this.maybeStartIndexing('Auto-starting visual indexing after vault import', {
      respectExplicitStop: true,
      includePreviousFailures: false
    })
  }

  public dispose(): void {
    this.disposed = true
    this.queuedFollowUp = false
    this.queuedIncludePreviousFailures = false
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.modelReadyTimer) {
      clearTimeout(this.modelReadyTimer)
      this.modelReadyTimer = null
    }
    this.unsubscribeIndexProgress()
    this.unsubscribeModelStatus()
  }

  private runStartupCatchUp(): void {
    if (this.disposed || this.isDisabled() || this.isCatalogClosed() || this.starting) {
      return
    }
    const modelStatus = this.modelManager.getStatus()
    if (modelStatus.state !== 'ready') {
      return
    }

    const current = this.indexCoordinator.getStatus()
    if (
      current.status === 'running' ||
      current.status === 'paused' ||
      current.status === 'cancelled'
    ) {
      return
    }

    if (current.status === 'interrupted' && this.indexCoordinator.resumeIndexing) {
      const matchesRecipe =
        current.modelId === modelStatus.modelId &&
        current.modelCommit === modelStatus.modelCommit &&
        current.preprocessingVersion === modelStatus.preprocessingVersion
      if (matchesRecipe) {
        const pendingAfter = this.getPendingCount(false)
        if (pendingAfter > 0) {
          this.queuedFollowUp = true
        }
        this.resumeSafely('Resuming interrupted visual indexing on startup')
        return
      }
    }

    this.maybeStartIndexing('Catching up missing visual-search entries on startup', {
      respectExplicitStop: true,
      includePreviousFailures: false
    })
  }

  private getPendingCount(includePreviousFailures: boolean): number {
    if (this.catalog.isClosed()) return 0
    const m = this.modelManager.getStatus()
    if (m.state !== 'ready') return 0
    return this.catalog.getSemanticCatchUpPendingCount({
      modelId: m.modelId,
      modelCommit: m.modelCommit,
      modelManifestSha256: m.modelManifestSha256,
      preprocessingVersion: m.preprocessingVersion,
      includePreviousFailures
    })
  }

  private maybeStartIndexing(
    reason: string,
    opts: { respectExplicitStop: boolean; includePreviousFailures: boolean }
  ): void {
    if (this.disposed || this.isDisabled() || this.isCatalogClosed() || this.starting) {
      return
    }
    if (this.modelManager.getStatus().state !== 'ready') {
      return
    }
    const current = this.indexCoordinator.getStatus()
    if (current.status === 'running' || current.status === 'paused') {
      return
    }
    if (opts.respectExplicitStop && current.status === 'cancelled') {
      return
    }
    const needed = this.getPendingCount(opts.includePreviousFailures)
    if (needed <= 0) {
      return
    }
    this.startSafely(`${reason} (${needed} photos pending)`)
  }

  private scheduleFollowUpStart(includePreviousFailures: boolean): void {
    this.flushingFollowUp = true
    void Promise.resolve()
      .then(async () => {
        if (this.indexCoordinator.waitForCompletion) {
          try {
            await this.indexCoordinator.waitForCompletion()
          } catch {
            // ignore
          }
        }
        if (this.disposed || this.isDisabled() || this.isCatalogClosed()) {
          return
        }
        const current = this.indexCoordinator.getStatus()
        if (current.status === 'paused' || current.status === 'cancelled') {
          return
        }
        if (current.status === 'running' || this.starting) {
          if (this.getPendingCount(includePreviousFailures) > 0) {
            this.queuedFollowUp = true
            if (includePreviousFailures) this.queuedIncludePreviousFailures = true
          }
          return
        }
        const needed = this.getPendingCount(includePreviousFailures)
        if (needed > 0) {
          await this.startSafelyAsync(
            `Auto-starting queued visual indexing follow-up (${needed} photos pending)`
          )
        }
      })
      .finally(() => {
        this.flushingFollowUp = false
      })
  }

  private resumeSafely(reason: string): void {
    if (
      this.disposed ||
      this.isDisabled() ||
      this.isCatalogClosed() ||
      this.starting ||
      !this.indexCoordinator.resumeIndexing
    ) {
      return
    }
    this.starting = true
    void (async () => {
      try {
        this.log?.(reason)
        await this.indexCoordinator.resumeIndexing!()
      } catch (err) {
        this.log?.(
          `Auto visual indexing resume failed: ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        this.starting = false
      }
    })()
  }

  private startSafely(reason: string): void {
    void this.startSafelyAsync(reason)
  }

  private async startSafelyAsync(reason: string): Promise<void> {
    if (this.disposed || this.isDisabled() || this.isCatalogClosed() || this.starting) {
      return
    }
    this.starting = true
    try {
      this.log?.(reason)
      await this.indexCoordinator.startIndexing()
    } catch (err) {
      this.log?.(
        `Auto visual indexing failed to start: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.starting = false
      if (this.queuedFollowUp && !this.flushingFollowUp && !this.disposed) {
        const current = this.indexCoordinator.getStatus()
        if (current.status !== 'running' && current.status !== 'paused') {
          const includePrev = this.queuedIncludePreviousFailures
          this.queuedFollowUp = false
          this.queuedIncludePreviousFailures = false
          this.scheduleFollowUpStart(includePrev)
        }
      }
    }
  }
}

export interface SemanticScanProgressSource {
  onProgress(listener: (progress: AutoSemanticScanProgressEvent) => void): () => void
}

export interface SemanticVaultImportProgressSource {
  onProgress(listener: (progress: AutoSemanticImportProgressEvent) => void): () => void
}

export function attachAutoSemanticIndexScheduler(options: {
  readonly catalog: CatalogDatabase
  readonly scanCoordinator: SemanticScanProgressSource
  readonly vaultImportCoordinator?: SemanticVaultImportProgressSource
  readonly semanticIndexCoordinator: AutoSemanticIndexCoordinatorPort
  readonly semanticModelManager: AutoSemanticModelManagerPort
  readonly isCatalogClosed: () => boolean
  readonly isDisabled?: () => boolean
  readonly startupDelayMs?: number
  readonly settleDelayMs?: number
  readonly log?: (message: string) => void
}): { scheduler: AutoSemanticIndexScheduler; dispose: () => void } {
  const scheduler = new AutoSemanticIndexScheduler({
    catalog: options.catalog,
    semanticIndexCoordinator: options.semanticIndexCoordinator,
    semanticModelManager: options.semanticModelManager,
    isCatalogClosed: options.isCatalogClosed,
    isDisabled: options.isDisabled,
    startupDelayMs: options.startupDelayMs,
    settleDelayMs: options.settleDelayMs,
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
