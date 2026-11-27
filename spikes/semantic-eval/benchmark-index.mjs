#!/usr/bin/env node
/**
 * Personal Vault — Stage 6A Semantic Evaluation Spike: Vector Index & Scan Cost Benchmark
 *
 * Benchmarks exact linear scan over L2-normalized 512-d Float32 vectors in SQLite / TypedArrays
 * at declared catalog sizes (1,000, 10,000, 25,000, and 50,000 items — labeled as synthetic vectors).
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { l2NormalizeFloat32, rankSemanticMatches } from './semantic-core.mjs'

function createSyntheticNormalizedVector(dim = 512, seed = 1) {
  const arr = new Float32Array(dim)
  let s = seed >>> 0
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    arr[i] = (s / 0xffffffff) * 2.0 - 1.0
  }
  return l2NormalizeFloat32(arr).vector
}

export function runSyntheticIndexBenchmark(sizes = [1_000, 10_000, 25_000, 50_000]) {
  const results = []
  const queryVec = createSyntheticNormalizedVector(512, 999999)

  for (const count of sizes) {
    // 1. In-memory Float32Array scan benchmark
    const entries = new Array(count)
    for (let i = 0; i < count; i++) {
      entries[i] = {
        fileLocationId: i + 1,
        id: `synth_${i + 1}`,
        fileName: `photo_${i + 1}.jpg`,
        category: 'synthetic',
        vector: createSyntheticNormalizedVector(512, i + 1)
      }
    }

    const trials = 15
    const memScanTimes = []
    for (let t = 0; t < trials; t++) {
      const t0 = performance.now()
      rankSemanticMatches(queryVec, entries, { topK: 50, maxIndexedItems: 50_000 })
      memScanTimes.push(performance.now() - t0)
    }
    memScanTimes.sort((a, b) => a - b)
    const memMedianMs = memScanTimes[Math.floor(trials / 2)]
    const memP95Ms = memScanTimes[Math.min(trials - 1, Math.floor(trials * 0.95))]

    // 2. Streaming SQLite BLOB read + dot product benchmark (zero permanent RAM retention)
    const tempDir = mkdtempSync(join(tmpdir(), 'pv-sem-bench-'))
    const dbPath = join(tempDir, 'bench.db')
    const db = new DatabaseSync(dbPath)
    let sqliteScanMs
    let dbBytes
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE photo_embeddings (
          file_location_id INTEGER PRIMARY KEY,
          model_id TEXT NOT NULL,
          is_current INTEGER NOT NULL,
          embedding_blob BLOB NOT NULL
        );
        CREATE INDEX idx_emb_curr ON photo_embeddings(model_id, is_current);
      `)
      const insertStmt = db.prepare(
        'INSERT INTO photo_embeddings (file_location_id, model_id, is_current, embedding_blob) VALUES (?, ?, 1, ?);'
      )
      db.exec('BEGIN TRANSACTION;')
      for (let i = 0; i < count; i++) {
        const v = entries[i].vector
        const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength)
        insertStmt.run(i + 1, 'Xenova/clip-vit-base-patch32@6b7c5237', buf)
      }
      db.exec('COMMIT;')

      const selectStmt = db.prepare(
        'SELECT file_location_id, embedding_blob FROM photo_embeddings WHERE model_id = ? AND is_current = 1;'
      )
      const tSql0 = performance.now()
      const topCandidates = []
      for (const row of selectStmt.iterate('Xenova/clip-vit-base-patch32@6b7c5237')) {
        const u8 = row.embedding_blob
        const vec = new Float32Array(u8.buffer, u8.byteOffset, 512)
        let dot = 0
        for (let k = 0; k < 512; k++) {
          dot += queryVec[k] * vec[k]
        }
        topCandidates.push({ fileLocationId: row.file_location_id, score: dot })
      }
      topCandidates.sort((a, b) => b.score - a.score || a.fileLocationId - b.fileLocationId)
      const top50 = topCandidates.slice(0, 50)
      sqliteScanMs = performance.now() - tSql0
      if (top50.length === 0) throw new Error('Unexpected empty result')

      const pageCount = db.prepare('PRAGMA page_count;').get().page_count
      const pageSize = db.prepare('PRAGMA page_size;').get().page_size
      dbBytes = pageCount * pageSize
    } finally {
      db.close()
      rmSync(tempDir, { recursive: true, force: true })
    }

    results.push({
      librarySize: count,
      vectorPayloadBytes: count * 512 * 4,
      vectorPayloadMiB: Number(((count * 512 * 4) / (1024 * 1024)).toFixed(2)),
      sqliteStorageMiB: Number((dbBytes / (1024 * 1024)).toFixed(2)),
      inMemoryScanMedianMs: Number(memMedianMs.toFixed(2)),
      inMemoryScanP95Ms: Number(memP95Ms.toFixed(2)),
      sqliteStreamingScanMs: Number(sqliteScanMs.toFixed(2))
    })
  }

  return results
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[\\/]/, ''))
) {
  const res = runSyntheticIndexBenchmark()
  console.log('\n[benchmark-index] Synthetic 512-d Float32 Exact Scan Benchmark:')
  console.table(res)
}
