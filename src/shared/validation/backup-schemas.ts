/**
 * Personal Vault — Stage 8B Backup, Recovery & Snapshot Schemas
 */

import { isAbsolute, sep } from 'node:path'
import { z } from 'zod'

export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_CHUNK_SIZE_BYTES = 4 * 1024 * 1024 // 4 MiB (16 x 256 KiB Drive upload alignment)
export const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export const BackupSha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hexadecimal SHA-256 digest')

export const BackupRelativePathSchema = z
  .string()
  .min(1)
  .refine((p) => {
    if (isAbsolute(p) || p.includes('\0')) return false
    const segments = p.split(/[/\\]/)
    return segments.every((s) => s.length > 0 && s !== '.' && s !== '..')
  }, 'Relative path must not be absolute, empty, or contain traversal segments')

export const BackupEncryptionModeSchema = z.enum(['none', 'aes-256-gcm-v1'])
export type BackupEncryptionMode = z.infer<typeof BackupEncryptionModeSchema>

export const BackupEncryptionKdfParamsSchema = z
  .object({
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    keyLenBytes: z.literal(32)
  })
  .strict()
export type BackupEncryptionKdfParams = z.infer<typeof BackupEncryptionKdfParamsSchema>

export const BackupEncryptionMetadataSchema = z
  .object({
    kdf: z.literal('scrypt'),
    kdfParams: BackupEncryptionKdfParamsSchema,
    saltBase64: z.string().min(1),
    wrappedMasterKeyBase64: z.string().min(1),
    keyWrapNonceBase64: z.string().min(1),
    keyWrapTagBase64: z.string().min(1),
    keyCheckTagBase64: z.string().min(1),
    keyId: z.string().min(1)
  })
  .strict()
export type BackupEncryptionMetadata = z.infer<typeof BackupEncryptionMetadataSchema>

export const BackupRepositoryIdentityV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    repositoryId: z.string().uuid(),
    createdAtMs: z.number().int().positive(),
    appVersion: z.string().min(1),
    chunkSizeBytes: z.literal(BACKUP_CHUNK_SIZE_BYTES),
    encryptionMode: BackupEncryptionModeSchema,
    encryption: BackupEncryptionMetadataSchema.nullable()
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.encryptionMode === 'none' && val.encryption !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'encryption must be null when encryptionMode is none'
      })
    }
    if (val.encryptionMode === 'aes-256-gcm-v1' && val.encryption === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'encryption metadata is required when encryptionMode is aes-256-gcm-v1'
      })
    }
  })
export type BackupRepositoryIdentityV1 = z.infer<typeof BackupRepositoryIdentityV1Schema>

export const BackupChunkRefSchema = z
  .object({
    objectId: BackupSha256HexSchema,
    index: z.number().int().nonnegative(),
    plaintextByteSize: z.number().int().nonnegative().max(BACKUP_CHUNK_SIZE_BYTES),
    storedByteSize: z.number().int().nonnegative(),
    plaintextSha256: BackupSha256HexSchema
  })
  .strict()
export type BackupChunkRef = z.infer<typeof BackupChunkRefSchema>

export const BackupFileEntrySchema = z
  .object({
    logicalPath: BackupRelativePathSchema,
    byteSize: z.number().int().nonnegative(),
    sha256: BackupSha256HexSchema,
    chunks: z.array(BackupChunkRefSchema)
  })
  .strict()
export type BackupFileEntry = z.infer<typeof BackupFileEntrySchema>

export const BackupVaultCopyEntrySchema = z
  .object({
    sha256: BackupSha256HexSchema,
    byteSize: z.number().int().nonnegative(),
    payloadRelativePath: BackupRelativePathSchema,
    manifestRelativePath: BackupRelativePathSchema,
    payloadFile: BackupFileEntrySchema,
    manifestFile: BackupFileEntrySchema
  })
  .strict()
export type BackupVaultCopyEntry = z.infer<typeof BackupVaultCopyEntrySchema>

export const BackupSnapshotManifestV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    snapshotId: z.string().min(1),
    repositoryId: z.string().uuid(),
    createdAtMs: z.number().int().positive(),
    appVersion: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    excludesUnimportedOriginals: z.literal(true),
    catalogFile: BackupFileEntrySchema,
    annotations: z
      .object({
        ownerMarkerFile: BackupFileEntrySchema,
        journalFile: BackupFileEntrySchema,
        cutSeq: z.number().int().nonnegative(),
        requiredJournalSeq: z.number().int().nonnegative()
      })
      .strict()
      .nullable(),
    vault: z
      .object({
        vaultId: z.string().min(1),
        vaultName: z.string().min(1),
        identityFile: BackupFileEntrySchema,
        copies: z.array(BackupVaultCopyEntrySchema)
      })
      .strict()
      .nullable()
  })
  .strict()
export type BackupSnapshotManifestV1 = z.infer<typeof BackupSnapshotManifestV1Schema>

export const BackupVerificationScopeSchema = z.enum([
  'full_readback',
  'incremental_new_chunks_verified'
])
export type BackupVerificationScope = z.infer<typeof BackupVerificationScopeSchema>

/**
 * Commit marker stored alongside encrypted/unencrypted snapshots.
 * Strictly forbids private filenames, paths, vault names, or user metadata.
 */
export const BackupSnapshotCompleteMarkerV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schema: z.literal('pv_backup_complete_v1'),
    snapshotId: z.string().min(1),
    repositoryId: z.string().uuid(),
    encryptionMode: BackupEncryptionModeSchema,
    manifestObjectId: BackupSha256HexSchema.nullable(),
    manifestSha256: BackupSha256HexSchema,
    totalObjectCount: z.number().int().nonnegative(),
    totalLogicalBytes: z.number().int().nonnegative(),
    totalStoredBytes: z.number().int().nonnegative(),
    verificationScope: BackupVerificationScopeSchema,
    completedAtMs: z.number().int().positive()
  })
  .strict()
