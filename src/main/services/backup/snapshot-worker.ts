/**
 * Personal Vault — Stage 8B Sub-slice 1A-1: Off-Main SQLite Snapshot Worker
 *
 * Opens a separate read-only DatabaseSync connection against the active WAL catalog,
 * executes `VACUUM INTO` into local app-owned staging, verifies `PRAGMA integrity_check`
 * and `PRAGMA foreign_key_check`, extracts the T0 journal watermark and active vault
 * inventory, and stream-hashes the staged SQLite snapshot.
 */

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { CURRENT_SCHEMA_VERSION } from '../catalog/migrations'

export interface BackupSnapshotWorkerData {
  readonly catalogPath: string
  readonly stagingCatalogPath: string
}

export interface StagedVaultCopyMeta {
  readonly sha256: string
  readonly byteSize: number
  readonly relativePath: string
  readonly manifestRelativePath: string
  readonly updatedAtMs: number
}

export interface StagedImportItemMeta {
  readonly importJobId: string
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly hashObservationId: number | null
  readonly sha256: string
  readonly status: string
}

export interface BackupSnapshotWorkerSuccessResult {
  readonly catalogSha256: string
  readonly catalogByteSize: number
  readonly schemaVersion: number
  readonly maxJournalOpSeq: number
  readonly checkpointSeq: number
  readonly requiredJournalSeq: number
  readonly snapshotJournalOpIds: readonly string[]
  readonly activeVault: {
    readonly vaultId: string
    readonly vaultPath: string
    readonly name: string
  } | null
  readonly vaultCopies: readonly StagedVaultCopyMeta[]
  readonly importJobIds: readonly string[]
  readonly importItems: readonly StagedImportItemMeta[]
}

export type BackupSnapshotWorkerMessage =
  | { readonly ok: true; readonly result: BackupSnapshotWorkerSuccessResult }
  | { readonly ok: false; readonly errorMessage: string }

function hashFileStream(filePath: string): Promise<{ sha256: string; byteSize: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let byteSize = 0
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 })
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      hash.update(buf)
      byteSize += buf.length
    })
    stream.on('end', () => {
      const st = statSync(filePath)
      if (st.size !== byteSize) {
        reject(
          new Error(
            `Staged SQLite size changed during hashing: expected ${byteSize}, got ${st.size}`
          )
        )
        return
      }
      resolve({ sha256: hash.digest('hex'), byteSize })
    })
    stream.on('error', reject)
  })
}

