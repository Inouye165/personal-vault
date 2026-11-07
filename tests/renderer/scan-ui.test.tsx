import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App.js'
import type { VaultApi } from '../../src/preload/index.d.js'
import type { ScanJobProgress } from '../../src/shared/validation/ipc-schemas.js'

describe('Stage 2D — Scan Job UI Integration', () => {
  let progressCallback: ((progress: ScanJobProgress) => void) | null = null

  const mockApi = (): VaultApi => ({
    getAppInfo: vi.fn(async () => ({
      name: 'Personal Vault',
      version: '0.1.0',
      platform: 'win32',
      isPackaged: false
    })),
    getVaultStatus: vi.fn(async () => ({ sourceCount: 0, itemCount: 0, isReady: true })),
    setTab: vi.fn(async () => true),
    selectRoots: vi.fn(async () => ({ cancelled: false, rootPaths: ['D:/photos'] })),
    startScan: vi.fn(async () => ({
      success: true,
      job: {
        jobId: 1,
        status: 'running' as const,
        phase: 'discovery' as const,
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
      }
    })),
    pauseScan: vi.fn(async () => ({ success: true })),
    resumeScan: vi.fn(async () => ({ success: true })),
    cancelScan: vi.fn(async () => ({ success: true })),
    getActiveScanJob: vi.fn(async () => ({ job: null })),
    onScanProgress: vi.fn((cb) => {
      progressCallback = cb
      return () => {
        progressCallback = null
      }
    })
  })

  beforeEach(() => {
    progressCallback = null
    window.api = mockApi()
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  const mount = async () => {
    await act(async () => {
      render(<App />)
    })
  }

  it('renders a button to select source folders in the empty state', async () => {
    await mount()
    const selectBtn = screen.getByRole('button', { name: /select source folders/i })
    expect(selectBtn).toBeInTheDocument()
  })

  it('selects source roots and allows starting a scan', async () => {
    await mount()
    const selectBtn = screen.getByRole('button', { name: /select source folders/i })

    await act(async () => {
      fireEvent.click(selectBtn)
    })

    expect(window.api.selectRoots).toHaveBeenCalled()
    expect(screen.getByText('D:/photos')).toBeInTheDocument()

    const startBtn = screen.getByRole('button', { name: /start scan/i })
    await act(async () => {
      fireEvent.click(startBtn)
    })

    expect(window.api.startScan).toHaveBeenCalledWith({ roots: ['D:/photos'] })
  })

  it('displays real-time progress, counters, and pause/cancel controls when a job is active', async () => {
    await mount()

    // Simulate progress event from main
    await act(async () => {
      progressCallback?.({
        jobId: 1,
        status: 'running',
        phase: 'hashing',
        roots: ['D:/photos'],
        discoveredCount: 100,
        hashedCount: 40,
        totalFilesToHash: 100,
        totalBytes: 500000,
        hashedBytes: 200000,
        skippedCount: 5,
        errorCount: 0,
        currentPath: 'D:/photos/vacation.jpg',
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null
      })
    })

    const progressbar = screen.getByRole('progressbar')
    expect(progressbar).toBeInTheDocument()
    expect(progressbar).toHaveAttribute('aria-valuenow', '40')

    expect(screen.getByText(/40 \/ 100/)).toBeInTheDocument()
    expect(screen.getByText(/vacation\.jpg/)).toBeInTheDocument()

    const pauseBtn = screen.getByRole('button', { name: /pause/i })
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    expect(pauseBtn).toBeInTheDocument()
    expect(cancelBtn).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(pauseBtn)
    })
    expect(window.api.pauseScan).toHaveBeenCalledWith(1)
  })

  it('renders recovery alert and resume button when an interrupted job is detected', async () => {
    window.api.getActiveScanJob = vi.fn(async () => ({
      job: {
        jobId: 42,
        status: 'interrupted' as const,
        phase: 'hashing' as const,
        roots: ['D:/photos'],
        discoveredCount: 50,
        hashedCount: 20,
        totalFilesToHash: 50,
        totalBytes: 100000,
        hashedBytes: 40000,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: null
      }
    }))

    await mount()

    expect(screen.getByRole('alert')).toHaveTextContent(/interrupted/i)
    const resumeBtn = screen.getByRole('button', { name: /resume/i })
    expect(resumeBtn).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(resumeBtn)
    })
    expect(window.api.resumeScan).toHaveBeenCalledWith(42)
  })

  it('displays errors visibly and never presents partial work as complete', async () => {
    await mount()

    await act(async () => {
      progressCallback?.({
        jobId: 1,
        status: 'completed',
        phase: 'completed',
        roots: ['D:/photos'],
        discoveredCount: 10,
        hashedCount: 9,
        totalFilesToHash: 10,
        totalBytes: 50000,
        hashedBytes: 45000,
        skippedCount: 0,
        errorCount: 1,
        errors: [
          {
            path: 'D:/photos/locked.jpg',
            code: 'permission_denied',
            message: 'EACCES: permission denied',
            phase: 'hashing'
          }
        ],
        startedAtMs: 1000,
        updatedAtMs: 2000,
        completedAtMs: 2000
      })
    })

    expect(screen.getByText(/permission_denied/i)).toBeInTheDocument()
    expect(screen.getByText(/locked\.jpg/)).toBeInTheDocument()
  })
})
