import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  lstatSync,
  realpathSync,
  createWriteStream,
  writeFileSync,
  copyFileSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_REPO,
  SEMANTIC_MODEL_COMMIT,
  SEMANTIC_PREPROCESSING_VERSION,
  SEMANTIC_EMBEDDING_DIMENSIONS,
  REQUIRED_MODEL_ARTIFACTS,
  APPROVED_DOWNLOAD_HOSTS,
  computeManifestSha256,
  getPinnedArtifactDownloadUrl,
  type SemanticModelArtifactSpec
} from './manifest'
import type { SemanticModelStatus, SemanticModelProvisionState } from './types'

const INSTALL_DIR_NAME = 'Xenova--clip-vit-base-patch32@6b7c5237'
const INSTALL_RECEIPT_FILE = '.install_complete.json'
const STAGING_PREFIX = '.model_staging_'
const BACKUP_PREFIX = '.model_backup_'
const MAX_REDIRECTS = 5

export interface DirectoryVerificationResult {
  ok: boolean
  error?: string
}

export type OffMainDirectoryVerifier = (
  directoryPath: string,
  specs: readonly SemanticModelArtifactSpec[]
) => Promise<DirectoryVerificationResult>

export interface SemanticModelManagerOptions {
  modelsRootDir: string
  getApprovedRoots: () => string[]
  getVaultRoot: () => string | null
  artifacts?: readonly SemanticModelArtifactSpec[]
  baseDownloadUrl?: string
  allowedHosts?: readonly string[]
  allowLoopbackHttpForTests?: boolean
  verifyDirectoryOffMain?: OffMainDirectoryVerifier
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
    throw new Error(`Unsafe artifact relative path: ${relPath}`)
  }
  const parts = relPath.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`Unsafe traversal segment in artifact path: ${relPath}`)
    }
  }
  return parts
}

function assertNoSymlinkChain(rootDir: string, targetPath: string): void {
  const rootStat = lstatSync(rootDir)
  if (rootStat.isSymbolicLink()) {
    throw new Error('Symlink or junction detected at root directory')
  }
  const canonicalRoot = realpathSync(rootDir)
  const rel = relative(rootDir, targetPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Target path escapes root directory')
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
    throw new Error('Canonical path escapes root directory via reparse point')
  }
}

