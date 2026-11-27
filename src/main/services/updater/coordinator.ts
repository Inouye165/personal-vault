import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  UpdateActionResponseDto,
  UpdateStateDto
} from '../../../shared/validation/update-ipc-schemas'

export interface UpdaterProgressInfo {
  readonly percent: number
  readonly transferred: number
  readonly total: number
  readonly bytesPerSecond: number
}

export interface UpdaterVersionInfo {
  readonly version: string
  readonly releaseDate?: string | null
}

export interface UpdaterLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
  debug?(message: string): void
}

export interface UpdaterAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  forceDevUpdateConfig: boolean
  requestHeaders: Record<string, string> | null
  logger?: UpdaterLogger | null
  setFeedURL(options: { provider: 'generic'; url: string; useMultipleRangeRequest?: boolean }): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<readonly string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
}

export interface VaultWriteDrain {
  isWriting(): boolean
  waitForActiveWriteToFinish(): Promise<void>
  setUpdateInstallPending(pending: boolean): void
}

export interface BackupJobDrain {
  isRunningJob(): boolean
  waitForActiveJobToFinish(): Promise<void>
  setUpdateInstallPending(pending: boolean): void
}

export interface ResolvedFeedConfiguration {
  readonly configured: boolean
  readonly source: 'env' | 'app-update-yml' | 'none'
  readonly provider: 'generic' | 'github' | null
  readonly feedUrl: string | null
  readonly allowLoopback: boolean
  readonly authToken: string | null
  readonly secrets: readonly string[]
  readonly reason: string
}

export interface UpdateCoordinatorOptions {
  readonly adapter: UpdaterAdapter
  readonly currentVersion: string
  readonly isPackaged: boolean
  readonly resourcesPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly vaultDrain?: VaultWriteDrain
  readonly backupDrain?: BackupJobDrain
  readonly prepareForUpdateQuit: () => Promise<void>
  readonly log?: (message: string) => void
  readonly nowMs?: () => number
  readonly fsExists?: (filePath: string) => boolean
  readonly fsReadFile?: (filePath: string, encoding: 'utf8') => string
}

const UNCONFIGURED_SENTINEL_HOST = 'updates.invalid'
const DEFAULT_STARTUP_CHECK_DELAY_MS = 1500

export function sanitizeUpdateErrorMessage(
  error: unknown,
  secrets: readonly string[] = []
): string {
  let message =
    error instanceof Error
      ? error.message || error.name
      : typeof error === 'string'
        ? error
        : String(error)

  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      message = message.split(secret).join('[REDACTED]')
    }
  }

  // Redact common bearer/token headers and embedded URL credentials.
  message = message.replace(/(Authorization\s*:\s*(?:Bearer|token)\s+)[^\s,;]+/gi, '$1[REDACTED]')
  message = message.replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
  message = message.replace(
    /\b(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})/g,
    '[REDACTED]'
  )
  message = message.replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1[REDACTED]:[REDACTED]@')

  const singleLine = message.replace(/[\r\n]+/g, ' ').trim()
  if (singleLine.length <= 400) {
    return singleLine || 'Update operation failed'
  }
  return `${singleLine.slice(0, 397)}...`
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function validateFeedUrl(
  rawUrl: string,
  allowLoopbackHttp: boolean
): { valid: true; url: string; loopback: boolean } | { valid: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { valid: false, reason: 'invalid_url' }
  }

  if (parsed.hostname.toLowerCase() === UNCONFIGURED_SENTINEL_HOST) {
    return { valid: false, reason: 'unconfigured_sentinel' }
  }

  if (parsed.protocol === 'https:') {
    return { valid: true, url: parsed.toString(), loopback: isLoopbackHost(parsed.hostname) }
  }

  if (parsed.protocol === 'http:' && allowLoopbackHttp && isLoopbackHost(parsed.hostname)) {
    return { valid: true, url: parsed.toString(), loopback: true }
  }

  return {
    valid: false,
    reason: parsed.protocol === 'http:' ? 'insecure_http' : 'unsupported_protocol'
  }
}

