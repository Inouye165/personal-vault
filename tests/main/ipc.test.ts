// @vitest-environment node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registered = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', isPackaged: true },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn)
  }
}))

import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { createSenderValidator } from '../../src/main/ipc/sender'
import { resolveAppLocation } from '../../src/main/navigation'
import type { ScanJobCoordinator } from '../../src/main/services/jobs'

const documentPath = resolve('app', 'out', 'renderer', 'index.html')
const documentUrl = pathToFileURL(documentPath).href
const TRUSTED_ID = 7

const trusted = { sender: { id: TRUSTED_ID }, senderFrame: { url: documentUrl, parent: null } }

const invoke = async (channel: string, event: unknown, ...args: unknown[]) => {
  const handler = registered.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler(event, ...args)
}

beforeEach(() => {
  registered.clear()
  const location = resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
  registerIpcHandlers({
    validateSender: createSenderValidator({ getTrustedWebContentsId: () => TRUSTED_ID, location })
  })
})

describe('IPC handlers: trusted sender', () => {
  it('returns application information', async () => {
    await expect(invoke(IPC_CHANNELS.APP_GET_INFO, trusted)).resolves.toMatchObject({
      name: 'Personal Vault',
      version: '1.2.3',
      isPackaged: true
    })
  })

  it('reports an honest empty vault', async () => {
    await expect(invoke(IPC_CHANNELS.VAULT_GET_STATUS, trusted)).resolves.toEqual({
      sourceCount: 0,
      itemCount: 0,
      isReady: true
    })
  })

  it('acknowledges a valid tab and refuses an invalid one', async () => {
    await expect(invoke(IPC_CHANNELS.NAVIGATE_SET_TAB, trusted, 'photos')).resolves.toBe(true)
    await expect(invoke(IPC_CHANNELS.NAVIGATE_SET_TAB, trusted, 'settings')).resolves.toBe(false)
  })

  it('handles scan directory selection', async () => {
    registered.clear()
    const location = resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
    registerIpcHandlers({
      validateSender: createSenderValidator({
        getTrustedWebContentsId: () => TRUSTED_ID,
        location
      }),
      selectDirectories: async () => ({ cancelled: false, filePaths: ['D:/photos'] })
    })

    await expect(invoke(IPC_CHANNELS.SCAN_SELECT_ROOTS, trusted)).resolves.toEqual({
      cancelled: false,
      rootPaths: ['D:/photos']
    })
  })

  it('handles scan job actions with validation', async () => {
    registered.clear()
    const location = resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
    const mockCoordinator = {
      startScan: vi.fn().mockResolvedValue({
        jobId: 1,
        status: 'running',
        phase: 'discovery',
        roots: ['D:/photos'],
        discoveredCount: 0,
        hashedCount: 0,
        totalFilesToHash: 0,
        totalBytes: 0,
        hashedBytes: 0,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 1000,
        completedAtMs: null
      }),
      pauseScan: vi.fn().mockResolvedValue({
        jobId: 1,
        status: 'paused',
        phase: 'discovery',
        roots: ['D:/photos'],
        discoveredCount: 0,
        hashedCount: 0,
        totalFilesToHash: 0,
        totalBytes: 0,
        hashedBytes: 0,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 1000,
        completedAtMs: null
      }),
      resumeScan: vi.fn(),
      cancelScan: vi.fn(),
      getActiveJob: vi.fn().mockReturnValue(null),
      getLatestJob: vi.fn().mockReturnValue(null),
      dismissScanJob: vi.fn(),
      onProgress: vi.fn()
    }

    registerIpcHandlers({
      validateSender: createSenderValidator({
        getTrustedWebContentsId: () => TRUSTED_ID,
        location
      }),
      coordinator: mockCoordinator as unknown as ScanJobCoordinator
    })

    // Start scan
    const startRes = await invoke(IPC_CHANNELS.SCAN_START_JOB, trusted, { roots: ['D:/photos'] })
    expect(startRes).toMatchObject({ success: true, job: { jobId: 1, status: 'running' } })

    // Pause scan
    const pauseRes = await invoke(IPC_CHANNELS.SCAN_PAUSE_JOB, trusted, { jobId: 1 })
    expect(pauseRes).toMatchObject({ success: true, job: { jobId: 1, status: 'paused' } })

    // Get active job
    const activeRes = await invoke(IPC_CHANNELS.SCAN_GET_ACTIVE_JOB, trusted)
    expect(activeRes).toEqual({ job: null })

    // Get latest job
    const latestRes = await invoke(IPC_CHANNELS.SCAN_GET_LATEST_JOB, trusted)
    expect(latestRes).toEqual({ job: null })

    // Dismiss job
    const dismissRes = await invoke(IPC_CHANNELS.SCAN_DISMISS_JOB, trusted, { jobId: 1 })
    expect(dismissRes).toEqual({ success: true })
    expect(mockCoordinator.dismissScanJob).toHaveBeenCalledWith(1)
  })
})

describe('IPC handlers: unauthorized sender', () => {
  const untrustedSenders: Array<[string, unknown]> = [
    ['a different WebContents', { ...trusted, sender: { id: 99 } }],
    ['a destroyed frame', { sender: { id: TRUSTED_ID }, senderFrame: null }],
    [
      'a subframe of the trusted window',
      { sender: { id: TRUSTED_ID }, senderFrame: { url: documentUrl, parent: {} } }
    ],
    [
      'a remote page in the trusted window',
      { sender: { id: TRUSTED_ID }, senderFrame: { url: 'https://example.com/', parent: null } }
    ],
    [
      'another local file in the trusted window',
      {
        sender: { id: TRUSTED_ID },
        senderFrame: { url: pathToFileURL(resolve('app', 'x.html')).href, parent: null }
      }
    ]
  ]

  for (const channel of Object.values(IPC_CHANNELS)) {
    it.each(untrustedSenders)(`rejects ${channel} from %s`, async (_label, event) => {
      await expect(invoke(channel, event, 'photos')).rejects.toThrow(/unauthorized/i)
    })
  }

  it('rejects every sender while no window is registered', async () => {
    registered.clear()
    registerIpcHandlers({
      validateSender: createSenderValidator({
        getTrustedWebContentsId: () => undefined,
        location: resolveAppLocation({ isPackaged: true, rendererUrl: undefined, documentPath })
      })
    })
    await expect(invoke(IPC_CHANNELS.APP_GET_INFO, trusted)).rejects.toThrow(/unauthorized/i)
  })
})
