// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogDatabase, DatabaseClosedError } from '../../src/main/services/catalog'

describe('Stage 7A — DocumentRepository', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-doc-repo-'))
    dbPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
  })

  afterEach(() => {
    if (!catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedMixedCatalog() {
    const sourceRoot = join(tempDir, 'docs-source')
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: join(sourceRoot, 'receipt_2025.pdf'),
        fileName: 'receipt_2025.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 4096,
        birthtimeMs: 1_690_000_000_000,
        mtimeMs: 1_695_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'notes_100%.md'),
        fileName: 'notes_100%.md',
        extension: '.MD',
        category: 'document',
        byteSize: 512,
        birthtimeMs: null,
        mtimeMs: null,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'manual_v1.txt'),
        fileName: 'manual_v1.txt',
        extension: '.txt',
        category: 'document',
        byteSize: 1024,
        birthtimeMs: 1_691_000_000_000,
        mtimeMs: 1_696_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'contract.pdf'),
        fileName: 'contract.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 8192,
        birthtimeMs: 1_692_000_000_000,
        mtimeMs: 1_697_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      },
      {
        originalPath: join(sourceRoot, 'sunset.jpg'),
        fileName: 'sunset.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 2048,
        birthtimeMs: 1_693_000_000_000,
        mtimeMs: 1_698_000_000_000,
        discoveredAtMs: 1_700_000_000_000
      }
    ])

    const page = catalog.getDocumentsPage({ offset: 0, limit: 50 })
    const pdfReceipt = page.items.find((i) => i.fileName === 'receipt_2025.pdf')!
    catalog.recordHashObservationsBatch([
      {
        originalPath: pdfReceipt.originalPath,
        sha256: 'a'.repeat(64),
        observedByteSize: 4096,
        observedMtimeMs: 1_695_000_000_000,
        hashedAtMs: 1_700_000_001_000
      }
    ])

    return { sourceRoot }
  }

  it('lists only category=document items deterministically with pagination and honest status', () => {
    seedMixedCatalog()

    const page1 = catalog.getDocumentsPage({ offset: 0, limit: 2 })
    expect(page1.totalCount).toBe(4)
    expect(page1.items).toHaveLength(2)
    expect(page1.items.every((item) => item.extractionStatus === 'not_extracted')).toBe(true)
    expect(page1.items.every((item) => item.previewStatus === 'not_implemented')).toBe(true)
    expect(page1.items.map((item) => item.fileName)).toEqual(['receipt_2025.pdf', 'notes_100%.md'])

    const page2 = catalog.getDocumentsPage({ offset: 2, limit: 2 })
    expect(page2.totalCount).toBe(4)
    expect(page2.items.map((item) => item.fileName)).toEqual(['manual_v1.txt', 'contract.pdf'])

    // Null timestamps and unhashed state remain explicitly null (never fabricated)
    const mdItem = page1.items[1]!
    expect(mdItem.filesystemBirthtimeMs).toBeNull()
    expect(mdItem.filesystemMtimeMs).toBeNull()
    expect(mdItem.activeHash).toBeNull()
    expect(mdItem.activeHashVerifiedAtMs).toBeNull()

    // Hashed item includes active SHA-256 and verification timestamp
    const pdfItem = page1.items[0]!
    expect(pdfItem.activeHash).toBe('a'.repeat(64))
    expect(pdfItem.activeHashVerifiedAtMs).toBe(1_700_000_001_000)
  })

  it('filters by extension and escaped filename substring', () => {
    seedMixedCatalog()

    const pdfs = catalog.getDocumentsPage({
      offset: 0,
      limit: 50,
      extensionFilter: '.pdf'
    })
    expect(pdfs.totalCount).toBe(2)
    expect(pdfs.items.map((i) => i.fileName)).toEqual(['receipt_2025.pdf', 'contract.pdf'])

    // Literal '%' in filenameQuery must not act as a wildcard matching everything
    const percentMatch = catalog.getDocumentsPage({
      offset: 0,
      limit: 50,
      filenameQuery: '100%'
    })
    expect(percentMatch.totalCount).toBe(1)
    expect(percentMatch.items[0]!.fileName).toBe('notes_100%.md')

    // Case-insensitive extension filter matches .MD
    const mdFilter = catalog.getDocumentsPage({
      offset: 0,
      limit: 50,
      extensionFilter: '.md'
    })
    expect(mdFilter.totalCount).toBe(1)
    expect(mdFilter.items[0]!.fileName).toBe('notes_100%.md')
  })

  it('returns full recorded detail provenance and excludes non-document items', () => {
    const { sourceRoot } = seedMixedCatalog()
    const page = catalog.getDocumentsPage({ offset: 0, limit: 50 })
    const target = page.items.find((i) => i.fileName === 'receipt_2025.pdf')!

    const detail = catalog.getDocumentDetail(target.fileLocationId)
    expect(detail).not.toBeNull()
    expect(detail!.sourceRootPath).toBe(sourceRoot)
    expect(detail!.originalPath).toBe(join(sourceRoot, 'receipt_2025.pdf'))
    expect(detail!.activeHash).toBe('a'.repeat(64))
    expect(detail!.extractionStatus).toBe('not_extracted')
    expect(detail!.previewStatus).toBe('not_implemented')

    // Photo record ID must return null from getDocumentDetail
    const photoPage = catalog.queryFileLocations({ category: 'photo', offset: 0, limit: 10 })
    expect(photoPage.items).toHaveLength(1)
    expect(catalog.getDocumentDetail(photoPage.items[0]!.id)).toBeNull()
  })

  it('paginates extension facets without silently truncating available extensions', () => {
    seedMixedCatalog()

    const facetsPage1 = catalog.getDocumentExtensionFacets({ offset: 0, limit: 2 })
    expect(facetsPage1.totalCount).toBe(3)
    expect(facetsPage1.items).toEqual([
      { extension: '.pdf', count: 2 },
      { extension: '.md', count: 1 }
    ])

    const facetsPage2 = catalog.getDocumentExtensionFacets({ offset: 2, limit: 2 })
    expect(facetsPage2.totalCount).toBe(3)
    expect(facetsPage2.items).toEqual([{ extension: '.txt', count: 1 }])
  })

  it('throws DatabaseClosedError when catalog is closed', () => {
    catalog.close()
    expect(() => catalog.getDocumentsPage({ offset: 0, limit: 20 })).toThrow(DatabaseClosedError)
    expect(() => catalog.getDocumentDetail(1)).toThrow(DatabaseClosedError)
    expect(() => catalog.getDocumentExtensionFacets({ offset: 0, limit: 20 })).toThrow(
      DatabaseClosedError
    )
  })
})
