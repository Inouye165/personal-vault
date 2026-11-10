/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/services/catalog/migrations'

describe('Stage 5C — Catalog Schema Migration 8 and Similarity Operations', () => {
  let tempDir: string
  let dbPath: string
  let catalog: CatalogDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-similarity-test-'))
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

  it('sets CURRENT_SCHEMA_VERSION to at least 8 and creates similarity tables', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(8)
    const tables = catalog
      .getRawDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table';")
      .all() as { name: string }[]
    const tableNames = tables.map((t) => t.name)

    expect(tableNames).toContain('photo_perceptual_hashes')
    expect(tableNames).toContain('similarity_candidate_pairs')
    expect(tableNames).toContain('similarity_decisions')
    expect(tableNames).toContain('similarity_jobs')
    expect(tableNames).toContain('similarity_job_items')
  })

  it('saves and retrieves perceptual hash with bucket indexing and revision tracking', () => {
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\pic1.jpg',
        fileName: 'pic1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 10000,
        birthtimeMs: 1000,
        mtimeMs: 2000,
        discoveredAtMs: 2000
      }
    ])

    const loc = catalog.getFileLocationByPath('C:\\photos\\pic1.jpg')!
    const sha = '1111111111111111111111111111111111111111111111111111111111111111'
    catalog.recordHashObservation({
      originalPath: 'C:\\photos\\pic1.jpg',
      sha256: sha,
      observedByteSize: 10000,
      observedMtimeMs: 2000,
      hashedAtMs: 3000
    })

    const revision = `rev:${loc.discoveryObservationId}:10000:2000:${sha}`

    catalog.savePhotoPerceptualHash({
      fileLocationId: loc.id,
      discoveryObservationId: loc.discoveryObservationId,
      contentSha256: sha,
      contentRevision: revision,
      algorithmVersion: 'dhash64_v1',
      fingerprint: '0123456789abcdef',
      bucket0: 0x0123,
      bucket1: 0x4567,
      bucket2: 0x89ab,
      bucket3: 0xcdef,
      width: 1920,
      height: 1080
    })

    const hashRecord = catalog.getPhotoPerceptualHash(loc.id, 'dhash64_v1')
    expect(hashRecord).not.toBeNull()
    expect(hashRecord?.fingerprint).toBe('0123456789abcdef')
    expect(hashRecord?.bucket0).toBe(0x0123)
    expect(hashRecord?.bucket1).toBe(0x4567)
    expect(hashRecord?.bucket2).toBe(0x89ab)
    expect(hashRecord?.bucket3).toBe(0xcdef)
    expect(hashRecord?.width).toBe(1920)
    expect(hashRecord?.height).toBe(1080)
    expect(hashRecord?.contentRevision).toBe(revision)
    expect(hashRecord?.isCurrent).toBe(true)
  })

  it('enforces canonical order and stores/retrieves similarity decisions', () => {
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\a.jpg',
        fileName: 'a.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      },
      {
        originalPath: 'C:\\photos\\b.jpg',
        fileName: 'b.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 2000,
        birthtimeMs: 2000,
        mtimeMs: 2000,
        discoveredAtMs: 2000
      }
    ])

    const locA = catalog.getFileLocationByPath('C:\\photos\\a.jpg')!
    const locB = catalog.getFileLocationByPath('C:\\photos\\b.jpg')!

    const revA = `rev:${locA.discoveryObservationId}:${locA.byteSize}:${locA.filesystemMtimeMs ?? 'null'}:${locA.activeHash ?? 'unhashed'}`
    const revB = `rev:${locB.discoveryObservationId}:${locB.byteSize}:${locB.filesystemMtimeMs ?? 'null'}:${locB.activeHash ?? 'unhashed'}`

    // Pass in reversed order (locB.id > locA.id)
    const result = catalog.setSimilarityDecision({
      locationIdA: locB.id,
      locationIdB: locA.id,
      expectedRevisionA: revB,
      expectedRevisionB: revA,
      decision: 'edited_version'
    })

    expect(result.decision).toBe('edited_version')
    expect(result.version).toBe(1)

    // Retrieve decision
    const decision = catalog.getSimilarityDecision(locA.id, locB.id)
    expect(decision).not.toBeNull()
    expect(decision?.decision).toBe('edited_version')
    expect(decision?.locationIdA).toBe(Math.min(locA.id, locB.id))
    expect(decision?.locationIdB).toBe(Math.max(locA.id, locB.id))

    // Setting unreviewed clears active decision
    const clearResult = catalog.setSimilarityDecision({
      locationIdA: locA.id,
      locationIdB: locB.id,
      expectedRevisionA: revA,
      expectedRevisionB: revB,
      decision: 'unreviewed'
    })
    expect(clearResult.decision).toBe('unreviewed')
    const cleared = catalog.getSimilarityDecision(locA.id, locB.id)
    expect(cleared).toBeNull()
  })

  it('manages similarity jobs and marks running jobs as interrupted', () => {
    catalog.persistDiscoveryBatch('C:\\photos', [
      {
        originalPath: 'C:\\photos\\1.jpg',
        fileName: '1.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      },
      {
        originalPath: 'C:\\photos\\2.jpg',
        fileName: '2.jpg',
        extension: '.jpg',
        category: 'photo',
        byteSize: 1000,
        birthtimeMs: 1000,
        mtimeMs: 1000,
        discoveredAtMs: 1000
      }
    ])
    const loc1 = catalog.getFileLocationByPath('C:\\photos\\1.jpg')!
    const loc2 = catalog.getFileLocationByPath('C:\\photos\\2.jpg')!

    const job = catalog.createSimilarityJob({
      jobId: 'job-sim-1',
      algorithmVersion: 'dhash64_v1',
      totalPhotos: 2,
      photoLocationIds: [loc1.id, loc2.id]
    })
    expect(job.jobId).toBe('job-sim-1')
    expect(job.status).toBe('running')
    expect(job.totalPhotos).toBe(2)

    const items = catalog.getSimilarityJobItems('job-sim-1')
    expect(items.length).toBe(2)
    expect(items[0]?.status).toBe('pending')

    // Mark as interrupted on crash/restart
    catalog.markRunningSimilarityJobsAsInterrupted()
    const updated = catalog.getSimilarityJob('job-sim-1')
    expect(updated?.status).toBe('interrupted')
  })
})
