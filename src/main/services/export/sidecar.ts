/**
 * Personal Vault — Stage 8A Allowlisted Sidecar & Bundle Manifest Builders
 */

import type {
  ExportBundleManifestV1,
  ExportByteSourceUsed,
  ExportPrivacyOptions,
  ExportSidecarV1,
  ExportVaultIntegrityWarning
} from '../../../shared/validation/export-schemas'
import {
  ExportBundleManifestV1Schema,
  ExportSidecarV1Schema
} from '../../../shared/validation/export-schemas'
import { EMBEDDED_METADATA_NOTICE, type ExportItemInput } from './types'

export function buildExportSidecarV1(params: {
  readonly exportJobId: string
  readonly exportedAtMs: number
  readonly appVersion: string
  readonly exportedFileName: string
  readonly verifiedSha256: string
  readonly verifiedByteSize: number
  readonly byteSourceUsed: ExportByteSourceUsed
  readonly vaultIntegrityWarning: ExportVaultIntegrityWarning | null
  readonly privacyOptions: ExportPrivacyOptions
  readonly item: ExportItemInput
}): ExportSidecarV1 {
  const { item, privacyOptions } = params

  const machineGenerated: ExportSidecarV1['machineGenerated'] =
    item.machineGenerated.kind === 'photo'
      ? {
          kind: 'photo',
          metadataStatus: item.machineGenerated.metadataStatus,
          parserRecipeVersion: item.machineGenerated.parserRecipeVersion,
          detectedFormat: item.machineGenerated.detectedFormat,
          extensionFormatMismatch: item.machineGenerated.extensionFormatMismatch,
          encodedWidthPx: item.machineGenerated.encodedWidthPx,
          encodedHeightPx: item.machineGenerated.encodedHeightPx,
          exifOrientation: item.machineGenerated.exifOrientation,
          displayWidthPx: item.machineGenerated.displayWidthPx,
          displayHeightPx: item.machineGenerated.displayHeightPx,
          inferredCaptureDate: item.machineGenerated.inferredCaptureDate
            ? { ...item.machineGenerated.inferredCaptureDate }
            : null,
          cameraDisplay: item.machineGenerated.cameraDisplay,
          lensDisplay: item.machineGenerated.lensDisplay,
          gpsLocation: {
            status: 'not_extracted',
            coordinates: null
          },
          dhash64: item.machineGenerated.dhash64
        }
      : {
          kind: 'document',
          nativeExtraction: {
            status: item.machineGenerated.nativeExtraction.status,
            recipeVersion: item.machineGenerated.nativeExtraction.recipeVersion,
            pageCount: item.machineGenerated.nativeExtraction.pageCount,
            charCount: item.machineGenerated.nativeExtraction.charCount,
            truncated: item.machineGenerated.nativeExtraction.truncated,
            text: privacyOptions.includeExtractedText
              ? item.machineGenerated.nativeExtraction.text
              : null
          },
          ocrExtraction: {
            status: item.machineGenerated.ocrExtraction.status,
            method: item.machineGenerated.ocrExtraction.method,
            modelId: item.machineGenerated.ocrExtraction.modelId,
            language: item.machineGenerated.ocrExtraction.language,
            meanConfidence: item.machineGenerated.ocrExtraction.meanConfidence,
            truncated: item.machineGenerated.ocrExtraction.truncated,
            text: privacyOptions.includeExtractedText
              ? item.machineGenerated.ocrExtraction.text
              : null
          },
          automaticClassification: item.machineGenerated.automaticClassification
            ? {
                ruleVersion: item.machineGenerated.automaticClassification.ruleVersion,
                textSourceKind: item.machineGenerated.automaticClassification.textSourceKind,
                purposeStatus: item.machineGenerated.automaticClassification.purposeStatus,
                purposeLabels: [...item.machineGenerated.automaticClassification.purposeLabels],
                originStatus: item.machineGenerated.automaticClassification.originStatus,
                originLabels: [...item.machineGenerated.automaticClassification.originLabels],
                confidenceBand: item.machineGenerated.automaticClassification.confidenceBand,
                isClutterCandidate:
                  item.machineGenerated.automaticClassification.isClutterCandidate,
                uncertaintyReasons: [
                  ...item.machineGenerated.automaticClassification.uncertaintyReasons
                ]
              }
            : null
        }

  const userOverridesAndAnnotations: ExportSidecarV1['userOverridesAndAnnotations'] =
    item.userOverridesAndAnnotations.kind === 'photo'
      ? {
          kind: 'photo',
          rating: item.userOverridesAndAnnotations.rating,
          flag: item.userOverridesAndAnnotations.flag,
          collections: [...item.userOverridesAndAnnotations.collections],
          duplicateReview: item.userOverridesAndAnnotations.duplicateReview
            ? { ...item.userOverridesAndAnnotations.duplicateReview }
            : null
        }
      : {
          kind: 'document',
          classificationOverride: item.userOverridesAndAnnotations.classificationOverride
            ? {
                purposeLabels: item.userOverridesAndAnnotations.classificationOverride.purposeLabels
                  ? [...item.userOverridesAndAnnotations.classificationOverride.purposeLabels]
                  : null,
                originLabels: item.userOverridesAndAnnotations.classificationOverride.originLabels
                  ? [...item.userOverridesAndAnnotations.classificationOverride.originLabels]
                  : null,
                clutterOverride:
                  item.userOverridesAndAnnotations.classificationOverride.clutterOverride,
                overrideVersion:
                  item.userOverridesAndAnnotations.classificationOverride.overrideVersion,
                updatedAtMs: item.userOverridesAndAnnotations.classificationOverride.updatedAtMs
              }
            : null,
          effectiveClassification: {
            purposeLabels: [
              ...item.userOverridesAndAnnotations.effectiveClassification.purposeLabels
            ],
            originLabels: [
              ...item.userOverridesAndAnnotations.effectiveClassification.originLabels
            ],
            isClutter: item.userOverridesAndAnnotations.effectiveClassification.isClutter,
            resolvedFrom: item.userOverridesAndAnnotations.effectiveClassification.resolvedFrom
          },
          duplicateReview: item.userOverridesAndAnnotations.duplicateReview
            ? { ...item.userOverridesAndAnnotations.duplicateReview }
            : null
        }

  const sidecar: ExportSidecarV1 = {
    formatVersion: 1,
    schema: 'pv_export_sidecar_v1',
    exportAudit: {
      exportJobId: params.exportJobId,
      exportedAtMs: params.exportedAtMs,
      appVersion: params.appVersion,
      exportedFileName: params.exportedFileName,
      verifiedSha256: params.verifiedSha256,
      verifiedByteSize: params.verifiedByteSize,
      byteSourceUsed: params.byteSourceUsed,
      vaultIntegrityWarning: params.vaultIntegrityWarning,
      privacyPolicyApplied: {
        includeOriginalPaths: privacyOptions.includeOriginalPaths,
        includeExtractedText: privacyOptions.includeExtractedText
      }
    },
    recordedFacts: {
      originalFileName: item.fileName,
      recordedExtension: item.extension,
      category: item.category,
      byteSize: item.recordedFacts.byteSize,
      sha256: item.expectedSha256,
      filesystemBirthtimeMs: item.recordedFacts.filesystemBirthtimeMs,
      filesystemMtimeMs: item.recordedFacts.filesystemMtimeMs,
      firstDiscoveredAtMs: item.recordedFacts.firstDiscoveredAtMs,
      lastSeenAtMs: item.recordedFacts.lastSeenAtMs,
      discoveryObservationId: item.discoveryObservationId,
      hashObservationId: item.hashObservationId,
      hashVerifiedAtMs: item.recordedFacts.hashVerifiedAtMs,
      originalSourcePath: privacyOptions.includeOriginalPaths ? item.originalPath : null
    },
    machineGenerated,
    userOverridesAndAnnotations
  }

  return ExportSidecarV1Schema.parse(sidecar)
}

