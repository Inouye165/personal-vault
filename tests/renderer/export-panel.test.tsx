// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportPanel } from '../../src/renderer/src/components/ExportPanel'

describe('Stage 8A Slice 3: ExportPanel UI', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('defaults privacy checkboxes to unchecked and wires destination, start, verify, and items', async () => {
    const selectExportDestination = vi
      .fn()
      .mockResolvedValue({ canceled: false, directoryPath: 'D:\\exports' })
    const startExport = vi.fn().mockResolvedValue({
      id: 'job-1',
      bundleDir: 'D:\\exports\\personal-vault-export',
      bundleFolderName: 'personal-vault-export',
      status: 'running',
      privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
      manifestPublished: false,
      bundleVerified: false,
      incompleteReasons: [],
      totalItems: 2,
      exportedItems: 0,
      failedItems: 0,
      cancelledItems: 0,
      vaultIntegrityWarnings: 0,
      errorCode: null,
      errorMessage: null,
      startedAtMs: 1000,
      updatedAtMs: 1000,
      completedAtMs: null
    })
    const listExportJobs = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'job-0',
          bundleDir: 'D:\\exports\\prev-bundle',
          bundleFolderName: 'prev-bundle',
          status: 'completed',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          manifestPublished: true,
          bundleVerified: true,
          incompleteReasons: [],
          totalItems: 1,
          exportedItems: 1,
          failedItems: 0,
          cancelledItems: 0,
          vaultIntegrityWarnings: 0,
          errorCode: null,
          errorMessage: null,
          startedAtMs: 500,
          updatedAtMs: 600,
          completedAtMs: 600
        }
      ],
      total: 1,
      limit: 20,
      offset: 0
    })
    const getActiveExportJob = vi.fn().mockResolvedValue(null)
    const verifyExportJob = vi.fn().mockResolvedValue(null)
    const getExportJobItems = vi.fn().mockResolvedValue({
      items: [
        {
          jobId: 'job-0',
          fileLocationId: 10,
          discoveryObservationId: 10,
          hashObservationId: 10,
          category: 'photo',
          originalFileName: 'pic.jpg',
          expectedSha256: 'a'.repeat(64),
          expectedByteSize: 123,
          status: 'completed',
          exportedFileName: 'pic.jpg',
          sidecarFileName: 'pic.jpg.pv-meta.json',
          byteSourceUsed: 'source_file',
          vaultIntegrityWarning: null,
          errorCode: null,
          errorMessage: null,
          updatedAtMs: 600
        }
      ],
      total: 1,
      limit: 100,
      offset: 0
    })
    const onExportProgress = vi.fn().mockReturnValue(() => {})

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        selectExportDestination,
        startExport,
        listExportJobs,
        getActiveExportJob,
        verifyExportJob,
        getExportJobItems,
        onExportProgress
      }
    })

    render(<ExportPanel selectedLocationIds={[10, 20]} />)

    await waitFor(() => {
      expect(screen.getByText('prev-bundle')).toBeInTheDocument()
    })

    const origPathsCheckbox = screen.getByLabelText(/include original source paths/i)
    const extractedTextCheckbox = screen.getByLabelText(/include extracted document text/i)
    expect(origPathsCheckbox).not.toBeChecked()
    expect(extractedTextCheckbox).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /select export folder/i }))
    await waitFor(() => {
      expect(screen.getByText('D:\\exports')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /export selected \(2\)/i }))
    await waitFor(() => {
      expect(startExport).toHaveBeenCalledWith({
        parentDir: 'D:\\exports',
        bundleFolderName: 'personal-vault-export',
        fileLocationIds: [10, 20],
        privacyOptions: {
          includeOriginalPaths: false,
          includeExtractedText: false
        }
      })
    })

    fireEvent.click(screen.getByRole('button', { name: /verify on disk/i }))
    await waitFor(() => {
      expect(verifyExportJob).toHaveBeenCalledWith('job-0')
    })

    fireEvent.click(screen.getByRole('button', { name: /view items/i }))
    await waitFor(() => {
      expect(screen.getByText(/pic\.jpg — completed/i)).toBeInTheDocument()
    })
  })
})
