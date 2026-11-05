/**
 * Domain types for Personal Vault.
 * In accordance with product principles:
 * - Source files remain read-only and unaltered.
 * - Recorded facts (filesystem timestamps, original filenames, recorded hashes)
 *   are strictly separated from inferred values (derived tags, AI classifications).
 * - Capture dates and GPS locations may remain unknown (nullable/optional).
 */

export type ItemKind = 'photo' | 'document'

export type DocumentPurpose =
  | 'personal'
  | 'software_project'
  | 'application_system'
  | 'legal'
  | 'lists'
  | 'instructions'
  | 'receipts'
  | 'recipes'
  | 'unclassified'

export interface RecordedFileFacts {
  readonly originalPath: string
  readonly originalFileName: string
  readonly byteSize: number
  readonly filesystemCreatedAt: string
  readonly filesystemModifiedAt: string
  readonly sha256: string
}

export interface InferredMetadata {
  readonly inferredCaptureDate?: string | null
  readonly inferredLocation?: string | null
  readonly classification?: DocumentPurpose
  readonly confidenceScore?: number
}

export interface VaultItem {
  readonly id: string
  readonly kind: ItemKind
  readonly facts: RecordedFileFacts
  readonly inferred: InferredMetadata
  readonly userRatings?: number
  readonly flags?: string[]
}

export interface SourceDirectory {
  readonly id: string
  readonly path: string
  readonly addedAt: string
  readonly lastScanAt?: string | null
  readonly isReadOnly: true
}
