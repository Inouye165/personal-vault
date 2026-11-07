import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App.js'
import type { VaultApi } from '../../src/preload/index.d.js'

describe('Stage 3 — Duplicate Review UI Integration', () => {
  const sampleGroup = {
    sha256: 'a'.repeat(64),
    byteSize: 1048576, // 1 MB
    fileCount: 2,
    groupSignature: 'sig111',
    reviewStatus: 'unreviewed' as const,
    preferredLocationId: null,
    hasStaleDecision: false,
    reviewedAtMs: null,
    previewLocations: [],
    truncatedLocations: false
  }

  const sampleMembers = [
    {
      fileLocationId: 101,
      sourceId: 1,
      originalPath: 'C:\\Photos\\IMG_001.JPG',
      normalizedPath: 'c:/photos/img_001.jpg',
      fileName: 'IMG_001.JPG',
      extension: '.jpg',
      category: 'photo' as const,
      byteSize: 1048576,
      filesystemBirthtimeMs: 1600000000000,
      filesystemMtimeMs: 1600000001000,
      inferredCaptureTimeMs: null,
      firstDiscoveredAtMs: 1600000002000,
      lastSeenAtMs: 1600000002000,
      discoveryObservationId: 10,
      hashObservationId: 20,
      activeHash: 'a'.repeat(64),
      activeHashVerifiedAtMs: 1600000003000,
      isPreferred: false
    },
    {
      fileLocationId: 102,
      sourceId: 2,
      originalPath: 'D:\\Backup\\copy_img.jpg',
      normalizedPath: 'd:/backup/copy_img.jpg',
      fileName: 'copy_img.jpg',
      extension: '.jpg',
      category: 'photo' as const,
      byteSize: 1048576,
      filesystemBirthtimeMs: null, // explicit unknown birthtime
      filesystemMtimeMs: 1600000001000,
      inferredCaptureTimeMs: null,
      firstDiscoveredAtMs: 1600000002000,
      lastSeenAtMs: 1600000002000,
      discoveryObservationId: 11,
      hashObservationId: 21,
      activeHash: 'a'.repeat(64),
      activeHashVerifiedAtMs: 1600000004000,
      isPreferred: false
    }
  ]

  let api: VaultApi

  beforeEach(() => {
    api = {
      getAppInfo: vi.fn(async () => ({
        name: 'Personal Vault',
        version: '0.1.0',
        platform: 'win32',
        isPackaged: false
      })),
      getVaultStatus: vi.fn(async () => ({ sourceCount: 2, itemCount: 5, isReady: true })),
      setTab: vi.fn(async () => true),
      selectRoots: vi.fn(async () => ({ cancelled: false, rootPaths: [] })),
      startScan: vi.fn(),
      pauseScan: vi.fn(),
      resumeScan: vi.fn(),
      cancelScan: vi.fn(),
      getActiveScanJob: vi.fn(async () => ({ job: null })),
      getLatestScanJob: vi.fn(async () => ({ job: null })),
      dismissScanJob: vi.fn(),
      onScanProgress: vi.fn(() => () => {}),
      getDuplicateGroups: vi.fn(async () => ({
        items: [sampleGroup],
        totalCount: 1,
        offset: 0,
        limit: 20,
        hasMore: false
      })),
      getDuplicateGroupMembers: vi.fn(async () => ({
        sha256: sampleGroup.sha256,
        byteSize: sampleGroup.byteSize,
        groupSignature: 'sig111',
        reviewStatus: 'unreviewed' as const,
        preferredLocationId: null,
        hasStaleDecision: false,
        items: sampleMembers,
        totalCount: 2,
        offset: 0,
        limit: 50,
        hasMore: false
      })),
      setDuplicateReview: vi.fn(async () => ({
        sha256: sampleGroup.sha256,
        byteSize: sampleGroup.byteSize,
        status: 'reviewed' as const,
        preferredLocationId: 101,
        groupSignature: 'sig111',
        reviewedAtMs: Date.now()
      }))
    } as unknown as VaultApi

    window.api = api
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  it('renders confirmed-empty state when no duplicate groups exist', async () => {
    ;(api.getDuplicateGroups as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      totalCount: 0,
      offset: 0,
      limit: 20,
      hasMore: false
    })

    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /duplicates/i })).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /duplicates/i }))

    await waitFor(() => {
      expect(screen.getByText(/no duplicate files found/i)).toBeDefined()
      expect(screen.getByText(/all cataloged files have unique content/i)).toBeDefined()
    })
  })

  it('renders duplicate groups, explains distinct operations, and displays side-by-side member inspection', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /duplicates/i })).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /duplicates/i }))

    // Explanations of distinct operations
    await waitFor(() => {
      expect(screen.getByText(/catalog-index removal/i)).toBeDefined()
      expect(screen.getByText(/vault-copy deletion/i)).toBeDefined()
      expect(screen.getByText(/original-source deletion/i)).toBeDefined()
    })

    // Inspect members
    await waitFor(() => {
      expect(screen.getByText('IMG_001.JPG')).toBeDefined()
      expect(screen.getByText('copy_img.jpg')).toBeDefined()
      expect(screen.getByText('C:\\Photos\\IMG_001.JPG')).toBeDefined()
      expect(screen.getByText('D:\\Backup\\copy_img.jpg')).toBeDefined()
      // Provenance: hash verification and observation ID
      expect(screen.getByText(/Observation #20/i)).toBeDefined()
      expect(screen.getByText(/Observation #21/i)).toBeDefined()
      // Explicit unknown creation date for second file
      expect(screen.getByText(/Unknown/i)).toBeDefined()
    })
  })

  it('allows marking group as reviewed and setting preferred location', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /duplicates/i })).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /duplicates/i }))

    await waitFor(() => expect(screen.getByText('IMG_001.JPG')).toBeDefined())

    // Click preferred location button/radio for IMG_001.JPG
    const preferBtns = screen.getAllByRole('button', { name: /preferred/i })
    expect(preferBtns.length).toBeGreaterThan(0)
    fireEvent.click(preferBtns[0]!)

    // Click Mark as Reviewed
    const reviewBtn = screen.getByRole('button', { name: /mark as reviewed/i })
    fireEvent.click(reviewBtn)

    await waitFor(() => {
      expect(api.setDuplicateReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sha256: sampleGroup.sha256,
          byteSize: sampleGroup.byteSize,
          status: 'reviewed',
          preferredLocationId: 101,
          expectedGroupSignature: 'sig111'
        })
      )
    })
  })

  it('handles stale review rejection and displays retry banner', async () => {
    ;(api.setDuplicateReview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Stale review: the duplicate group has changed since it was loaded.')
    )

    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /duplicates/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /duplicates/i }))

    await waitFor(() => expect(screen.getByText('IMG_001.JPG')).toBeDefined())

    const reviewBtn = screen.getByRole('button', { name: /mark as reviewed/i })
    fireEvent.click(reviewBtn)

    await waitFor(() => {
      expect(screen.getByText(/action failed/i)).toBeDefined()
      expect(
        screen.getByText(/stale review: the duplicate group has changed since it was loaded/i)
      ).toBeDefined()
    })
  })

  it('prevents stale async responses from replacing a newer selection on rapid clicks', async () => {
    const groupA = { ...sampleGroup, sha256: 'a'.repeat(64) }
    const groupB = { ...sampleGroup, sha256: 'b'.repeat(64) }

    ;(api.getDuplicateGroups as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [groupA, groupB],
      totalCount: 2,
      offset: 0,
      limit: 20,
      hasMore: false
    })

    let resolveGroupA!: (value: unknown) => void
    const groupAPromise = new Promise((resolve) => {
      resolveGroupA = resolve
    })

    ;(api.getDuplicateGroupMembers as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { sha256: string }) => {
        if (req.sha256 === groupA.sha256) {
          await groupAPromise
          return {
            sha256: groupA.sha256,
            byteSize: groupA.byteSize,
            groupSignature: 'sigA',
            reviewStatus: 'unreviewed',
            preferredLocationId: null,
            hasStaleDecision: false,
            items: [
              {
                ...sampleMembers[0],
                fileName: 'SLOW_FILE_A.JPG',
                activeHash: groupA.sha256
              }
            ],
            totalCount: 1,
            offset: 0,
            limit: 50,
            hasMore: false
          }
        }
        return {
          sha256: groupB.sha256,
          byteSize: groupB.byteSize,
          groupSignature: 'sigB',
          reviewStatus: 'unreviewed',
          preferredLocationId: null,
          hasStaleDecision: false,
          items: [
            {
              ...sampleMembers[0],
              fileName: 'FAST_FILE_B.JPG',
              activeHash: groupB.sha256
            }
          ],
          totalCount: 1,
          offset: 0,
          limit: 50,
          hasMore: false
        }
      }
    )

    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /duplicates/i })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /duplicates/i }))

    // Now select group B immediately
    await waitFor(() => {
      const items = screen.getAllByRole('listitem')
      expect(items.length).toBe(2)
      fireEvent.click(items[1]!) // Click group B
    })

    // Group B loads fast
    await waitFor(() => {
      expect(screen.getByText('FAST_FILE_B.JPG')).toBeDefined()
    })

    // Now resolve slow Group A response
    resolveGroupA(true)
    await new Promise((r) => setTimeout(r, 50))

    // FAST_FILE_B.JPG must still be displayed! Slow group A response must NOT overwrite group B!
    expect(screen.getByText('FAST_FILE_B.JPG')).toBeDefined()
    expect(screen.queryByText('SLOW_FILE_A.JPG')).toBeNull()
  })
})
