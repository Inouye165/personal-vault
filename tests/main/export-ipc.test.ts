// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/contracts/channels'
import { CatalogDatabase } from '../../src/main/services/catalog'
import {
  EXPORT_COMPLETE_MARKER,
  EXPORT_MANIFEST_FILENAME,
  ExportCoordinator
} from '../../src/main/services/export'

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '',
    getVersion: () => '0.1.0'
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcState.handlers.set(channel, handler)
    }
  }
}))

import { registerIpcHandlers } from '../../src/main/ipc/handlers'

function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function seedCatalogLocation(
  catalog: CatalogDatabase,
  sourceRoot: string,
  filePath: string,
  content: Buffer,
  category: 'photo' | 'document' = 'photo'
): {
  fileLocationId: number
  discoveryObservationId: number
  hashObservationId: number
  sha256: string
} {
  const db = catalog.getRawDb()
  const now = Date.now()
  const sha = sha256Bytes(content)
  const fileName = filePath.split(/[\\/]/).pop() ?? 'file.bin'
  const ext = fileName.includes('.') ? `.${fileName.split('.').pop()}` : ''
  const st = statSync(filePath)

  const existingSource = db
    .prepare('SELECT id FROM sources WHERE normalized_root_path = ?;')
    .get(sourceRoot.toLowerCase()) as { id: number } | undefined

  const sourceId = existingSource
    ? existingSource.id
    : Number(
        db
          .prepare(
            'INSERT INTO sources (root_path, normalized_root_path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);'
          )
          .run(sourceRoot, sourceRoot.toLowerCase(), now, now).lastInsertRowid
      )

  const fileLocationId = Number(
    db
      .prepare(
        `INSERT INTO file_locations (
          source_id, original_path, normalized_path, file_name, extension, category,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
      )
      .run(sourceId, filePath, filePath.toLowerCase(), fileName, ext, category, now, now)
      .lastInsertRowid
  )

  const discoveryObservationId = Number(
    db
      .prepare(
        `INSERT INTO discovery_observations (
          file_location_id, byte_size, filesystem_birthtime_ms, filesystem_mtime_ms,
          observed_at_ms, last_seen_at_ms, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, 1);`
      )
      .run(fileLocationId, content.byteLength, st.birthtimeMs, st.mtimeMs, now, now).lastInsertRowid
  )

  const hashObservationId = Number(
    db
      .prepare(
        `INSERT INTO hash_observations (
          file_location_id, discovery_observation_id, sha256, observed_byte_size,
          observed_mtime_ms, hashed_at_ms, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, 1);`
      )
      .run(fileLocationId, discoveryObservationId, sha, content.byteLength, st.mtimeMs, now + 10)
      .lastInsertRowid
  )

  return { fileLocationId, discoveryObservationId, hashObservationId, sha256: sha }
}

describe('Stage 8A Slice 3: ExportCoordinator & Export IPC Handlers', () => {
  let tempRoot: string
  let dbPath: string
  let sourceRoot: string
  let exportParentDir: string
  let userDataDir: string
  let catalog: CatalogDatabase
  let exportCoordinator: ExportCoordinator
  let allowSender: boolean

  beforeEach(() => {
    ipcState.handlers.clear()
    tempRoot = mkdtempSync(join(tmpdir(), 'pv-export-slice3-'))
    dbPath = join(tempRoot, 'catalog.sqlite')
    sourceRoot = join(tempRoot, 'sources')
    exportParentDir = join(tempRoot, 'exports')
    userDataDir = join(tempRoot, 'userdata')
    mkdirSync(sourceRoot, { recursive: true })
    mkdirSync(exportParentDir, { recursive: true })
    mkdirSync(userDataDir, { recursive: true })

    catalog = CatalogDatabase.open({ catalogPath: dbPath })
    exportCoordinator = new ExportCoordinator({
      catalog,
      userDataDir,
      appVersion: '0.1.0'
    })
    allowSender = true

    registerIpcHandlers({
      validateSender: () => allowSender,
      catalog,
      exportCoordinator,
      selectExportDestinationDirectory: async () => ({
        canceled: false,
        directoryPath: exportParentDir
      })
    })
  })

  afterEach(async () => {
    await exportCoordinator.shutdown()
    if (!catalog.isClosed()) {
      catalog.close()
    }
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('rejects untrusted senders and invalid export payloads at the IPC boundary', async () => {
    allowSender = false
    const listHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_LIST_JOBS)!
    await expect(listHandler({}, {})).rejects.toThrow(/Unauthorized IPC sender/)

    allowSender = true
    const startHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_START)!
    await expect(
      startHandler(
        {},
        {
          parentDir: exportParentDir,
          bundleFolderName: '../escape',
          fileLocationIds: [1]
        }
      )
    ).rejects.toThrow()

    await expect(
      startHandler(
        {},
        {
          parentDir: exportParentDir,
          bundleFolderName: 'valid-name',
          fileLocationIds: []
        }
      )
    ).rejects.toThrow()
  })

  it('marks stale running jobs as interrupted on startup before history is queried, keeping published-before-commit bundles interrupted', async () => {
    const photoBytes = Buffer.from('stale-job-photo')
    const photoPath = join(sourceRoot, 'stale.jpg')
    writeFileSync(photoPath, photoBytes)
    const seeded = seedCatalogLocation(catalog, sourceRoot, photoPath, photoBytes, 'photo')

    const publishedDir = join(exportParentDir, 'published-before-commit')
    mkdirSync(publishedDir, { recursive: true })
    // Simulate a bundle that was even finalized on disk before SQLite was updated
    writeFileSync(join(publishedDir, EXPORT_COMPLETE_MARKER), '{}')

    catalog.getExportRepository().createExportJob({
      id: 'stale-running-job',
      bundleDir: publishedDir,
      bundleFolderName: 'published-before-commit',
      items: [
        {
          fileLocationId: seeded.fileLocationId,
          discoveryObservationId: seeded.discoveryObservationId,
          hashObservationId: seeded.hashObservationId,
          category: 'photo',
          originalFileName: 'stale.jpg',
          expectedSha256: seeded.sha256,
          expectedByteSize: photoBytes.byteLength
        }
      ]
    })

    expect(exportCoordinator.initialize()).toBe(1)

    const listHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_LIST_JOBS)!
    const list = (await listHandler({}, {})) as { items: Array<{ id: string; status: string }> }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.id).toBe('stale-running-job')
    expect(list.items[0]?.status).toBe('interrupted')
  })

  it('executes verified export end-to-end via IPC, enforces privacy defaults, prevents overwrite, supports verify & cancel, and leaves sources untouched', async () => {
    const photoBytes = Buffer.from('photo-payload')
    const docBytes = Buffer.from('confidential document text')
    const photoPath = join(sourceRoot, 'vacation.jpg')
    const docPath = join(sourceRoot, 'tax.txt')
    writeFileSync(photoPath, photoBytes)
    writeFileSync(docPath, docBytes)

    const s1 = seedCatalogLocation(catalog, sourceRoot, photoPath, photoBytes, 'photo')
    const s2 = seedCatalogLocation(catalog, sourceRoot, docPath, docBytes, 'document')

    // Record extracted document text in catalog to confirm default privacy omits it from export
    catalog
      .getRawDb()
      .prepare(
        `INSERT INTO document_extractions (
        file_location_id, discovery_observation_id, content_sha256, observed_byte_size,
        content_revision, recipe_version, extraction_status, extracted_text,
        extracted_char_count, truncated, extracted_at_ms, is_current
      ) VALUES (?, ?, ?, ?, 'rev-1', 'doc_extract_v1', 'extracted', 'confidential document text', 26, 0, ?, 1);`
      )
      .run(s2.fileLocationId, s2.discoveryObservationId, s2.sha256, docBytes.byteLength, Date.now())

    const selectHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_SELECT_DESTINATION)!
    const selected = (await selectHandler({})) as { canceled: boolean; directoryPath: string }
    expect(selected.canceled).toBe(false)
    expect(selected.directoryPath).toBe(exportParentDir)

    const startHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_START)!
    const started = (await startHandler(
      {},
      {
        parentDir: selected.directoryPath,
        bundleFolderName: 'my-bundle-1',
        fileLocationIds: [s1.fileLocationId, s2.fileLocationId]
      }
    )) as {
      id: string
      status: string
      privacyOptions: { includeOriginalPaths: boolean; includeExtractedText: boolean }
    }

    expect(started.status).toBe('running')
    expect(started.privacyOptions).toEqual({
      includeOriginalPaths: false,
      includeExtractedText: false
    })

    const completed = await exportCoordinator.waitForCompletion()
    expect(completed?.status).toBe('completed')
    expect(completed?.bundleVerified).toBe(true)
    expect(completed?.exportedItems).toBe(2)

    const getJobHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_GET_JOB)!
    const fetchedJob = (await getJobHandler({}, { jobId: started.id })) as {
      status: string
      bundleVerified: boolean
      bundleDir: string
    }
    expect(fetchedJob.status).toBe('completed')
    expect(fetchedJob.bundleVerified).toBe(true)

    const getItemsHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_GET_JOB_ITEMS)!
    const fetchedItems = (await getItemsHandler({}, { jobId: started.id })) as {
      total: number
      items: Array<{ status: string }>
    }
    expect(fetchedItems.total).toBe(2)
    expect(fetchedItems.items.every((i) => i.status === 'completed')).toBe(true)

    // Privacy check: manifest & sidecar must omit originalPath and extracted text by default
    const manifestJson = readFileSync(join(fetchedJob.bundleDir, EXPORT_MANIFEST_FILENAME), 'utf8')
    expect(manifestJson).not.toContain(sourceRoot)
    const docSidecarJson = readFileSync(join(fetchedJob.bundleDir, 'tax.txt.pv-meta.json'), 'utf8')
    expect(docSidecarJson).not.toContain('confidential document text')
    expect(docSidecarJson).not.toContain(sourceRoot)

    // No-overwrite: exporting to the same folder again must fail before creating a job
    await expect(
      startHandler(
        {},
        {
          parentDir: selected.directoryPath,
          bundleFolderName: 'my-bundle-1',
          fileLocationIds: [s1.fileLocationId]
        }
      )
    ).rejects.toThrow(/already exists/i)

    // Explicit on-disk verification detects tampered completion marker
    unlinkSync(join(fetchedJob.bundleDir, EXPORT_COMPLETE_MARKER))
    const verifyHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_VERIFY_JOB)!
    const verifiedAfterTamper = (await verifyHandler({}, { jobId: started.id })) as {
      status: string
      bundleVerified: boolean
    }
    expect(verifiedAfterTamper.status).toBe('failed')
    expect(verifiedAfterTamper.bundleVerified).toBe(false)

    // Source files remain untouched byte-for-byte
    expect(readFileSync(photoPath)).toEqual(photoBytes)
    expect(readFileSync(docPath)).toEqual(docBytes)
  })

  it('supports cancelling an active export job via ExportCoordinator', async () => {
    const b1 = Buffer.from('cancel-1')
    const b2 = Buffer.from('cancel-2')
    const p1 = join(sourceRoot, 'c1.jpg')
    const p2 = join(sourceRoot, 'c2.jpg')
    writeFileSync(p1, b1)
    writeFileSync(p2, b2)

    const s1 = seedCatalogLocation(catalog, sourceRoot, p1, b1, 'photo')
    const s2 = seedCatalogLocation(catalog, sourceRoot, p2, b2, 'photo')

    let jobId = ''
    const started = exportCoordinator.startExport({
      parentDir: exportParentDir,
      bundleFolderName: 'cancel-bundle',
      fileLocationIds: [s1.fileLocationId, s2.fileLocationId],
      hooks: {
        onChunkReadHook: () => {
          exportCoordinator.cancelExport(jobId)
        }
      }
    })
    jobId = started.id

    const cancelHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_CANCEL)!
    const cancelRes = (await cancelHandler({}, { jobId })) as { cancelled: boolean }
    expect(cancelRes.cancelled).toBe(true)

    const finished = await exportCoordinator.waitForCompletion()
    expect(finished?.status).toBe('cancelled')
    expect(finished?.cancelledItems).toBeGreaterThanOrEqual(1)
  })

  it('exports a document with a saved classification override using the exact persisted updatedAtMs and override values', async () => {
    const docBytes = Buffer.from('contract agreement terms')
    const docPath = join(sourceRoot, 'contract.txt')
    writeFileSync(docPath, docBytes)

    const seeded = seedCatalogLocation(catalog, sourceRoot, docPath, docBytes, 'document')
    const docDetail = catalog.getDocumentDetail(seeded.fileLocationId)
    const expectedRevision = docDetail!.classification!.contentRevision

    const savedOverride = catalog.getDocumentClassificationRepository().setClassificationOverride({
      fileLocationId: seeded.fileLocationId,
      expectedRevision,
      expectedOverrideVersion: 0,
      purposeLabels: ['legal'],
      originLabels: ['personal'],
      clutterOverride: 'force_keep'
    })

    expect(savedOverride.updatedAtMs).toBeGreaterThan(0)

    const startHandler = ipcState.handlers.get(IPC_CHANNELS.EXPORT_START)!
    const started = (await startHandler(
      {},
      {
        parentDir: exportParentDir,
        bundleFolderName: 'override-bundle-1',
        fileLocationIds: [seeded.fileLocationId]
      }
    )) as { id: string; bundleDir: string }

    const completed = await exportCoordinator.waitForCompletion()
    expect(completed?.status).toBe('completed')
    expect(completed?.bundleVerified).toBe(true)
    expect(completed?.exportedItems).toBe(1)
    expect(completed?.failedItems).toBe(0)

    const sidecar = JSON.parse(
      readFileSync(join(started.bundleDir, 'contract.txt.pv-meta.json'), 'utf8')
    ) as {
      userOverridesAndAnnotations: {
        kind: string
        classificationOverride: {
          purposeLabels: string[] | null
          originLabels: string[] | null
          clutterOverride: string
          overrideVersion: number
          updatedAtMs: number
        } | null
        effectiveClassification: {
          purposeLabels: string[]
          originLabels: string[]
          isClutter: boolean
          resolvedFrom: string
        }
      }
    }

    expect(sidecar.userOverridesAndAnnotations.classificationOverride).toEqual({
      purposeLabels: ['legal'],
      originLabels: ['personal'],
      clutterOverride: 'force_keep',
      overrideVersion: savedOverride.overrideVersion,
      updatedAtMs: savedOverride.updatedAtMs
    })
    expect(sidecar.userOverridesAndAnnotations.effectiveClassification).toEqual({
      purposeLabels: ['legal'],
      originLabels: ['personal'],
      isClutter: false,
      resolvedFrom: 'user_override'
    })
  })
})