export function resolveFeedConfiguration(options: {
  readonly isPackaged: boolean
  readonly resourcesPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly fsExists?: (filePath: string) => boolean
  readonly fsReadFile?: (filePath: string, encoding: 'utf8') => string
}): ResolvedFeedConfiguration {
  const env = options.env ?? process.env
  const fsExists = options.fsExists ?? existsSync
  const fsReadFile = options.fsReadFile ?? ((p, enc) => readFileSync(p, enc))
  const allowLoopback = env.PV_ALLOW_LOOPBACK_UPDATE_URL === '1'
  const authToken = env.PV_UPDATE_FEED_TOKEN?.trim() || null
  const secrets = [env.PV_UPDATE_FEED_TOKEN, env.GH_TOKEN]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())

  const envUrl = env.PV_UPDATE_FEED_URL?.trim()
  if (envUrl) {
    const checked = validateFeedUrl(envUrl, allowLoopback)
    if (!checked.valid) {
      return {
        configured: false,
        source: 'none',
        provider: null,
        feedUrl: null,
        allowLoopback,
        authToken,
        secrets,
        reason: checked.reason
      }
    }
    return {
      configured: true,
      source: 'env',
      provider: 'generic',
      feedUrl: checked.url,
      allowLoopback: checked.loopback && allowLoopback,
      authToken,
      secrets,
      reason: 'env_override'
    }
  }

  if (options.isPackaged) {
    const resPath = options.resourcesPath ?? process.resourcesPath ?? ''
    const appUpdatePath = join(resPath, 'app-update.yml')
    if (!resPath || !fsExists(appUpdatePath)) {
      return {
        configured: false,
        source: 'none',
        provider: null,
        feedUrl: null,
        allowLoopback: false,
        authToken,
        secrets,
        reason: 'missing_app_update_yml'
      }
    }

    const content = fsReadFile(appUpdatePath, 'utf8')
    const providerMatch = content.match(/^provider:\s*['"]?([^\s'"#]+)['"]?/m)
    const provider = providerMatch?.[1]?.toLowerCase() ?? null

    if (provider === 'generic') {
      const urlMatch = content.match(/^url:\s*['"]?([^\s'"#]+)['"]?/m)
      const rawUrl = urlMatch?.[1] ?? ''
      if (!rawUrl) {
        return {
          configured: false,
          source: 'none',
          provider: null,
          feedUrl: null,
          allowLoopback: false,
          authToken,
          secrets,
          reason: 'missing_feed_url'
        }
      }
      const checked = validateFeedUrl(rawUrl, allowLoopback)
      if (!checked.valid) {
        return {
          configured: false,
          source: 'none',
          provider: null,
          feedUrl: null,
          allowLoopback: false,
          authToken,
          secrets,
          reason: checked.reason
        }
      }
      return {
        configured: true,
        source: 'app-update-yml',
        provider: 'generic',
        feedUrl: checked.url,
        allowLoopback: checked.loopback && allowLoopback,
        authToken,
        secrets,
        reason: 'app_update_yml_generic'
      }
    }

    if (provider === 'github') {
      return {
        configured: true,
        source: 'app-update-yml',
        provider: 'github',
        feedUrl: null,
        allowLoopback: false,
        authToken,
        secrets,
        reason: 'app_update_yml_github'
      }
    }

    return {
      configured: false,
      source: 'none',
      provider: null,
      feedUrl: null,
      allowLoopback: false,
      authToken,
      secrets,
      reason: 'unsupported_app_update_provider'
    }
  }

  return {
    configured: false,
    source: 'none',
    provider: null,
    feedUrl: null,
    allowLoopback: false,
    authToken,
    secrets,
    reason: 'unpackaged_without_feed_override'
  }
}

export class UpdateCoordinator {
  private readonly adapter: UpdaterAdapter
  private readonly isPackaged: boolean
  private readonly env: NodeJS.ProcessEnv
  private readonly vaultDrain?: VaultWriteDrain
  private readonly backupDrain?: BackupJobDrain
  private readonly prepareForUpdateQuit: () => Promise<void>
  private readonly log: (message: string) => void
  private readonly nowMs: () => number
  private readonly feedConfig: ResolvedFeedConfiguration
  private readonly listeners = new Set<(state: UpdateStateDto) => void>()

  private state: UpdateStateDto
  private activeFlow: 'check' | 'install' | null = null
  private checkIsBackground = false
  private downloadedVersion: string | null = null
  private needsReCheck = false
  private startupTimer: NodeJS.Timeout | null = null
  private pendingFlowPromise: Promise<unknown> | null = null
  private isShutdown = false

