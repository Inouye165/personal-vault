// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { AnnotationJournal } from '../../src/main/services/annotations/journal'
import { CatalogDatabase } from '../../src/main/services/catalog'
import { DocumentClassificationCoordinator } from '../../src/main/services/documents/classification/coordinator'
import { DOC_SEMANTIC_EMBEDDING_DIMENSIONS } from '../../src/main/services/documents/semantic/manifest'
import { l2NormalizeDocVector } from '../../src/main/services/documents/semantic/vector'
import { buildDocumentContentRevision } from '../../src/main/services/catalog/document-snapshot-query'
import { AppWorkerBudget } from '../../src/main/services/worker-budget'

const { registeredHandlers, mockHandle } = vi.hoisted(() => {
  const registeredHandlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown
  >()
  const mockHandle = vi.fn(
    (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown) => {
      registeredHandlers.set(channel, fn)
    }
  )
  return { registeredHandlers, mockHandle }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle,
    removeHandler: vi.fn()
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  app: {
    getPath: vi.fn(() => tmpdir()),
    getVersion: vi.fn(() => '0.1.0')
  }
}))

describe('Stage 7E Slice 3 — Document Classification IPC, Filtering & Semantic Revalidation', () => {
  let tempDir: string
  let catalog: CatalogDatabase
  let journal: AnnotationJournal
  let clsCoordinator: DocumentClassificationCoordinator

  beforeEach(async () => {
    registeredHandlers.clear()
    mockHandle.mockClear()
    tempDir = mkdtempSync(join(tmpdir(), 'pv-stage7e-ipc-'))
    journal = new AnnotationJournal({ storageDir: join(tempDir, 'journal') })
    await journal.initialize()
    catalog = CatalogDatabase.open({
      catalogPath: join(tempDir, 'catalog.db'),
      journal
    })
    clsCoordinator = new DocumentClassificationCoordinator({
      catalog,
      workerBudget: new AppWorkerBudget(3)
    })
  })

  afterEach(async () => {
    await clsCoordinator.shutdown()
    catalog.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedDocument(params: {
    fileName: string
    relativeDir: string
    extractedText?: string | null
    sha256: string
  }): number {
    const sourceRoot = join(tempDir, 'src')
    const origPath = join(sourceRoot, params.relativeDir, params.fileName)
    const ext = params.fileName.includes('.') ? `.${params.fileName.split('.').pop()}` : ''
    const byteSize = (params.extractedText ?? '').length || 128
    const mtimeMs = 1_700_000_000_000

    catalog.persistDiscoveryBatch(sourceRoot, [
      {
        originalPath: origPath,
        fileName: params.fileName,
        extension: ext,
        category: 'document',
        byteSize,
        birthtimeMs: mtimeMs,
        mtimeMs,
        discoveredAtMs: mtimeMs
      }
    ])
    catalog.recordHashObservation({
      originalPath: origPath,
      sha256: params.sha256,
      observedByteSize: byteSize,
      observedMtimeMs: mtimeMs,
      hashedAtMs: mtimeMs
    })

    const loc = catalog.getFileLocationByPath(origPath)!
    if (params.extractedText !== undefined && params.extractedText !== null) {
      const db = catalog.getRawDb()
      const obs = db
        .prepare(
          'SELECT id FROM discovery_observations WHERE file_location_id = ? AND is_current = 1;'
        )
        .get(loc.id) as { id: number }
      const contentRev = buildDocumentContentRevision({
        discoveryObservationId: obs.id,
        byteSize,
        filesystemMtimeMs: mtimeMs,
        activeHash: params.sha256
      })
      db.prepare(
        `INSERT INTO document_extractions (
          file_location_id, discovery_observation_id, content_sha256, observed_byte_size,
          observed_mtime_ms, content_revision, recipe_version, extraction_status,
          extracted_text, extracted_char_count, truncated, is_current, extracted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'doc_extract_v1', 'extracted', ?, ?, 0, 1, ?);`
      ).run(
        loc.id,
        obs.id,
        params.sha256,
        byteSize,
        mtimeMs,
        contentRev,
        params.extractedText,
        params.extractedText.length,
        mtimeMs
      )
      catalog.bumpDocumentClassificationMutationSeq()
    }
    return loc.id
  }

  it('enforces trusted-sender checks, classifies via IPC, filters page with Show all default, and handles override conflicts + persistencePending', async () => {
    const trustedSender = { id: 42 }
    const untrustedSender = { id: 999 }
    const trustedEvent = {
      sender: trustedSender,
      senderFrame: { parent: null, url: 'app://local' }
    }
    const untrustedEvent = {
      sender: untrustedSender,
      senderFrame: { parent: null, url: 'https://evil.test' }
    }

    registerIpcHandlers({
      validateSender: (event) =>
        (event as { sender?: { id: number } }).sender?.id === trustedSender.id,
      catalog,
      documentClassificationCoordinator: clsCoordinator
    })

    const noticeId = seedDocument({
      fileName: 'LICENSE.txt',
      relativeDir: 'repos/pkg-0',
      extractedText:
        'SPDX-License-Identifier: MIT\nPermission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\nWITHOUT WARRANTY OF ANY KIND.\n',
      sha256: 'a'.repeat(64)
    })
    const receiptId = seedDocument({
      fileName: 'groceries_receipt.txt',
      relativeDir: 'Personal/Receipts',
      extractedText:
        'Receipt #104\nMilk $3.50\nBread $2.50\nSubtotal: $6.00\nTotal: $6.50\nPaid Visa',
      sha256: 'b'.repeat(64)
    })
    const proseId = seedDocument({
      fileName: 'journal_entry.txt',
      relativeDir: 'Personal/Notes',
      extractedText:
        'Today was a quiet afternoon walking by the river and thinking about summer plans.',
      sha256: 'c'.repeat(64)
    })
    const unknownId = seedDocument({
      fileName: 'scan_pending.pdf',
      relativeDir: 'Personal/Scans',
      extractedText: null,
      sha256: 'd'.repeat(64)
    })

    // 1. Untrusted sender rejected
    await expect(
      registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_CLASSIFY_GET_PROGRESS)!(untrustedEvent)
    ).rejects.toThrow()

    // 2. Event-only channel cannot be invoked
    await expect(
      registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_CLASSIFY_PROGRESS_EVENT)!(trustedEvent)
    ).rejects.toThrow(/Event-only/)

    // 3. Classify all documents via IPC
    const prog = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_CLASSIFY_START)!(
      trustedEvent,
      { scope: 'all' }
    )) as { status: string; totalItems: number; clutterItems: number }
    expect(prog.status).toBe('completed')
    expect(prog.totalItems).toBe(4)
    expect(prog.clutterItems).toBe(1)

    // 4. Default browsing (show_all) returns all 4 documents + exact scoped hiddenClutterCount = 1
    const pageAll = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_PAGE)!(trustedEvent, {
      offset: 0,
      limit: 50
    })) as {
      items: Array<{ fileLocationId: number }>
      totalCount: number
      hiddenClutterCount: number
    }
    expect(pageAll.totalCount).toBe(4)
    expect(pageAll.hiddenClutterCount).toBe(1)

    // 5. Opt-in hide_clutter hides noticeId, keeps receiptId, proseId ('other'), unknownId ('unknown')
    const pageHide = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_PAGE)!(trustedEvent, {
      offset: 0,
      limit: 50,
      clutterFilter: 'hide_clutter'
    })) as {
      items: Array<{ fileLocationId: number }>
      totalCount: number
      hiddenClutterCount: number
    }
    expect(pageHide.totalCount).toBe(3)
    expect(pageHide.hiddenClutterCount).toBe(1)
    expect(pageHide.items.map((i) => i.fileLocationId)).not.toContain(noticeId)

    // 6. Inspect hidden (only_clutter) returns only noticeId
    const pageOnlyClutter = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_PAGE)!(
      trustedEvent,
      { offset: 0, limit: 50, clutterFilter: 'only_clutter' }
    )) as { items: Array<{ fileLocationId: number }>; totalCount: number }
    expect(pageOnlyClutter.items.map((i) => i.fileLocationId)).toEqual([noticeId])

    // 7. Purpose filter distinguishes 'other' vs 'unknown'
    const pageOther = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_PAGE)!(
      trustedEvent,
      { offset: 0, limit: 50, purposeFilter: 'other' }
    )) as { items: Array<{ fileLocationId: number }> }
    expect(pageOther.items.map((i) => i.fileLocationId)).toEqual([proseId])

    const pageUnknown = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_PAGE)!(
      trustedEvent,
      { offset: 0, limit: 50, purposeFilter: 'unknown' }
    )) as { items: Array<{ fileLocationId: number }> }
    expect(pageUnknown.items.map((i) => i.fileLocationId)).toEqual([unknownId])

    // 8. Facets match exact counts
    const facets = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_CLASSIFICATION_FACETS)!(
      trustedEvent,
      {}
    )) as {
      purposeCounts: Record<string, number>
      clutterCount: number
      totalDocuments: number
    }
    expect(facets.totalDocuments).toBe(4)
    expect(facets.clutterCount).toBe(1)
    expect(facets.purposeCounts.receipts).toBe(1)
    expect(facets.purposeCounts.other).toBe(1)
    expect(facets.purposeCounts.unknown).toBe(1)

    // 9. Override with post-commit journal failure -> truthful persistencePending: true ack
    const detailRes = (await registeredHandlers.get(IPC_CHANNELS.DOCUMENTS_GET_DETAIL)!(
      trustedEvent,
      { fileLocationId: receiptId }
    )) as { item: { classification: { contentRevision: string; overrideVersion: number } } }
    const origCommitSync = journal.appendCommitRecordSync.bind(journal)
    journal.appendCommitRecordSync = () => {
      throw new Error('DISK_IO_AFTER_COMMIT')
    }
    const pendingAck = (await registeredHandlers.get(
      IPC_CHANNELS.DOCUMENTS_SET_CLASSIFICATION_OVERRIDE
    )!(trustedEvent, {
      fileLocationId: receiptId,
      expectedRevision: detailRes.item.classification.contentRevision,
      expectedOverrideVersion: detailRes.item.classification.overrideVersion,
      purposeLabels: ['receipts'],
      originLabels: ['personal'],
      clutterOverride: 'force_keep'
    })) as { ok: boolean; persistencePending: boolean; persistenceError?: string }
    journal.appendCommitRecordSync = origCommitSync
    expect(pendingAck.ok).toBe(true)
    expect(pendingAck.persistencePending).toBe(true)
    expect(pendingAck.persistenceError).toContain('DISK_IO_AFTER_COMMIT')

    // 10. Stale override version conflict returns ok: false, conflict: 'STALE_OVERRIDE_VERSION'
    const conflictAck = (await registeredHandlers.get(
      IPC_CHANNELS.DOCUMENTS_SET_CLASSIFICATION_OVERRIDE
    )!(trustedEvent, {
      fileLocationId: receiptId,
      expectedRevision: detailRes.item.classification.contentRevision,
      expectedOverrideVersion: 0,
      purposeLabels: ['lists'],
      originLabels: ['personal'],
      clutterOverride: 'force_keep'
    })) as { ok: boolean; conflict?: string }
    expect(conflictAck.ok).toBe(false)
    expect(conflictAck.conflict).toBe('STALE_OVERRIDE_VERSION')
  })

  it('applies purpose/origin/clutter filters before semantic ranking and revalidates classification/override currency', async () => {
    const noticeId = seedDocument({
      fileName: 'LICENSE.txt',
      relativeDir: 'repos/pkg-0',
      extractedText:
        'SPDX-License-Identifier: MIT\nPermission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\nWITHOUT WARRANTY OF ANY KIND.\n',
      sha256: 'e'.repeat(64)
    })
    const receiptId = seedDocument({
      fileName: 'hotel_receipt.txt',
      relativeDir: 'Personal/Travel',
      extractedText: 'Hotel Receipt\nRoom Total: $180.00\nPaid Card',
      sha256: 'f'.repeat(64)
    })

    await clsCoordinator.startClassification({ scopeKind: 'all' })

    // Seed semantic tracks/chunks for both documents directly
    const db = catalog.getRawDb()
    const vec = l2NormalizeDocVector(new Float32Array(DOC_SEMANTIC_EMBEDDING_DIMENSIONS).fill(1))
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
    for (const docId of [noticeId, receiptId]) {
      const ext = db
        .prepare(
          'SELECT id, discovery_observation_id, content_sha256, observed_byte_size, observed_mtime_ms, content_revision, extracted_text FROM document_extractions WHERE file_location_id = ?;'
        )
        .get(docId) as {
        id: number
        discovery_observation_id: number
        content_sha256: string
        observed_byte_size: number
        observed_mtime_ms: number
        content_revision: string
        extracted_text: string
      }
      const semRepo = catalog.getDocumentSemanticRepository()
      const compat = {
        docModelId: 'Xenova/bge-small-en-v1.5',
        docModelCommit: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
        docModelManifestSha256: 'm'.repeat(64),
        chunkingRecipeVersion: 'doc_tok_chunk_v1',
        maxContentTokensPerChunk: 400,
        overlapTokens: 64,
        maxChunksPerDocument: 128,
        maxTextCharsForIndexing: 200000
      }
      const { createHash } = await import('node:crypto')
      const normHash = createHash('sha256').update(ext.extracted_text).digest('hex')
      const trackRes = db
        .prepare(
          `INSERT INTO document_semantic_tracks (
            file_location_id, discovery_observation_id, content_sha256, observed_byte_size,
            observed_mtime_ms, content_revision, text_source_kind, source_extraction_id,
            source_recipe_version, normalized_text_sha256, doc_model_id, doc_model_commit,
            doc_model_manifest_sha256, chunking_recipe_version, max_content_tokens_per_chunk,
            overlap_tokens, max_chunks_per_document, max_text_chars_for_indexing, status,
            normalized_char_count, indexed_char_count, coverage_ratio, truncated,
            truncation_reason, total_token_count, unique_indexed_token_count,
            emitted_chunk_token_sum, chunk_count, is_current, indexed_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'native', ?, 'doc_extract_v1', ?, ?, ?, ?, ?, 400, 64, 128, 200000, 'indexed', ?, ?, 1.0, 0, 'none', 5, 5, 5, 1, 1, ?);`
        )
        .run(
          docId,
          ext.discovery_observation_id,
          ext.content_sha256,
          ext.observed_byte_size,
          ext.observed_mtime_ms,
          ext.content_revision,
          ext.id,
          normHash,
          compat.docModelId,
          compat.docModelCommit,
          compat.docModelManifestSha256,
          compat.chunkingRecipeVersion,
          ext.extracted_text.length,
          ext.extracted_text.length,
          Date.now()
        )
      db.prepare(
        `INSERT INTO document_semantic_chunks (
          track_id, file_location_id, text_source_kind, discovery_observation_id,
          content_sha256, observed_byte_size, observed_mtime_ms, content_revision,
          source_extraction_id, source_recipe_version, normalized_text_sha256,
          doc_model_id, doc_model_commit, doc_model_manifest_sha256, chunking_recipe_version,
          max_content_tokens_per_chunk, overlap_tokens, max_chunks_per_document,
          max_text_chars_for_indexing, chunk_index, char_offset_start, char_offset_end,
          content_token_count, vector_dimensions, embedding_vector, is_current, created_at_ms
        ) VALUES (?, ?, 'native', ?, ?, ?, ?, ?, ?, 'doc_extract_v1', ?, ?, ?, ?, ?, 400, 64, 128, 200000, 0, 0, ?, 5, ?, ?, 1, ?);`
      ).run(
        Number(trackRes.lastInsertRowid),
        docId,
        ext.discovery_observation_id,
        ext.content_sha256,
        ext.observed_byte_size,
        ext.observed_mtime_ms,
        ext.content_revision,
        ext.id,
        normHash,
        compat.docModelId,
        compat.docModelCommit,
        compat.docModelManifestSha256,
        compat.chunkingRecipeVersion,
        ext.extracted_text.length,
        DOC_SEMANTIC_EMBEDDING_DIMENSIONS,
        blob,
        Date.now()
      )

      // 1. SQL filtering before chunk ranking: hide_clutter excludes noticeId
      const hiddenRes = semRepo.searchDocumentChunksBounded(vec, {
        compat,
        clutterFilter: 'hide_clutter'
      })
      if (docId === receiptId) {
        expect(hiddenRes.items.map((i) => i.fileLocationId)).toEqual([receiptId])
        expect(hiddenRes.totalMatched).toBe(1)

        // 2. Revalidation detects classification/override mutation between scoring and main-process check
        const scored = hiddenRes.items[0]!
        expect(semRepo.revalidateScoredSearchItem(scored, compat)).toBe(true)

        const eff = catalog
          .getDocumentClassificationRepository()
          .getEffectiveDocumentClassification(receiptId)!
        catalog.getDocumentClassificationRepository().setClassificationOverride({
          fileLocationId: receiptId,
          expectedRevision: eff.contentRevision,
          expectedOverrideVersion: eff.latestOverrideVersion,
          purposeLabels: ['legal'],
          originLabels: ['personal'],
          clutterOverride: 'force_keep'
        })

        // Scored item now fails revalidation because override changed!
        expect(semRepo.revalidateScoredSearchItem(scored, compat)).toBe(false)
      }
    }
  })
})
