/**
 * Personal Vault — Strict Portable Manifest Validation Schema (Stage 4)
 */

import { isAbsolute, sep } from 'node:path'
import { z } from 'zod'

const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character hexadecimal SHA-256 hash')

export const VaultManifestManagedCopySchema = z.object({
  relativePath: z
    .string()
    .min(1)
    .refine((p) => {
      if (isAbsolute(p)) return false
      if (p.startsWith('..') || p.includes(`..${sep}`) || p.includes('../')) return false
      return true
    }, 'managedCopy.relativePath must not be absolute or contain path traversal'),
  fileName: z
    .string()
    .min(1)
    .refine(
      (n) => !n.includes('/') && !n.includes('\\'),
      'managedCopy.fileName cannot contain path separators'
    ),
  publishedAtMs: z.number().positive(),
  verifiedSha256: Sha256Schema,
  verifiedByteSize: z.number().int().nonnegative()
})

export const VaultManifestSourceRecordedFactsSchema = z.object({
  byteSize: z.number().int().nonnegative(),
  filesystemBirthtimeMs: z.number().nullable(),
  filesystemMtimeMs: z.number().nullable(),
  firstDiscoveredAtMs: z.number().positive(),
  lastSeenAtMs: z.number().positive(),
  discoveryObservationId: z.number().int().positive(),
  hashObservationId: z.number().int().positive(),
  hashVerifiedAtMs: z.number().positive()
})

export const VaultManifestSourceInferredMetadataSchema = z.object({
  inferredCaptureTimeMs: z.number().nullable()
})

export const VaultManifestSourceReviewDecisionsSchema = z.object({
  isPreferred: z.boolean(),
  duplicateReviewStatus: z.enum(['reviewed', 'unreviewed']).nullable()
})

export const VaultManifestSourceStabilitySchema = z.object({
  preCopyMtimeMs: z.number().nullable(),
  postCopyMtimeMs: z.number().nullable(),
  preCopyByteSize: z.number().int().nonnegative(),
  postCopyByteSize: z.number().int().nonnegative()
})

export const VaultManifestSourceImportResultSchema = z.object({
  importJobId: z.string().min(1),
  importedAtMs: z.number().positive(),
  verifiedSourceSha256: Sha256Schema,
  verifiedSourceByteSize: z.number().int().nonnegative(),
  sourceStability: VaultManifestSourceStabilitySchema
})

export const VaultManifestSourceEntrySchema = z.object({
  fileLocationId: z.number().int().positive(),
  originalPath: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string(),
  category: z.enum(['photo', 'document']),
  recordedFacts: VaultManifestSourceRecordedFactsSchema,
  inferredMetadata: VaultManifestSourceInferredMetadataSchema,
  reviewDecisions: VaultManifestSourceReviewDecisionsSchema,
  importResult: VaultManifestSourceImportResultSchema
})

export const VaultManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    vaultId: z.string().min(1),
    sha256: Sha256Schema,
    byteSize: z.number().int().nonnegative(),
    managedCopy: VaultManifestManagedCopySchema,
    sources: z.array(VaultManifestSourceEntrySchema).min(1)
  })
  .superRefine((val, ctx) => {
    if (val.managedCopy.verifiedSha256.toLowerCase() !== val.sha256.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'managedCopy.verifiedSha256 does not match manifest.sha256'
      })
    }
    if (val.managedCopy.verifiedByteSize !== val.byteSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'managedCopy.verifiedByteSize does not match manifest.byteSize'
      })
    }
    for (let i = 0; i < val.sources.length; i++) {
      const src = val.sources[i]
      if (!src) continue
      if (src.recordedFacts.byteSize !== val.byteSize) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sources[${i}].recordedFacts.byteSize does not match manifest.byteSize`
        })
      }
      if (src.importResult.verifiedSourceSha256.toLowerCase() !== val.sha256.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sources[${i}].importResult.verifiedSourceSha256 does not match manifest.sha256`
        })
      }
    }
  })
