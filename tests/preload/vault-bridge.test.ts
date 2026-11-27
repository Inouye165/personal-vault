import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface GlobalWithWindow {
  window?: {
    api?: import('../../src/preload/index.d.js').VaultApi
  }
}

describe('Preload Bridge — Stage 4 Vault Methods', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    delete (globalThis as GlobalWithWindow).window
  })

  it('exposes vault methods on window.api with runtime validation', async () => {
    const ipcRendererMock = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }

    vi.doMock('electron', () => ({
      contextBridge: {
        exposeInMainWorld: (_key: string, api: unknown) => {
          ;(globalThis as GlobalWithWindow).window = {
            api: api as import('../../src/preload/index.d.js').VaultApi
          }
        }
      },
      ipcRenderer: ipcRendererMock
    }))

    await import('../../src/preload/index')

    const api = (globalThis as GlobalWithWindow).window?.api
    expect(api).toBeDefined()
    if (!api) return
    expect(typeof api.selectVaultDirectory).toBe('function')
    expect(typeof api.initializeVault).toBe('function')
    expect(typeof api.getActiveVault).toBe('function')
    expect(typeof api.getImportCandidates).toBe('function')
    expect(typeof api.startImport).toBe('function')
    expect(typeof api.pauseImport).toBe('function')
    expect(typeof api.resumeImport).toBe('function')
    expect(typeof api.cancelImport).toBe('function')
    expect(typeof api.onImportProgress).toBe('function')
  })
})