  private readonly onCheckingForUpdateBound = (): void => {
    if (this.activeFlow === 'install') return
    if (this.state.phase !== 'checking') {
      this.setState({
        phase: 'checking',
        errorMessage: null,
        failedStage: null,
        downloadProgress: null
      })
    }
  }

  private readonly onUpdateAvailableBound = (rawInfo: unknown): void => {
    const info = (rawInfo ?? {}) as Partial<UpdaterVersionInfo>
    const version =
      typeof info.version === 'string' && info.version.trim() ? info.version.trim() : null
    if (!version) return

    const releaseDate = typeof info.releaseDate === 'string' ? info.releaseDate : null
    if (this.downloadedVersion !== version) {
      this.downloadedVersion = null
    }
    this.needsReCheck = false

    if (this.activeFlow === 'install') {
      this.setState({
        availableVersion: version,
        releaseDate,
        lastCheckedAtMs: this.nowMs()
      })
      return
    }

    this.log(`Update available: version=${version}`)
    this.setState({
      phase: 'available',
      availableVersion: version,
      releaseDate,
      downloadProgress: null,
      errorMessage: null,
      failedStage: null,
      lastCheckedAtMs: this.nowMs()
    })
  }

  private readonly onUpdateNotAvailableBound = (): void => {
    this.downloadedVersion = null
    this.needsReCheck = false
    if (this.activeFlow === 'install') {
      this.setState({
        availableVersion: null,
        releaseDate: null,
        lastCheckedAtMs: this.nowMs()
      })
      return
    }
    const nextPhase = this.checkIsBackground ? 'idle' : 'up_to_date'
    this.log(`No update available (current=${this.state.currentVersion})`)
    this.setState({
      phase: nextPhase,
      availableVersion: null,
      releaseDate: null,
      downloadProgress: null,
      errorMessage: null,
      failedStage: null,
      lastCheckedAtMs: this.nowMs()
    })
  }

  private readonly onDownloadProgressBound = (rawProgress: unknown): void => {
    if (this.state.phase !== 'downloading') return
    const p = (rawProgress ?? {}) as Partial<UpdaterProgressInfo>
    const percent =
      typeof p.percent === 'number' && Number.isFinite(p.percent)
        ? Math.max(0, Math.min(100, p.percent))
        : 0
    const transferredBytes =
      typeof p.transferred === 'number' && Number.isFinite(p.transferred)
        ? Math.max(0, Math.round(p.transferred))
        : 0
    const totalBytes =
      typeof p.total === 'number' && Number.isFinite(p.total) ? Math.max(0, Math.round(p.total)) : 0
    const bytesPerSecond =
      typeof p.bytesPerSecond === 'number' && Number.isFinite(p.bytesPerSecond)
        ? Math.max(0, p.bytesPerSecond)
        : 0

    this.setState({
      downloadProgress: {
        percent,
        transferredBytes,
        totalBytes,
        bytesPerSecond
      }
    })
  }

  private readonly onUpdateDownloadedBound = (rawEvent: unknown): void => {
    const info = (rawEvent ?? {}) as Partial<UpdaterVersionInfo>
    const version =
      typeof info.version === 'string' && info.version.trim()
        ? info.version.trim()
        : this.state.availableVersion
    this.downloadedVersion = version
    this.log(`Update downloaded and verified: version=${version ?? 'unknown'}`)
    if (this.state.phase === 'downloading') {
      const existing = this.state.downloadProgress
      this.setState({
        availableVersion: version,
        downloadProgress: existing
          ? {
              ...existing,
              percent: 100,
              transferredBytes: existing.totalBytes || existing.transferredBytes
            }
          : {
              percent: 100,
              transferredBytes: 0,
              totalBytes: 0,
              bytesPerSecond: 0
            }
      })
    }
  }

  private readonly onErrorBound = (rawError: unknown): void => {
    const sanitized = this.sanitizeError(rawError)
    this.log(`Updater error event: ${sanitized}`)
    if (this.activeFlow === null && this.state.phase === 'installing') {
      this.releaseInstallPendingFlags()
      if (!this.isShutdown) {
        this.setState({
          phase: 'error',
          failedStage: 'install',
          downloadProgress: null,
          activeJobs: { vaultImportActive: false, backupActive: false },
          errorMessage: sanitized
        })
      }
    }
  }