async function defaultVerifyDirectory(
  directoryPath: string,
  specs: readonly SemanticModelArtifactSpec[]
): Promise<DirectoryVerificationResult> {
  try {
    if (!existsSync(directoryPath)) {
      return { ok: false, error: 'Model directory does not exist' }
    }
    const rootStat = lstatSync(directoryPath)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, error: 'Model directory is not a canonical directory' }
    }

    for (const spec of specs) {
      const parts = validateRelativeArtifactPath(spec.relativePath)
      const filePath = join(directoryPath, ...parts)
      if (!existsSync(filePath)) {
        return { ok: false, error: `Missing required model artifact: ${spec.relativePath}` }
      }
      assertNoSymlinkChain(directoryPath, filePath)
      const st = lstatSync(filePath)
      if (!st.isFile()) {
        return { ok: false, error: `Artifact is not a regular file: ${spec.relativePath}` }
      }
      if (st.size !== spec.byteSize) {
        return {
          ok: false,
          error: `Artifact byte size mismatch for ${spec.relativePath}: expected ${spec.byteSize}, got ${st.size}`
        }
      }

      const handle = await open(filePath, 'r')
      try {
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
            error: `Artifact read size mismatch for ${spec.relativePath}`
          }
        }
        const digest = hash.digest('hex')
        if (digest.toLowerCase() !== spec.sha256.toLowerCase()) {
          return {
            ok: false,
            error: `Artifact SHA-256 digest mismatch for ${spec.relativePath}`
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
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export class SemanticModelManager {
  private readonly modelsRootDir: string
  private readonly getApprovedRoots: () => string[]
  private readonly getVaultRoot: () => string | null
  private readonly artifacts: readonly SemanticModelArtifactSpec[]
  private readonly manifestSha256: string
  private readonly requiredBytes: number
  private readonly baseDownloadUrl: string
  private readonly allowedHosts: Set<string>
  private readonly allowLoopbackHttpForTests: boolean
  private readonly verifyDirectoryOffMain: OffMainDirectoryVerifier

  private state: SemanticModelProvisionState = 'missing'
  private downloadedBytes = 0
  private currentArtifact: string | null = null
  private verifiedAtMs: number | null = null
  private error: string | null = null
  private lastReplacementError: string | null = null
  private hasVerifiedInstall = false
  private activeAbortController: AbortController | null = null
  private activeStagingDir: string | null = null
  private listeners = new Set<(status: SemanticModelStatus) => void>()

  constructor(options: SemanticModelManagerOptions) {
    this.modelsRootDir = resolve(options.modelsRootDir)
    this.getApprovedRoots = options.getApprovedRoots
    this.getVaultRoot = options.getVaultRoot
    this.artifacts = options.artifacts ?? REQUIRED_MODEL_ARTIFACTS
    this.manifestSha256 = computeManifestSha256(this.artifacts)
    this.requiredBytes = this.artifacts.reduce((acc, a) => acc + a.byteSize, 0)
    this.baseDownloadUrl =
      options.baseDownloadUrl ??
      `https://huggingface.co/${SEMANTIC_MODEL_REPO}/resolve/${SEMANTIC_MODEL_COMMIT}`
    this.allowedHosts = new Set(
      (options.allowedHosts ?? APPROVED_DOWNLOAD_HOSTS).map((h) => h.toLowerCase())
    )
    this.allowLoopbackHttpForTests = options.allowLoopbackHttpForTests ?? false
    this.verifyDirectoryOffMain = options.verifyDirectoryOffMain ?? defaultVerifyDirectory
  }

  public onStatusChange(listener: (status: SemanticModelStatus) => void): () => void {
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
        // ignore listener errors
      }
    }
  }

  public getStatus(): SemanticModelStatus {
    return {
      state: this.state,
      modelId: SEMANTIC_MODEL_ID,
      modelCommit: SEMANTIC_MODEL_COMMIT,
      modelManifestSha256: this.manifestSha256,
      preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION,
      dimensions: SEMANTIC_EMBEDDING_DIMENSIONS,
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

  private validateStorageContainment(): { ok: boolean; error?: string } {
    try {
      const approvedRoots = this.getApprovedRoots()
      for (const sourceRoot of approvedRoots) {
        if (pathsOverlap(this.modelsRootDir, sourceRoot)) {
          return {
            ok: false,
            error: `Model storage containment violation: overlaps with approved source root (${sourceRoot})`
          }
        }
      }

      const vaultRoot = this.getVaultRoot()
      if (vaultRoot && pathsOverlap(this.modelsRootDir, vaultRoot)) {
        return {
          ok: false,
          error: `Model storage containment violation: overlaps with vault storage (${vaultRoot})`
        }
      }

      if (existsSync(this.modelsRootDir)) {
        const st = lstatSync(this.modelsRootDir)
        if (st.isSymbolicLink()) {
          return {
            ok: false,
            error: 'Model storage root cannot be a symlink or junction'
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

    // If an interrupted backup exists and no active install dir exists, restore it
    const installDir = join(this.modelsRootDir, INSTALL_DIR_NAME)
    for (const entry of entries) {
      if (entry.startsWith(BACKUP_PREFIX)) {
        const backupPath = join(this.modelsRootDir, entry)
        if (!existsSync(installDir)) {
          try {
            renameSync(backupPath, installDir)
          } catch {
            // ignore
          }
        } else {
          rmSync(backupPath, { recursive: true, force: true })
        }
      }
    }
  }

  public async initialize(): Promise<SemanticModelStatus> {
    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      this.state = 'error'
      this.error = containment.error ?? 'Storage containment error'
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
      this.error = 'Incomplete model installation detected (missing completion receipt)'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return this.getStatus()
    }

    const verification = await this.verifyDirectoryOffMain(installDir, this.artifacts)
    if (!verification.ok) {
      this.state = 'error'
      this.error = verification.error ?? 'Installed model failed integrity check'
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

  public async revalidateForLoading(): Promise<DirectoryVerificationResult> {
    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      this.state = 'error'
      this.error = containment.error ?? 'Model containment check failed'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return containment
    }

    const installDir = join(this.modelsRootDir, INSTALL_DIR_NAME)
    if (!existsSync(installDir) || !existsSync(join(installDir, INSTALL_RECEIPT_FILE))) {
      this.state = 'missing'
      this.hasVerifiedInstall = false
      this.emitStatus()
      return { ok: false, error: 'Semantic model is not installed' }
    }

    const res = await this.verifyDirectoryOffMain(installDir, this.artifacts)
    if (!res.ok) {
      this.state = 'error'
      this.error = res.error ?? 'Semantic model failed integrity revalidation'
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

    // Write installation receipt inside staging before atomic promotion
    writeFileSync(
      join(stagingDir, INSTALL_RECEIPT_FILE),
      JSON.stringify(
        {
          modelId: SEMANTIC_MODEL_ID,
          modelCommit: SEMANTIC_MODEL_COMMIT,
          modelManifestSha256: this.manifestSha256,
          preprocessingVersion: SEMANTIC_PREPROCESSING_VERSION,
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
        renameSync(installDir, backupDir)
        movedExistingToBackup = true
      }
      renameSync(stagingDir, installDir)
      if (movedExistingToBackup && existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true })
      }
    } catch (err) {
      if (movedExistingToBackup && existsSync(backupDir) && !existsSync(installDir)) {
        try {
          renameSync(backupDir, installDir)
        } catch {
          // ignore
        }
      }
      throw err
    }
  }

  private handleFailedProvisioning(reason: string, wasCancelled = false): SemanticModelStatus {
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

  public async importFromDirectory(sourceDir: string): Promise<SemanticModelStatus> {
    if (this.state === 'installing') {
      return this.getStatus()
    }

    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      return this.handleFailedProvisioning(
        containment.error ?? 'Model storage containment check failed'
      )
    }

    const resolvedSource = resolve(sourceDir)
    if (!existsSync(resolvedSource)) {
      return this.handleFailedProvisioning('Selected import directory does not exist')
    }

    try {
      const sourceStat = lstatSync(resolvedSource)
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
        return this.handleFailedProvisioning(
          'Selected import path cannot be a symlink, junction, or non-directory'
        )
      }
      if (pathsOverlap(resolvedSource, this.modelsRootDir)) {
        return this.handleFailedProvisioning(
          'Selected import directory overlaps with managed model storage'
        )
      }
    } catch (err) {
      return this.handleFailedProvisioning(
        err instanceof Error ? err.message : 'Failed to inspect import directory'
      )
    }

    mkdirSync(this.modelsRootDir, { recursive: true })
    const stagingDir = join(this.modelsRootDir, `${STAGING_PREFIX}${randomUUID()}`)
    this.activeStagingDir = stagingDir
    this.state = 'installing'
    this.downloadedBytes = 0
    this.currentArtifact = null
    this.error = null
    this.lastReplacementError = null
    this.emitStatus()

    try {
      mkdirSync(stagingDir, { recursive: false })

      for (const spec of this.artifacts) {
        this.currentArtifact = spec.relativePath
        this.emitStatus()

        const parts = validateRelativeArtifactPath(spec.relativePath)
        const srcFile = join(resolvedSource, ...parts)
        if (!existsSync(srcFile)) {
          throw new Error(`Missing required artifact in import folder: ${spec.relativePath}`)
        }

        assertNoSymlinkChain(resolvedSource, srcFile)
        const st = lstatSync(srcFile)
        if (!st.isFile()) {
          throw new Error(`Import artifact is not a regular file: ${spec.relativePath}`)
        }
        if (st.size !== spec.byteSize) {
          throw new Error(
            `Artifact byte size mismatch for ${spec.relativePath}: expected ${spec.byteSize}, got ${st.size}`
          )
        }

        const dstFile = join(stagingDir, ...parts)
        mkdirSync(dirname(dstFile), { recursive: true })
        copyFileSync(srcFile, dstFile)
        this.downloadedBytes += spec.byteSize
        this.emitStatus()
      }

      const verifyRes = await this.verifyDirectoryOffMain(stagingDir, this.artifacts)
      if (!verifyRes.ok) {
        throw new Error(verifyRes.error ?? 'Imported model failed SHA-256 digest verification')
      }

      this.promoteStagedDirectory(stagingDir)
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
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true })
      }
      this.activeStagingDir = null
      return this.handleFailedProvisioning(err instanceof Error ? err.message : String(err))
    }
  }

  public async downloadModel(): Promise<SemanticModelStatus> {
    if (this.state === 'installing') {
      return this.getStatus()
    }

    const containment = this.validateStorageContainment()
    if (!containment.ok) {
      return this.handleFailedProvisioning(
        containment.error ?? 'Model storage containment check failed'
      )
    }

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

        const downloadUrl = getPinnedArtifactDownloadUrl(spec.relativePath, this.baseDownloadUrl)
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
        throw new Error(verifyRes.error ?? 'Downloaded model failed SHA-256 verification')
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
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true })
      }
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

  public async cancelProvisioning(): Promise<SemanticModelStatus> {
    if (this.activeAbortController) {
      this.activeAbortController.abort()
    }
    if (this.activeStagingDir && existsSync(this.activeStagingDir)) {
      try {
        rmSync(this.activeStagingDir, { recursive: true, force: true })
      } catch {
        // ignore if stream cleanup handles it
      }
    }
    return this.handleFailedProvisioning('Model installation cancelled by user', true)
  }

  private validateDownloadUrl(rawUrl: string): URL {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new Error(`Invalid download URL: ${rawUrl}`)
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
    spec: SemanticModelArtifactSpec,
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

      const clientGet = parsedUrl.protocol === 'https:' ? httpsGet : httpGet
      const req = clientGet(
        parsedUrl,
        {
          headers: {
            'User-Agent': 'PersonalVault/0.1.0 (Offline-First Semantic Model Provisioner)'
          }
        },
        (res) => {
          const statusCode = res.statusCode ?? 0

          if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
            res.resume()
            let redirectTarget: string
            try {
              redirectTarget = new URL(res.headers.location, parsedUrl).toString()
              this.validateDownloadUrl(redirectTarget)
            } catch (err) {
              rejectPromise(err)
              return
            }
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
            rejectPromise(
              new Error(`HTTP ${statusCode} while downloading artifact ${spec.relativePath}`)
            )
            return
          }

          const contentLengthHeader = res.headers['content-length']
          if (contentLengthHeader !== undefined) {
            const declaredLength = Number(contentLengthHeader)
            if (!Number.isFinite(declaredLength) || declaredLength !== spec.byteSize) {
              res.destroy()
              rejectPromise(
                new Error(
                  `Content-Length mismatch for ${spec.relativePath}: expected ${spec.byteSize}, got ${contentLengthHeader}`
                )
              )
              return
            }
          }

          const hash = createHash('sha256')
          const fileStream = createWriteStream(destinationPath, { flags: 'wx' })
          let receivedBytes = 0
          let settled = false

          const fail = (err: Error): void => {
            if (settled) return
            settled = true
            res.destroy()
            fileStream.destroy()
            rejectPromise(err)
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
                settled = true
                rejectPromise(
                  new Error(
                    `Incomplete download size for ${spec.relativePath}: expected ${spec.byteSize}, got ${receivedBytes}`
                  )
                )
                return
              }
              const digest = hash.digest('hex')
              if (digest.toLowerCase() !== spec.sha256.toLowerCase()) {
                settled = true
                rejectPromise(
                  new Error(
                    `SHA-256 digest mismatch for ${spec.relativePath}: expected ${spec.sha256}, got ${digest}`
                  )
                )
                return
              }
              settled = true
              resolvePromise()
            })
          })
        }
      )

      const onAbort = (): void => {
        req.destroy(new Error('PROVISIONING_CANCELLED'))
        rejectPromise(new Error('PROVISIONING_CANCELLED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })

      req.on('error', (err) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          rejectPromise(new Error('PROVISIONING_CANCELLED'))
        } else {
          rejectPromise(err)
        }
      })

      req.on('close', () => {
        signal.removeEventListener('abort', onAbort)
      })
    })
  }
}