export function buildExportBundleManifestV1(params: {
  readonly exportJobId: string
  readonly status: 'completed' | 'cancelled' | 'failed'
  readonly createdAtMs: number
  readonly completedAtMs: number
  readonly appVersion: string
  readonly privacyOptions: ExportPrivacyOptions
  readonly items: ExportBundleManifestV1['items']
  readonly vaultIntegrityWarnings: number
}): ExportBundleManifestV1 {
  const exportedItems = params.items.filter((i) => i.status === 'completed').length
  const failedItems = params.items.filter((i) => i.status === 'failed').length
  const cancelledItems = params.items.filter((i) => i.status === 'cancelled').length

  const manifest: ExportBundleManifestV1 = {
    formatVersion: 1,
    schema: 'pv_export_bundle_v1',
    exportJobId: params.exportJobId,
    status: params.status,
    createdAtMs: params.createdAtMs,
    completedAtMs: params.completedAtMs,
    appVersion: params.appVersion,
    privacyPolicy: {
      includeOriginalPaths: params.privacyOptions.includeOriginalPaths,
      includeExtractedText: params.privacyOptions.includeExtractedText,
      gpsPolicy: 'not_extracted',
      embeddedMetadataNotice: EMBEDDED_METADATA_NOTICE
    },
    counts: {
      totalItems: params.items.length,
      exportedItems,
      failedItems,
      cancelledItems,
      vaultIntegrityWarnings: params.vaultIntegrityWarnings
    },
    items: params.items
  }

  return ExportBundleManifestV1Schema.parse(manifest)
}