  public constructor(options: UpdateCoordinatorOptions) {
    this.adapter = options.adapter
    this.isPackaged = options.isPackaged
    this.env = options.env ?? process.env
    this.vaultDrain = options.vaultDrain
    this.backupDrain = options.backupDrain
    this.prepareForUpdateQuit = options.prepareForUpdateQuit
    this.log = options.log ?? (() => {})
    this.nowMs = options.nowMs ?? (() => Date.now())

    this.feedConfig = resolveFeedConfiguration({
      isPackaged: options.isPackaged,
      resourcesPath: options.resourcesPath,
      env: this.env,
      fsExists: options.fsExists,
      fsReadFile: options.fsReadFile
    })

    // Enforce explicit user consent invariants on electron-updater.
    this.adapter.autoDownload = false
    this.adapter.autoInstallOnAppQuit = false
    this.adapter.allowDowngrade = false
    this.adapter.logger = {
      info: (msg) => this.log(`[updater] ${this.sanitizeError(msg)}`),
      warn: (msg) => this.log(`[updater:warn] ${this.sanitizeError(msg)}`),
      error: (msg) => this.log(`[updater:error] ${this.sanitizeError(msg)}`)
    }

    if (this.feedConfig.configured && this.feedConfig.source === 'env' && this.feedConfig.feedUrl) {
      this.adapter.setFeedURL({
        provider: 'generic',
        url: this.feedConfig.feedUrl,
        useMultipleRangeRequest: false
      })
      if (!this.isPackaged && this.feedConfig.allowLoopback) {
        this.adapter.forceDevUpdateConfig = true
      }
    }

    if (this.feedConfig.configured && this.feedConfig.authToken) {
      this.adapter.requestHeaders = {
        ...(this.adapter.requestHeaders ?? {}),
        Authorization: `Bearer ${this.feedConfig.authToken}`
      }
    }

    this.state = {
      phase: 'idle',
      configured: this.feedConfig.configured,
      currentVersion: options.currentVersion,
      availableVersion: null,
      releaseDate: null,
      downloadProgress: null,
      activeJobs: { vaultImportActive: false, backupActive: false },
      errorMessage: null,
      failedStage: null,
      lastCheckedAtMs: null
    }

    this.adapter.on('checking-for-update', this.onCheckingForUpdateBound)
    this.adapter.on('update-available', this.onUpdateAvailableBound)
    this.adapter.on('update-not-available', this.onUpdateNotAvailableBound)
    this.adapter.on('download-progress', this.onDownloadProgressBound)
    this.adapter.on('update-downloaded', this.onUpdateDownloadedBound)
    this.adapter.on('error', this.onErrorBound)

    this.log(
      `UpdateCoordinator initialized: configured=${this.feedConfig.configured}, reason=${this.feedConfig.reason}`
    )
  }

  public getState(): UpdateStateDto {
    return {
      ...this.state,
      downloadProgress: this.state.downloadProgress ? { ...this.state.downloadProgress } : null,
      activeJobs: { ...this.state.activeJobs }
    }
  }

  public isInstallPending(): boolean {
    return (
      this.state.phase === 'waiting_for_jobs' ||
      this.state.phase === 'installing' ||
      this.activeFlow === 'install'
    )
  }

