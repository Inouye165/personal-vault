// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposed: {} as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (
      name: string,
      api: Record<string, (...args: unknown[]) => Promise<unknown>>
    ) => {
      electron.exposed[name] = api
    }
  },
  ipcRenderer: { invoke: electron.invoke }
}))

async function loadApi() {
  vi.resetModules()
  await import('../../src/preload/index')
  const api = electron.exposed['api']
  if (!api) throw new Error('window.api was not exposed')
  return api
}

beforeEach(() => {
  electron.invoke.mockReset()
  for (const key of Object.keys(electron.exposed)) delete electron.exposed[key]
})

describe('preload bridge', () => {
  it('exposes only the three narrow methods', async () => {
    const api = await loadApi()
    expect(Object.keys(api).sort()).toEqual(['getAppInfo', 'getVaultStatus', 'setTab'])
  })

  it('returns validated responses', async () => {
    electron.invoke.mockResolvedValueOnce({ sourceCount: 0, itemCount: 0, isReady: true })
    const api = await loadApi()
    await expect(api.getVaultStatus!()).resolves.toEqual({
      sourceCount: 0,
      itemCount: 0,
      isReady: true
    })
  })

  it('rejects a malformed application info response', async () => {
    electron.invoke.mockResolvedValueOnce({ name: 'Personal Vault' })
    const api = await loadApi()
    await expect(api.getAppInfo!()).rejects.toThrow(/invalid/i)
  })

  it('returns the setTab acknowledgement when it is a boolean', async () => {
    electron.invoke.mockResolvedValueOnce(true)
    const api = await loadApi()
    await expect(api.setTab!('photos')).resolves.toBe(true)
    expect(electron.invoke).toHaveBeenCalledWith('navigation:set-tab', 'photos')
  })

  it.each([
    ['a string', 'yes'],
    ['undefined', undefined],
    ['an object', { accepted: true }]
  ])('rejects a setTab acknowledgement that is %s', async (_label, response) => {
    electron.invoke.mockResolvedValueOnce(response)
    const api = await loadApi()
    await expect(api.setTab!('photos')).rejects.toThrow(/invalid/i)
  })

  it('rejects an unknown tab without calling the main process', async () => {
    const api = await loadApi()
    await expect(api.setTab!('settings')).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()
  })
})
