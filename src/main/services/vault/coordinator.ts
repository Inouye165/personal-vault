/**
 * Personal Vault — Vault Import Coordinator (Stage 4)
 *
 * Coordinates verified copying of selected candidate files into vault storage,
 * manages job lifecycle (running, paused, cancelled, interrupted, completed),
 * verifies integrity, generates portable metadata, and commits catalog audit records.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { CatalogDatabase } from '../catalog/database'
import type { CatalogVaultImportJobRecord, ImportCandidateItem } from '../catalog/types'
import type { VaultImportProgress } from '../../../shared/validation/ipc-schemas'
import {
  cleanupOwnedStagingFiles,
  copyAndVerifyFileToVault,
  validateVaultSeparation
} from './copier'
import { loadVaultIdentity } from './identity'

export interface VaultImportCoordinatorOptions {
  readonly catalog: CatalogDatabase
}

export interface StartImportOptions {
  readonly vaultId: string
  readonly fileLocationIds: readonly number[]
}

export class VaultImportCoordinator {
  private readonly catalog: CatalogDatabase
  private readonly events = new EventEmitter()
  private activeJob: CatalogVaultImportJobRecord | null = null
  private abortController: AbortController | null = null
  private isStarting = false
  private isPaused = false
  private isShutdown = false
  private completionPromise: Promise<CatalogVaultImportJobRecord> | null = null

  constructor(options: VaultImportCoordinatorOptions) {
    this.catalog = options.catalog
  }

  public async initialize(): Promise<void> {
    // 1. Recover any running/paused jobs from prior crash or abrupt termination
    this.catalog.markRunningImportJobsAsInterrupted()

    // 2. Clean up owned temporary staging files in active vault
    const activeVault = this.catalog.getActiveVault()
    if (activeVault) {
      cleanupOwnedStagingFiles(activeVault.vaultPath)
    }
  }

  public hasActiveJob(): boolean {
    if (this.isStarting || this.activeJob !== null) {
      return true
    }
    const dbActive = this.catalog.getActiveVaultImportJob()
    return dbActive !== null && (dbActive.status === 'running' || dbActive.status === 'paused')
  }

  public getActiveImportJob(): CatalogVaultImportJobRecord | null {
    if (this.activeJob) {
      return this.activeJob
    }
    return this.catalog.getActiveVaultImportJob()
  }

  public getLatestImportJob(): CatalogVaultImportJobRecord | null {
    if (this.activeJob) {
      return this.activeJob
    }
    return this.catalog.getLatestVaultImportJob()
  }

  public onProgress(listener: (progress: VaultImportProgress) => void): () => void {
    this.events.on('progress', listener)
    return () => {
      this.events.off('progress', listener)
    }
  }

  private emitProgress(progress: VaultImportProgress): void {
    this.events.emit('progress', progress)
  }

  public async startImport(options: StartImportOptions): Promise<CatalogVaultImportJobRecord> {
    if (this.hasActiveJob()) {
      throw new Error('An import job is already active or starting')
    }

    this.isStarting = true
    try {
      const activeVault = this.catalog.getActiveVault()
      if (!activeVault || activeVault.vaultId !== options.vaultId) {
        throw new Error(`Vault "${options.vaultId}" is not currently active`)
      }

      // Validate vault exists and identity is intact
      loadVaultIdentity(activeVault.vaultPath)

      // Validate source separation against all catalog source roots
      const sources = this.catalog.listSources({ limit: 1000 })
      const sourceRoots = sources.items.map((s) => s.rootPath)
      validateVaultSeparation(activeVault.vaultPath, sourceRoots)

      // Query candidate files for the requested locations
      const candidates = this.catalog.getImportCandidates({
        vaultId: options.vaultId,
        limit: 1000,
        offset: 0
      })

      const requestedSet = new Set(options.fileLocationIds)
      const selectedItems = candidates.items.filter((item) => requestedSet.has(item.fileLocationId))

      if (selectedItems.length === 0) {
        throw new Error('No valid cataloged files found for the selected IDs')
      }

      const jobId = randomUUID()
      const totalBytes = selectedItems.reduce((acc, item) => acc + item.byteSize, 0)

      const jobRecord = this.catalog.createVaultImportJob({
        jobId,
        vaultId: options.vaultId,
        totalFiles: selectedItems.length,
        totalBytes,
        items: selectedItems.map((item) => ({
          fileLocationId: item.fileLocationId,
          discoveryObservationId: item.discoveryObservationId,
          hashObservationId: item.hashObservationId,
          sha256: item.sha256,
          byteSize: item.byteSize
        }))
      })

      this.activeJob = jobRecord
      this.abortController = new AbortController()
      this.isPaused = false

      this.completionPromise = this.runImportPipeline(
        jobRecord,
        activeVault.vaultPath,
        selectedItems
      )
      return await this.completionPromise
    } finally {
      this.isStarting = false
    }
  }

  private async runImportPipeline(
    job: CatalogVaultImportJobRecord,
    vaultPath: string,
    items: readonly ImportCandidateItem[]
  ): Promise<CatalogVaultImportJobRecord> {
    let copiedFiles = 0
    let copiedBytes = 0
    let verifiedFiles = 0
    let failedFiles = 0
    let errorMessage: string | null = null

    for (const item of items) {
      // Check cooperative pause / cancel / shutdown
      if (this.isShutdown) {
        this.catalog.updateVaultImportStatus(job.id, 'interrupted')
        break
      }

      if (this.abortController?.signal.aborted) {
        this.catalog.updateVaultImportStatus(job.id, 'cancelled')
        break
      }

      if (this.isPaused) {
        this.catalog.updateVaultImportStatus(job.id, 'paused')
        break
      }

      // Yield event loop
      await new Promise((r) => setImmediate(r))

      this.emitProgress({
        jobId: job.id,
        vaultId: job.vaultId,
        status: 'running',
        phase: 'copying',
        totalFiles: items.length,
        totalBytes: job.totalBytes,
        copiedFiles,
        copiedBytes,
        verifiedFiles,
        failedFiles,
        currentFileName: item.fileName
      })

      this.catalog.updateVaultImportItem({
        jobId: job.id,
        fileLocationId: item.fileLocationId,
        status: 'copying'
      })

      const result = await copyAndVerifyFileToVault({
        vaultPath,
        vaultId: job.vaultId,
        importJobId: job.id,
        source: {
          fileLocationId: item.fileLocationId,
          discoveryObservationId: item.discoveryObservationId,
          originalPath: item.originalPath,
          fileName: item.fileName,
          extension: item.extension,
          category: item.category,
          recordedFacts: {
            byteSize: item.byteSize,
            filesystemBirthtimeMs: item.filesystemBirthtimeMs,
            filesystemMtimeMs: item.filesystemMtimeMs,
            firstDiscoveredAtMs: Date.now(),
            lastSeenAtMs: Date.now(),
            hashObservationId: item.hashObservationId,
            hashVerifiedAtMs: Date.now()
          },
          inferredMetadata: {
            inferredCaptureTimeMs: item.inferredCaptureTimeMs
          },
          reviewDecisions: {
            isPreferred: item.isPreferred ?? false,
            duplicateReviewStatus: null
          },
          expectedSha256: item.sha256,
          expectedByteSize: item.byteSize
        },
        signal: this.abortController?.signal
      })

      if (result.status === 'success') {
        // Record managed copy in catalog
        const copy = this.catalog.recordVaultCopy({
          vaultId: job.vaultId,
          sha256: result.sha256,
          byteSize: result.byteSize,
          relativePath: result.relativePath,
          manifestRelativePath: result.manifestRelativePath,
          verifiedAtMs: Date.now()
        })

        this.catalog.updateVaultImportItem({
          jobId: job.id,
          fileLocationId: item.fileLocationId,
          status: 'completed',
          vaultCopyId: copy.id,
          completedAtMs: Date.now()
        })

        copiedFiles++
        copiedBytes += item.byteSize
        verifiedFiles++
      } else if (result.status === 'cancelled') {
        this.catalog.updateVaultImportItem({
          jobId: job.id,
          fileLocationId: item.fileLocationId,
          status: 'cancelled',
          completedAtMs: Date.now()
        })
        break
      } else {
        failedFiles++
        errorMessage = result.message
        this.catalog.updateVaultImportItem({
          jobId: job.id,
          fileLocationId: item.fileLocationId,
          status: 'failed',
          errorCode: result.code,
          errorMessage: result.message,
          completedAtMs: Date.now()
        })
      }

      this.catalog.updateVaultImportProgress({
        jobId: job.id,
        copiedFiles,
        copiedBytes,
        verifiedFiles,
        failedFiles
      })
    }

    const currentDbJob = this.catalog.getVaultImportJob(job.id)!
    let finalStatus = currentDbJob.status
    if (this.isShutdown) {
      finalStatus = 'interrupted'
    } else if (this.abortController?.signal.aborted) {
      finalStatus = 'cancelled'
    } else if (this.isPaused) {
      finalStatus = 'paused'
    } else if (copiedFiles + failedFiles === items.length) {
      finalStatus = 'completed'
    }

    const completedAtMs =
      finalStatus === 'completed' || finalStatus === 'cancelled' || finalStatus === 'failed'
        ? Date.now()
        : null

    this.catalog.updateVaultImportStatus(job.id, finalStatus, errorMessage, completedAtMs)

    this.emitProgress({
      jobId: job.id,
      vaultId: job.vaultId,
      status: finalStatus,
      phase: 'idle',
      totalFiles: items.length,
      totalBytes: job.totalBytes,
      copiedFiles,
      copiedBytes,
      verifiedFiles,
      failedFiles,
      errorMessage: errorMessage ?? undefined
    })

    const finalRecord = this.catalog.getVaultImportJob(job.id)!
    this.activeJob = null
    this.abortController = null
    return finalRecord
  }

  public async pauseImport(): Promise<CatalogVaultImportJobRecord | null> {
    if (!this.activeJob) return null
    this.isPaused = true
    if (this.completionPromise) {
      await this.completionPromise
    }
    return this.catalog.getActiveVaultImportJob()
  }

  public async cancelImport(): Promise<CatalogVaultImportJobRecord | null> {
    if (!this.activeJob && !this.abortController) return null
    if (this.abortController) {
      this.abortController.abort()
    }
    if (this.completionPromise) {
      await this.completionPromise
    }
    return this.catalog.getLatestVaultImportJob()
  }

  public async resumeImport(jobId?: string): Promise<CatalogVaultImportJobRecord> {
    const job = jobId
      ? this.catalog.getVaultImportJob(jobId)
      : this.catalog.getActiveVaultImportJob()
    if (!job) {
      throw new Error('No import job found to resume')
    }
    if (job.status !== 'paused' && job.status !== 'interrupted') {
      throw new Error(`Cannot resume job with status "${job.status}"`)
    }

    const activeVault = this.catalog.getActiveVault()
    if (!activeVault || activeVault.vaultId !== job.vaultId) {
      throw new Error(`Vault "${job.vaultId}" is not currently active`)
    }

    // Load remaining pending/interrupted items
    const allCandidates = this.catalog.getImportCandidates({
      vaultId: job.vaultId,
      limit: 1000,
      offset: 0
    })

    this.activeJob = job
    this.abortController = new AbortController()
    this.isPaused = false
    this.catalog.updateVaultImportStatus(job.id, 'running')

    this.completionPromise = this.runImportPipeline(job, activeVault.vaultPath, allCandidates.items)
    return await this.completionPromise
  }

  public async shutdown(): Promise<void> {
    this.isShutdown = true
    if (this.abortController) {
      this.abortController.abort()
    }
    if (this.completionPromise) {
      try {
        await this.completionPromise
      } catch {
        // Ignore completion error on shutdown
      }
    }
    this.catalog.markRunningImportJobsAsInterrupted()
  }
}
