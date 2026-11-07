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

describe('Stage 3 — Preload duplicate bridge', () => {
  it('exposes duplicate review methods on window.api', async () => {
    const api = await loadApi()
    expect(typeof api.getDuplicateGroups).toBe('function')
    expect(typeof api.getDuplicateGroupMembers).toBe('function')
    expect(typeof api.setDuplicateReview).toBe('function')
  })

  it('validates request and response across IPC for getDuplicateGroups', async () => {
    const api = await loadApi()
    electron.invoke.mockResolvedValueOnce({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 20,
      hasMore: false
    })

    const result = await api.getDuplicateGroups!({ offset: 0, limit: 20 })
    expect(result).toEqual({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 20,
      hasMore: false
    })
    expect(electron.invoke).toHaveBeenCalledWith('duplicates:get-groups', { offset: 0, limit: 20 })
  })

  it('validates request and response across IPC for setDuplicateReview', async () => {
    const api = await loadApi()
    const mockResponse = {
      sha256: 'a'.repeat(64),
      byteSize: 500,
      status: 'reviewed',
      preferredLocationId: 10,
      groupSignature: 'sig123',
      reviewedAtMs: 12345678
    }
    electron.invoke.mockResolvedValueOnce(mockResponse)

    const result = await api.setDuplicateReview!({
      sha256: 'a'.repeat(64),
      byteSize: 500,
      status: 'reviewed',
      preferredLocationId: 10,
      expectedGroupSignature: 'sig123'
    })
    expect(result).toEqual(mockResponse)
    expect(electron.invoke).toHaveBeenCalledWith('duplicates:set-review', {
      sha256: 'a'.repeat(64),
      byteSize: 500,
      status: 'reviewed',
      preferredLocationId: 10,
      expectedGroupSignature: 'sig123'
    })
  })
})