async function run(): Promise<void> {
  const data = workerData as BackupSnapshotWorkerData | undefined
  if (!data || !data.catalogPath || !data.stagingCatalogPath) {
    parentPort?.postMessage({
      ok: false,
      errorMessage: 'Invalid backup snapshot worker payload'
    } satisfies BackupSnapshotWorkerMessage)
    return
  }

  let liveDb: DatabaseSync | null = null
  let stagedDb: DatabaseSync | null = null

  try {
    liveDb = new DatabaseSync(data.catalogPath, {
      readOnly: true,
      timeout: 5000,
      enableForeignKeyConstraints: true
    })

    liveDb.prepare('VACUUM INTO ?').run(data.stagingCatalogPath)
    liveDb.close()
    liveDb = null

    stagedDb = new DatabaseSync(data.stagingCatalogPath, {
      readOnly: true,
      timeout: 5000,
      enableForeignKeyConstraints: true
    })

    const integrityRow = stagedDb.prepare('PRAGMA integrity_check;').get() as
      { integrity_check?: string } | undefined
    if (integrityRow?.integrity_check !== 'ok') {
      throw new Error(
        `Staged catalog failed PRAGMA integrity_check: ${String(integrityRow?.integrity_check)}`
      )
    }

    const fkRows = stagedDb.prepare('PRAGMA foreign_key_check;').all()
    if (fkRows.length > 0) {
      throw new Error(
        `Staged catalog failed PRAGMA foreign_key_check (${fkRows.length} violations)`
      )
    }

    const versionRow = stagedDb
      .prepare('SELECT MAX(version) as max_version FROM schema_migrations;')
      .get() as { max_version: number | null } | undefined
    const schemaVersion = versionRow?.max_version ?? 0
    if (schemaVersion < 1 || schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported staged catalog schema version: ${schemaVersion} (supported 1..${CURRENT_SCHEMA_VERSION})`
      )
    }

    const maxOpRow = stagedDb
      .prepare('SELECT COALESCE(MAX(entry_seq), 0) as max_seq FROM journal_operations;')
      .get() as { max_seq: number }
    const maxJournalOpSeq = Number(maxOpRow?.max_seq ?? 0)

    const cpRow = stagedDb
      .prepare('SELECT last_applied_seq FROM journal_checkpoints WHERE singleton_id = 1;')
      .get() as { last_applied_seq: number } | undefined
    const checkpointSeq = Number(cpRow?.last_applied_seq ?? 0)
    const requiredJournalSeq = Math.max(maxJournalOpSeq, checkpointSeq)

    const opRows = stagedDb.prepare('SELECT op_id FROM journal_operations;').all() as Array<{
      op_id: string
    }>
    const snapshotJournalOpIds = opRows.map((r) => r.op_id)

    const vaultRow = stagedDb
      .prepare(
        'SELECT vault_id, vault_path, name FROM vaults WHERE is_active = 1 ORDER BY updated_at_ms DESC LIMIT 1;'
      )
      .get() as { vault_id: string; vault_path: string; name: string } | undefined

    const activeVault = vaultRow
      ? {
          vaultId: vaultRow.vault_id,
          vaultPath: vaultRow.vault_path,
          name: vaultRow.name
        }
      : null

    let vaultCopies: StagedVaultCopyMeta[] = []
    let importJobIds: string[] = []
    let importItems: StagedImportItemMeta[] = []

    if (activeVault) {
      const copyRows = stagedDb
        .prepare(
          'SELECT sha256, byte_size, relative_path, manifest_relative_path, updated_at_ms FROM vault_copies WHERE vault_id = ? ORDER BY id ASC;'
        )
        .all(activeVault.vaultId) as Array<{
        sha256: string
        byte_size: number
        relative_path: string
        manifest_relative_path: string
        updated_at_ms: number
      }>
      vaultCopies = copyRows.map((r) => ({
        sha256: r.sha256,
        byteSize: r.byte_size,
        relativePath: r.relative_path,
        manifestRelativePath: r.manifest_relative_path,
        updatedAtMs: r.updated_at_ms
      }))

      const jobRows = stagedDb
        .prepare('SELECT id FROM vault_imports WHERE vault_id = ?;')
        .all(activeVault.vaultId) as Array<{ id: string }>
      importJobIds = jobRows.map((r) => r.id)

      const itemRows = stagedDb
        .prepare(
          `SELECT vii.import_id, vii.file_location_id, vii.discovery_observation_id,
                  vii.hash_observation_id, vii.sha256, vii.status
           FROM vault_import_items vii
           JOIN vault_imports vi ON vi.id = vii.import_id
           WHERE vi.vault_id = ?;`
        )
        .all(activeVault.vaultId) as Array<{
        import_id: string
        file_location_id: number
        discovery_observation_id: number
        hash_observation_id: number | null
        sha256: string
        status: string
      }>
      importItems = itemRows.map((r) => ({
        importJobId: r.import_id,
        fileLocationId: r.file_location_id,
        discoveryObservationId: r.discovery_observation_id,
        hashObservationId: r.hash_observation_id,
        sha256: r.sha256,
        status: r.status
      }))
    }

    stagedDb.close()
    stagedDb = null

    const { sha256: catalogSha256, byteSize: catalogByteSize } = await hashFileStream(
      data.stagingCatalogPath
    )

    parentPort?.postMessage({
      ok: true,
      result: {
        catalogSha256,
        catalogByteSize,
        schemaVersion,
        maxJournalOpSeq,
        checkpointSeq,
        requiredJournalSeq,
        snapshotJournalOpIds,
        activeVault,
        vaultCopies,
        importJobIds,
        importItems
      }
    } satisfies BackupSnapshotWorkerMessage)
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err)
    } satisfies BackupSnapshotWorkerMessage)
  } finally {
    if (stagedDb) {
      try {
        stagedDb.close()
      } catch {
        // ignore close error
      }
    }
    if (liveDb) {
      try {
        liveDb.close()
      } catch {
        // ignore close error
      }
    }
  }
}

void run()