export type BackupSnapshotCompleteMarkerV1 = z.infer<typeof BackupSnapshotCompleteMarkerV1Schema>

export const BackupSnapshotInProgressMarkerV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schema: z.literal('pv_backup_in_progress_v1'),
    jobId: z.string().min(1),
    snapshotId: z.string().min(1),
    repositoryId: z.string().uuid(),
    startedAtMs: z.number().int().positive()
  })
  .strict()
export type BackupSnapshotInProgressMarkerV1 = z.infer<
  typeof BackupSnapshotInProgressMarkerV1Schema
>

export const BackupStagedVaultCopySchema = z
  .object({
    sha256: BackupSha256HexSchema,
    byteSize: z.number().int().nonnegative(),
    sourcePayloadRelativePath: BackupRelativePathSchema,
    sourceManifestRelativePath: BackupRelativePathSchema,
    stagedManifestRelativePath: BackupRelativePathSchema,
    manifestSha256: BackupSha256HexSchema,
    manifestByteSize: z.number().int().nonnegative()
  })
  .strict()
export type BackupStagedVaultCopy = z.infer<typeof BackupStagedVaultCopySchema>

export const BackupStagingManifestV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schema: z.literal('pv_backup_staging_v1'),
    jobId: z.string().min(1),
    snapshotId: z.string().min(1),
    capturedAtMs: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    excludesUnimportedOriginals: z.literal(true),
    catalog: z
      .object({
        stagedRelativePath: BackupRelativePathSchema,
        sha256: BackupSha256HexSchema,
        byteSize: z.number().int().nonnegative()
      })
      .strict(),
    annotations: z
      .object({
        ownerMarkerRelativePath: BackupRelativePathSchema,
        ownerMarkerSha256: BackupSha256HexSchema,
        ownerMarkerByteSize: z.number().int().nonnegative(),
        journalRelativePath: BackupRelativePathSchema,
        journalSha256: BackupSha256HexSchema,
        journalByteSize: z.number().int().nonnegative(),
        cutSeq: z.number().int().nonnegative(),
        requiredJournalSeq: z.number().int().nonnegative()
      })
      .strict()
      .nullable(),
    vault: z
      .object({
        vaultId: z.string().min(1),
        vaultName: z.string().min(1),
        sourceVaultPath: z.string().min(1),
        identityRelativePath: BackupRelativePathSchema,
        identitySha256: BackupSha256HexSchema,
        identityByteSize: z.number().int().nonnegative(),
        copies: z.array(BackupStagedVaultCopySchema)
      })
      .strict()
      .nullable()
  })
  .strict()
export type BackupStagingManifestV1 = z.infer<typeof BackupStagingManifestV1Schema>

export const BackupRestoreInProgressMarkerV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schema: z.literal('pv_restore_in_progress_v1'),
    restoreJobId: z.string().min(1),
    repositoryId: z.string().uuid(),
    snapshotId: z.string().min(1),
    targetProfileDir: z.string().min(1),
    targetVaultDir: z.string().min(1).nullable(),
    startedAtMs: z.number().int().positive()
  })
  .strict()
export type BackupRestoreInProgressMarkerV1 = z.infer<typeof BackupRestoreInProgressMarkerV1Schema>

export const BackupRestoreCompleteMarkerV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schema: z.literal('pv_restore_complete_v1'),
    restoreJobId: z.string().min(1),
    repositoryId: z.string().uuid(),
    snapshotId: z.string().min(1),
    restoredProfilePath: z.string().min(1),
    restoredVaultPath: z.string().min(1).nullable(),
    catalogSha256: BackupSha256HexSchema,
    verifiedFileCount: z.number().int().nonnegative(),
    restoredAtMs: z.number().int().positive()
  })
  .strict()
export type BackupRestoreCompleteMarkerV1 = z.infer<typeof BackupRestoreCompleteMarkerV1Schema>

export const CatalogRecoveryInProgressMarkerV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schema: z.literal('pv_recovery_in_progress_v1'),
    recoveryJobId: z.string().min(1),
    vaultId: z.string().min(1),
    sourceVaultDir: z.string().min(1),
    targetProfileDir: z.string().min(1),
    stagedCatalogSha256: BackupSha256HexSchema.nullable(),
    startedAtMs: z.number().int().positive()
  })
  .strict()
export type CatalogRecoveryInProgressMarkerV1 = z.infer<
  typeof CatalogRecoveryInProgressMarkerV1Schema
>

export const CatalogRecoveryCompleteMarkerV1Schema = z
  .object({
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    schema: z.literal('pv_recovery_complete_v1'),
    recoveryJobId: z.string().min(1),
    vaultId: z.string().min(1),
    sourceVaultDir: z.string().min(1),
    targetProfileDir: z.string().min(1),
    catalogSha256: BackupSha256HexSchema,
    recoveredVaultCopies: z.number().int().nonnegative(),
    recoveredFileLocations: z.number().int().nonnegative(),
    recoveredObservations: z.number().int().nonnegative(),
    recoveredAtMs: z.number().int().positive()
  })
  .strict()
export type CatalogRecoveryCompleteMarkerV1 = z.infer<typeof CatalogRecoveryCompleteMarkerV1Schema>

export function assertSafeRelativePath(relPath: string): void {
  if (isAbsolute(relPath) || relPath.startsWith('..') || relPath.includes(`..${sep}`)) {
    throw new Error(`Unsafe relative path: ${relPath}`)
  }
  BackupRelativePathSchema.parse(relPath)
}
