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
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
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
  it('exposes only the narrow typed methods', async () => {
    const api = await loadApi()
    expect(Object.keys(api).sort()).toEqual(
      [
        'getAppInfo',
        'getVaultStatus',
        'setTab',
        'selectRoots',
        'startScan',
        'pauseScan',
        'resumeScan',
        'cancelScan',
        'dismissScanJob',
        'getActiveScanJob',
        'getLatestScanJob',
        'onScanProgress',
        'getDuplicateGroups',
        'getDuplicateGroupMembers',
        'setDuplicateReview',
        'selectVaultDirectory',
        'initializeVault',
        'getActiveVault',
        'setActiveVault',
        'getImportCandidates',
        'startImport',
        'pauseImport',
        'resumeImport',
        'cancelImport',
        'getActiveImportJob',
        'getLatestImportJob',
        'onImportProgress',
        'getPhotosPage',
        'getThumbnail',
        'cancelThumbnail',
        'getPhotosDiagnostics',
        'setPhotoAnnotation',
        'getPhotoAnnotation',
        'listCollections',
        'createCollection',
        'renameCollection',
        'addCollectionMember',
        'removeCollectionMember',
        'getPhotoMemberships',
        'reconcileJournal',
        'startSimilarityAnalysis',
        'cancelSimilarityAnalysis',
        'resumeSimilarityAnalysis',
        'getSimilarityProgress',
        'getSimilarityPairs',
        'setSimilarityDecision',
        'reconcileSimilarity'
      ].sort()
    )
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
    await expect(
      api.setTab!(
        'settings' as unknown as import('../../src/shared/validation/ipc-schemas.js').NavigationTab
      )
    ).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('validates startScan requests and responses', async () => {
    electron.invoke.mockResolvedValueOnce({ success: true })
    const api = await loadApi()

    // Invalid request: empty roots
    await expect(api.startScan!({ roots: [] })).rejects.toThrow(/invalid/i)
    expect(electron.invoke).not.toHaveBeenCalled()

    // Valid request
    await expect(api.startScan!({ roots: ['D:/photos'] })).resolves.toEqual({ success: true })
    expect(electron.invoke).toHaveBeenCalledWith('scan:start-job', { roots: ['D:/photos'] })
  })

  it('validates selectRoots response', async () => {
    electron.invoke.mockResolvedValueOnce({ cancelled: false, rootPaths: ['D:/photos'] })
    const api = await loadApi()
    await expect(api.selectRoots!()).resolves.toEqual({
      cancelled: false,
      rootPaths: ['D:/photos']
    })
  })
})
