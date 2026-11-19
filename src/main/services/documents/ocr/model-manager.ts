/**
 * Personal Vault — Stage 7C Offline English OCR Model Manager
 *
 * Enforces explicit verified local directory import or explicit HTTPS download from
 * allowlisted GitHub raw/CDN hosts, with ZERO automatic downloads, safe staging,
 * symlink/junction rejection, exact byte-size + SHA-256 integrity checks, atomic
 * promotion with backup + rollback, active cancellation, and deterministic cleanup.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  APPROVED_OCR_DOWNLOAD_HOSTS,
  OCR_ENGINE_PACKAGE,
  OCR_MODEL_COMMIT,
  OCR_MODEL_ID,
  OCR_MODEL_LANGUAGE,
  OCR_MODEL_REPO,
  REQUIRED_OCR_MODEL_ARTIFACTS,
  computeOcrManifestSha256,
  getPinnedOcrArtifactDownloadUrl
} from './manifest'
import type { OcrModelArtifactSpec, OcrModelProvisionState, OcrModelStatus } from './types'

const INSTALL_DIR_NAME = 'tesseract-ocr--tessdata_fast--eng@65727574'
const INSTALL_RECEIPT_FILE = '.ocr_install_complete.json'
const STAGING_PREFIX = '.ocr_model_staging_'
const BACKUP_PREFIX = '.ocr_model_backup_'
const MAX_REDIRECTS = 5

export interface OcrDirectoryVerificationResult {
  readonly ok: boolean
  readonly code?: 'OCR_MODEL_MISSING' | 'OCR_MODEL_INVALID'
  readonly error?: string
}

export type OffMainOcrDirectoryVerifier = (
  directoryPath: string,
  specs: readonly OcrModelArtifactSpec[]
) => Promise<OcrDirectoryVerificationResult>

export interface OcrModelManagerOptions {
  readonly modelsRootDir: string
  readonly getApprovedRoots: () => string[]
  readonly getVaultRoot: () => string | null
  readonly artifacts?: readonly OcrModelArtifactSpec[]
  readonly baseDownloadUrl?: string
  readonly allowedHosts?: readonly string[]
  readonly allowLoopbackHttpForTests?: boolean
  readonly verifyDirectoryOffMain?: OffMainOcrDirectoryVerifier
  readonly renameImpl?: (oldPath: string, newPath: string) => void
}

function normalizePathForComparison(p: string): string {
  const resolved = resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function resolveCanonicalOrPlannedPath(targetPath: string): string {
  const abs = resolve(targetPath)
  const segments: string[] = []
  let current = abs

  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    segments.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''))
    current = parent
  }

  let base = current
  if (existsSync(current)) {
    base = realpathSync(current)
  }
  return segments.length > 0 ? join(base, ...segments) : base
}

function pathsOverlap(pathA: string, pathB: string): boolean {
  const normA = normalizePathForComparison(resolveCanonicalOrPlannedPath(pathA))
  const normB = normalizePathForComparison(resolveCanonicalOrPlannedPath(pathB))
  if (normA === normB) return true

  const relAB = relative(normA, normB)
  if (relAB && !relAB.startsWith('..') && !isAbsolute(relAB)) return true

  const relBA = relative(normB, normA)
  if (relBA && !relBA.startsWith('..') && !isAbsolute(relBA)) return true

  return false
}

function validateRelativeArtifactPath(relPath: string): string[] {
  if (!relPath || isAbsolute(relPath) || relPath.includes('\\')) {
    throw new Error(`Unsafe OCR artifact relative path: ${relPath}`)
  }
  const parts = relPath.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`Unsafe traversal segment in OCR artifact path: ${relPath}`)
    }
  }
  return parts
}

function assertNoSymlinkChain(rootDir: string, targetPath: string): void {
  const rootStat = lstatSync(rootDir)
  if (rootStat.isSymbolicLink()) {
    throw new Error('Symlink or junction detected at OCR model root directory')
  }
  const canonicalRoot = realpathSync(rootDir)
  const rel = relative(rootDir, targetPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Target path escapes OCR model root directory')
  }

  const segments = rel.split(/[\\/]+/).filter(Boolean)
  let cur = rootDir
  for (const seg of segments) {
    cur = join(cur, seg)
    const st = lstatSync(cur)
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink or junction rejected: ${cur}`)
    }
  }

  const canonicalTarget = realpathSync(targetPath)
  const canonicalRel = relative(
    normalizePathForComparison(canonicalRoot),
    normalizePathForComparison(canonicalTarget)
  )
  if (!canonicalRel || canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
    throw new Error('Canonical path escapes OCR model root directory via reparse point')
  }
}

export async function verifyOcrModelDirectory(
  directoryPath: string,
  specs: readonly OcrModelArtifactSpec[] = REQUIRED_OCR_MODEL_ARTIFACTS
): Promise<OcrDirectoryVerificationResult> {
  try {
    if (!existsSync(directoryPath)) {
      return {
        ok: false,
        code: 'OCR_MODEL_MISSING',
        error: 'OCR model directory does not exist'
      }
    }
    const rootStat = lstatSync(directoryPath)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return {
        ok: false,
        code: 'OCR_MODEL_INVALID',
        error: 'OCR model directory is not a canonical directory'
      }
    }

    for (const spec of specs) {
      const parts = validateRelativeArtifactPath(spec.relativePath)
      const filePath = join(directoryPath, ...parts)
      if (!existsSync(filePath)) {
        return {
          ok: false,
          code: 'OCR_MODEL_MISSING',
          error: `Missing required OCR model artifact: ${spec.relativePath}`
        }
      }
      assertNoSymlinkChain(directoryPath, filePath)
      const st = lstatSync(filePath)
      if (!st.isFile()) {
        return {
          ok: false,
          code: 'OCR_MODEL_INVALID',
          error: `OCR model artifact is not a regular file: ${spec.relativePath}`
        }
      }
      if (st.size !== spec.byteSize) {
        return {
          ok: false,
          code: 'OCR_MODEL_INVALID',
          error: `OCR artifact byte size mismatch for ${spec.relativePath}: expected ${spec.byteSize}, got ${st.size}`
        }
      }

      const handle = await open(filePath, 'r')
      try {
        const handleStat = await handle.stat({ bigint: false })
        if (handleStat.size !== spec.byteSize) {
          return {
            ok: false,
            code: 'OCR_MODEL_INVALID',
            error: `OCR artifact handle size mismatch for ${spec.relativePath}`
          }
        }
        const hash = createHash('sha256')
        const buf = Buffer.allocUnsafe(64 * 1024)
        let totalRead = 0
        while (true) {
          const { bytesRead } = await handle.read(buf, 0, buf.length, totalRead)
          if (bytesRead <= 0) break
          hash.update(buf.subarray(0, bytesRead))
          totalRead += bytesRead
        }
        if (totalRead !== spec.byteSize) {
          return {
            ok: false,
            code: 'OCR_MODEL_INVALID',
            error: `OCR artifact read size mismatch for ${spec.relativePath}`
          }
        }
        const digest = hash.digest('hex')
        if (digest.toLowerCase() !== spec.sha256.toLowerCase()) {
          return {
            ok: false,
            code: 'OCR_MODEL_INVALID',
            error: `OCR artifact SHA-256 digest mismatch for ${spec.relativePath}`
          }
        }
      } finally {
        await handle.close()
      }
    }

    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      code: 'OCR_MODEL_INVALID',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export class OcrModelManager {
  private readonly modelsRootDir: string
  private readonly getApprovedRoots: () => string[]
  private readonly getVaultRoot: () => string | null
  private readonly artifacts: readonly OcrModelArtifactSpec[]
  private readonly manifestSha256: string
  private readonly requiredBytes: number
  private readonly baseDownloadUrl: string
  private readonly allowedHosts: Set<string>
  private readonly allowLoopbackHttpForTests: boolean
  private readonly verifyDirectoryOffMain: OffMainOcrDirectoryVerifier
  private readonly renameImpl: (oldPath: string, newPath: string) => void

  private state: OcrModelProvisionState = 'missing'
  private downloadedBytes = 0
  private currentArtifact: string | null = null
  private verifiedAtMs: number | null = null
  private error: string | null = null
  private lastReplacementError: string | null = null
  private hasVerifiedInstall = false
  private activeAbortController: AbortController | null = null
  private activeStagingDir: string | null = null
  private activeProvisioningPromise: Promise<OcrModelStatus> | null = null
  private readonly listeners = new Set<(status: OcrModelStatus) => void>()

  public constructor(options: OcrModelManagerOptions) {
    this.modelsRootDir = resolve(options.modelsRootDir)
    this.getApprovedRoots = options.getApprovedRoots
    this.getVaultRoot = options.getVaultRoot
    this.artifacts = options.artifacts ?? REQUIRED_OCR_MODEL_ARTIFACTS
    this.manifestSha256 = computeOcrManifestSha256(this.artifacts)
    this.requiredBytes = this.artifacts.reduce((acc, item) => acc + item.byteSize, 0)
    this.baseDownloadUrl =
      options.baseDownloadUrl ??
      `https://raw.githubusercontent.com/${OCR_MODEL_REPO}/${OCR_MODEL_COMMIT}`
    this.allowedHosts = new Set(
      (options.allowedHosts ?? APPROVED_OCR_DOWNLOAD_HOSTS).map((h) => h.toLowerCase())
    )
    this.allowLoopbackHttpForTests = options.allowLoopbackHttpForTests ?? false
    this.verifyDirectoryOffMain = options.verifyDirectoryOffMain ?? verifyOcrModelDirectory
    this.renameImpl = options.renameImpl ?? ((oldPath, newPath) => renameSync(oldPath, newPath))
  }

  public onStatusChange(listener: (status: OcrModelStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitStatus(): void {
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Ignore listener errors
      }
    }
  }

  public getStatus(): OcrModelStatus {
    return {
      state: this.state,
      modelId: OCR_MODEL_ID,
      modelCommit: OCR_MODEL_COMMIT,
      modelManifestSha256: this.manifestSha256,
      language: OCR_MODEL_LANGUAGE,
      enginePackage: OCR_ENGINE_PACKAGE,
      requiredBytes: this.requiredBytes,
      downloadedBytes: this.downloadedBytes,
      currentArtifact: this.currentArtifact,
      verifiedAtMs: this.verifiedAtMs,
      error: this.error,
      lastReplacementError: this.lastReplacementError
    }
  }

  public getActiveModelInstallDir(): string | null {
    if (this.state !== 'ready' || !this.hasVerifiedInstall) {
      return null
    }
    return join(this.modelsRootDir, INSTALL_DIR_NAME)
  }

  public getArtifacts(): readonly OcrModelArtifactSpec[] {
    return this.artifacts
  }

  private validateStorageContainment(): { ok: boolean; error?: string } {
    try {
      const approvedRoots = this.getApprovedRoots()
      for (const sourceRoot of approvedRoots) {
        if (pathsOverlap(this.modelsRootDir, sourceRoot)) {
          return {
            ok: false,
            error: `OCR model storage containment violation: overlaps with approved source root (${sourceRoot})`
          }
        }
      }

      const vaultRoot = this.getVaultRoot()
      if (vaultRoot && pathsOverlap(this.modelsRootDir, vaultRoot)) {
        return {
          ok: false,
          error: `OCR model storage containment violation: overlaps with vault storage (${vaultRoot})`
        }
      }

      if (existsSync(this.modelsRootDir)) {
        const st = lstatSync(this.modelsRootDir)
        if (st.isSymbolicLink()) {
          return {
            ok: false,
            error: 'OCR model storage root cannot be a symlink or junction'
          }
        }
      }

      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private cleanupOwnedTempDirectories(): void {
    if (!existsSync(this.modelsRootDir)) return
    const entries = readdirSync(this.modelsRootDir)
    for (const entry of entries) {
      if (entry.startsWith(STAGING_PREFIX)) {
        rmSync(join(this.modelsRootDir, entry), { recursive: true, force: true })
      }
    }

    const installDir = join(this.modelsRootDir, INSTALL_DIR_NAME)
    for (const entry of entries) {
      if (entry.startsWith(BACKUP_PREFIX)) {
        const backupPath = join(this.modelsRootDir, entry)
        if (!existsSync(installDir)) {
          try {
            renameSync(backupPath, installDir)
          } catch {
            // Ignore
          }
        } else {
          rmSync(backupPath, { recursive: true, force: true })
        }
      }
    }
  }

  public async initialize(): Promise<OcrModelStatus> {
    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      this.state = 'error'
      this.error = containment.error ?? 'OCR model storage containment error'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return this.getStatus()
    }

    this.cleanupOwnedTempDirectories()

    const installDir = join(this.modelsRootDir, INSTALL_DIR_NAME)
    const receiptPath = join(installDir, INSTALL_RECEIPT_FILE)
    if (!existsSync(installDir)) {
      this.state = 'missing'
      this.downloadedBytes = 0
      this.verifiedAtMs = null
      this.error = null
      this.hasVerifiedInstall = false
      this.emitStatus()
      return this.getStatus()
    }

    if (!existsSync(receiptPath)) {
      this.state = 'error'
      this.error = 'Incomplete OCR model installation detected (missing completion receipt)'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return this.getStatus()
    }

    const verification = await this.verifyDirectoryOffMain(installDir, this.artifacts)
    if (!verification.ok) {
      this.state = 'error'
      this.error = verification.error ?? 'Installed OCR model failed integrity check'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return this.getStatus()
    }

    this.state = 'ready'
    this.downloadedBytes = this.requiredBytes
    this.verifiedAtMs = Date.now()
    this.error = null
    this.hasVerifiedInstall = true
    this.emitStatus()
    return this.getStatus()
  }

  public async revalidateForLoading(): Promise<OcrDirectoryVerificationResult> {
    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      this.state = 'error'
      this.error = containment.error ?? 'OCR model containment check failed'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return { ok: false, code: 'OCR_MODEL_INVALID', error: containment.error }
    }

    const installDir = join(this.modelsRootDir, INSTALL_DIR_NAME)
    if (!existsSync(installDir) || !existsSync(join(installDir, INSTALL_RECEIPT_FILE))) {
      this.state = 'missing'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return { ok: false, code: 'OCR_MODEL_MISSING', error: 'English OCR model is not installed' }
    }

    const res = await this.verifyDirectoryOffMain(installDir, this.artifacts)
    if (!res.ok) {
      this.state = 'error'
      this.error = res.error ?? 'English OCR model failed integrity revalidation'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return res
    }

    this.state = 'ready'
    this.verifiedAtMs = Date.now()
    this.hasVerifiedInstall = true
    this.emitStatus()
    return { ok: true }
  }

  private promoteStagedDirectory(stagingDir: string): void {
    const installDir = join(this.modelsRootDir, INSTALL_DIR_NAME)
    const backupDir = join(this.modelsRootDir, `${BACKUP_PREFIX}${randomUUID()}`)

    writeFileSync(
      join(stagingDir, INSTALL_RECEIPT_FILE),
      JSON.stringify(
        {
          modelId: OCR_MODEL_ID,
          modelCommit: OCR_MODEL_COMMIT,
          modelManifestSha256: this.manifestSha256,
          language: OCR_MODEL_LANGUAGE,
          installedAtMs: Date.now()
        },
        null,
        2
      ),
      'utf8'
    )

    let movedExistingToBackup = false
    try {
      if (existsSync(installDir)) {
        this.renameImpl(installDir, backupDir)
        movedExistingToBackup = true
      }
      this.renameImpl(stagingDir, installDir)
      if (movedExistingToBackup && existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true })
      }
    } catch (err) {
      if (movedExistingToBackup && existsSync(backupDir) && !existsSync(installDir)) {
        try {
          renameSync(backupDir, installDir)
        } catch {
          // Ignore secondary rollback failure
        }
      }
      throw err
    }
  }

  private handleFailedProvisioning(reason: string, wasCancelled = false): OcrModelStatus {
    this.currentArtifact = null
    if (this.hasVerifiedInstall && existsSync(join(this.modelsRootDir, INSTALL_DIR_NAME))) {
      this.state = 'ready'
      this.downloadedBytes = this.requiredBytes
      this.lastReplacementError = reason
      this.error = null
    } else if (wasCancelled) {
      this.state = 'cancelled'
      this.error = null
    } else {
      this.state = 'error'
      this.error = reason
    }
    this.emitStatus()
    return this.getStatus()
  }

  public async importFromDirectory(sourceDir: string): Promise<OcrModelStatus> {
    if (this.state === 'installing') {
      return this.getStatus()
    }

    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      return this.handleFailedProvisioning(
        containment.error ?? 'OCR model storage containment check failed'
      )
    }

    const resolvedSource = resolve(sourceDir)
    if (!existsSync(resolvedSource)) {
      return this.handleFailedProvisioning('Selected OCR import directory does not exist')
    }

    try {
      const sourceStat = lstatSync(resolvedSource)
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
        return this.handleFailedProvisioning(
          'Selected OCR import path cannot be a symlink, junction, or non-directory'
        )
      }
      if (pathsOverlap(resolvedSource, this.modelsRootDir)) {
        return this.handleFailedProvisioning(
          'Selected OCR import directory overlaps with managed OCR model storage'
        )
      }
    } catch (err) {
      return this.handleFailedProvisioning(
        err instanceof Error ? err.message : 'Failed to inspect OCR import directory'
      )
    }

    mkdirSync(this.modelsRootDir, { recursive: true })
    const abortController = new AbortController()
    const stagingDir = join(this.modelsRootDir, `${STAGING_PREFIX}${randomUUID()}`)
    this.activeAbortController = abortController
    this.activeStagingDir = stagingDir
    this.state = 'installing'
    this.downloadedBytes = 0
    this.currentArtifact = null
    this.error = null
    this.lastReplacementError = null
    this.emitStatus()

    const run = async (): Promise<OcrModelStatus> => {
      try {
        mkdirSync(stagingDir, { recursive: false })

        for (const spec of this.artifacts) {
          if (abortController.signal.aborted) {
            throw new Error('PROVISIONING_CANCELLED')
          }
          this.currentArtifact = spec.relativePath
          this.emitStatus()

          const parts = validateRelativeArtifactPath(spec.relativePath)
          const srcFile = join(resolvedSource, ...parts)
          if (!existsSync(srcFile)) {
            throw new Error(`Missing required OCR artifact in import folder: ${spec.relativePath}`)
          }

          assertNoSymlinkChain(resolvedSource, srcFile)
          const st = lstatSync(srcFile)
          if (!st.isFile()) {
            throw new Error(`OCR import artifact is not a regular file: ${spec.relativePath}`)
          }
          if (st.size !== spec.byteSize) {
            throw new Error(
              `OCR artifact byte size mismatch for ${spec.relativePath}: expected ${spec.byteSize}, got ${st.size}`
            )
          }

          const dstFile = join(stagingDir, ...parts)
          mkdirSync(dirname(dstFile), { recursive: true })
          copyFileSync(srcFile, dstFile)
          this.downloadedBytes += spec.byteSize
          this.emitStatus()
        }

        if (abortController.signal.aborted) {
          throw new Error('PROVISIONING_CANCELLED')
        }
        const verifyRes = await this.verifyDirectoryOffMain(stagingDir, this.artifacts)
        if (abortController.signal.aborted) {
          throw new Error('PROVISIONING_CANCELLED')
        }
        if (!verifyRes.ok) {
          throw new Error(
            verifyRes.error ?? 'Imported OCR model failed SHA-256 digest verification'
          )
        }

        this.promoteStagedDirectory(stagingDir)
        this.activeAbortController = null
        this.activeStagingDir = null
        this.state = 'ready'
        this.downloadedBytes = this.requiredBytes
        this.currentArtifact = null
        this.verifiedAtMs = Date.now()
        this.error = null
        this.lastReplacementError = null
        this.hasVerifiedInstall = true
        this.emitStatus()
        return this.getStatus()
      } catch (err) {
        await this.safeRemoveDirAsync(stagingDir)
        const wasCancelled =
          abortController.signal.aborted ||
          (err instanceof Error && err.message === 'PROVISIONING_CANCELLED')
        this.activeAbortController = null
        this.activeStagingDir = null
        return this.handleFailedProvisioning(
          err instanceof Error ? err.message : String(err),
          wasCancelled
        )
      }
    }

    const promise = run().finally(() => {
      if (this.activeProvisioningPromise === promise) {
        this.activeProvisioningPromise = null
      }
    })
    this.activeProvisioningPromise = promise
    return promise
  }

  private async safeRemoveDirAsync(targetDir: string): Promise<void> {
    if (!existsSync(targetDir)) return
    try {
      await rm(targetDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // Fallback sync attempt if needed
      try {
        rmSync(targetDir, { recursive: true, force: true })
      } catch {
        // Ignore residual lock; startup/cleanupOwnedTempDirectories sweeps later
      }
    }
  }

  public async downloadModel(): Promise<OcrModelStatus> {
    if (this.state === 'installing') {
      return this.activeProvisioningPromise ?? this.getStatus()
    }

    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      return this.handleFailedProvisioning(
        containment.error ?? 'OCR model storage containment check failed'
      )
    }

    const run = async (): Promise<OcrModelStatus> => {
      mkdirSync(this.modelsRootDir, { recursive: true })
      const stagingDir = join(this.modelsRootDir, `${STAGING_PREFIX}${randomUUID()}`)
      const abortController = new AbortController()
      this.activeAbortController = abortController
      this.activeStagingDir = stagingDir

      this.state = 'installing'
      this.downloadedBytes = 0
      this.currentArtifact = null
      this.error = null
      this.lastReplacementError = null
      this.emitStatus()

      try {
        mkdirSync(stagingDir, { recursive: false })

        let completedBytes = 0
        for (const spec of this.artifacts) {
          if (abortController.signal.aborted) {
            throw new Error('PROVISIONING_CANCELLED')
          }
          this.currentArtifact = spec.relativePath
          this.emitStatus()

          const parts = validateRelativeArtifactPath(spec.relativePath)
          const dstFile = join(stagingDir, ...parts)
          mkdirSync(dirname(dstFile), { recursive: true })

          const downloadUrl = getPinnedOcrArtifactDownloadUrl(
            spec.relativePath,
            this.baseDownloadUrl
          )
          await this.downloadSingleArtifact(
            downloadUrl,
            dstFile,
            spec,
            abortController.signal,
            (artifactBytes) => {
              this.downloadedBytes = completedBytes + artifactBytes
              this.emitStatus()
            }
          )
          completedBytes += spec.byteSize
          this.downloadedBytes = completedBytes
          this.emitStatus()
        }

        const verifyRes = await this.verifyDirectoryOffMain(stagingDir, this.artifacts)
        if (!verifyRes.ok) {
          throw new Error(verifyRes.error ?? 'Downloaded OCR model failed SHA-256 verification')
        }

        this.promoteStagedDirectory(stagingDir)
        this.activeAbortController = null
        this.activeStagingDir = null
        this.state = 'ready'
        this.downloadedBytes = this.requiredBytes
        this.currentArtifact = null
        this.verifiedAtMs = Date.now()
        this.error = null
        this.lastReplacementError = null
        this.hasVerifiedInstall = true
        this.emitStatus()
        return this.getStatus()
      } catch (err) {
        await this.safeRemoveDirAsync(stagingDir)
        const wasCancelled =
          abortController.signal.aborted ||
          (err instanceof Error && err.message === 'PROVISIONING_CANCELLED')
        this.activeAbortController = null
        this.activeStagingDir = null
        return this.handleFailedProvisioning(
          err instanceof Error ? err.message : String(err),
          wasCancelled
        )
      }
    }

    const promise = run().finally(() => {
      if (this.activeProvisioningPromise === promise) {
        this.activeProvisioningPromise = null
      }
    })
    this.activeProvisioningPromise = promise
    return promise
  }

  public async cancelProvisioning(): Promise<OcrModelStatus> {
    if (this.activeAbortController) {
      this.activeAbortController.abort()
    }
    if (this.activeProvisioningPromise) {
      return await this.activeProvisioningPromise
    }
    if (this.activeStagingDir) {
      await this.safeRemoveDirAsync(this.activeStagingDir)
      this.activeStagingDir = null
    }
    return this.handleFailedProvisioning('OCR model installation cancelled by user', true)
  }

  public async shutdown(): Promise<void> {
    if (this.activeAbortController) {
      this.activeAbortController.abort()
    }
    if (this.activeProvisioningPromise) {
      try {
        await this.activeProvisioningPromise
      } catch {
        // Ignore provisioning error during shutdown
      }
    }
    if (this.activeStagingDir) {
      await this.safeRemoveDirAsync(this.activeStagingDir)
      this.activeStagingDir = null
    }
    this.cleanupOwnedTempDirectories()
  }

  public async removeModel(): Promise<OcrModelStatus> {
    if (this.state === 'installing') {
      await this.cancelProvisioning()
    }
    const installDir = join(this.modelsRootDir, INSTALL_DIR_NAME)
    if (existsSync(installDir)) {
      rmSync(installDir, { recursive: true, force: true })
    }
    this.cleanupOwnedTempDirectories()
    this.state = 'missing'
    this.downloadedBytes = 0
    this.currentArtifact = null
    this.verifiedAtMs = null
    this.error = null
    this.lastReplacementError = null
    this.hasVerifiedInstall = false
    this.emitStatus()
    return this.getStatus()
  }

  private validateDownloadUrl(rawUrl: string): URL {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new Error(`Invalid OCR download URL: ${rawUrl}`)
    }

    const hostname = parsed.hostname.toLowerCase()
    const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost'
    if (parsed.protocol !== 'https:') {
      if (!(this.allowLoopbackHttpForTests && parsed.protocol === 'http:' && isLoopback)) {
        throw new Error(`Disallowed download protocol (${parsed.protocol}) for host ${hostname}`)
      }
    }

    if (!this.allowedHosts.has(hostname)) {
      throw new Error(`Disallowed download host or redirect destination: ${hostname}`)
    }

    return parsed
  }

  private downloadSingleArtifact(
    urlStr: string,
    destinationPath: string,
    spec: OcrModelArtifactSpec,
    signal: AbortSignal,
    onProgress: (bytes: number) => void,
    redirectCount = 0
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(new Error('PROVISIONING_CANCELLED'))
        return
      }
      if (redirectCount > MAX_REDIRECTS) {
        rejectPromise(new Error(`Exceeded maximum redirects (${MAX_REDIRECTS})`))
        return
      }

      let parsedUrl: URL
      try {
        parsedUrl = this.validateDownloadUrl(urlStr)
      } catch (err) {
        rejectPromise(err)
        return
      }

      let activeFileStream: ReturnType<typeof createWriteStream> | null = null
      let fileStreamClosedPromise: Promise<void> | null = null
      let settled = false

      const settleRejectAfterStreamClose = (err: Error): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (activeFileStream) {
          activeFileStream.destroy()
        }
        if (fileStreamClosedPromise) {
          const timeoutFallback = new Promise<void>((r) => setTimeout(r, 500))
          void Promise.race([fileStreamClosedPromise, timeoutFallback]).finally(() => {
            rejectPromise(err)
          })
        } else {
          rejectPromise(err)
        }
      }

      const clientGet = parsedUrl.protocol === 'https:' ? httpsGet : httpGet
      const req = clientGet(
        parsedUrl,
        {
          headers: {
            'User-Agent': 'PersonalVault/0.1.0 (Offline-First OCR Model Provisioner)'
          }
        },
        (res) => {
          if (settled || signal.aborted) {
            res.destroy()
            settleRejectAfterStreamClose(new Error('PROVISIONING_CANCELLED'))
            return
          }

          const statusCode = res.statusCode ?? 0

          if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
            res.resume()
            let redirectTarget: string
            try {
              redirectTarget = new URL(res.headers.location, parsedUrl).toString()
              this.validateDownloadUrl(redirectTarget)
            } catch (err) {
              settleRejectAfterStreamClose(err instanceof Error ? err : new Error(String(err)))
              return
            }
            settled = true
            signal.removeEventListener('abort', onAbort)
            this.downloadSingleArtifact(
              redirectTarget,
              destinationPath,
              spec,
              signal,
              onProgress,
              redirectCount + 1
            )
              .then(resolvePromise)
              .catch(rejectPromise)
            return
          }

          if (statusCode !== 200) {
            res.resume()
            settleRejectAfterStreamClose(
              new Error(`HTTP ${statusCode} while downloading OCR artifact ${spec.relativePath}`)
            )
            return
          }

          const contentLengthHeader = res.headers['content-length']
          if (contentLengthHeader !== undefined) {
            const declaredLength = Number(contentLengthHeader)
            if (!Number.isFinite(declaredLength) || declaredLength !== spec.byteSize) {
              res.destroy()
              settleRejectAfterStreamClose(
                new Error(
                  `Content-Length mismatch for ${spec.relativePath}: expected ${spec.byteSize}, got ${contentLengthHeader}`
                )
              )
              return
            }
          }

          const hash = createHash('sha256')
          const fileStream = createWriteStream(destinationPath, { flags: 'wx' })
          activeFileStream = fileStream
          fileStreamClosedPromise = new Promise<void>((resClose) => {
            fileStream.once('close', () => resClose())
            fileStream.once('open', () => {
              if (settled) {
                fileStream.destroy()
              }
            })
          })
          let receivedBytes = 0

          const fail = (err: Error): void => {
            res.destroy()
            settleRejectAfterStreamClose(err)
          }

          res.on('data', (chunk: Buffer) => {
            if (settled) return
            receivedBytes += chunk.byteLength
            if (receivedBytes > spec.byteSize) {
              fail(
                new Error(
                  `Downloaded byte size exceeded pinned length (${spec.byteSize}) for ${spec.relativePath}`
                )
              )
              return
            }
            hash.update(chunk)
            fileStream.write(chunk)
            onProgress(receivedBytes)
          })

          res.on('error', (err) => fail(err))
          fileStream.on('error', (err) => fail(err))

          res.on('end', () => {
            if (settled) return
            fileStream.end(() => {
              if (settled) return
              if (receivedBytes !== spec.byteSize) {
                settleRejectAfterStreamClose(
                  new Error(
                    `Incomplete download size for ${spec.relativePath}: expected ${spec.byteSize}, got ${receivedBytes}`
                  )
                )
                return
              }
              const digest = hash.digest('hex')
              if (digest.toLowerCase() !== spec.sha256.toLowerCase()) {
                settleRejectAfterStreamClose(
                  new Error(
                    `SHA-256 digest mismatch for ${spec.relativePath}: expected ${spec.sha256}, got ${digest}`
                  )
                )
                return
              }
              settled = true
              signal.removeEventListener('abort', onAbort)
              resolvePromise()
            })
          })
        }
      )

      const onAbort = (): void => {
        req.destroy(new Error('PROVISIONING_CANCELLED'))
        settleRejectAfterStreamClose(new Error('PROVISIONING_CANCELLED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })

      req.on('error', (err) => {
        if (signal.aborted) {
          settleRejectAfterStreamClose(new Error('PROVISIONING_CANCELLED'))
        } else {
          settleRejectAfterStreamClose(err)
        }
      })

      req.on('close', () => {
        signal.removeEventListener('abort', onAbort)
      })
    })
  }
}
