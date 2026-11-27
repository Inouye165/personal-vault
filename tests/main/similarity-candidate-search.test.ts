/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import {
  findAndPersistCandidatePairs,
  MAX_SIMILARITY_DISTANCE
} from '../../src/main/services/similarity/candidate-search'

describe('Stage 5C — Partitioned Similarity Candidate Search', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-sim-search-test-'))
    dbPath = join(tempDir, 'catalog.db')
    catalog = CatalogDatabase.open({ catalogPath: dbPath })
  })

  afterEach(() => {
    try {
      catalog.close()
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('detects similar photos and recompressed derivatives while excluding exact byte duplicates', () => {
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\img1.jpg',
        fileName: 'img1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      },
      {
        originalPath: 'C:\\photos\\img1_recompressed.jpg',
        fileName: 'img1_recompressed.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 800,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      },
      {
        originalPath: 'C:\\photos\\img1_exact_copy.jpg',
        fileName: 'img1_exact_copy.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      },
      {
        originalPath: 'C:\\photos\\unrelated.jpg',
        fileName: 'unrelated.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1500,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      }
    ])

    const p1 = catalog.getFileLocationByPath('C:\\photos\\img1.jpg')!
    const pRecompressed = catalog.getFileLocationByPath('C:\\photos\\img1_recompressed.jpg')!
    const pExact = catalog.getFileLocationByPath('C:\\photos\\img1_exact_copy.jpg')!
    const pUnrelated = catalog.getFileLocationByPath('C:\\photos\\unrelated.jpg')!

    const shaOriginal = '1'.repeat(64)
    const shaRecompressed = '2'.repeat(64)
    const shaExact = shaOriginal // EXACT byte duplicate!
    const shaUnrelated = '3'.repeat(64)

    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\img1.jpg',
      sha256: shaOriginal,
      observedByteSize: 1000,
      observedMtimeMs: 1000,
      hashedAtMs: 1000
    })
    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\img1_recompressed.jpg',
      sha256: shaRecompressed,
      observedByteSize: 800,
      observedMtimeMs: 1000,
      hashedAtMs: 1000
    })
    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\img1_exact_copy.jpg',
      sha256: shaExact,
      observedByteSize: 1000,
      observedMtimeMs: 1000,
      hashedAtMs: 1000
    })
    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\unrelated.jpg',
      sha256: shaUnrelated,
      observedByteSize: 1500,
      observedMtimeMs: 1000,
      hashedAtMs: 1000
    })

    // p1 fingerprint: 0000 0000 0000 0000
    catalog.savePhotoPerceptualHash({
      fileLocationId: p1.id,
      discoveryObservationId: p1.discoveryObservationId,
      contentSha256: shaOriginal,
      contentRevision: 'rev1',
      algorithmVersion: 'dhash64_v1',
      fingerprint: '0000000000000000',
      bucket0: 0,
      bucket1: 0,
      bucket2: 0,
      bucket3: 0
    })

    // pRecompressed fingerprint: 0000 0000 0000 0003 (2 bits diff from p1)
    catalog.savePhotoPerceptualHash({
      fileLocationId: pRecompressed.id,
      discoveryObservationId: pRecompressed.discoveryObservationId,
      contentSha256: shaRecompressed,
      contentRevision: 'rev2',
      algorithmVersion: 'dhash64_v1',
      fingerprint: '0000000000000003',
      bucket0: 0,
      bucket1: 0,
      bucket2: 0,
      bucket3: 3
    })

    // pExact fingerprint: identical fingerprint 0000 0000 0000 0000
    catalog.savePhotoPerceptualHash({
      fileLocationId: pExact.id,
      discoveryObservationId: pExact.discoveryObservationId,
      contentSha256: shaExact,
      contentRevision: 'rev3',
      algorithmVersion: 'dhash64_v1',
      fingerprint: '0000000000000000',
      bucket0: 0,
      bucket1: 0,
      bucket2: 0,
      bucket3: 0
    })

    // pUnrelated fingerprint: ffff ffff ffff ffff (64 bits diff)
    catalog.savePhotoPerceptualHash({
      fileLocationId: pUnrelated.id,
      discoveryObservationId: pUnrelated.discoveryObservationId,
      contentSha256: shaUnrelated,
      contentRevision: 'rev4',
      algorithmVersion: 'dhash64_v1',
      fingerprint: 'ffffffffffffffff',
      bucket0: 0xffff,
      bucket1: 0xffff,
      bucket2: 0xffff,
      bucket3: 0xffff
    })

    const jobId = 'test-job-1'
    catalog.createSimilarityJob({
      jobId,
      algorithmVersion: 'dhash64_v1',
      totalPhotos: 4,
      photoLocationIds: [p1.id, pRecompressed.id, pExact.id, pUnrelated.id]
    })

    const count = findAndPersistCandidatePairs(catalog, jobId, [
      p1.id,
      pRecompressed.id,
      pExact.id,
      pUnrelated.id
    ])

    // Should only find the pair (p1, pRecompressed) and (pExact, pRecompressed)!
    // EXACT byte duplicate (p1, pExact) MUST NOT be in similarity pairs!
    // Unrelated image MUST NOT be in similarity pairs!
    expect(count).toBeGreaterThanOrEqual(1)

    const pairsRes = catalog.getSimilarityCandidatePairs({ page: 1, pageSize: 10 })
    expect(pairsRes.totalCount).toBe(2)

    // Ensure p1 and pExact are not paired together
    const exactPair = pairsRes.pairs.find(
      (p) =>
        (p.locationIdA === p1.id && p.locationIdB === pExact.id) ||
        (p.locationIdA === pExact.id && p.locationIdB === p1.id)
    )
    expect(exactPair).toBeUndefined()

    // Ensure order is strictly locationIdA < locationIdB
    for (const pair of pairsRes.pairs) {
      expect(pair.locationIdA).toBeLessThan(pair.locationIdB)
      expect(pair.distance).toBeLessThanOrEqual(MAX_SIMILARITY_DISTANCE)
    }
  })
})
