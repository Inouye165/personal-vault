/**
 * Personal Vault — Bounded Thumbnail & Cache Service Contracts (Stage 5A)
 */

export const THUMBNAIL_LIMITS = {
  MAX_DIMENSION_PX: 512,
  MAX_ACTIVE_JOBS: 2,
  MAX_QUEUED_JOBS: 64,
  MAX_SOURCE_SIZE_BYTES: 128 * 1024 * 1024, // 128 MiB
  MAX_INPUT_PIXELS: 100_000_000, // 100 MP
  MAX_THUMBNAIL_BYTES: 1024 * 1024, // 1 MiB max encoded thumbnail
  JOB_TIMEOUT_MS: 15_000, // 15 seconds
  DISK_CACHE_BUDGET_BYTES: 1024 * 1024 * 1024, // 1 GiB
  RECIPE_VERSION: 'v1_512_webp'
} as const

export interface ThumbnailCacheKeyParams {
  readonly locationId?: number
  readonly sourcePath?: string
  readonly sha256?: string | null
  readonly byteSize: number
  readonly mtimeMs?: number | null
}

export interface ThumbnailDiskCacheOptions {
  readonly cacheDir: string
  readonly maxSizeBytes?: number
  readonly maxThumbnailSizeBytes?: number
  readonly sourceRoots?: readonly string[] | (() => readonly string[])
  readonly vaultPath?: string | (() => string | null)
  readonly validateBuffer?:
    | ((
        buffer: Buffer
      ) =>
        | Promise<{ width: number; height: number } | null>
        | { width: number; height: number }
        | null)
    | false
  readonly renameFile?: (tempPath: string, targetPath: string) => Promise<void>
  readonly maxRetryAttempts?: number
  readonly retryBaseDelayMs?: number
}

export interface ThumbnailDiagnostics {
  readonly activeWorkers: number
  readonly terminatingWorkers?: number
  readonly liveWorkers?: number
  readonly queuedJobs: number
  readonly totalDecodes: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly mainEventLoopDelayP95Ms?: number
  readonly mainEventLoopDelayMaxMs?: number
  readonly mainEventLoopDelayMeanMs?: number
}

export interface ThumbnailCoordinatorOptions {
  readonly cacheDir: string
  readonly approvedRoots?: readonly string[] | (() => readonly string[])
  readonly vaultPath?: string | (() => string | null)
  readonly maxActiveJobs?: number
  readonly maxQueuedJobs?: number
  readonly jobTimeoutMs?: number
  readonly maxSourceSizeBytes?: number
  readonly maxInputPixels?: number
  readonly diskCacheBudget?: number
  readonly workerScriptPath?: string
}

export interface ThumbnailRequestParams {
  readonly locationId: number
  readonly sourcePath: string
  readonly expectedByteSize: number
  readonly expectedMtimeMs: number | null
  readonly expectedSha256: string | null
  readonly priority?: 'high' | 'normal' | 'low'
}

export type FingerprintJobResult =
  | {
      readonly status: 'ready'
      readonly locationId: number
      readonly fingerprint: string
      readonly bucket0: number
      readonly bucket1: number
      readonly bucket2: number
      readonly bucket3: number
      readonly width: number
      readonly height: number
      readonly algorithmVersion: string
      readonly computedSha256: string
    }
  | {
      readonly status: 'unsupported'
      readonly locationId: number
      readonly reason: string
    }
  | {
      readonly status: 'error'
      readonly locationId: number
      readonly code: string
      readonly message: string
    }