  public onStateChange(listener: (state: UpdateStateDto) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public async waitForPendingWork(): Promise<void> {
    if (this.pendingFlowPromise) {
      await this.pendingFlowPromise
    }
  }

  public scheduleStartupCheck(delayMs?: number): void {
    if (this.isShutdown || !this.feedConfig.configured || this.env.PV_DISABLE_AUTO_UPDATE === '1') {
      return
    }
    if (this.startupTimer) {
      return
    }

    const envDelay = Number(this.env.PV_UPDATE_CHECK_DELAY_MS)
    const effectiveDelay =
      delayMs !== undefined
        ? Math.max(0, delayMs)
        : Number.isFinite(envDelay) && envDelay >= 0
          ? envDelay
          : DEFAULT_STARTUP_CHECK_DELAY_MS

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (!this.isShutdown) {
        void this.checkForUpdates({ background: true })
      }
    }, effectiveDelay)
    this.startupTimer.unref?.()
  }

  public async checkForUpdates(options?: {
    readonly background?: boolean
  }): Promise<UpdateActionResponseDto> {
    const background = options?.background === true
    if (this.isShutdown || !this.feedConfig.configured) {
      return { accepted: false, state: this.getState() }
    }
    if (
      this.activeFlow !== null ||
      this.state.phase === 'checking' ||
      this.state.phase === 'downloading' ||
      this.state.phase === 'waiting_for_jobs' ||
      this.state.phase === 'installing'
    ) {
      return { accepted: false, state: this.getState() }
    }

    this.activeFlow = 'check'
    this.checkIsBackground = background
    this.setState({
      phase: 'checking',
      errorMessage: null,
      failedStage: null,
      downloadProgress: null
    })

    const runCheck = async (): Promise<UpdateActionResponseDto> => {
      try {
        await this.adapter.checkForUpdates()
        if (this.state.phase === 'checking') {
          this.setState({
            phase: background ? 'idle' : 'up_to_date',
            lastCheckedAtMs: this.nowMs()
          })
        }
        return { accepted: true, state: this.getState() }
      } catch (err) {
        const sanitized = this.sanitizeError(err)
        this.log(`Update check failed (${background ? 'background' : 'manual'}): ${sanitized}`)
        if (background) {
          this.setState({
            phase: this.state.availableVersion ? 'deferred' : 'idle',
            errorMessage: null,
            failedStage: null
          })
        } else {
          this.setState({
            phase: 'error',
            failedStage: 'check',
            errorMessage: sanitized,
            downloadProgress: null
          })
        }
        return { accepted: true, state: this.getState() }
      } finally {
        if (this.activeFlow === 'check') {
          this.activeFlow = null
        }
        this.checkIsBackground = false
      }
    }

    const promise = runCheck()
    this.pendingFlowPromise = promise
    try {
      return await promise
    } finally {
      if (this.pendingFlowPromise === promise) {
        this.pendingFlowPromise = null
      }
    }
  }

  public deferUpdate(): UpdateActionResponseDto {
    if (
      this.state.phase !== 'available' &&
      !(this.state.phase === 'error' && this.state.availableVersion !== null)
    ) {
      return { accepted: false, state: this.getState() }
    }

    this.log(`Update deferred by user: version=${this.state.availableVersion ?? 'unknown'}`)
    this.setState({
      phase: 'deferred',
      downloadProgress: null,
      errorMessage: null,
      failedStage: null,
      activeJobs: { vaultImportActive: false, backupActive: false }
    })
    return { accepted: true, state: this.getState() }
  }

  public dismissError(): UpdateActionResponseDto {
    if (this.state.phase !== 'error') {
      return { accepted: false, state: this.getState() }
    }

    this.setState({
      phase: this.state.availableVersion ? 'deferred' : 'idle',
      downloadProgress: null,
      errorMessage: null,
      failedStage: null,
      activeJobs: { vaultImportActive: false, backupActive: false }
    })
    return { accepted: true, state: this.getState() }
  }

  public installUpdateNow(): UpdateActionResponseDto {
    if (this.isShutdown || !this.feedConfig.configured || !this.state.availableVersion) {
      return { accepted: false, state: this.getState() }
    }
    if (
      this.activeFlow !== null ||
      this.state.phase === 'checking' ||
      this.state.phase === 'downloading' ||
      this.state.phase === 'waiting_for_jobs' ||
      this.state.phase === 'installing'
    ) {
      return { accepted: false, state: this.getState() }
    }
    if (
      this.state.phase !== 'available' &&
      this.state.phase !== 'deferred' &&
      this.state.phase !== 'error'
    ) {
      return { accepted: false, state: this.getState() }
    }

    const targetVersion = this.state.availableVersion
    const alreadyDownloaded = this.downloadedVersion === targetVersion
    this.activeFlow = 'install'
    this.setState({
      phase: 'downloading',
      errorMessage: null,
      failedStage: null,
      activeJobs: { vaultImportActive: false, backupActive: false },
      downloadProgress: alreadyDownloaded
        ? { percent: 100, transferredBytes: 0, totalBytes: 0, bytesPerSecond: 0 }
        : { percent: 0, transferredBytes: 0, totalBytes: 0, bytesPerSecond: 0 }
    })

    const flowPromise = this.runInstallFlow(targetVersion)
    this.pendingFlowPromise = flowPromise
    void flowPromise.finally(() => {
      if (this.pendingFlowPromise === flowPromise) {
        this.pendingFlowPromise = null
      }
    })

    return { accepted: true, state: this.getState() }
  }

  private async runInstallFlow(targetVersion: string): Promise<void> {
    try {
      if (this.isShutdown) return

      if (this.downloadedVersion !== targetVersion) {
        try {
          if (this.needsReCheck) {
            await this.adapter.checkForUpdates()
            if (!this.state.availableVersion) {
              throw new Error('Selected update version is no longer available on the update feed')
            }
          }
          await this.adapter.downloadUpdate()
          this.downloadedVersion = this.state.availableVersion
          this.needsReCheck = false
        } catch (err) {
          this.downloadedVersion = null
          this.needsReCheck = true
          this.releaseInstallPendingFlags()
          if (!this.isShutdown) {
            this.setState({
              phase: 'error',
              failedStage: 'download',
              downloadProgress: null,
              activeJobs: { vaultImportActive: false, backupActive: false },
              errorMessage: this.sanitizeError(err)
            })
          }
          return
        }
      }

      if (this.isShutdown) return

      // Block new vault writes and backup jobs while draining active ones cleanly.
      this.vaultDrain?.setUpdateInstallPending(true)
      this.backupDrain?.setUpdateInstallPending(true)

      while (!this.isShutdown) {
        const vaultActive = this.vaultDrain?.isWriting() ?? false
        const backupActive = this.backupDrain?.isRunningJob() ?? false
        if (!vaultActive && !backupActive) {
          break
        }
        this.log(
          `Waiting for active jobs before update install: vaultWrite=${vaultActive}, backupJob=${backupActive}`
        )
        this.setState({
          phase: 'waiting_for_jobs',
          downloadProgress: null,
          activeJobs: {
            vaultImportActive: vaultActive,
            backupActive
          }
        })
        const waiters: Promise<void>[] = []
        if (vaultActive && this.vaultDrain) {
          waiters.push(this.vaultDrain.waitForActiveWriteToFinish())
        }
        if (backupActive && this.backupDrain) {
          waiters.push(this.backupDrain.waitForActiveJobToFinish())
        }
        if (waiters.length === 0) {
          break
        }
        await Promise.race(waiters)
      }

      if (this.isShutdown) {
        this.releaseInstallPendingFlags()
        return
      }

      if (this.startupTimer) {
        clearTimeout(this.startupTimer)
        this.startupTimer = null
      }

      this.setState({
        phase: 'installing',
        downloadProgress: null,
        activeJobs: { vaultImportActive: false, backupActive: false }
      })

      this.log(`Drained active jobs; shutting down services before installing ${targetVersion}`)
      await this.prepareForUpdateQuit()

      this.activeFlow = null
      this.log(`Calling quitAndInstall(isSilent=true, isForceRunAfter=true) for ${targetVersion}`)
      this.adapter.quitAndInstall(true, true)
    } catch (err) {
      this.releaseInstallPendingFlags()
      if (!this.isShutdown) {
        this.setState({
          phase: 'error',
          failedStage: 'install',
          downloadProgress: null,
          activeJobs: { vaultImportActive: false, backupActive: false },
          errorMessage: this.sanitizeError(err)
        })
      }
    } finally {
      if (this.activeFlow === 'install') {
        this.activeFlow = null
      }
    }
  }

  public shutdown(): void {
    this.isShutdown = true
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.releaseInstallPendingFlags()
    this.adapter.off('checking-for-update', this.onCheckingForUpdateBound)
    this.adapter.off('update-available', this.onUpdateAvailableBound)
    this.adapter.off('update-not-available', this.onUpdateNotAvailableBound)
    this.adapter.off('download-progress', this.onDownloadProgressBound)
    this.adapter.off('update-downloaded', this.onUpdateDownloadedBound)
    this.adapter.off('error', this.onErrorBound)
    this.listeners.clear()
  }

  private releaseInstallPendingFlags(): void {
    this.vaultDrain?.setUpdateInstallPending(false)
    this.backupDrain?.setUpdateInstallPending(false)
  }

  private sanitizeError(err: unknown): string {
    return sanitizeUpdateErrorMessage(err, this.feedConfig.secrets)
  }

  private setState(patch: Partial<UpdateStateDto>): void {
    this.state = {
      ...this.state,
      ...patch
    }
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Ignore subscriber error to keep updater state machine safe.
      }
    }
  }
}
