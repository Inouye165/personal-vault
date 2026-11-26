/**
 * Personal Vault — Vault & Verified Import Domain Types (Stage 4)
 */

export interface VaultIdentity {
  readonly formatVersion: 1
  readonly vaultId: string
  readonly vaultName: string
  readonly createdAtMs: number
  readonly appVersion: string
}

export interface VaultManifestSourceRecordedFacts {
  readonly byteSize: number
  readonly filesystemBirthtimeMs: number | null
  readonly filesystemMtimeMs: number | null
  readonly firstDiscoveredAtMs: number
  readonly lastSeenAtMs: number
  readonly discoveryObservationId: number
  readonly hashObservationId: number
  readonly hashVerifiedAtMs: number
}

export interface VaultManifestSourceInferredMetadata {
  readonly inferredCaptureTimeMs: number | null
}

export interface VaultManifestSourceReviewDecisions {
  readonly isPreferred: boolean
  readonly duplicateReviewStatus: 'reviewed' | 'unreviewed' | null
}

export interface VaultManifestSourceStability {
  readonly preCopyMtimeMs: number
  readonly postCopyMtimeMs: number
  readonly preCopyByteSize: number
  readonly postCopyByteSize: number
}

export interface VaultManifestSourceImportResult {
  readonly importJobId: string
  readonly importedAtMs: number
  readonly verifiedSourceSha256: string
  readonly verifiedSourceByteSize: number
  readonly sourceStability: VaultManifestSourceStability
}

export interface VaultManifestSourceEntry {
  readonly fileLocationId: number
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly recordedFacts: VaultManifestSourceRecordedFacts
  readonly inferredMetadata: VaultManifestSourceInferredMetadata
  readonly reviewDecisions: VaultManifestSourceReviewDecisions
  readonly importResult: VaultManifestSourceImportResult
}

export interface VaultManifestManagedCopy {
  readonly relativePath: string
  readonly fileName: string
  readonly publishedAtMs: number
  readonly verifiedSha256: string
  readonly verifiedByteSize: number
}

export interface VaultManifest {
  readonly formatVersion: 1
  readonly vaultId: string
  readonly sha256: string
  readonly byteSize: number
  readonly managedCopy: VaultManifestManagedCopy
  readonly sources: readonly VaultManifestSourceEntry[]
}

export interface CopySourceParams {
  readonly fileLocationId: number
  readonly discoveryObservationId: number
  readonly originalPath: string
  readonly fileName: string
  readonly extension: string
  readonly category: 'photo' | 'document'
  readonly recordedFacts: {
    readonly byteSize: number
    readonly filesystemBirthtimeMs: number | null
    readonly filesystemMtimeMs: number | null
    readonly firstDiscoveredAtMs: number
    readonly lastSeenAtMs: number
    readonly hashObservationId: number
    readonly hashVerifiedAtMs: number
  }
  readonly inferredMetadata: {
    readonly inferredCaptureTimeMs: number | null
  }
  readonly reviewDecisions: {
    readonly isPreferred: boolean
    readonly duplicateReviewStatus: 'reviewed' | 'unreviewed' | null
  }
  readonly expectedSha256: string
  readonly expectedByteSize: number
}

export interface VaultPublishOps {
  readonly renameSync?: (oldPath: string, newPath: string) => void
  readonly copyFileSync?: (src: string, dest: string, mode?: number) => void
}

export interface CopyFileToVaultParams {
  readonly vaultPath: string
  readonly vaultId: string
  readonly importJobId: string
  readonly source: CopySourceParams
  readonly signal?: AbortSignal
  readonly publishOps?: VaultPublishOps
}

export type CopyFileResult =
  | {
      readonly status: 'success'
      readonly sha256: string
      readonly byteSize: number
      readonly relativePath: string
      readonly manifestRelativePath: string
      readonly reusedExistingCopy: boolean
    }
  | {
      readonly status: 'cancelled'
    }
  | {
      readonly status: 'error'
      readonly code: string
      readonly message: string
    }
