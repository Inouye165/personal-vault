// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveFeedConfiguration,
  sanitizeUpdateErrorMessage,
  UpdateCoordinator,
  type BackupJobDrain,
  type UpdaterAdapter,
  type VaultWriteDrain
} from '../../src/main/services/updater/coordinator'

class FakeUpdaterAdapter implements UpdaterAdapter {
  public autoDownload = true
  public autoInstallOnAppQuit = true
  public allowDowngrade = true
  public forceDevUpdateConfig = false
  public requestHeaders: Record<string, string> | null = null
  public feedConfigs: Array<{
    provider: 'generic'
    url: string
    useMultipleRangeRequest?: boolean
  }> = []
  public checkCalls = 0
  public downloadCalls = 0
  public quitAndInstallCalls: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = []

  private readonly emitter = new EventEmitter()
  public onCheck: () => Promise<unknown> = async () => null
  public onDownload: () => Promise<readonly string[]> = async () => []
  public onQuitAndInstall?: () => void

  public setFeedURL(options: {
    provider: 'generic'
    url: string
    useMultipleRangeRequest?: boolean
  }): void {
    this.feedConfigs.push(options)
  }

  public async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1
    this.emitter.emit('checking-for-update')
    return await this.onCheck()
  }

  public async downloadUpdate(): Promise<readonly string[]> {
    this.downloadCalls += 1
    return await this.onDownload()
  }

  public quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    this.quitAndInstallCalls.push({ isSilent, isForceRunAfter })
    this.onQuitAndInstall?.()
  }

  public emit(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args)
  }

  public on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener)
  }

  public off(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.off(event, listener)
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('UpdateCoordinator & feed resolution', () => {
  it('stays unconfigured with zero network calls when no private feed is configured', async () => {
    const adapter = new FakeUpdaterAdapter()
    const coordinator = new UpdateCoordinator({
      adapter,
      currentVersion: '0.1.0',
      isPackaged: true,
      resourcesPath: 'C:/fake/resources',
      env: {},
      prepareForUpdateQuit: async () => {},
      fsExists: () => true,
      fsReadFile: () =>
        'provider: generic\nurl: https://updates.invalid/personal-vault/win-x64\nupdaterCacheDirName: personal-vault-updater\n'
    })

    expect(adapter.autoDownload).toBe(false)
    expect(adapter.autoInstallOnAppQuit).toBe(false)
    expect(adapter.allowDowngrade).toBe(false)
    expect(coordinator.getState().configured).toBe(false)

    coordinator.scheduleStartupCheck(0)
    await new Promise((r) => setTimeout(r, 20))
    const checkRes = await coordinator.checkForUpdates()
    expect(checkRes.accepted).toBe(false)
    expect(adapter.checkCalls).toBe(0)
    coordinator.shutdown()
  })

  it('rejects insecure non-loopback HTTP update URLs while allowing HTTPS and guarded loopback test feeds', () => {
    const insecure = resolveFeedConfiguration({
      isPackaged: false,
      env: { PV_UPDATE_FEED_URL: 'http://example.com/updates' }
    })
    expect(insecure.configured).toBe(false)

    const loopbackBlocked = resolveFeedConfiguration({
      isPackaged: false,
      env: { PV_UPDATE_FEED_URL: 'http://127.0.0.1:8080' }
    })
    expect(loopbackBlocked.configured).toBe(false)

    const loopbackAllowed = resolveFeedConfiguration({
      isPackaged: false,
      env: {
        PV_UPDATE_FEED_URL: 'http://127.0.0.1:8080',
        PV_ALLOW_LOOPBACK_UPDATE_URL: '1'
      }
    })
    expect(loopbackAllowed.configured).toBe(true)
    expect(loopbackAllowed.allowLoopback).toBe(true)

    const httpsAllowed = resolveFeedConfiguration({
      isPackaged: true,
      resourcesPath: 'C:/app/resources',
      env: {},
      fsExists: () => true,
      fsReadFile: () => 'provider: generic\nurl: https://updates.private.example/win-x64\n'
    })
    expect(httpsAllowed.configured).toBe(true)
    expect(httpsAllowed.provider).toBe('generic')
  })

  it('prompts only on available updates and keeps the old version when Later is chosen', async () => {
    const adapter = new FakeUpdaterAdapter()
    adapter.onCheck = async () => {
      adapter.emit('update-available', {
        version: '0.1.1',
        releaseDate: '2026-11-22T12:00:00.000Z'
      })
      return null
    }

    const coordinator = new UpdateCoordinator({
      adapter,
      currentVersion: '0.1.0',
      isPackaged: true,
      env: { PV_UPDATE_FEED_URL: 'https://updates.private.example/pv' },
      prepareForUpdateQuit: async () => {}
    })

    const checkRes = await coordinator.checkForUpdates()
    expect(checkRes.accepted).toBe(true)
    expect(checkRes.state.phase).toBe('available')
    expect(checkRes.state.availableVersion).toBe('0.1.1')
    expect(adapter.downloadCalls).toBe(0)
    expect(adapter.quitAndInstallCalls).toHaveLength(0)

    const deferred = coordinator.deferUpdate()
    expect(deferred.accepted).toBe(true)
    expect(deferred.state.phase).toBe('deferred')
    expect(deferred.state.availableVersion).toBe('0.1.1')
    expect(adapter.downloadCalls).toBe(0)
    expect(adapter.quitAndInstallCalls).toHaveLength(0)
    coordinator.shutdown()
  })

  it('handles failed download cleanly with secret redaction, leaving the app usable and retryable', async () => {
    const adapter = new FakeUpdaterAdapter()
    const logs: string[] = []
    adapter.onCheck = async () => {
      adapter.emit('update-available', { version: '0.1.1' })
      return null
    }
    let attempt = 0
    adapter.onDownload = async () => {
      attempt += 1
      if (attempt === 1) {
        const err = new Error('HTTP 500 with Authorization: Bearer super-secret-token-123')
        adapter.emit('error', err)
        throw err
      }
      adapter.emit('download-progress', {
        percent: 50,
        transferred: 500,
        total: 1000,
        bytesPerSecond: 250
      })
      adapter.emit('update-downloaded', { version: '0.1.1' })
      return ['C:/temp/Personal-Vault-Setup-0.1.1.exe']
    }

    let preparedCount = 0
    const coordinator = new UpdateCoordinator({
      adapter,
      currentVersion: '0.1.0',
      isPackaged: true,
      env: {
        PV_UPDATE_FEED_URL: 'https://updates.private.example/pv',
        PV_UPDATE_FEED_TOKEN: 'super-secret-token-123'
      },
      prepareForUpdateQuit: async () => {
        preparedCount += 1
      },
      log: (m) => logs.push(m)
    })

    expect(adapter.requestHeaders).toEqual({ Authorization: 'Bearer super-secret-token-123' })

    await coordinator.checkForUpdates()
    const failStart = coordinator.installUpdateNow()
    expect(failStart.accepted).toBe(true)
    await coordinator.waitForPendingWork()

    const failedState = coordinator.getState()
    expect(failedState.phase).toBe('error')
    expect(failedState.failedStage).toBe('download')
    expect(failedState.errorMessage).not.toContain('super-secret-token-123')
    expect(failedState.errorMessage).toContain('[REDACTED]')
    expect(logs.join('\n')).not.toContain('super-secret-token-123')
    expect(preparedCount).toBe(0)
    expect(adapter.quitAndInstallCalls).toHaveLength(0)

    // Retry succeeds cleanly and installs
    const retryStart = coordinator.installUpdateNow()
    expect(retryStart.accepted).toBe(true)
    await coordinator.waitForPendingWork()

    expect(adapter.checkCalls).toBe(2) // re-checked on retry after error
    expect(adapter.downloadCalls).toBe(2)
    expect(preparedCount).toBe(1)
    expect(adapter.quitAndInstallCalls).toEqual([{ isSilent: true, isForceRunAfter: true }])
    coordinator.shutdown()
  })

  it('waits for both active vault writes and active backup jobs to finish without aborting before shutting down and calling quitAndInstall', async () => {
    const adapter = new FakeUpdaterAdapter()
    const events: string[] = []
    adapter.onCheck = async () => {
      adapter.emit('update-available', { version: '0.1.1' })
      return null
    }
    adapter.onDownload = async () => {
      events.push('downloaded')
      adapter.emit('update-downloaded', { version: '0.1.1' })
      return ['C:/temp/Personal-Vault-Setup-0.1.1.exe']
    }
    adapter.onQuitAndInstall = () => {
      events.push('quitAndInstall')
    }

    const vaultDeferred = createDeferred<void>()
    const backupDeferred = createDeferred<void>()
    let vaultWriting = true
    let backupRunning = true
    let vaultPendingBlocked = false
    let backupPendingBlocked = false

    const vaultDrain: VaultWriteDrain = {
      isWriting: () => vaultWriting,
      waitForActiveWriteToFinish: async () => {
        await vaultDeferred.promise
      },
      setUpdateInstallPending: (pending) => {
        vaultPendingBlocked = pending
      }
    }

    const backupDrain: BackupJobDrain = {
      isRunningJob: () => backupRunning,
      waitForActiveJobToFinish: async () => {
        await backupDeferred.promise
      },
      setUpdateInstallPending: (pending) => {
        backupPendingBlocked = pending
      }
    }

    const coordinator = new UpdateCoordinator({
      adapter,
      currentVersion: '0.1.0',
      isPackaged: true,
      env: { PV_UPDATE_FEED_URL: 'https://updates.private.example/pv' },
      vaultDrain,
      backupDrain,
      prepareForUpdateQuit: async () => {
        events.push('prepareForUpdateQuit')
      }
    })

    const observedPhases: string[] = []
    coordinator.onStateChange((st) => observedPhases.push(st.phase))

    await coordinator.checkForUpdates()
    const installRes = coordinator.installUpdateNow()
    expect(installRes.accepted).toBe(true)

    await vi.waitFor(() => {
      expect(coordinator.getState().phase).toBe('waiting_for_jobs')
    })

    expect(coordinator.getState().activeJobs).toEqual({
      vaultImportActive: true,
      backupActive: true
    })
    expect(vaultPendingBlocked).toBe(true)
    expect(backupPendingBlocked).toBe(true)
    expect(adapter.quitAndInstallCalls).toHaveLength(0)

    // Finish vault write first; backup is still running so app must remain waiting!
    vaultWriting = false
    vaultDeferred.resolve()
    await vi.waitFor(() => {
      expect(coordinator.getState().activeJobs).toEqual({
        vaultImportActive: false,
        backupActive: true
      })
    })
    expect(adapter.quitAndInstallCalls).toHaveLength(0)

    // Now finish backup job; coordinator must shut down cleanly BEFORE quitAndInstall.
    backupRunning = false
    backupDeferred.resolve()
    await coordinator.waitForPendingWork()

    expect(observedPhases).toContain('waiting_for_jobs')
    expect(observedPhases).toContain('installing')
    expect(events).toEqual(['downloaded', 'prepareForUpdateQuit', 'quitAndInstall'])
    expect(adapter.quitAndInstallCalls).toEqual([{ isSilent: true, isForceRunAfter: true }])
    coordinator.shutdown()
  })

  it('suppresses background startup check errors on offline launch', async () => {
    const adapter = new FakeUpdaterAdapter()
    adapter.onCheck = async () => {
      const err = new Error('net::ERR_NAME_NOT_RESOLVED')
      adapter.emit('error', err)
      throw err
    }

    const coordinator = new UpdateCoordinator({
      adapter,
      currentVersion: '0.1.0',
      isPackaged: true,
      env: { PV_UPDATE_FEED_URL: 'https://updates.private.example/pv' },
      prepareForUpdateQuit: async () => {}
    })

    coordinator.scheduleStartupCheck(0)
    await new Promise((r) => setTimeout(r, 25))
    await coordinator.waitForPendingWork()

    expect(adapter.checkCalls).toBe(1)
    expect(coordinator.getState().phase).toBe('idle')
    expect(coordinator.getState().errorMessage).toBeNull()
    coordinator.shutdown()
  })

  it('sanitizes URL credentials and tokens from error strings', () => {
    const cleaned = sanitizeUpdateErrorMessage(
      new Error('Failed GET https://user:pw123@host.example/file?token=ghp_abc123456789xyz'),
      ['pw123']
    )
    expect(cleaned).not.toContain('pw123')
    expect(cleaned).not.toContain('ghp_abc123456789xyz')
    expect(cleaned).toContain('[REDACTED]')
  })

  it('keeps the adapter error listener attached across quitAndInstall handoff', async () => {
    const adapter = new FakeUpdaterAdapter()
    adapter.onCheck = async () => {
      adapter.emit('update-available', { version: '0.1.1' })
      return null
    }
    adapter.onDownload = async () => {
      adapter.emit('update-downloaded', { version: '0.1.1' })
      return ['C:/temp/Personal-Vault-Setup-0.1.1.exe']
    }

    const coordinator = new UpdateCoordinator({
      adapter,
      currentVersion: '0.1.0',
      isPackaged: true,
      env: { PV_UPDATE_FEED_URL: 'https://updates.private.example/pv' },
      prepareForUpdateQuit: async () => {
        // In production main/index.ts, prepareForUpdateQuit skips coordinator.shutdown()
      }
    })

    adapter.onQuitAndInstall = () => {
      // Simulate electron-updater emitting an async error during quitAndInstall after prepareForUpdateQuit
      adapter.emit('error', new Error('Spawn elevate failed'))
    }

    await coordinator.checkForUpdates()
    coordinator.installUpdateNow()
    await coordinator.waitForPendingWork()

    expect(coordinator.getState().phase).toBe('error')
    expect(coordinator.getState().failedStage).toBe('install')
    expect(coordinator.getState().errorMessage).toContain('Spawn elevate failed')
    coordinator.shutdown()
  })
})
