import type { CatalogDatabase } from '../catalog/database'
import { resolveReadableFileLocation } from '../backup/recovered-file-resolver'
import { inspectMediaFileByContent } from './inspector'

export interface VideoMediaReconcilerOptions {
  readonly catalog: CatalogDatabase
  readonly startupDelayMs?: number
  readonly batchSize?: number
  readonly onLibraryUpdated?: (reclassifiedCount: number) => void
  readonly log?: (message: string) => void
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Inspects existing cataloged `category = 'photo'` rows whose `media_kind` has
 * not yet been verified by content (for example, `IMG_1450.JPG` scanned before
 * video detection existed) and reclassifies videos in place while preserving
 * `file_locations.id`, ratings, flags, collections, vault copies, and backups.
 */
export class VideoMediaReconciler {
  private readonly catalog: CatalogDatabase
  private readonly startupDelayMs: number
  private readonly batchSize: number
  private readonly onLibraryUpdated?: (reclassifiedCount: number) => void
  private readonly log?: (message: string) => void

  private startupTimer: NodeJS.Timeout | null = null
  private loopPromise: Promise<number> | null = null
  private rerunRequested = false
  private isShutdown = false

  constructor(options: VideoMediaReconcilerOptions) {
    this.catalog = options.catalog
    this.startupDelayMs = Math.max(0, options.startupDelayMs ?? 1500)
    this.batchSize = Math.max(1, Math.min(200, options.batchSize ?? 40))
    this.onLibraryUpdated = options.onLibraryUpdated
    this.log = options.log
  }

  public initialize(): void {
    if (this.isShutdown || this.catalog.isClosed()) return
    if (this.startupDelayMs === 0) {
      this.triggerReconciliation()
      return
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.triggerReconciliation()
    }, this.startupDelayMs)
    this.startupTimer.unref?.()
  }

  public triggerReconciliation(): void {
    if (this.isShutdown || this.catalog.isClosed()) return
    if (this.loopPromise) {
      this.rerunRequested = true
      return
    }
    const run = async (): Promise<number> => {
      try {
        return await this.reconcileNow()
      } finally {
        this.loopPromise = null
        if (this.rerunRequested && !this.isShutdown && !this.catalog.isClosed()) {
          this.rerunRequested = false
          this.triggerReconciliation()
        }
      }
    }
    this.loopPromise = run()
  }

  public async waitForCompletion(): Promise<number> {
    if (this.loopPromise) {
      return await this.loopPromise
    }
    return 0
  }

  public async reconcileNow(): Promise<number> {
    let reclassifiedTotal = 0
    while (!this.isShutdown && !this.catalog.isClosed()) {
      const batch = this.catalog.getUninspectedPhotoLocationsBatch(this.batchSize)
      if (batch.length === 0) break

      let reclassifiedInBatch = 0
      for (const entry of batch) {
        if (this.isShutdown || this.catalog.isClosed()) break
        const now = Date.now()
        const resolved = resolveReadableFileLocation(this.catalog, entry.id, {
          verifyPayloadHash: false,
          allowVaultCopyFallbackForUnavailableSource: true
        })

        if (!resolved.ok) {
          // Leave offline entries uninspected when disconnected, or mark? Mark nothing so when reconnected it can be checked,
          // UNLESS we break loop if same batch repeats! To avoid infinite loops on permanently offline rows, inspect in one pass using a visited set.
          continue
        }

        try {
          const inspected = await inspectMediaFileByContent(resolved.filePath)
          if (inspected.mediaKind === 'video') {
            const changed = this.catalog.reclassifyLocationAsVideoInPlace(entry.id, {
              containerFormat: inspected.video.container,
              videoCodec: inspected.video.videoCodec,
              audioCodec: inspected.video.audioCodec,
              durationMs: inspected.video.durationMs,
              widthPx: inspected.video.widthPx,
              heightPx: inspected.video.heightPx,
              isPlayableStructure: inspected.video.isPlayableStructure,
              structureError: inspected.video.structureError,
              inspectedAtMs: now
            })
            if (changed) {
              reclassifiedInBatch++
              reclassifiedTotal++
            }
          } else {
            this.catalog.markLocationMediaKindInspected(entry.id, 'photo', now)
          }
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code
          if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENXIO') {
            // Source offline; leave uninspected for future reconnection
            break
          }
          // Non-ENOENT error (e.g., unreadable permissions): skip without altering catalog facts
        }
      }

      if (reclassifiedInBatch > 0) {
        this.onLibraryUpdated?.(reclassifiedInBatch)
      }

      // If every item in the batch was skipped (e.g., offline), stop this pass cleanly
      const remaining = this.catalog.getUninspectedPhotoLocationsBatch(this.batchSize)
      if (remaining.length > 0 && remaining.every((r) => batch.some((b) => b.id === r.id))) {
        break
      }

      await yieldToEventLoop()
    }

    if (reclassifiedTotal > 0) {
      this.log?.(`VideoMediaReconciler: reclassified ${reclassifiedTotal} item(s) in place`)
    }
    return reclassifiedTotal
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    this.rerunRequested = false
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.loopPromise) {
      try {
        await this.loopPromise
      } catch {
        // ignore
      }
    }
  }
}
