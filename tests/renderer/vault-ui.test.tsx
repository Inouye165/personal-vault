import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultImportPanel } from '../../src/renderer/src/components/VaultImportPanel'
import type { VaultApi } from '../../src/preload/index.d.js'

function setWindowApi(api: Partial<VaultApi>): void {
  ;(window as unknown as { api: Partial<VaultApi> }).api = api
}

describe('VaultImportPanel UI Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders operation distinction notice', async () => {
    setWindowApi({
      getActiveVault: vi.fn().mockResolvedValue({ vault: null }),
      getImportCandidates: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getActiveImportJob: vi.fn().mockResolvedValue({ job: null }),
      getLatestImportJob: vi.fn().mockResolvedValue({ job: null }),
      onImportProgress: vi.fn().mockReturnValue(() => {})
    })

    await act(async () => {
      render(<VaultImportPanel />)
    })

    expect(screen.getByText(/operations distinction/i)).toBeInTheDocument()
    expect(screen.getByText(/strictly read-only/i)).toBeInTheDocument()
  })

  it('renders vault initialization card when no vault is configured and allows selection', async () => {
    const mockSelectDir = vi.fn().mockResolvedValue({ selectedDirectory: 'D:\\MyVault' })
    const mockInitVault = vi.fn().mockResolvedValue({
      vault: {
        formatVersion: 1,
        vaultId: 'v-1',
        vaultName: 'Personal Vault',
        createdAtMs: Date.now(),
        appVersion: '0.1.0'
      }
    })

    setWindowApi({
      getActiveVault: vi.fn().mockResolvedValue({ vault: null }),
      getImportCandidates: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getActiveImportJob: vi.fn().mockResolvedValue({ job: null }),
      getLatestImportJob: vi.fn().mockResolvedValue({ job: null }),
      selectVaultDirectory: mockSelectDir,
      initializeVault: mockInitVault,
      onImportProgress: vi.fn().mockReturnValue(() => {})
    })

    await act(async () => {
      render(<VaultImportPanel />)
    })

    const chooseBtn = screen.getByText(/choose vault directory/i)
    await act(async () => {
      fireEvent.click(chooseBtn)
    })

    expect(mockSelectDir).toHaveBeenCalled()
    expect(await screen.findByText(/initialize vault/i)).toBeInTheDocument()

    const initBtn = screen.getByText(/initialize vault/i)
    await act(async () => {
      fireEvent.click(initBtn)
    })

    expect(mockInitVault).toHaveBeenCalledWith({
      vaultPath: 'D:\\MyVault',
      vaultName: 'Personal Vault'
    })
  })

  it('renders candidates table and updates selection scope before starting import', async () => {
    const mockCandidates = [
      {
        fileLocationId: 1,
        sourceId: 10,
        originalPath: 'C:\\photos\\photo1.jpg',
        fileName: 'photo1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1024,
        filesystemBirthtimeMs: 1730000000000,
        filesystemMtimeMs: 1730000000000,
        inferredCaptureTimeMs: null,
        sha256: 'a'.repeat(64),
        discoveryObservationId: 100,
        hashObservationId: 200,
        vaultStatus: 'not_imported'
      }
    ]

    const mockStartImport = vi.fn().mockResolvedValue({
      job: {
        id: 'job-1',
        vaultId: 'v-1',
        status: 'running',
        totalFiles: 1,
        totalBytes: 1024,
        copiedFiles: 0,
        copiedBytes: 0,
        verifiedFiles: 0,
        failedFiles: 0,
        startedAtMs: Date.now()
      }
    })

    setWindowApi({
      getActiveVault: vi.fn().mockResolvedValue({
        vault: {
          vaultId: 'v-1',
          vaultPath: 'D:\\MyVault',
          name: 'My Vault',
          createdAtMs: Date.now()
        }
      }),
      getImportCandidates: vi.fn().mockResolvedValue({
        items: mockCandidates,
        totalCount: 1,
        hasMore: false
      }),
      getActiveImportJob: vi.fn().mockResolvedValue({ job: null }),
      getLatestImportJob: vi.fn().mockResolvedValue({ job: null }),
      startImport: mockStartImport,
      onImportProgress: vi.fn().mockReturnValue(() => {})
    })

    await act(async () => {
      render(<VaultImportPanel />)
    })

    expect(await screen.findByText('photo1.jpg')).toBeInTheDocument()
    expect(screen.getAllByText('D:\\MyVault').length).toBeGreaterThan(0)

    // Select the item
    const checkbox = screen.getByLabelText('Select photo1.jpg')
    await act(async () => {
      fireEvent.click(checkbox)
    })

    expect(screen.getByText(/start verified import \(1 files, 1.0 kb\)/i)).toBeInTheDocument()

    // Start import
    const startBtn = screen.getByText(/start verified import/i)
    await act(async () => {
      fireEvent.click(startBtn)
    })

    expect(mockStartImport).toHaveBeenCalledWith({
      vaultId: 'v-1',
      fileLocationIds: [1]
    })
  })

  it('renders recovery alert and resume button when job is interrupted', async () => {
    const mockResume = vi.fn().mockResolvedValue({
      job: {
        id: 'job-interrupted-1',
        vaultId: 'v-1',
        status: 'running',
        totalFiles: 2,
        totalBytes: 2048,
        copiedFiles: 1,
        copiedBytes: 1024,
        verifiedFiles: 1,
        failedFiles: 0,
        startedAtMs: Date.now()
      }
    })

    setWindowApi({
      getActiveVault: vi.fn().mockResolvedValue({
        vault: {
          vaultId: 'v-1',
          vaultPath: 'D:\\MyVault',
          name: 'My Vault',
          createdAtMs: Date.now()
        }
      }),
      getImportCandidates: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasMore: false }),
      getActiveImportJob: vi.fn().mockResolvedValue({
        job: {
          id: 'job-interrupted-1',
          vaultId: 'v-1',
          status: 'interrupted',
          totalFiles: 2,
          totalBytes: 2048,
          copiedFiles: 1,
          copiedBytes: 1024,
          verifiedFiles: 1,
          failedFiles: 0,
          startedAtMs: Date.now()
        }
      }),
      getLatestImportJob: vi.fn().mockResolvedValue({ job: null }),
      resumeImport: mockResume,
      onImportProgress: vi.fn().mockReturnValue(() => {})
    })

    await act(async () => {
      render(<VaultImportPanel />)
    })

    expect(await screen.findByText(/import interrupted/i)).toBeInTheDocument()
    expect(screen.getByText(/resume import/i)).toBeInTheDocument()

    const resumeBtn = screen.getByText(/resume import/i)
    await act(async () => {
      fireEvent.click(resumeBtn)
    })

    expect(mockResume).toHaveBeenCalled()
  })
})
