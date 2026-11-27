import type { CatalogDatabase, ScanJobPhase, ScanJobStatus } from '../catalog'
import type { ReadOnlyFsAdapter } from '../discovery/fs-adapter'
import type { ReadOnlyHashingFsAdapter } from '../hashing/fs-adapter'

export interface ScanJobStructuredError {
  readonly path: string
  readonly code: string
  readonly message: string
  readonly phase: 'discovery' | 'hashing'
}

export interface ScanJobProgress {
  readonly jobId: number
  readonly status: ScanJobStatus
  readonly phase: ScanJobPhase
  readonly roots: readonly string[]
  readonly discoveredCount: number
  readonly hashedCount: number
  readonly totalFilesToHash: number
  readonly totalBytes: number
  readonly hashedBytes: number
  readonly skippedCount: number
  readonly errorCount: number
  readonly currentPath?: string
  readonly errors: readonly ScanJobStructuredError[]
  readonly errorMessage?: string
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly completedAtMs: number | null
}

export interface StartScanOptions {
  readonly roots: readonly string[]
}

export interface ScanJobCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly discoveryFsAdapter?: ReadOnlyFsAdapter
  readonly hashingFsAdapter?: ReadOnlyHashingFsAdapter
  readonly batchSize?: number
}

export type ScanJobProgressCallback = (progress: ScanJobProgress) => void
