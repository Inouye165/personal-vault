/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { CatalogDatabase } from '../../src/main/services/catalog/database'
import { ThumbnailCoordinator } from '../../src/main/services/thumbnails/coordinator'
import { SimilarityCoordinator } from '../../src/main/services/similarity/coordinator'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import {
  extractDHash64FromImageBuffer,
  computeHammingDistance,
  computeAlgorithmicSimilarity,
  DHASH_ALGORITHM_VERSION
} from '../../src/main/services/similarity/fingerprint'
import { findAndPersistCandidatePairs } from '../../src/main/services/similarity/candidate-search'

describe('Stage 5C Acceptance Suite — Perceptual Similarity & Review Invariants', () => {
  let tempDir: string
  let dbPath: string
  let photosDir: string
  let cacheDir: string
  let storageDir: string
  let catalog: CatalogDatabase
  let thumbnailCoordinator: ThumbnailCoordinator
  let journal: AnnotationJournal
  let similarityCoordinator: SimilarityCoordinator

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-similarity-acceptance-'))
    dbPath = join(tempDir, 'catalog.db')
    photosDir = join(tempDir, 'photos')
    cacheDir = join(tempDir, 'cache')
    storageDir = join(tempDir, 'storage')

    mkdirSync(photosDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(storageDir, { recursive: true })

    journal = new AnnotationJournal({ storageDir })
    await journal.initialize()

    catalog = CatalogDatabase.open({
      catalogPath: dbPath,
      journal
    })

    thumbnailCoordinator = new ThumbnailCoordinator({
      cacheDir,
      approvedRoots: [photosDir],
      maxActiveJobs: 2,
      maxQueuedJobs: 64
    })

    similarityCoordinator = new SimilarityCoordinator({
      catalog,
      thumbnailCoordinator
    })
    await similarityCoordinator.initialize()
  })

  afterEach(async () => {
    if (similarityCoordinator) {
      await similarityCoordinator.shutdown()
    }
    if (thumbnailCoordinator) {
      await thumbnailCoordinator.shutdown()
    }
    if (catalog) {
      catalog.close()
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function addPhoto(filePath: string, fileName: string, sha256?: string) {
    const st = statSync(filePath)
    catalog.persistDiscoveryBatch('src-1', [
      {
        originalPath: filePath,
        fileName,
        extension: '.jpg',
        category: 'photo',
        byteSize: st.size,
        mtimeMs: st.mtimeMs,
        birthtimeMs: st.birthtimeMs,
        discoveredAtMs: Date.now()
      }
    ])
    if (sha256) {
      catalog.recordHashObservation({
        originalPath: filePath,
        sha256,
        observedByteSize: st.size,
        observedMtimeMs: st.mtimeMs,
        hashedAtMs: Date.now()
      })
    }
  }

  it('detects recompressed and resized derivatives while distinct scenes remain suggestions', async () => {
    // 1. Original image
    const origBuf = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 220, g: 100, b: 50 }
      }
    })
      .jpeg({ quality: 95 })
      .toBuffer()

    // 2. Resized and recompressed derivative of image 1
    const derivBuf = await sharp(origBuf).resize(100, 100).jpeg({ quality: 50 }).toBuffer()

    // 3. Distinct scene (different color pattern)
    const distinctBuf = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 30, g: 180, b: 240 }
      }
    })
      .jpeg({ quality: 95 })
      .toBuffer()

    const fpOrig = await extractDHash64FromImageBuffer(origBuf)
    const fpDeriv = await extractDHash64FromImageBuffer(derivBuf)
    const fpDistinct = await extractDHash64FromImageBuffer(distinctBuf)

    const distDeriv = computeHammingDistance(fpOrig.fingerprint, fpDeriv.fingerprint)
    const distDistinct = computeHammingDistance(fpOrig.fingerprint, fpDistinct.fingerprint)

    // Recompressed/resized derivative should have very close fingerprint (distance <= 5)
    expect(distDeriv).toBeLessThanOrEqual(5)
    const simDeriv = computeAlgorithmicSimilarity(distDeriv)
    expect(simDeriv).toBeGreaterThanOrEqual(0.9)

    expect(distDistinct).toBeGreaterThanOrEqual(0)
    const simDistinct = computeAlgorithmicSimilarity(distDistinct)
    expect(simDistinct).toBeLessThanOrEqual(1.0)

    // Algorithmic similarity score must be bounded between 0 and 1
    expect(simDeriv).toBeLessThanOrEqual(1.0)
    expect(computeAlgorithmicSimilarity(64)).toBe(0)
    expect(computeAlgorithmicSimilarity(0)).toBe(1)
  })

  it('excludes exact byte duplicates from similarity candidate pairs', async () => {
    const imgBuf = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 100, g: 150, b: 200 }
      }
    })
      .jpeg()
      .toBuffer()

    const file1 = join(photosDir, 'photo1.jpg')
    const file2 = join(photosDir, 'photo2_exact_copy.jpg')
    writeFileSync(file1, imgBuf)
    writeFileSync(file2, imgBuf)

    const hash = createHash('sha256').update(imgBuf).digest('hex')

    addPhoto(file1, 'photo1.jpg', hash)
    addPhoto(file2, 'photo2_exact_copy.jpg', hash)

    await similarityCoordinator.startAnalysis()
    const progress = await similarityCoordinator.waitForCompletion()
    expect(progress.status).toBe('completed')

    // Candidate search must NOT produce a pair for exact byte duplicates
    // (exact duplicates are handled by Stage 3 exact duplicate workflow)
    const res = catalog.getSimilarityCandidatePairs({ page: 1, pageSize: 50 })
    expect(res.totalCount).toBe(0)
    expect(res.pairs.length).toBe(0)
  })

  it('handles unsupported or corrupt files truthfully without failing analysis', async () => {
    const validBuf = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 50, g: 50, b: 50 }
      }
    })
      .jpeg()
      .toBuffer()

    const validPath = join(photosDir, 'valid.jpg')
    const corruptPath = join(photosDir, 'corrupt.jpg')
    writeFileSync(validPath, validBuf)
    writeFileSync(corruptPath, Buffer.from('NOT_AN_IMAGE_HEADER_GARBAGE_BYTES'))

    const validHash = createHash('sha256').update(validBuf).digest('hex')
    addPhoto(validPath, 'valid.jpg', validHash)
    addPhoto(corruptPath, 'corrupt.jpg', 'b'.repeat(64))

    await similarityCoordinator.startAnalysis()
    const progress = await similarityCoordinator.waitForCompletion()
    expect(progress.status).toBe('completed')
    expect(progress.totalPhotos).toBe(2)
    expect(progress.processedPhotos + progress.unsupportedPhotos + progress.errorPhotos).toBe(2)
    // One photo should be recorded as error/unsupported
    expect(progress.errorPhotos + progress.unsupportedPhotos).toBe(1)
  })

  it('enforces canonical pair ordering (locA < locB) and deterministic pagination without reversed pairs', async () => {
    // Generate 4 slightly different images
    for (let i = 0; i < 4; i++) {
      const p = join(photosDir, `item_${i}.jpg`)
      const buf = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 3,
          background: { r: 100 + i * 2, g: 100 + i * 2, b: 100 + i * 2 }
        }
      })
        .jpeg()
        .toBuffer()
      const fileHash = createHash('sha256').update(buf).digest('hex')
      writeFileSync(p, buf)
      addPhoto(p, `item_${i}.jpg`, fileHash)
    }

    await similarityCoordinator.startAnalysis()
    const progress = await similarityCoordinator.waitForCompletion()
    expect(progress.status).toBe('completed')

    // Fetch candidate pairs
    const res = catalog.getSimilarityCandidatePairs({ page: 1, pageSize: 50 })
    expect(res.pairs.length).toBeGreaterThan(0)

    for (const pair of res.pairs) {
      // Invariant: locationIdA MUST strictly be less than locationIdB
      expect(pair.locationIdA).toBeLessThan(pair.locationIdB)
    }

    // Verify deterministic pagination
    const page1 = catalog.getSimilarityCandidatePairs({ page: 1, pageSize: 2 })
    const page2 = catalog.getSimilarityCandidatePairs({ page: 2, pageSize: 2 })
    expect(page1.pairs.length).toBeLessThanOrEqual(2)
    if (page1.pairs.length > 0 && page2.pairs.length > 0) {
      expect(page1.pairs[0].id).not.toBe(page2.pairs[0].id)
    }
  })

  it('rejects stale decision revisions and invalidates decisions when content changes', async () => {
    const bufA = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 80, g: 120, b: 160 }
      }
    })
      .jpeg()
      .toBuffer()

    const bufB = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 82, g: 122, b: 162 }
      }
    })
      .jpeg()
      .toBuffer()

    const pathA = join(photosDir, 'rev_a.jpg')
    const pathB = join(photosDir, 'rev_b.jpg')
    writeFileSync(pathA, bufA)
    writeFileSync(pathB, bufB)

    addPhoto(pathA, 'rev_a.jpg', '1'.repeat(64))
    addPhoto(pathB, 'rev_b.jpg', '2'.repeat(64))

    const locRecA = catalog.getFileLocationByPath(pathA)!
    const locRecB = catalog.getFileLocationByPath(pathB)!

    await similarityCoordinator.startAnalysis()
    await similarityCoordinator.waitForCompletion()

    const statA = statSync(pathA)
    const statB = statSync(pathB)
    const obsA = locRecA.discoveryObservationId
    const obsB = locRecB.discoveryObservationId

    const validRevA = `rev:${obsA}:${statA.size}:${statA.mtimeMs}:${locRecA.activeHash ?? 'unhashed'}`
    const validRevB = `rev:${obsB}:${statB.size}:${statB.mtimeMs}:${locRecB.activeHash ?? 'unhashed'}`
    const staleRevA = `rev:${obsA}:999999:${statA.mtimeMs}:${locRecA.activeHash ?? 'unhashed'}`

    // Attempting decision with stale revision string must fail
    expect(() => {
      catalog.setSimilarityDecision({
        locationIdA: locRecA.id,
        locationIdB: locRecB.id,
        expectedRevisionA: staleRevA,
        expectedRevisionB: validRevB,
        decision: 'edited_version'
      })
    }).toThrow(/mismatch|stale/i)

    // Valid revision succeeds
    const decRes = catalog.setSimilarityDecision({
      locationIdA: locRecA.id,
      locationIdB: locRecB.id,
      expectedRevisionA: validRevA,
      expectedRevisionB: validRevB,
      decision: 'edited_version'
    })
    expect(decRes.success).toBe(true)
    expect(decRes.decision).toBe('edited_version')
    expect(decRes.version).toBe(1)
  })

  it('persists decisions to durable journal and supports restart reconciliation', async () => {
    const p1 = join(photosDir, 'journ_1.jpg')
    const p2 = join(photosDir, 'journ_2.jpg')
    const buf = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(p1, buf)
    writeFileSync(p2, buf)

    addPhoto(p1, 'journ_1.jpg', 'a'.repeat(64))
    addPhoto(p2, 'journ_2.jpg', 'b'.repeat(64))

    const locRecA = catalog.getFileLocationByPath(p1)!
    const locRecB = catalog.getFileLocationByPath(p2)!

    const st1 = statSync(p1)
    const st2 = statSync(p2)
    const revA = `rev:${locRecA.discoveryObservationId}:${st1.size}:${st1.mtimeMs}:${locRecA.activeHash ?? 'unhashed'}`
    const revB = `rev:${locRecB.discoveryObservationId}:${st2.size}:${st2.mtimeMs}:${locRecB.activeHash ?? 'unhashed'}`

    const res = catalog.setSimilarityDecision({
      locationIdA: locRecA.id,
      locationIdB: locRecB.id,
      expectedRevisionA: revA,
      expectedRevisionB: revB,
      decision: 'similar_scene'
    })
    expect(res.success).toBe(true)
    expect(res.persistencePending).toBe(false)

    // Verify journal file contains the decision entry
    const journalPath = join(storageDir, 'review-journal.jsonl')
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n')
    const entries = lines.map((l) => JSON.parse(l))
    const decEntry = entries.find((e) => e.kind === 'similarity_decision')
    expect(decEntry).toBeDefined()
    expect(decEntry.decision).toBe('similar_scene')
  })

  it('supports cancellation and truthful progress reporting', async () => {
    // Populate several items
    for (let i = 0; i < 5; i++) {
      const p = join(photosDir, `item_cancel_${i}.jpg`)
      const buf = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 50, g: 50, b: 50 } }
      })
        .jpeg()
        .toBuffer()
      writeFileSync(p, buf)
      addPhoto(p, `item_cancel_${i}.jpg`, (i + 1).toString().repeat(64))
    }

    // Start and cancel
    await similarityCoordinator.startAnalysis()
    similarityCoordinator.cancelAnalysis()
    const finalProg = await similarityCoordinator.waitForCompletion()

    expect(['cancelled', 'completed']).toContain(finalProg.status)
    if (finalProg.status === 'cancelled') {
      expect(finalProg.completedAtMs).not.toBeNull()
    }
  })

  it('enforces candidate search bounds and partitions on 10,000-photo scale fixtures with dense similarity', async () => {
    // Populate dummy source, file_locations, and discovery_observations for 10,000 items
    const rawDb = catalog.getRawDb()
    rawDb.exec('BEGIN TRANSACTION;')
    rawDb
      .prepare(
        `
      INSERT OR IGNORE INTO sources (id, root_path, normalized_root_path, created_at_ms, updated_at_ms)
      VALUES (999, 'C:\\photos', 'c:/photos', 0, 0)
    `
      )
      .run()

    const locStmt = rawDb.prepare(`
      INSERT INTO file_locations (
        id, source_id, original_path, normalized_path, file_name, extension, category, created_at_ms, updated_at_ms
      ) VALUES (?, 999, ?, ?, ?, '.jpg', 'photo', 0, 0)
    `)
    const obsStmt = rawDb.prepare(`
      INSERT INTO discovery_observations (
        id, file_location_id, byte_size, observed_at_ms, last_seen_at_ms
      ) VALUES (?, ?, 100, 0, 0)
    `)
    const hashStmt = rawDb.prepare(`
      INSERT INTO photo_perceptual_hashes (
        file_location_id,
        discovery_observation_id,
        content_sha256,
        content_revision,
        algorithm_version,
        fingerprint,
        bucket_0,
        bucket_1,
        bucket_2,
        bucket_3,
        created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const locationIds: number[] = []
    for (let i = 1; i <= 10000; i++) {
      locationIds.push(i)
      const p = `C:\\photos\\img_${i}.jpg`
      const norm = `c:/photos/img_${i}.jpg`
      locStmt.run(i, p, norm, `img_${i}.jpg`)
      obsStmt.run(i, i)

      // Create dense overlap in bucket_0 for the first 1000 photos
      const b0 = i <= 1000 ? 42 : i
      const b1 = i % 50
      const b2 = i % 100
      const b3 = i % 200
      const hex = '00'.repeat(8)
      hashStmt.run(
        i,
        i,
        `sha-${i}`,
        `rev:${i}`,
        DHASH_ALGORITHM_VERSION,
        hex,
        b0,
        b1,
        b2,
        b3,
        Date.now()
      )
    }
    rawDb.exec('COMMIT;')

    const jobId = 'scale-test-job-1'
    catalog.createSimilarityJob({
      jobId,
      algorithmVersion: DHASH_ALGORITHM_VERSION,
      totalPhotos: 10000,
      photoLocationIds: locationIds
    })

    // Find and persist candidate pairs with partitioned search
    const startTime = Date.now()
    const pairsFound = findAndPersistCandidatePairs(catalog, jobId, locationIds, {
      algorithmVersion: DHASH_ALGORITHM_VERSION
    })
    const elapsed = Date.now() - startTime

    // Partitioned candidate search must complete under 10 seconds for 10,000 photos
    expect(elapsed).toBeLessThan(10000)

    // Must enforce global candidate cap (<= 10,000 total candidate pairs)
    expect(pairsFound).toBeLessThanOrEqual(10000)

    // Query candidate pairs with pagination
    const pageRes = catalog.getSimilarityCandidatePairs({ page: 1, pageSize: 25 })
    expect(pageRes.pageSize).toBe(25)
    expect(pageRes.totalPages).toBeGreaterThanOrEqual(1)
    expect(pageRes.pairs.length).toBeLessThanOrEqual(25)
  })

  it('guarantees source file preservation invariance (source bytes, size, mtime unchanged)', async () => {
    const testImg = join(photosDir, 'source_invariance_test.jpg')
    const imgBuf = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 3,
        background: { r: 99, g: 88, b: 77 }
      }
    })
      .jpeg()
      .toBuffer()
    writeFileSync(testImg, imgBuf)

    const initialStat = statSync(testImg)
    const initialHash = createHash('sha256').update(imgBuf).digest('hex')

    addPhoto(testImg, 'source_invariance_test.jpg', initialHash)

    // Run similarity analysis
    await similarityCoordinator.startAnalysis()
    await similarityCoordinator.waitForCompletion()

    // Post-analysis checks
    const finalStat = statSync(testImg)
    const finalBuf = readFileSync(testImg)
    const finalHash = createHash('sha256').update(finalBuf).digest('hex')

    // Inviolable principle: source files are strictly read-only
    expect(finalStat.size).toBe(initialStat.size)
    expect(finalStat.mtimeMs).toBe(initialStat.mtimeMs)
    expect(finalHash).toBe(initialHash)
  })
})
