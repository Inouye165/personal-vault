import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App.js'
import type { VaultApi } from '../../src/preload/index.d.js'

const healthyApi = (): VaultApi =>
  ({
    getAppInfo: vi.fn(async () => ({
      name: 'Personal Vault',
      version: '0.1.0',
      platform: 'win32',
      isPackaged: false
    })),
    getVaultStatus: vi.fn(async () => ({ sourceCount: 0, itemCount: 0, isReady: true })),
    setTab: vi.fn(async () => true),
    selectRoots: vi.fn(async () => ({ cancelled: true, rootPaths: [] })),
    startScan: vi.fn(async () => ({ success: true })),
    pauseScan: vi.fn(async () => ({ success: true })),
    resumeScan: vi.fn(async () => ({ success: true })),
    cancelScan: vi.fn(async () => ({ success: true })),
    getActiveScanJob: vi.fn(async () => ({ job: null })),
    getLatestScanJob: vi.fn(async () => ({ job: null })),
    dismissScanJob: vi.fn(async () => ({ success: true })),
    onScanProgress: vi.fn(() => () => {}),
    getDuplicateGroups: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 20,
      hasMore: false
    })),
    getDuplicateGroupMembers: vi.fn(async () => ({
      sha256: 'a'.repeat(64),
      byteSize: 100,
      groupSignature: 'sig',
      reviewStatus: 'unreviewed' as const,
      preferredLocationId: null,
      hasStaleDecision: false,
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false
    })),
    setDuplicateReview: vi.fn(async () => ({
      sha256: 'a'.repeat(64),
      byteSize: 100,
      status: 'reviewed' as const,
      preferredLocationId: null,
      groupSignature: 'sig',
      reviewedAtMs: 1000
    })),
    selectVaultDirectory: vi.fn(async () => ({ selectedDirectory: null })),
    initializeVault: vi.fn(async () => ({
      vault: {
        formatVersion: 1 as const,
        vaultId: 'v-1',
        vaultName: 'Vault',
        createdAtMs: Date.now(),
        appVersion: '0.1.0'
      }
    })),
    getActiveVault: vi.fn(async () => ({ vault: null })),
    setActiveVault: vi.fn(async () => ({
      vault: { vaultId: 'v-1', vaultPath: 'D:/vault', name: 'Vault', createdAtMs: Date.now() }
    })),
    getImportCandidates: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false
    })),
    startImport: vi.fn(async () => ({
      job: {
        id: 'j-1',
        vaultId: 'v-1',
        status: 'running' as const,
        totalFiles: 0,
        totalBytes: 0,
        copiedFiles: 0,
        copiedBytes: 0,
        verifiedFiles: 0,
        failedFiles: 0,
        startedAtMs: Date.now()
      }
    })),
    pauseImport: vi.fn(async () => ({ success: true })),
    resumeImport: vi.fn(async () => ({ success: true })),
    cancelImport: vi.fn(async () => ({ success: true })),
    getActiveImportJob: vi.fn(async () => ({ job: null })),
    getLatestImportJob: vi.fn(async () => ({ job: null })),
    onImportProgress: vi.fn(() => () => {}),
    getPhotosPage: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
      hasMore: false
    })),
    getThumbnail: vi.fn(async () => ({
      status: 'missing' as const,
      locationId: 1,
      reason: 'mock'
    })),
    cancelThumbnail: vi.fn(async () => ({ success: true, locationId: 1 })),
    getPhotosDiagnostics: vi.fn(async () => ({
      activeWorkers: 0,
      queuedJobs: 0,
      totalDecodes: 0,
      cacheHits: 0,
      cacheMisses: 0
    }))
  }) as unknown as VaultApi

const mount = async () => {
  await act(async () => {
    render(<App />)
  })
}

const emptyHeading = () => screen.queryByRole('heading', { name: /no sources connected/i })

beforeEach(() => {
  window.api = healthyApi()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

describe('shell: confirmed empty state', () => {
  it('shows the product name, the five views and an honest empty state', async () => {
    await mount()
    expect(screen.getByRole('heading', { name: 'Personal Vault', level: 1 })).toBeInTheDocument()
    for (const name of ['All Items', 'Photos', 'Documents', 'Review', 'Duplicates']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(emptyHeading()).toBeInTheDocument()
    expect(screen.getByText(/never modified or deleted/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not show development-stage commentary or invented data', async () => {
    await mount()
    expect(screen.queryByText(/stage \d/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/engineering foundation/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/\b\d[\d,]*\s+(items|photos|documents)\b/i)).not.toBeInTheDocument()
  })

  it('disables search and explains why', async () => {
    await mount()
    const search = screen.getByRole('searchbox', { name: /search/i })
    expect(search).toBeDisabled()
    expect(search).toHaveAccessibleDescription(/unavailable until a source/i)
  })

  it('switches views, names the current view, and tells the main process', async () => {
    await mount()
    const photos = screen.getByRole('button', { name: 'Photos' })
    await act(async () => {
      fireEvent.click(photos)
    })
    expect(photos).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'All Items' })).not.toHaveAttribute('aria-current')
    expect(screen.getByText(/the photos view is empty/i)).toBeInTheDocument()
    expect(window.api.setTab).toHaveBeenCalledWith('photos')
  })
})

describe('shell: bridge states', () => {
  it('shows a loading status, not the empty state, while the bridge answers', async () => {
    const pending = new Promise<never>(() => {})
    window.api = { ...healthyApi(), getAppInfo: () => pending }
    await mount()
    expect(screen.getByRole('status')).toHaveTextContent(/connecting/i)
    expect(emptyHeading()).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an accessible error when window.api is missing', async () => {
    Reflect.deleteProperty(window, 'api')
    await mount()
    expect(screen.getByRole('alert')).toHaveTextContent(/could not (start|connect)/i)
    expect(emptyHeading()).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows an error when the main process rejects a request', async () => {
    window.api = {
      ...healthyApi(),
      getVaultStatus: vi.fn(async () => {
        throw new Error('Unauthorized IPC sender')
      })
    }
    await mount()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(emptyHeading()).not.toBeInTheDocument()
  })

  it('shows an error when the main process does not acknowledge a view change', async () => {
    window.api = { ...healthyApi(), setTab: vi.fn(async () => false) }
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Documents' }))
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('keeps search disabled while loading or failed', async () => {
    Reflect.deleteProperty(window, 'api')
    await mount()
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeDisabled()
  })
})
