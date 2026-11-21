/**
 * Personal Vault — Vault Import Coordinator (Stage 4)
 *
 * Coordinates verified copying of selected candidate files into vault storage,
 * manages job lifecycle (running, paused, cancelled, interrupted, completed, failed),
 * verifies integrity, generates portable metadata, and commits catalog audit records.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { CatalogDatabase } from '../catalog/database'
import type {
  CatalogVaultImportJobRecord,
  ImportCandidateItem,
  VaultImportItemDetail
} from '../catalog/types'
import type { VaultImportProgress } from '../../../shared/validation/ipc-schemas'
import {
  cleanupOwnedStagingFiles,
  copyAndVerifyFileToVault,
  validateVaultSeparation
} from './copier'
import { loadVaultIdentity } from './identity'

import type { BackupCaptureGuard } from '../backup/capture-guard'

export interface VaultImportCoordinatorOptions {
  readonly catalog: CatalogDatabase
  readonly captureGuard?: BackupCaptureGuard
}

export interface StartImportOptions {
  readonly vaultId: string
  readonly fileLocationIds: readonly number[]
}

export class VaultImportCoordinator {
  private readonly catalog: CatalogDatabase
  private captureGuard?: BackupCaptureGuard
  private readonly events = new EventEmitter()
  private activeJob: CatalogVaultImportJobRecord | null = null
  private abortController: AbortController | null = null
  private isStarting = false
  private isPaused = false
  private isShutdown = false
  private completionPromise: Promise<CatalogVaultImportJobRecord> | null = null

  constructor(options: VaultImportCoordinatorOptions) {
    this.catalog = options.catalog
    this.captureGuard = options.captureGuard
  }

  public setCaptureGuard(guard: BackupCaptureGuard | undefined): void {
    this.captureGuard = guard
  }

  public async initialize(): Promise<void> {
    // 1. Recover any running/paused jobs from prior crash or abrupt termination
    this.catalog.markRunningImportJobsAsInterrupted()

    // 2. Clean up owned temporary staging files in active vault
    const activeVault = this.catalog.getActiveVault()
    if (activeVault) {
      cleanupOwnedStagingFiles(activeVault.vaultPath, activeVault.vaultId)
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

  public async waitForCompletion(): Promise<CatalogVaultImportJobRecord> {
    if (this.completionPromise) {
      return await this.completionPromise
    }
    const job = this.catalog.getLatestVaultImportJob()
    if (!job) throw new Error('No vault import job found')
    return job
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
      if (activeVault.isReadOnly) {
        throw new Error(`Vault "${options.vaultId}" is bound read-only and cannot accept imports`)
      }

      // Validate vault exists and identity is intact
      loadVaultIdentity(activeVault.vaultPath)

      // Validate source separation against all catalog source roots
      const sources = this.catalog.listSources({ limit: 1000 })
      const sourceRoots = sources.items.map((s) => s.rootPath)
      validateVaultSeparation(activeVault.vaultPath, sourceRoots)

      // Query candidate files for the requested locations directly in chunks
      const selectedItems = this.catalog.getImportCandidatesByLocationIds(
        options.vaultId,
        options.fileLocationIds
      )

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

      // Spawn background import pipeline and return the job record promptly
      this.completionPromise = this.runImportPipeline(
        jobRecord,
        activeVault.vaultPath,
        selectedItems
      )

      return jobRecord
    } finally {
      this.isStarting = false
    }
  }

  private async runImportPipeline(
    job: CatalogVaultImportJobRecord,
    vaultPath: string,
    items: readonly (ImportCandidateItem | VaultImportItemDetail)[],
    initialCounts?: {
      copiedFiles: number
      copiedBytes: number
      verifiedFiles: number
      failedFiles: number
    }
  ): Promise<CatalogVaultImportJobRecord> {
    let copiedFiles = initialCounts?.copiedFiles ?? job.copiedFiles ?? 0
    let copiedBytes = initialCounts?.copiedBytes ?? job.copiedBytes ?? 0
    let verifiedFiles = initialCounts?.verifiedFiles ?? job.verifiedFiles ?? 0
    let failedFiles = initialCounts?.failedFiles ?? job.failedFiles ?? 0
    let errorMessage: string | null = null

    try {
      for (const item of items) {
        // Skip items already completed in earlier runs
        if ('status' in item && item.status === 'completed') {
          continue
        }

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
          totalFiles: job.totalFiles,
          totalBytes: job.totalBytes,
          copiedFiles,
          copiedBytes,
          verifiedFiles,
          failedFiles,
          currentFileName: item.fileName
        })

        // Check observation currency for resumed items
        if ('isDiscoveryCurrent' in item && (!item.isDiscoveryCurrent || !item.isHashActive)) {
          failedFiles++
          const reason = !item.isDiscoveryCurrent
            ? 'Source discovery observation is stale or superseded'
            : 'Source hash observation is no longer active'
          this.catalog.updateVaultImportItem({
            jobId: job.id,
            fileLocationId: item.fileLocationId,
            status: 'failed',
            errorCode: 'stale_observation',
            errorMessage: reason,
            completedAtMs: Date.now()
          })
          continue
        }

        this.catalog.updateVaultImportItem({
          jobId: job.id,
          fileLocationId: item.fileLocationId,
          status: 'copying'
        })

        const runImportStep = async () =>
          copyAndVerifyFileToVault({
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
                firstDiscoveredAtMs: item.firstDiscoveredAtMs || Date.now(),
                lastSeenAtMs: item.lastSeenAtMs || Date.now(),
                hashObservationId: item.hashObservationId ?? 0,
                hashVerifiedAtMs: item.hashVerifiedAtMs || Date.now()
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

        const runWithCommit = async () => {
          const result = await runImportStep()
          if (result.status === 'success') {
            // Record managed copy in catalog while holding captureGuard so
            // manifest.json and SQLite vault_copies stay mutually consistent.
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
          }
          return result
        }

        const result = this.captureGuard
          ? await this.captureGuard.runExclusive(runWithCommit)
          : await runWithCommit()

        if (result.status === 'success') {
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
      } else if (copiedFiles + failedFiles === job.totalFiles) {
        // Truthful completion status:
        // If all items failed, status is 'failed'!
        // If some succeeded and some failed, status is 'completed' with failedFiles > 0
        finalStatus = copiedFiles === 0 && failedFiles > 0 ? 'failed' : 'completed'
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
        totalFiles: job.totalFiles,
        totalBytes: job.totalBytes,
        copiedFiles,
        copiedBytes,
        verifiedFiles,
        failedFiles,
        errorMessage: errorMessage ?? undefined
      })

      return this.catalog.getVaultImportJob(job.id)!
    } catch (pipelineErr) {
      const errText = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr)
      try {
        this.catalog.updateVaultImportStatus(job.id, 'failed', errText, Date.now())
      } catch {
        // Ignore DB update error
      }
      throw pipelineErr
    } finally {
      this.activeJob = null
      this.abortController = null
      this.isPaused = false
    }
  }

  public async pauseImport(): Promise<CatalogVaultImportJobRecord | null> {
    if (!this.activeJob) return null
    this.isPaused = true
    if (this.completionPromise) {
      try {
        await this.completionPromise
      } catch {
        // Ignore
      }
    }
    return this.catalog.getActiveVaultImportJob()
  }

  public async cancelImport(jobId?: string): Promise<CatalogVaultImportJobRecord | null> {
    const targetJobId = jobId ?? this.activeJob?.id ?? this.catalog.getActiveVaultImportJob()?.id
    if (!targetJobId) return null

    if (this.activeJob && this.activeJob.id === targetJobId) {
      if (this.abortController) {
        this.abortController.abort()
      }
      if (this.completionPromise) {
        try {
          await this.completionPromise
        } catch {
          // Ignore
        }
      }
      return this.catalog.getVaultImportJob(targetJobId)
    }

    // Job exists in DB but not active in memory (e.g. paused or interrupted job)
    const dbJob = this.catalog.getVaultImportJob(targetJobId)
    if (
      dbJob &&
      (dbJob.status === 'paused' || dbJob.status === 'interrupted' || dbJob.status === 'running')
    ) {
      this.catalog.updateVaultImportStatus(
        targetJobId,
        'cancelled',
        'Import cancelled while paused',
        Date.now()
      )
      const updated = this.catalog.getVaultImportJob(targetJobId)!
      this.emitProgress({
        jobId: updated.id,
        vaultId: updated.vaultId,
        status: 'cancelled',
        phase: 'idle',
        totalFiles: updated.totalFiles,
        totalBytes: updated.totalBytes,
        copiedFiles: updated.copiedFiles,
        copiedBytes: updated.copiedBytes,
        verifiedFiles: updated.verifiedFiles,
        failedFiles: updated.failedFiles,
        errorMessage: 'Import cancelled'
      })
      return updated
    }

    return dbJob
  }

  public async resumeImport(jobId?: string): Promise<CatalogVaultImportJobRecord> {
    if (this.hasActiveJob()) {
      throw new Error('An import job is already actively running or starting')
    }

    this.isStarting = true
    try {
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
      if (activeVault.isReadOnly) {
        throw new Error(`Vault "${job.vaultId}" is bound read-only and cannot resume imports`)
      }

      // Vault integrity and path containment checks on resume as well as initial start
      loadVaultIdentity(activeVault.vaultPath)
      const sources = this.catalog.listSources({ limit: 1000 })
      const sourceRoots = sources.items.map((s) => s.rootPath)
      validateVaultSeparation(activeVault.vaultPath, sourceRoots)

      // Strictly load the original job's authorized items from vault_import_items
      const itemDetails = this.catalog.getVaultImportItems(job.id)
      if (itemDetails.length === 0) {
        throw new Error(`No items found for import job "${job.id}"`)
      }

      this.activeJob = job
      this.abortController = new AbortController()
      this.isPaused = false
      this.catalog.updateVaultImportStatus(job.id, 'running')

      this.completionPromise = this.runImportPipeline(job, activeVault.vaultPath, itemDetails, {
        copiedFiles: job.copiedFiles,
        copiedBytes: job.copiedBytes,
        verifiedFiles: job.verifiedFiles,
        failedFiles: job.failedFiles
      })

      return this.catalog.getVaultImportJob(job.id)!
    } finally {
      this.isStarting = false
    }
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
