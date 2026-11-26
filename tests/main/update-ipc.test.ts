// @vitest-environment node
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerUpdateIpcHandlers } from '../../src/main/ipc/update-handlers'
import { createSenderValidator } from '../../src/main/ipc/sender'
import { resolveAppLocation } from '../../src/main/navigation'
import { UpdateCoordinator, type UpdaterAdapter } from '../../src/main/services/updater/coordinator'

class MockAdapter implements UpdaterAdapter {
  public autoDownload = false
  public autoInstallOnAppQuit = false
  public allowDowngrade = false
  public forceDevUpdateConfig = false
  public requestHeaders: Record<string, string> | null = null
  private readonly emitter = new EventEmitter()

  public setFeedURL(): void {}
  public async checkForUpdates(): Promise<unknown> {
    this.emitter.emit('update-available', { version: '0.1.1' })
    return null
  }
  public async downloadUpdate(): Promise<readonly string[]> {
    this.emitter.emit('update-downloaded', { version: '0.1.1' })
    return ['C:/temp/setup.exe']
  }
  public quitAndInstall(): void {}
  public on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener)
  }
  public off(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.off(event, listener)
  }
}

describe('update IPC handlers', () => {
  it('enforces sender validation, validates payloads, rejects event-only invocation, and forwards state events', async () => {
    const documentPath = resolve('app', 'out', 'renderer', 'index.html')
    const documentUrl = pathToFileURL(documentPath).href
    const validateSender = createSenderValidator({
      getTrustedWebContentsId: () => 42,
      location: resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
    })

    const sentEvents: Array<{ channel: string; payload: unknown }> = []
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sentEvents.push({ channel, payload })
        }
      }
    }

    const coordinator = new UpdateCoordinator({
      adapter: new MockAdapter(),
      currentVersion: '0.1.0',
      isPackaged: true,
      env: { PV_UPDATE_FEED_URL: 'https://updates.private.example/pv' },
      prepareForUpdateQuit: async () => {}
    })

    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
    registerUpdateIpcHandlers({
      handle: (channel, fn) => {
        handlers.set(channel, async (event, ...args) => {
          if (!validateSender(event as never)) {
            throw new Error(`Unauthorized IPC sender for ${channel}`)
          }
          return await fn(...args)
        })
      },
      updateCoordinator: coordinator,
      currentVersion: '0.1.0',
      getMainWindow: () => mockWindow as never
    })

    const trustedEvent = {
      sender: { id: 42 },
      senderFrame: { url: documentUrl, parent: null }
    }
    const untrustedEvent = {
      sender: { id: 99 },
      senderFrame: { url: documentUrl, parent: null }
    }

    await expect(handlers.get(IPC_CHANNELS.UPDATE_GET_STATE)!(untrustedEvent)).rejects.toThrow(
      /unauthorized/i
    )
    await expect(handlers.get(IPC_CHANNELS.UPDATE_STATE_EVENT)!(trustedEvent)).rejects.toThrow(
      /event-only/i
    )

    const initial = await handlers.get(IPC_CHANNELS.UPDATE_GET_STATE)!(trustedEvent)
    expect(initial).toMatchObject({ phase: 'idle', configured: true, currentVersion: '0.1.0' })

    const checkRes = await handlers.get(IPC_CHANNELS.UPDATE_CHECK)!(trustedEvent)
    expect(checkRes).toMatchObject({
      accepted: true,
      state: { phase: 'available', availableVersion: '0.1.1' }
    })

    const deferRes = await handlers.get(IPC_CHANNELS.UPDATE_DEFER)!(trustedEvent)
    expect(deferRes).toMatchObject({
      accepted: true,
      state: { phase: 'deferred', availableVersion: '0.1.1' }
    })

    expect(sentEvents.some((e) => e.channel === IPC_CHANNELS.UPDATE_STATE_EVENT)).toBe(true)
    const lastSent = sentEvents[sentEvents.length - 1]
    expect(lastSent?.payload).toMatchObject({ phase: 'deferred', availableVersion: '0.1.1' })

    coordinator.shutdown()
  })
})
