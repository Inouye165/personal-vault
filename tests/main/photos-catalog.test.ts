/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CatalogDatabase } from '../../src/main/services/catalog/database'

describe('CatalogDatabase — Photo queries', () => {
  let tempDir: string
  let catalogPath: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-photos-cat-test-'))
    catalogPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath })
  })

  afterEach(() => {
    try {
      catalog.close()
    } catch {
      // ignore
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('filters catalog items strictly by photo category and preserves duplicates as distinct records', () => {
    const sourceRoot = 'C:\\test_photos'
    catalog.registerSource(sourceRoot)

    // Insert mixed photos and documents
    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: 'C:\\test_photos\\pic1.jpg',
        fileName: 'pic1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000001000,
        discoveredAtMs: 1700000002000
      },
      {
        originalPath: 'C:\\test_photos\\doc1.pdf',
        fileName: 'doc1.pdf',
        extension: '.pdf',
        category: 'document',
        byteSize: 5000,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000001000,
        discoveredAtMs: 1700000002000
      },
      {
        originalPath: 'C:\\test_photos\\pic1_copy.jpg',
        fileName: 'pic1_copy.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1700000000000,
        mtimeMs: 1700000001000,
        discoveredAtMs: 1700000002000
      }
    ])

    // Add identical hash to pic1 and pic1_copy
    const files = catalog.queryFileLocations({ category: 'photo' })
    expect(files.totalCount).toBe(2)
    expect(files.items).toHaveLength(2)

    catalog.recordHashObservationsBatch([
      {
        originalPath: files.items[0]!.originalPath,
        sha256: 'e'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: 1700000001000,
        hashedAtMs: 1700000003000
      },
      {
        originalPath: files.items[1]!.originalPath,
        sha256: 'e'.repeat(64),
        observedByteSize: 1000,
        observedMtimeMs: 1700000001000,
        hashedAtMs: 1700000003000
      }
    ])

    // Query again: both items are preserved distinctly
    const photoResults = catalog.queryFileLocations({ category: 'photo' })
    expect(photoResults.totalCount).toBe(2)
    expect(photoResults.items[0]!.id).not.toBe(photoResults.items[1]!.id)
    expect(photoResults.items[0]!.originalPath).toBe('C:\\test_photos\\pic1.jpg')
    expect(photoResults.items[1]!.originalPath).toBe('C:\\test_photos\\pic1_copy.jpg')
    expect(photoResults.items[0]!.activeHash).toBe('e'.repeat(64))
    expect(photoResults.items[1]!.activeHash).toBe('e'.repeat(64))
  })

  it('paginates photos deterministically ordered by location ID ASC', () => {
    const sourceRoot = 'C:\\photos_paging'
    catalog.registerSource(sourceRoot)

    const candidates = []
    for (let i = 0; i < 15; i++) {
      candidates.push({
        originalPath: `C:\\photos_paging\\photo_${String(i).padStart(2, '0')}.jpg`,
        fileName: `photo_${String(i).padStart(2, '0')}.jpg`,
        extension: '.jpg',
        category: 'photo' as const,
        byteSize: 1000 + i,
        birthtimeMs: null,
        mtimeMs: 1700000000000 + i,
        discoveredAtMs: 1700000000000
      })
    }

    catalog.persistDiscoveryBatch(sourceRoot, candidates)

    const page1 = catalog.queryFileLocations({ category: 'photo', offset: 0, limit: 10 })
    expect(page1.totalCount).toBe(15)
    expect(page1.items).toHaveLength(10)
    expect(page1.hasMore).toBe(true)

    const page2 = catalog.queryFileLocations({ category: 'photo', offset: 10, limit: 10 })
    expect(page2.totalCount).toBe(15)
    expect(page2.items).toHaveLength(5)
    expect(page2.hasMore).toBe(false)

    // IDs are strictly ascending
    for (let i = 1; i < page1.items.length; i++) {
      expect(page1.items[i]!.id).toBeGreaterThan(page1.items[i - 1]!.id)
    }
  })
})
