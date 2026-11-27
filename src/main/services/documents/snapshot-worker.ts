/**
 * Worker thread for capturing an isolated point-in-time read-only SQLite
 * snapshot of document extraction or OCR job candidates off the main event loop.
 */

import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import {
  writeSnapshotToStagingFile,
  type SnapshotJobInput
} from '../catalog/document-snapshot-query'
import {
  writeOcrSnapshotToStagingFile,
  type OcrSnapshotJobInput
} from '../catalog/document-ocr-snapshot-query'
import {
  writeDocSemanticSnapshotToStagingFile,
  type DocSemanticSnapshotJobInput
} from '../catalog/document-semantic-snapshot-query'
import {
  writeDocClassificationSnapshotToStagingFile,
  type DocClassificationSnapshotJobInput
} from '../catalog/document-classification-snapshot-query'

export type DocumentSnapshotWorkerData =
  | {
      readonly kind?: 'native'
      readonly catalogPath: string
      readonly stagingFilePath: string
      readonly input: SnapshotJobInput
    }
  | {
      readonly kind: 'ocr'
      readonly catalogPath: string
      readonly stagingFilePath: string
      readonly input: OcrSnapshotJobInput
    }
  | {
      readonly kind: 'doc_semantic'
      readonly catalogPath: string
      readonly stagingFilePath: string
      readonly input: DocSemanticSnapshotJobInput
    }
  | {
      readonly kind: 'doc_classify'
      readonly catalogPath: string
      readonly stagingFilePath: string
      readonly input: DocClassificationSnapshotJobInput
    }

export type DocumentSnapshotWorkerResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly errorMessage: string }

function run(): void {
  const data = workerData as DocumentSnapshotWorkerData | undefined
  if (!data || !data.catalogPath || !data.stagingFilePath || !data.input) {
    parentPort?.postMessage({
      ok: false,
      errorMessage: 'Invalid document snapshot worker payload'
    } satisfies DocumentSnapshotWorkerResult)
    return
  }

  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(data.catalogPath, {
      readOnly: true,
      timeout: 5000,
      enableForeignKeyConstraints: true
    })
    const count =
      data.kind === 'ocr'
        ? writeOcrSnapshotToStagingFile(db, data.input, data.stagingFilePath)
        : data.kind === 'doc_semantic'
          ? writeDocSemanticSnapshotToStagingFile(db, data.input, data.stagingFilePath)
          : data.kind === 'doc_classify'
            ? writeDocClassificationSnapshotToStagingFile(db, data.input, data.stagingFilePath)
            : writeSnapshotToStagingFile(db, data.input, data.stagingFilePath)
    parentPort?.postMessage({ ok: true, count } satisfies DocumentSnapshotWorkerResult)
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err)
    } satisfies DocumentSnapshotWorkerResult)
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        // ignore close error
      }
    }
  }
}

run()
