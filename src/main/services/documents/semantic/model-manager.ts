/**
 * Personal Vault — Stage 7D Offline Document Semantic Model Manager
 *
 * Enforces explicit verified local directory import or explicit HTTPS download from
 * allowlisted Hugging Face / XetHub hosts, with ZERO automatic downloads, safe staging,
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
  APPROVED_DOC_SEMANTIC_DOWNLOAD_HOSTS,
  DOC_SEMANTIC_MODEL_COMMIT,
  DOC_SEMANTIC_MODEL_ID,
  DOC_SEMANTIC_MODEL_REPO,
  PINNED_DOC_SEMANTIC_MANIFEST_SHA256,
  REQUIRED_DOC_SEMANTIC_ARTIFACTS,
  computeDocSemanticManifestSha256,
  getPinnedDocSemanticArtifactDownloadUrl
} from './manifest'
import type {
  DocSemanticModelArtifactSpec,
  DocSemanticModelProvisionState,
  DocSemanticModelStatus
} from './types'

const INSTALL_DIR_NAME = 'Xenova--bge-small-en-v1.5@ea104dac'
const INSTALL_RECEIPT_FILE = '.doc_model_install_complete.json'
const STAGING_PREFIX = '.doc_model_staging_'
const BACKUP_PREFIX = '.doc_model_backup_'
const MAX_REDIRECTS = 5

export interface DocSemanticDirectoryVerificationResult {
  readonly ok: boolean
  readonly code?: 'DOC_MODEL_MISSING' | 'DOC_MODEL_INVALID'
  readonly error?: string
}

export type OffMainDocSemanticDirectoryVerifier = (
  directoryPath: string,
  specs: readonly DocSemanticModelArtifactSpec[]
) => Promise<DocSemanticDirectoryVerificationResult>

export interface DocSemanticModelManagerOptions {
  readonly modelsRootDir: string
  readonly getApprovedRoots: () => string[]
  readonly getVaultRoot: () => string | null
  readonly artifacts?: readonly DocSemanticModelArtifactSpec[]
  readonly baseDownloadUrl?: string
  readonly allowedHosts?: readonly string[]
  readonly allowLoopbackHttpForTests?: boolean
  readonly verifyDirectoryOffMain?: OffMainDocSemanticDirectoryVerifier
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

function assertNoSymlinkChainSync(targetPath: string, stopAtAncestor?: string): void {
  const abs = resolve(targetPath)
  const stopNorm = stopAtAncestor ? normalizePathForComparison(resolve(stopAtAncestor)) : null

  const chain: string[] = []
  let current = abs
  while (true) {
    chain.unshift(current)
    if (stopNorm && normalizePathForComparison(current) === stopNorm) {
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  for (const segment of chain) {
    if (!existsSync(segment)) continue
    const st = lstatSync(segment)
    if (st.isSymbolicLink()) {
      throw new Error(`Security error: symlink or junction detected at "${segment}"`)
    }
  }
}

export async function verifyDocSemanticDirectoryIntegrity(
  directoryPath: string,
  artifacts: readonly DocSemanticModelArtifactSpec[] = REQUIRED_DOC_SEMANTIC_ARTIFACTS
): Promise<DocSemanticDirectoryVerificationResult> {
  try {
    if (!existsSync(directoryPath)) {
      return { ok: false, code: 'DOC_MODEL_MISSING', error: 'Model directory does not exist' }
    }
    const rootStat = lstatSync(directoryPath)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return {
        ok: false,
        code: 'DOC_MODEL_INVALID',
        error: 'Model root is a symlink or non-directory'
      }
    }

    for (const artifact of artifacts) {
      const targetPath = join(directoryPath, artifact.relativePath)
      if (!existsSync(targetPath)) {
        return {
          ok: false,
          code: 'DOC_MODEL_MISSING',
          error: `Missing required artifact: ${artifact.relativePath}`
        }
      }

      assertNoSymlinkChainSync(targetPath, directoryPath)
      const st = lstatSync(targetPath)
      if (!st.isFile() || st.size !== artifact.byteSize) {
        return {
          ok: false,
          code: 'DOC_MODEL_INVALID',
          error: `Artifact size mismatch for ${artifact.relativePath}: expected ${artifact.byteSize}, got ${st.size}`
        }
      }

      const handle = await open(targetPath, 'r')
      const hash = createHash('sha256')
      try {
        const chunk = Buffer.allocUnsafe(65_536)
        while (true) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
          if (bytesRead <= 0) break
          hash.update(chunk.subarray(0, bytesRead))
        }
      } finally {
        await handle.close()
      }

      const actualSha256 = hash.digest('hex')
      if (actualSha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
        return {
          ok: false,
          code: 'DOC_MODEL_INVALID',
          error: `Artifact SHA-256 mismatch for ${artifact.relativePath}`
        }
      }
    }

    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      code: 'DOC_MODEL_INVALID',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export class DocSemanticModelUnavailableError extends Error {
  public readonly code: 'DOC_MODEL_MISSING' | 'DOC_MODEL_INVALID' | 'DOC_MODEL_MISMATCH'

  public constructor(
    code: 'DOC_MODEL_MISSING' | 'DOC_MODEL_INVALID' | 'DOC_MODEL_MISMATCH',
    message: string
  ) {
    super(message)
    this.name = 'DocSemanticModelUnavailableError'
    this.code = code
  }
}

export class DocSemanticModelSecurityError extends Error {
  public readonly code = 'DOC_MODEL_SECURITY_VIOLATION'

  public constructor(message: string) {
    super(message)
    this.name = 'DocSemanticModelSecurityError'
  }
}

export class DocSemanticModelManager {
  private readonly modelsRootDir: string
  private readonly getApprovedRoots: () => string[]
  private readonly getVaultRoot: () => string | null
  private readonly artifacts: readonly DocSemanticModelArtifactSpec[]
  private readonly manifestSha256: string
  private readonly totalBytes: number
  private readonly baseDownloadUrl: string
  private readonly allowedHosts: Set<string>
  private readonly allowLoopbackHttpForTests: boolean
  private readonly verifyDirectoryOffMain: OffMainDocSemanticDirectoryVerifier
  private readonly renameImpl: (oldPath: string, newPath: string) => void

  private status: DocSemanticModelStatus
  private activeProvisioningPromise: Promise<DocSemanticModelStatus> | null = null
  private activeAbortController: AbortController | null = null
  private activeStreamClosePromise: Promise<void> | null = null
  private initialized = false

  public constructor(options: DocSemanticModelManagerOptions) {
    this.modelsRootDir = resolve(options.modelsRootDir)
    this.getApprovedRoots = options.getApprovedRoots
    this.getVaultRoot = options.getVaultRoot
    this.artifacts = options.artifacts ?? REQUIRED_DOC_SEMANTIC_ARTIFACTS
    this.manifestSha256 = options.artifacts
      ? computeDocSemanticManifestSha256(options.artifacts)
      : PINNED_DOC_SEMANTIC_MANIFEST_SHA256
    this.totalBytes = this.artifacts.reduce((acc, item) => acc + item.byteSize, 0)
    this.baseDownloadUrl =
      options.baseDownloadUrl ??
      process.env.PV_TEST_DOC_MODEL_BASE_URL ??
      `https://huggingface.co/${DOC_SEMANTIC_MODEL_REPO}/resolve/${DOC_SEMANTIC_MODEL_COMMIT}`
    this.allowedHosts = new Set(
      (options.allowedHosts ?? APPROVED_DOC_SEMANTIC_DOWNLOAD_HOSTS).map((h) => h.toLowerCase())
    )
    this.allowLoopbackHttpForTests =
      options.allowLoopbackHttpForTests ?? Boolean(process.env.PV_TEST_DOC_MODEL_BASE_URL)
    this.verifyDirectoryOffMain =
      options.verifyDirectoryOffMain ?? verifyDocSemanticDirectoryIntegrity
    this.renameImpl = options.renameImpl ?? renameSync

    this.status = this.buildStatus('unprovisioned', 0, null, null, null, null)
  }

  public getArtifacts(): readonly DocSemanticModelArtifactSpec[] {
    return this.artifacts
  }

  public getInstallDir(): string {
    return join(this.modelsRootDir, INSTALL_DIR_NAME)
  }

  public getStatus(): DocSemanticModelStatus {
    return { ...this.status }
  }

  public async initialize(): Promise<DocSemanticModelStatus> {
    this.assertStorageSeparatedFromSourcesAndVault(this.modelsRootDir)
    mkdirSync(this.modelsRootDir, { recursive: true })
    assertNoSymlinkChainSync(this.modelsRootDir)
    await this.cleanupAbandonedDirs()
    const status = await this.refreshStatus()
    this.initialized = true
    return status
  }

  public async refreshStatus(): Promise<DocSemanticModelStatus> {
    const installDir = this.getInstallDir()
    const receiptPath = join(installDir, INSTALL_RECEIPT_FILE)
    if (!existsSync(installDir) || !existsSync(receiptPath)) {
      this.status = this.buildStatus('unprovisioned', 0, null, null, null, null)
      return this.getStatus()
    }

    const check = await this.verifyDirectoryOffMain(installDir, this.artifacts)
    if (check.ok) {
      this.status = this.buildStatus('ready', this.totalBytes, null, installDir, null, null)
    } else {
      const code = check.code ?? 'DOC_MODEL_INVALID'
      this.status = this.buildStatus(
        code === 'DOC_MODEL_MISSING' ? 'unprovisioned' : 'corrupt',
        0,
        null,
        null,
        code,
        check.error ?? 'Installed document semantic model failed verification'
      )
    }
    return this.getStatus()
  }

  public async verifyInstalledIntegrity(): Promise<{
    readonly installDir: string
    readonly modelId: string
    readonly modelCommit: string
    readonly manifestSha256: string
  }> {
    if (!this.initialized) {
      await this.initialize()
    }
    const installDir = this.getInstallDir()
    const receiptPath = join(installDir, INSTALL_RECEIPT_FILE)
    if (!existsSync(installDir) || !existsSync(receiptPath)) {
      this.status = this.buildStatus('unprovisioned', 0, null, null, null, null)
      throw new DocSemanticModelUnavailableError(
        'DOC_MODEL_MISSING',
        'Document semantic model is not installed'
      )
    }

    const check = await this.verifyDirectoryOffMain(installDir, this.artifacts)
    if (!check.ok) {
      const code = check.code === 'DOC_MODEL_MISSING' ? 'DOC_MODEL_MISSING' : 'DOC_MODEL_INVALID'
      this.status = this.buildStatus(
        code === 'DOC_MODEL_MISSING' ? 'unprovisioned' : 'corrupt',
        0,
        null,
        null,
        code,
        check.error ?? 'Document semantic model verification failed'
      )
      throw new DocSemanticModelUnavailableError(
        code,
        check.error ?? 'Document semantic model verification failed'
      )
    }

    this.status = this.buildStatus('ready', this.totalBytes, null, installDir, null, null)
    return {
      installDir,
      modelId: DOC_SEMANTIC_MODEL_ID,
      modelCommit: DOC_SEMANTIC_MODEL_COMMIT,
      manifestSha256: this.manifestSha256
    }
  }

  public async importFromDirectory(sourceDir: string): Promise<DocSemanticModelStatus> {
    if (this.activeProvisioningPromise) {
      throw new Error('Model provisioning is already in progress')
    }

    const controller = new AbortController()
    this.activeAbortController = controller

    const run = async (): Promise<DocSemanticModelStatus> => {
      let stagingDir: string | null = null
      const priorReady = await this.hasValidInstalledModel()
      try {
        await this.initialize()
        if (controller.signal.aborted) {
          throw new DOMException('Model import cancelled', 'AbortError')
        }
        const resolvedSource = resolve(sourceDir)
        this.assertStorageSeparatedFromSourcesAndVault(resolvedSource)
        if (!existsSync(resolvedSource)) {
          throw new DocSemanticModelUnavailableError(
            'DOC_MODEL_MISSING',
            'Selected model folder does not exist'
          )
        }
        assertNoSymlinkChainSync(resolvedSource)
        if (!lstatSync(resolvedSource).isDirectory()) {
          throw new DocSemanticModelUnavailableError(
            'DOC_MODEL_INVALID',
            'Selected model path is not a directory'
          )
        }

        this.status = this.buildStatus('importing', 0, null, null, null, null)
        stagingDir = join(this.modelsRootDir, `${STAGING_PREFIX}${randomUUID()}`)
        mkdirSync(stagingDir, { recursive: true })

        let copiedBytes = 0
        for (const artifact of this.artifacts) {
          if (controller.signal.aborted) {
            throw new DOMException('Model import cancelled', 'AbortError')
          }
          const srcFile = join(resolvedSource, artifact.relativePath)
          if (!existsSync(srcFile)) {
            throw new DocSemanticModelUnavailableError(
              'DOC_MODEL_MISSING',
              `Missing required model file: ${artifact.relativePath}`
            )
          }
          assertNoSymlinkChainSync(srcFile, resolvedSource)
          const st = lstatSync(srcFile)
          if (!st.isFile() || st.size !== artifact.byteSize) {
            throw new DocSemanticModelUnavailableError(
              'DOC_MODEL_INVALID',
              `Model file size mismatch for ${artifact.relativePath}: expected ${artifact.byteSize}, got ${st.size}`
            )
          }

          const destFile = join(stagingDir, artifact.relativePath)
          mkdirSync(dirname(destFile), { recursive: true })
          copyFileSync(srcFile, destFile)
          copiedBytes += artifact.byteSize
          this.status = this.buildStatus(
            'importing',
            copiedBytes,
            artifact.relativePath,
            null,
            null,
            null
          )
        }

        this.status = this.buildStatus('verifying', this.totalBytes, null, null, null, null)
        const verify = await this.verifyDirectoryOffMain(stagingDir, this.artifacts)
        if (controller.signal.aborted) {
          throw new DOMException('Model import cancelled', 'AbortError')
        }
        if (!verify.ok) {
          throw new DocSemanticModelUnavailableError(
            verify.code === 'DOC_MODEL_MISSING' ? 'DOC_MODEL_MISSING' : 'DOC_MODEL_INVALID',
            verify.error ?? 'Model verification failed'
          )
        }

        if (controller.signal.aborted) {
          throw new DOMException('Model import cancelled', 'AbortError')
        }
        await this.promoteStagingDir(stagingDir)
        stagingDir = null
        this.status = this.buildStatus(
          'ready',
          this.totalBytes,
          null,
          this.getInstallDir(),
          null,
          null
        )
        return this.getStatus()
      } catch (err) {
        if (stagingDir) {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
        }
        if (priorReady) {
          await this.refreshStatus().catch(() => {})
        } else if (err instanceof DOMException && err.name === 'AbortError') {
          this.status = this.buildStatus(
            'cancelled',
            0,
            null,
            null,
            'CANCELLED',
            'Model import cancelled'
          )
        } else {
          const code =
            err instanceof DocSemanticModelUnavailableError
              ? err.code
              : err instanceof DocSemanticModelSecurityError
                ? err.code
                : 'IMPORT_FAILED'
          this.status = this.buildStatus(
            'error',
            0,
            null,
            null,
            code,
            err instanceof Error ? err.message : String(err)
          )
        }
        throw err
      } finally {
        this.activeAbortController = null
        this.activeProvisioningPromise = null
      }
    }

    this.activeProvisioningPromise = run()
    return this.activeProvisioningPromise
  }

  public async downloadModel(): Promise<DocSemanticModelStatus> {
    if (this.activeProvisioningPromise) {
      throw new Error('Model provisioning is already in progress')
    }

    const controller = new AbortController()
    this.activeAbortController = controller

    const run = async (): Promise<DocSemanticModelStatus> => {
      let stagingDir: string | null = null
      const priorReady = await this.hasValidInstalledModel()
      try {
        await this.initialize()
        if (controller.signal.aborted) {
          throw new DOMException('Model download cancelled', 'AbortError')
        }
        this.status = this.buildStatus('downloading', 0, null, null, null, null)
        stagingDir = join(this.modelsRootDir, `${STAGING_PREFIX}${randomUUID()}`)
        mkdirSync(stagingDir, { recursive: true })

        let downloadedTotal = 0
        for (const artifact of this.artifacts) {
          if (controller.signal.aborted) {
            throw new DOMException('Model download cancelled', 'AbortError')
          }
          const url = getPinnedDocSemanticArtifactDownloadUrl(
            artifact.relativePath,
            this.baseDownloadUrl
          )
          const destFile = join(stagingDir, artifact.relativePath)
          mkdirSync(dirname(destFile), { recursive: true })

          await this.downloadVerifiedArtifact(
            url,
            destFile,
            artifact.byteSize,
            artifact.sha256,
            controller.signal,
            (deltaBytes) => {
              downloadedTotal += deltaBytes
              this.status = this.buildStatus(
                'downloading',
                Math.min(this.totalBytes, downloadedTotal),
                artifact.relativePath,
                null,
                null,
                null
              )
            }
          )
        }

        if (controller.signal.aborted) {
          throw new DOMException('Model download cancelled', 'AbortError')
        }
        this.status = this.buildStatus('verifying', this.totalBytes, null, null, null, null)
        const verify = await this.verifyDirectoryOffMain(stagingDir, this.artifacts)
        if (controller.signal.aborted) {
          throw new DOMException('Model download cancelled', 'AbortError')
        }
        if (!verify.ok) {
          throw new DocSemanticModelUnavailableError(
            verify.code === 'DOC_MODEL_MISSING' ? 'DOC_MODEL_MISSING' : 'DOC_MODEL_INVALID',
            verify.error ?? 'Downloaded model verification failed'
          )
        }

        if (controller.signal.aborted) {
          throw new DOMException('Model download cancelled', 'AbortError')
        }
        await this.promoteStagingDir(stagingDir)
        stagingDir = null
        this.status = this.buildStatus(
          'ready',
          this.totalBytes,
          null,
          this.getInstallDir(),
          null,
          null
        )
        return this.getStatus()
      } catch (err) {
        if (this.activeStreamClosePromise) {
          await this.activeStreamClosePromise.catch(() => {})
        }
        if (stagingDir) {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
        }
        if (priorReady) {
          await this.refreshStatus().catch(() => {})
        } else if (err instanceof DOMException && err.name === 'AbortError') {
          this.status = this.buildStatus(
            'cancelled',
            0,
            null,
            null,
            'CANCELLED',
            'Model download cancelled'
          )
        } else {
          const code =
            err instanceof DocSemanticModelUnavailableError
              ? err.code
              : err instanceof DocSemanticModelSecurityError
                ? err.code
                : 'DOWNLOAD_FAILED'
          this.status = this.buildStatus(
            'error',
            0,
            null,
            null,
            code,
            err instanceof Error ? err.message : String(err)
          )
        }
        throw err
      } finally {
        this.activeAbortController = null
        this.activeProvisioningPromise = null
      }
    }

    this.activeProvisioningPromise = run()
    return this.activeProvisioningPromise
  }

  public async cancelProvisioning(): Promise<DocSemanticModelStatus> {
    if (this.activeAbortController) {
      this.activeAbortController.abort()
    }
    if (this.activeProvisioningPromise) {
      await this.activeProvisioningPromise.catch(() => {})
    }
    return this.getStatus()
  }

  public async removeModel(): Promise<DocSemanticModelStatus> {
    if (this.activeProvisioningPromise) {
      await this.cancelProvisioning()
    }
    const installDir = this.getInstallDir()
    if (existsSync(installDir)) {
      await rm(installDir, { recursive: true, force: true })
    }
    this.status = this.buildStatus('unprovisioned', 0, null, null, null, null)
    return this.getStatus()
  }

  private async hasValidInstalledModel(): Promise<boolean> {
    const installDir = this.getInstallDir()
    const receiptPath = join(installDir, INSTALL_RECEIPT_FILE)
    if (!existsSync(installDir) || !existsSync(receiptPath)) return false
    const res = await this.verifyDirectoryOffMain(installDir, this.artifacts)
    return res.ok
  }

  private async promoteStagingDir(stagingDir: string): Promise<void> {
    const installDir = this.getInstallDir()
    const receiptPath = join(stagingDir, INSTALL_RECEIPT_FILE)
    writeFileSync(
      receiptPath,
      JSON.stringify({
        modelId: DOC_SEMANTIC_MODEL_ID,
        modelCommit: DOC_SEMANTIC_MODEL_COMMIT,
        manifestSha256: this.manifestSha256,
        installedAtMs: Date.now()
      }),
      'utf8'
    )

    let backupDir: string | null = null
    if (existsSync(installDir)) {
      backupDir = join(this.modelsRootDir, `${BACKUP_PREFIX}${randomUUID()}`)
      this.renameImpl(installDir, backupDir)
    }

    try {
      this.renameImpl(stagingDir, installDir)
    } catch (err) {
      if (backupDir && existsSync(backupDir) && !existsSync(installDir)) {
        try {
          this.renameImpl(backupDir, installDir)
        } catch {
          // Best-effort rollback
        }
      }
      throw err
    }

    if (backupDir && existsSync(backupDir)) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async cleanupAbandonedDirs(): Promise<void> {
    if (!existsSync(this.modelsRootDir)) return
    const entries = readdirSync(this.modelsRootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        (entry.name.startsWith(STAGING_PREFIX) || entry.name.startsWith(BACKUP_PREFIX))
      ) {
        await rm(join(this.modelsRootDir, entry.name), { recursive: true, force: true }).catch(
          () => {}
        )
      }
    }
  }

  private assertStorageSeparatedFromSourcesAndVault(targetDir: string): void {
    for (const root of this.getApprovedRoots()) {
      if (pathsOverlap(targetDir, root)) {
        throw new DocSemanticModelSecurityError(
          `Model storage directory overlaps with approved source root "${root}"`
        )
      }
    }
    const vaultRoot = this.getVaultRoot()
    if (vaultRoot && pathsOverlap(targetDir, vaultRoot)) {
      throw new DocSemanticModelSecurityError(
        `Model storage directory overlaps with active vault "${vaultRoot}"`
      )
    }
  }

  private assertDownloadUrlAllowed(rawUrl: string): URL {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new DocSemanticModelSecurityError(`Invalid download URL: ${rawUrl}`)
    }

    const host = parsed.hostname.toLowerCase()
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'

    if (parsed.protocol === 'http:') {
      if (this.allowLoopbackHttpForTests && isLoopback) {
        return parsed
      }
      throw new DocSemanticModelSecurityError(
        `Insecure HTTP download rejected: ${parsed.origin} (HTTPS required)`
      )
    }

    if (parsed.protocol !== 'https:') {
      throw new DocSemanticModelSecurityError(`Unsupported download protocol: ${parsed.protocol}`)
    }

    if (this.allowLoopbackHttpForTests && isLoopback) {
      return parsed
    }

    if (!this.allowedHosts.has(host)) {
      throw new DocSemanticModelSecurityError(`Download host not in allowlist: ${host}`)
    }

    return parsed
  }

  private async downloadVerifiedArtifact(
    initialUrl: string,
    destPath: string,
    expectedBytes: number,
    expectedSha256: string,
    signal: AbortSignal,
    onProgress: (deltaBytes: number) => void
  ): Promise<void> {
    let currentUrl = initialUrl
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const parsed = this.assertDownloadUrlAllowed(currentUrl)
      const outcome = await this.performSingleDownloadRequest(
        parsed,
        destPath,
        expectedBytes,
        expectedSha256,
        signal,
        onProgress
      )
      if (outcome.kind === 'done') return
      currentUrl = new URL(outcome.location, parsed).toString()
    }
    throw new DocSemanticModelUnavailableError(
      'DOC_MODEL_INVALID',
      `Exceeded maximum redirect hops (${MAX_REDIRECTS})`
    )
  }

  private performSingleDownloadRequest(
    url: URL,
    destPath: string,
    expectedBytes: number,
    expectedSha256: string,
    signal: AbortSignal,
    onProgress: (deltaBytes: number) => void
  ): Promise<{ kind: 'done' } | { kind: 'redirect'; location: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(new DOMException('Model download cancelled', 'AbortError'))
        return
      }

      const getter = url.protocol === 'http:' ? httpGet : httpsGet
      let settled = false
      const settleErr = (err: unknown): void => {
        if (settled) return
        settled = true
        rejectPromise(err)
      }

      const req = getter(url, (res) => {
        const statusCode = res.statusCode ?? 0
        if (
          statusCode === 301 ||
          statusCode === 302 ||
          statusCode === 303 ||
          statusCode === 307 ||
          statusCode === 308
        ) {
          res.resume()
          const location = res.headers.location
          if (!location) {
            settleErr(new Error(`Redirect ${statusCode} missing Location header`))
            return
          }
          if (!settled) {
            settled = true
            resolvePromise({ kind: 'redirect', location })
          }
          return
        }

        if (statusCode !== 200) {
          res.resume()
          settleErr(new Error(`HTTP ${statusCode} downloading ${url.pathname}`))
          return
        }

        const hash = createHash('sha256')
        let receivedBytes = 0
        const writeStream = createWriteStream(destPath, { flags: 'w' })
        this.activeStreamClosePromise = new Promise((resClose) => {
          writeStream.once('close', () => resClose())
        })

        const abortHandler = (): void => {
          res.destroy()
          writeStream.destroy()
          rmSync(destPath, { force: true })
          settleErr(new DOMException('Model download cancelled', 'AbortError'))
        }
        signal.addEventListener('abort', abortHandler, { once: true })

        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length
          if (receivedBytes > expectedBytes) {
            signal.removeEventListener('abort', abortHandler)
            res.destroy()
            writeStream.destroy()
            settleErr(
              new DocSemanticModelUnavailableError(
                'DOC_MODEL_INVALID',
                `Downloaded size exceeded expected ${expectedBytes} bytes`
              )
            )
            return
          }
          hash.update(chunk)
          onProgress(chunk.length)
        })

        res.on('error', (err) => {
          signal.removeEventListener('abort', abortHandler)
          writeStream.destroy()
          settleErr(err)
        })

        writeStream.on('error', (err) => {
          signal.removeEventListener('abort', abortHandler)
          res.destroy()
          settleErr(err)
        })

        writeStream.on('finish', () => {
          signal.removeEventListener('abort', abortHandler)
          if (receivedBytes !== expectedBytes) {
            settleErr(
              new DocSemanticModelUnavailableError(
                'DOC_MODEL_INVALID',
                `Downloaded size mismatch: expected ${expectedBytes}, got ${receivedBytes}`
              )
            )
            return
          }
          const actualSha = hash.digest('hex')
          if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
            settleErr(
              new DocSemanticModelUnavailableError(
                'DOC_MODEL_INVALID',
                `Downloaded SHA-256 mismatch for ${url.pathname}`
              )
            )
            return
          }
          if (!settled) {
            settled = true
            resolvePromise({ kind: 'done' })
          }
        })

        res.pipe(writeStream)
      })

      req.on('error', (err) => settleErr(err))
      const onAbortBeforeRes = (): void => {
        req.destroy()
        settleErr(new DOMException('Model download cancelled', 'AbortError'))
      }
      signal.addEventListener('abort', onAbortBeforeRes, { once: true })
      req.once('response', () => {
        signal.removeEventListener('abort', onAbortBeforeRes)
      })
    })
  }

  private buildStatus(
    state: DocSemanticModelProvisionState,
    downloadedBytes: number,
    currentFile: string | null,
    installDir: string | null,
    errorCode: string | null,
    errorMessage: string | null
  ): DocSemanticModelStatus {
    return {
      state,
      modelId: DOC_SEMANTIC_MODEL_ID,
      modelCommit: DOC_SEMANTIC_MODEL_COMMIT,
      manifestSha256: this.manifestSha256,
      totalBytes: this.totalBytes,
      downloadedBytes,
      currentFile,
      installDir,
      errorCode,
      errorMessage,
      updatedAtMs: Date.now()
    }
  }
}
