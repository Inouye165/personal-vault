import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExportBundleManifestV1Schema,
  ExportSidecarV1Schema
} from '../../src/shared/validation/export-schemas'
import {
  exportBundle,
  inspectExportBundleStatus,
  resolveExportBatchFileNames,
  sanitizeExportFileName,
  validateExportParentAndBundlePath,
  type ExportItemInput
} from '../../src/main/services/export'

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function makeMinimalJpegWithTextMarker(label: string): Buffer {
  // Minimal valid-looking JPEG bytes with an embedded APP1 comment/EXIF-like marker payload
  // to prove byte-for-byte copy preserves embedded binary metadata intact.
  const payload = Buffer.from(`Exif\0\0FAKE_GPS_AND_CAMERA_${label}`, 'ascii')
  const len = payload.length + 2
  const app1 = Buffer.alloc(4 + payload.length)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(len, 2)
  payload.copy(app1, 4)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])])
}

describe('Stage 8A Slice 1 — Selective Export Core', () => {
  const tempRoots: string[] = []

  function createWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pv-export-test-'))
    tempRoots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempRoots.splice(0, tempRoots.length)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('Path containment, sibling export, and filename sanitization', () => {
    it('allows a sibling export when chosen parent is an ancestor of a registered source root', () => {
      const ws = createWorkspace()
      const parentDir = join(ws, 'library')
      const sourceRoot = join(parentDir, 'photos-2025')
      const vaultRoot = join(ws, 'vault')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(vaultRoot, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const res = validateExportParentAndBundlePath({
        parentDir,
        bundleFolderName: 'PersonalVault-Export-20261119',
        sourceRoots: [sourceRoot],
        vaultRoots: [vaultRoot],
        userDataDir
      })

      expect(res.bundleDir).toBe(join(res.canonicalParentDir, 'PersonalVault-Export-20261119'))
    })

    it('rejects parent inside source/vault/userData and rejects bundle equal to or above source', () => {
      const ws = createWorkspace()
      const parentDir = join(ws, 'library')
      const sourceRoot = join(parentDir, 'photos-2025')
      const vaultRoot = join(ws, 'vault')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(vaultRoot, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      // Parent inside source root -> reject
      expect(() =>
        validateExportParentAndBundlePath({
          parentDir: sourceRoot,
          bundleFolderName: 'Export-1',
          sourceRoots: [sourceRoot],
          vaultRoots: [vaultRoot],
          userDataDir
        })
      ).toThrow(/overlap|inside|source/i)

      // Parent inside vault -> reject
      expect(() =>
        validateExportParentAndBundlePath({
          parentDir: vaultRoot,
          bundleFolderName: 'Export-1',
          sourceRoots: [sourceRoot],
          vaultRoots: [vaultRoot],
          userDataDir
        })
      ).toThrow(/overlap|inside|vault/i)

      // Parent inside userData -> reject
      expect(() =>
        validateExportParentAndBundlePath({
          parentDir: userDataDir,
          bundleFolderName: 'Export-1',
          sourceRoots: [sourceRoot],
          vaultRoots: [vaultRoot],
          userDataDir
        })
      ).toThrow(/overlap|inside|app/i)

      // Bundle name colliding with source root -> reject
      expect(() =>
        validateExportParentAndBundlePath({
          parentDir,
          bundleFolderName: 'photos-2025',
          sourceRoots: [sourceRoot],
          vaultRoots: [vaultRoot],
          userDataDir
        })
      ).toThrow(/overlap|exist/i)

      // Bundle folder above a source root -> reject
      expect(() =>
        validateExportParentAndBundlePath({
          parentDir: ws,
          bundleFolderName: 'library',
          sourceRoots: [sourceRoot],
          vaultRoots: [vaultRoot],
          userDataDir
        })
      ).toThrow(/overlap|exist/i)
    })

    it('rejects symlinked parent directories', () => {
      const ws = createWorkspace()
      const realTarget = join(ws, 'real-dest')
      const linkParent = join(ws, 'link-dest')
      mkdirSync(realTarget, { recursive: true })

      let created: boolean
      try {
        symlinkSync(realTarget, linkParent, process.platform === 'win32' ? 'junction' : 'dir')
        created = true
      } catch {
        created = false
      }
      if (!created) return

      expect(() =>
        validateExportParentAndBundlePath({
          parentDir: linkParent,
          bundleFolderName: 'Export-1',
          sourceRoots: [],
          vaultRoots: [],
          userDataDir: join(ws, 'user-data')
        })
      ).toThrow(/symlink|junction/i)
    })

    it('sanitizes Windows-illegal, reserved device, and reserved bundle filenames', () => {
      expect(sanitizeExportFileName('CON.txt')).toBe('_CON.txt')
      expect(sanitizeExportFileName('nul')).toBe('_nul')
      expect(sanitizeExportFileName('bad<name>:file?.jpg.')).toBe('bad_name__file_.jpg')
      expect(sanitizeExportFileName('export-manifest.json')).toBe('item_export-manifest.json')
      expect(sanitizeExportFileName('photo.jpg.pv-meta.json')).toBe('photo.jpg_.json')
    })

    it('resolves intra-batch filename collisions deterministically while preserving originalFileName', () => {
      const resolved = resolveExportBatchFileNames([
        { fileLocationId: 20, fileName: 'IMG_0001.JPG' },
        { fileLocationId: 10, fileName: 'img_0001.jpg' },
        { fileLocationId: 30, fileName: 'IMG_0001.JPG' }
      ])
      expect(resolved.get(10)).toBe('img_0001.jpg')
      expect(resolved.get(20)).toBe('IMG_0001__2.JPG')
      expect(resolved.get(30)).toBe('IMG_0001__3.JPG')
    })
  })

  describe('Verified export, publication paths, collisions, and privacy allowlist', () => {
    it('exports via hard-link path with default redacted sidecars, preserved timestamps without EXIF, and untouched source', async () => {
      const ws = createWorkspace()
      const sourceRoot = join(ws, 'sources')
      const exportParent = join(ws, 'exports')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(exportParent, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const photoPath = join(sourceRoot, 'beach.jpg')
      const photoBytes = makeMinimalJpegWithTextMarker('PRIVATE_CAM')
      writeFileSync(photoPath, photoBytes)
      const photoStat = statSync(photoPath)
      const photoSha = sha256Hex(photoBytes)

      const docPath = join(sourceRoot, 'notes.txt')
      const docBytes = Buffer.from('Secret personal medical note', 'utf8')
      writeFileSync(docPath, docBytes)
      const docStat = statSync(docPath)
      const docSha = sha256Hex(docBytes)

      const items: ExportItemInput[] = [
        {
          fileLocationId: 1,
          discoveryObservationId: 101,
          hashObservationId: 201,
          originalPath: photoPath,
          fileName: 'beach.jpg',
          extension: '.jpg',
          category: 'photo',
          recordedFacts: {
            byteSize: photoBytes.length,
            filesystemBirthtimeMs: photoStat.birthtimeMs,
            filesystemMtimeMs: photoStat.mtimeMs,
            firstDiscoveredAtMs: 1700000000000,
            lastSeenAtMs: 1700000005000,
            hashVerifiedAtMs: 1700000006000
          },
          expectedSha256: photoSha,
          vaultCopy: null,
          machineGenerated: {
            kind: 'photo',
            metadataStatus: 'no_metadata',
            parserRecipeVersion: 'exif_tech_v1',
            detectedFormat: 'jpeg',
            extensionFormatMismatch: false,
            encodedWidthPx: 800,
            encodedHeightPx: 600,
            exifOrientation: null,
            displayWidthPx: 800,
            displayHeightPx: 600,
            inferredCaptureDate: null,
            cameraDisplay: null,
            lensDisplay: null,
            dhash64: '0123456789abcdef'
          },
          userOverridesAndAnnotations: {
            kind: 'photo',
            rating: 5,
            flag: 'pick',
            collections: ['Favorites'],
            duplicateReview: { status: 'reviewed', isPreferredLocation: true }
          }
        },
        {
          fileLocationId: 2,
          discoveryObservationId: 102,
          hashObservationId: 202,
          originalPath: docPath,
          fileName: 'notes.txt',
          extension: '.txt',
          category: 'document',
          recordedFacts: {
            byteSize: docBytes.length,
            filesystemBirthtimeMs: docStat.birthtimeMs,
            filesystemMtimeMs: docStat.mtimeMs,
            firstDiscoveredAtMs: 1700000001000,
            lastSeenAtMs: 1700000005000,
            hashVerifiedAtMs: 1700000006000
          },
          expectedSha256: docSha,
          vaultCopy: null,
          machineGenerated: {
            kind: 'document',
            nativeExtraction: {
              status: 'extracted',
              recipeVersion: 'doc_extract_v1',
              pageCount: null,
              charCount: 28,
              truncated: false,
              text: 'Secret personal medical note'
            },
            ocrExtraction: {
              status: 'not_processed',
              method: null,
              modelId: null,
              language: null,
              meanConfidence: null,
              truncated: false,
              text: null
            },
            automaticClassification: {
              ruleVersion: 'doc_classify_rules_v1',
              textSourceKind: 'native',
              purposeStatus: 'other',
              purposeLabels: [],
              originStatus: 'classified',
              originLabels: ['personal'],
              confidenceBand: 'medium',
              isClutterCandidate: false,
              uncertaintyReasons: []
            }
          },
          userOverridesAndAnnotations: {
            kind: 'document',
            classificationOverride: {
              purposeLabels: ['lists'],
              originLabels: ['personal'],
              clutterOverride: 'force_keep',
              overrideVersion: 2,
              updatedAtMs: 1700000010000
            },
            effectiveClassification: {
              purposeLabels: ['lists'],
              originLabels: ['personal'],
              isClutter: false,
              resolvedFrom: 'user_override'
            },
            duplicateReview: null
          }
        }
      ]

      const result = await exportBundle({
        exportJobId: 'job-1',
        parentDir: exportParent,
        bundleFolderName: 'Bundle-Default',
        sourceRoots: [sourceRoot],
        vaultRoots: [],
        userDataDir,
        vaultPath: null,
        appVersion: '0.1.0',
        privacyOptions: {
          includeOriginalPaths: false,
          includeExtractedText: false
        },
        items
      })

      expect(result.status).toBe('completed')
      expect(result.manifestPublished).toBe(true)
      expect(result.exportedItems).toBe(2)
      expect(result.failedItems).toBe(0)

      // Completion rule passes
      const inspection = inspectExportBundleStatus(result.bundleDir)
      expect(inspection.isCompleteVerified).toBe(true)
      expect(inspection.reasons).toEqual([])

      // Embedded binary bytes are exact byte-for-byte copies
      const exportedPhotoBytes = readFileSync(join(result.bundleDir, 'beach.jpg'))
      expect(exportedPhotoBytes.equals(photoBytes)).toBe(true)

      // Sidecar privacy & layer separation checks
      const photoSidecar = ExportSidecarV1Schema.parse(
        JSON.parse(readFileSync(join(result.bundleDir, 'beach.jpg.pv-meta.json'), 'utf8'))
      )
      expect(photoSidecar.recordedFacts.originalSourcePath).toBeNull()
      expect(photoSidecar.recordedFacts.filesystemBirthtimeMs).toBe(photoStat.birthtimeMs)
      expect(photoSidecar.recordedFacts.filesystemMtimeMs).toBe(photoStat.mtimeMs)
      expect(photoSidecar.machineGenerated.kind).toBe('photo')
      if (photoSidecar.machineGenerated.kind === 'photo') {
        expect(photoSidecar.machineGenerated.inferredCaptureDate).toBeNull()
        expect(photoSidecar.machineGenerated.gpsLocation).toEqual({
          status: 'not_extracted',
          coordinates: null
        })
      }
      expect(photoSidecar.userOverridesAndAnnotations.kind).toBe('photo')

      const docSidecarRaw = readFileSync(join(result.bundleDir, 'notes.txt.pv-meta.json'), 'utf8')
      expect(docSidecarRaw).not.toContain('Secret personal medical note')
      expect(docSidecarRaw).not.toContain(sourceRoot)
      const docSidecar = ExportSidecarV1Schema.parse(JSON.parse(docSidecarRaw))
      if (docSidecar.machineGenerated.kind === 'document') {
        expect(docSidecar.machineGenerated.nativeExtraction.text).toBeNull()
      }

      const manifestRaw = readFileSync(join(result.bundleDir, 'export-manifest.json'), 'utf8')
      expect(manifestRaw).not.toContain(sourceRoot)
      const manifest = ExportBundleManifestV1Schema.parse(JSON.parse(manifestRaw))
      expect(manifest.privacyPolicy.embeddedMetadataNotice).toMatch(/exact.*byte-for-byte/i)

      // Source preservation invariance
      const photoStatAfter = statSync(photoPath)
      const docStatAfter = statSync(docPath)
      expect(sha256Hex(readFileSync(photoPath))).toBe(photoSha)
      expect(photoStatAfter.size).toBe(photoStat.size)
      expect(photoStatAfter.birthtimeMs).toBe(photoStat.birthtimeMs)
      expect(photoStatAfter.mtimeMs).toBe(photoStat.mtimeMs)
      expect(sha256Hex(readFileSync(docPath))).toBe(docSha)
      expect(docStatAfter.size).toBe(docStat.size)
      expect(docStatAfter.birthtimeMs).toBe(docStat.birthtimeMs)
      expect(docStatAfter.mtimeMs).toBe(docStat.mtimeMs)
    })

    it('uses COPYFILE_EXCL fallback when hard-link fails with EXDEV and verifies destination bytes', async () => {
      const ws = createWorkspace()
      const sourceRoot = join(ws, 'sources')
      const exportParent = join(ws, 'exports')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(exportParent, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const filePath = join(sourceRoot, 'doc.txt')
      const fileBytes = Buffer.from('Cross-device fallback content', 'utf8')
      writeFileSync(filePath, fileBytes)
      const st = statSync(filePath)
      const sha = sha256Hex(fileBytes)

      const item: ExportItemInput = {
        fileLocationId: 1,
        discoveryObservationId: 1,
        hashObservationId: 1,
        originalPath: filePath,
        fileName: 'doc.txt',
        extension: '.txt',
        category: 'document',
        recordedFacts: {
          byteSize: fileBytes.length,
          filesystemBirthtimeMs: st.birthtimeMs,
          filesystemMtimeMs: st.mtimeMs,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashVerifiedAtMs: 1700000000000
        },
        expectedSha256: sha,
        vaultCopy: null,
        machineGenerated: {
          kind: 'document',
          nativeExtraction: {
            status: 'not_extracted',
            recipeVersion: null,
            pageCount: null,
            charCount: 0,
            truncated: false,
            text: null
          },
          ocrExtraction: {
            status: 'not_processed',
            method: null,
            modelId: null,
            language: null,
            meanConfidence: null,
            truncated: false,
            text: null
          },
          automaticClassification: null
        },
        userOverridesAndAnnotations: {
          kind: 'document',
          classificationOverride: null,
          effectiveClassification: {
            purposeLabels: [],
            originLabels: [],
            isClutter: false,
            resolvedFrom: 'unclassified'
          },
          duplicateReview: null
        }
      }

      const result = await exportBundle(
        {
          exportJobId: 'job-exdev',
          parentDir: exportParent,
          bundleFolderName: 'Bundle-Fallback',
          sourceRoots: [sourceRoot],
          vaultRoots: [],
          userDataDir,
          vaultPath: null,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [item]
        },
        {
          linkSync: () => {
            const err = new Error('EXDEV') as NodeJS.ErrnoException
            err.code = 'EXDEV'
            throw err
          }
        }
      )

      expect(result.status).toBe('completed')
      expect(result.manifestPublished).toBe(true)
      expect(readFileSync(join(result.bundleDir, 'doc.txt')).equals(fileBytes)).toBe(true)
      expect(inspectExportBundleStatus(result.bundleDir).isCompleteVerified).toBe(true)
    })

    it('refuses to overwrite an existing destination file on both hard-link and COPYFILE_EXCL paths', async () => {
      const ws = createWorkspace()
      const sourceRoot = join(ws, 'sources')
      const exportParent = join(ws, 'exports')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(exportParent, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const filePath = join(sourceRoot, 'a.txt')
      const bytes = Buffer.from('new content', 'utf8')
      writeFileSync(filePath, bytes)
      const st = statSync(filePath)
      const sha = sha256Hex(bytes)

      const makeItem = (): ExportItemInput => ({
        fileLocationId: 1,
        discoveryObservationId: 1,
        hashObservationId: 1,
        originalPath: filePath,
        fileName: 'a.txt',
        extension: '.txt',
        category: 'document',
        recordedFacts: {
          byteSize: bytes.length,
          filesystemBirthtimeMs: st.birthtimeMs,
          filesystemMtimeMs: st.mtimeMs,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashVerifiedAtMs: 1700000000000
        },
        expectedSha256: sha,
        vaultCopy: null,
        machineGenerated: {
          kind: 'document',
          nativeExtraction: {
            status: 'not_extracted',
            recipeVersion: null,
            pageCount: null,
            charCount: 0,
            truncated: false,
            text: null
          },
          ocrExtraction: {
            status: 'not_processed',
            method: null,
            modelId: null,
            language: null,
            meanConfidence: null,
            truncated: false,
            text: null
          },
          automaticClassification: null
        },
        userOverridesAndAnnotations: {
          kind: 'document',
          classificationOverride: null,
          effectiveClassification: {
            purposeLabels: [],
            originLabels: [],
            isClutter: false,
            resolvedFrom: 'unclassified'
          },
          duplicateReview: null
        }
      })

      // Inject an existing destination file right before publication on hard-link path
      const resLink = await exportBundle(
        {
          exportJobId: 'job-col-1',
          parentDir: exportParent,
          bundleFolderName: 'Bundle-Col-Link',
          sourceRoots: [sourceRoot],
          vaultRoots: [],
          userDataDir,
          vaultPath: null,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [makeItem()]
        },
        {
          beforePublishHook: (destPath) => {
            if (destPath.endsWith('a.txt')) {
              writeFileSync(destPath, 'DO_NOT_OVERWRITE', 'utf8')
            }
          }
        }
      )

      expect(resLink.status).toBe('failed')
      expect(resLink.failedItems).toBe(1)
      expect(readFileSync(join(resLink.bundleDir, 'a.txt'), 'utf8')).toBe('DO_NOT_OVERWRITE')

      // Inject EXDEV + existing destination file on COPYFILE_EXCL fallback path
      const resCopy = await exportBundle(
        {
          exportJobId: 'job-col-2',
          parentDir: exportParent,
          bundleFolderName: 'Bundle-Col-Copy',
          sourceRoots: [sourceRoot],
          vaultRoots: [],
          userDataDir,
          vaultPath: null,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [makeItem()]
        },
        {
          beforePublishHook: (destPath) => {
            if (destPath.endsWith('a.txt')) {
              writeFileSync(destPath, 'DO_NOT_OVERWRITE_FALLBACK', 'utf8')
            }
          },
          linkSync: () => {
            const err = new Error('EXDEV') as NodeJS.ErrnoException
            err.code = 'EXDEV'
            throw err
          }
        }
      )

      expect(resCopy.status).toBe('failed')
      expect(resCopy.failedItems).toBe(1)
      expect(readFileSync(join(resCopy.bundleDir, 'a.txt'), 'utf8')).toBe(
        'DO_NOT_OVERWRITE_FALLBACK'
      )
    })

    it('prefers verified vault copy, warns & falls back to hash-verified source if vault copy is corrupt, and preserves vault/source timestamps', async () => {
      const ws = createWorkspace()
      const sourceRoot = join(ws, 'sources')
      const vaultRoot = join(ws, 'vault')
      const exportParent = join(ws, 'exports')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(exportParent, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const bytes1 = Buffer.from('item-1-vault-ok', 'utf8')
      const sha1 = sha256Hex(bytes1)
      const src1 = join(sourceRoot, 'v1.txt')
      writeFileSync(src1, bytes1)
      const src1Stat = statSync(src1)

      const vaultRel1 = `files/${sha1.slice(0, 2)}/${sha1}/v1.txt`
      const vaultAbs1 = join(vaultRoot, vaultRel1)
      mkdirSync(join(vaultRoot, 'files', sha1.slice(0, 2), sha1), { recursive: true })
      writeFileSync(vaultAbs1, bytes1)
      const vault1Stat = statSync(vaultAbs1)

      const bytes2 = Buffer.from('item-2-vault-corrupt', 'utf8')
      const sha2 = sha256Hex(bytes2)
      const src2 = join(sourceRoot, 'v2.txt')
      writeFileSync(src2, bytes2)
      const src2Stat = statSync(src2)

      const vaultRel2 = `files/${sha2.slice(0, 2)}/${sha2}/v2.txt`
      const vaultAbs2 = join(vaultRoot, vaultRel2)
      mkdirSync(join(vaultRoot, 'files', sha2.slice(0, 2), sha2), { recursive: true })
      writeFileSync(vaultAbs2, Buffer.from('CORRUPTED_VAULT_BYTES!', 'utf8'))

      const makeDocItem = (
        id: number,
        orig: string,
        name: string,
        bytes: Buffer,
        st: Stats,
        sha: string,
        rel: string
      ): ExportItemInput => ({
        fileLocationId: id,
        discoveryObservationId: id,
        hashObservationId: id,
        originalPath: orig,
        fileName: name,
        extension: '.txt',
        category: 'document',
        recordedFacts: {
          byteSize: bytes.length,
          filesystemBirthtimeMs: st.birthtimeMs,
          filesystemMtimeMs: st.mtimeMs,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashVerifiedAtMs: 1700000000000
        },
        expectedSha256: sha,
        vaultCopy: {
          relativePath: rel,
          verifiedSha256: sha,
          verifiedByteSize: bytes.length
        },
        machineGenerated: {
          kind: 'document',
          nativeExtraction: {
            status: 'not_extracted',
            recipeVersion: null,
            pageCount: null,
            charCount: 0,
            truncated: false,
            text: null
          },
          ocrExtraction: {
            status: 'not_processed',
            method: null,
            modelId: null,
            language: null,
            meanConfidence: null,
            truncated: false,
            text: null
          },
          automaticClassification: null
        },
        userOverridesAndAnnotations: {
          kind: 'document',
          classificationOverride: null,
          effectiveClassification: {
            purposeLabels: [],
            originLabels: [],
            isClutter: false,
            resolvedFrom: 'unclassified'
          },
          duplicateReview: null
        }
      })

      const result = await exportBundle({
        exportJobId: 'job-vault-first',
        parentDir: exportParent,
        bundleFolderName: 'Bundle-Vault-First',
        sourceRoots: [sourceRoot],
        vaultRoots: [vaultRoot],
        userDataDir,
        vaultPath: vaultRoot,
        appVersion: '0.1.0',
        privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
        items: [
          makeDocItem(1, src1, 'v1.txt', bytes1, src1Stat, sha1, vaultRel1),
          makeDocItem(2, src2, 'v2.txt', bytes2, src2Stat, sha2, vaultRel2)
        ]
      })

      expect(result.status).toBe('completed')
      expect(result.exportedItems).toBe(2)
      expect(result.vaultIntegrityWarnings).toBe(1)

      const s1 = ExportSidecarV1Schema.parse(
        JSON.parse(readFileSync(join(result.bundleDir, 'v1.txt.pv-meta.json'), 'utf8'))
      )
      expect(s1.exportAudit.byteSourceUsed).toBe('vault_copy')
      expect(s1.exportAudit.vaultIntegrityWarning).toBeNull()

      const s2 = ExportSidecarV1Schema.parse(
        JSON.parse(readFileSync(join(result.bundleDir, 'v2.txt.pv-meta.json'), 'utf8'))
      )
      expect(s2.exportAudit.byteSourceUsed).toBe('source_fallback_after_vault_warning')
      expect(s2.exportAudit.vaultIntegrityWarning).toBe('vault_copy_hash_mismatch')
      expect(readFileSync(join(result.bundleDir, 'v2.txt')).equals(bytes2)).toBe(true)

      // Vault copy 1 timestamps & bytes preserved
      const vault1After = statSync(vaultAbs1)
      expect(vault1After.mtimeMs).toBe(vault1Stat.mtimeMs)
      expect(vault1After.birthtimeMs).toBe(vault1Stat.birthtimeMs)
    })
  })

  describe('Partial failures, cancellation, disk-full manifest, and single completion rule', () => {
    it('handles partial failures with sanitized error messages (no raw absolute paths leaked)', async () => {
      const ws = createWorkspace()
      const sourceRoot = join(ws, 'sources')
      const exportParent = join(ws, 'exports')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(exportParent, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const goodPath = join(sourceRoot, 'good.txt')
      const goodBytes = Buffer.from('good-file', 'utf8')
      writeFileSync(goodPath, goodBytes)
      const goodStat = statSync(goodPath)
      const goodSha = sha256Hex(goodBytes)

      const missingPath = join(sourceRoot, 'secret-user-folder', 'missing.txt')

      const makeItem = (
        id: number,
        p: string,
        name: string,
        size: number,
        sha: string
      ): ExportItemInput => ({
        fileLocationId: id,
        discoveryObservationId: id,
        hashObservationId: id,
        originalPath: p,
        fileName: name,
        extension: '.txt',
        category: 'document',
        recordedFacts: {
          byteSize: size,
          filesystemBirthtimeMs: goodStat.birthtimeMs,
          filesystemMtimeMs: goodStat.mtimeMs,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashVerifiedAtMs: 1700000000000
        },
        expectedSha256: sha,
        vaultCopy: null,
        machineGenerated: {
          kind: 'document',
          nativeExtraction: {
            status: 'not_extracted',
            recipeVersion: null,
            pageCount: null,
            charCount: 0,
            truncated: false,
            text: null
          },
          ocrExtraction: {
            status: 'not_processed',
            method: null,
            modelId: null,
            language: null,
            meanConfidence: null,
            truncated: false,
            text: null
          },
          automaticClassification: null
        },
        userOverridesAndAnnotations: {
          kind: 'document',
          classificationOverride: null,
          effectiveClassification: {
            purposeLabels: [],
            originLabels: [],
            isClutter: false,
            resolvedFrom: 'unclassified'
          },
          duplicateReview: null
        }
      })

      const result = await exportBundle({
        exportJobId: 'job-partial',
        parentDir: exportParent,
        bundleFolderName: 'Bundle-Partial',
        sourceRoots: [sourceRoot],
        vaultRoots: [],
        userDataDir,
        vaultPath: null,
        appVersion: '0.1.0',
        privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
        items: [
          makeItem(1, goodPath, 'good.txt', goodBytes.length, goodSha),
          makeItem(2, missingPath, 'missing.txt', 100, goodSha)
        ]
      })

      expect(result.status).toBe('completed')
      expect(result.exportedItems).toBe(1)
      expect(result.failedItems).toBe(1)
      expect(result.manifestPublished).toBe(true)
      expect(existsSync(join(result.bundleDir, 'missing.txt'))).toBe(false)

      const manifestRaw = readFileSync(join(result.bundleDir, 'export-manifest.json'), 'utf8')
      expect(manifestRaw).not.toContain('secret-user-folder')
      expect(manifestRaw).not.toContain(sourceRoot)

      const manifest = ExportBundleManifestV1Schema.parse(JSON.parse(manifestRaw))
      const failedEntry = manifest.items.find((i) => i.fileLocationId === 2)
      expect(failedEntry?.status).toBe('failed')
      if (failedEntry?.status === 'failed') {
        expect(failedEntry.errorCode).toBe('source_missing')
        expect(failedEntry.originalSourcePath).toBeNull()
      }
      expect(inspectExportBundleStatus(result.bundleDir).isCompleteVerified).toBe(true)
    })

    it('cancels cleanly on AbortSignal, cleans temp files, and marks incomplete bundle on ENOSPC during manifest publish', async () => {
      const ws = createWorkspace()
      const sourceRoot = join(ws, 'sources')
      const exportParent = join(ws, 'exports')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(exportParent, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const filePath = join(sourceRoot, 'big.bin')
      const bytes = Buffer.alloc(128 * 1024, 0x41)
      writeFileSync(filePath, bytes)
      const st = statSync(filePath)
      const sha = sha256Hex(bytes)

      const makeItem = (): ExportItemInput => ({
        fileLocationId: 1,
        discoveryObservationId: 1,
        hashObservationId: 1,
        originalPath: filePath,
        fileName: 'big.bin',
        extension: '.bin',
        category: 'document',
        recordedFacts: {
          byteSize: bytes.length,
          filesystemBirthtimeMs: st.birthtimeMs,
          filesystemMtimeMs: st.mtimeMs,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashVerifiedAtMs: 1700000000000
        },
        expectedSha256: sha,
        vaultCopy: null,
        machineGenerated: {
          kind: 'document',
          nativeExtraction: {
            status: 'not_extracted',
            recipeVersion: null,
            pageCount: null,
            charCount: 0,
            truncated: false,
            text: null
          },
          ocrExtraction: {
            status: 'not_processed',
            method: null,
            modelId: null,
            language: null,
            meanConfidence: null,
            truncated: false,
            text: null
          },
          automaticClassification: null
        },
        userOverridesAndAnnotations: {
          kind: 'document',
          classificationOverride: null,
          effectiveClassification: {
            purposeLabels: [],
            originLabels: [],
            isClutter: false,
            resolvedFrom: 'unclassified'
          },
          duplicateReview: null
        }
      })

      // 1. Mid-stream AbortSignal cancellation
      const ac = new AbortController()
      const cancelRes = await exportBundle(
        {
          exportJobId: 'job-cancel',
          parentDir: exportParent,
          bundleFolderName: 'Bundle-Cancel',
          sourceRoots: [sourceRoot],
          vaultRoots: [],
          userDataDir,
          vaultPath: null,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [makeItem()],
          signal: ac.signal
        },
        {
          onChunkReadHook: () => {
            ac.abort()
          }
        }
      )

      expect(cancelRes.status).toBe('cancelled')
      expect(cancelRes.exportedItems).toBe(0)
      expect(existsSync(join(cancelRes.bundleDir, 'big.bin'))).toBe(false)
      expect(existsSync(join(cancelRes.bundleDir, '.pv-export-temp'))).toBe(false)
      expect(inspectExportBundleStatus(cancelRes.bundleDir).isCompleteVerified).toBe(true)

      // 2. ENOSPC during manifest publication -> incomplete bundle even though item succeeded
      const enospcRes = await exportBundle(
        {
          exportJobId: 'job-enospc',
          parentDir: exportParent,
          bundleFolderName: 'Bundle-Enospc',
          sourceRoots: [sourceRoot],
          vaultRoots: [],
          userDataDir,
          vaultPath: null,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [makeItem()]
        },
        {
          beforePublishHook: (destPath) => {
            if (destPath.endsWith('export-manifest.json')) {
              const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
              err.code = 'ENOSPC'
              throw err
            }
          }
        }
      )

      expect(enospcRes.status).toBe('failed')
      expect(enospcRes.manifestPublished).toBe(false)
      expect(enospcRes.exportedItems).toBe(1)
      expect(enospcRes.errorCode).toBe('destination_disk_full')
      expect(existsSync(join(enospcRes.bundleDir, '.pv-export-in-progress.json'))).toBe(true)
      expect(existsSync(join(enospcRes.bundleDir, '.pv-export-complete.json'))).toBe(false)

      const enospcInspection = inspectExportBundleStatus(enospcRes.bundleDir)
      expect(enospcInspection.isCompleteVerified).toBe(false)
      expect(enospcInspection.reasons).toContain('in_progress_marker_present')
      expect(enospcInspection.reasons).toContain('completion_marker_missing')
      expect(enospcInspection.reasons).toContain('manifest_missing')
    })

    it('detects interrupted bundles, orphaned files, and partial/tampered manifests via single completion rule', () => {
      const ws = createWorkspace()

      // Case 1: Orphaned file without sidecar
      const orphanDir = join(ws, 'orphan-bundle')
      mkdirSync(orphanDir, { recursive: true })
      writeFileSync(join(orphanDir, 'stray.jpg'), 'abc')
      const orphanStatus = inspectExportBundleStatus(orphanDir)
      expect(orphanStatus.isCompleteVerified).toBe(false)
      expect(orphanStatus.reasons).toContain('orphaned_file_without_sidecar')

      // Case 2: Leftover progress marker & temp dir
      const crashDir = join(ws, 'crash-bundle')
      mkdirSync(join(crashDir, '.pv-export-temp'), { recursive: true })
      writeFileSync(join(crashDir, '.pv-export-in-progress.json'), '{"status":"running"}')
      const crashStatus = inspectExportBundleStatus(crashDir)
      expect(crashStatus.isCompleteVerified).toBe(false)
      expect(crashStatus.reasons).toContain('in_progress_marker_present')
      expect(crashStatus.reasons).toContain('temp_dir_present')
      expect(crashStatus.reasons).toContain('completion_marker_missing')
    })

    it('rejects corrupted destination bytes on COPYFILE_EXCL fallback and detects tampered manifest hashes', async () => {
      const ws = createWorkspace()
      const sourceRoot = join(ws, 'sources')
      const exportParent = join(ws, 'exports')
      const userDataDir = join(ws, 'user-data')
      mkdirSync(sourceRoot, { recursive: true })
      mkdirSync(exportParent, { recursive: true })
      mkdirSync(userDataDir, { recursive: true })

      const filePath = join(sourceRoot, 'item.txt')
      const bytes = Buffer.from('verified-source-bytes', 'utf8')
      writeFileSync(filePath, bytes)
      const st = statSync(filePath)
      const sha = sha256Hex(bytes)

      const makeItem = (): ExportItemInput => ({
        fileLocationId: 1,
        discoveryObservationId: 1,
        hashObservationId: 1,
        originalPath: filePath,
        fileName: 'item.txt',
        extension: '.txt',
        category: 'document',
        recordedFacts: {
          byteSize: bytes.length,
          filesystemBirthtimeMs: st.birthtimeMs,
          filesystemMtimeMs: st.mtimeMs,
          firstDiscoveredAtMs: 1700000000000,
          lastSeenAtMs: 1700000000000,
          hashVerifiedAtMs: 1700000000000
        },
        expectedSha256: sha,
        vaultCopy: null,
        machineGenerated: {
          kind: 'document',
          nativeExtraction: {
            status: 'extracted',
            recipeVersion: 'doc_extract_v1',
            pageCount: null,
            charCount: 21,
            truncated: false,
            text: 'verified-source-bytes'
          },
          ocrExtraction: {
            status: 'not_processed',
            method: null,
            modelId: null,
            language: null,
            meanConfidence: null,
            truncated: false,
            text: null
          },
          automaticClassification: null
        },
        userOverridesAndAnnotations: {
          kind: 'document',
          classificationOverride: null,
          effectiveClassification: {
            purposeLabels: [],
            originLabels: [],
            isClutter: false,
            resolvedFrom: 'unclassified'
          },
          duplicateReview: null
        }
      })

      // Injected corrupt copy on COPYFILE_EXCL fallback -> destination unlinked, item failed
      const corruptCopyRes = await exportBundle(
        {
          exportJobId: 'job-corrupt-fallback',
          parentDir: exportParent,
          bundleFolderName: 'Bundle-Corrupt-Fallback',
          sourceRoots: [sourceRoot],
          vaultRoots: [],
          userDataDir,
          vaultPath: null,
          appVersion: '0.1.0',
          privacyOptions: { includeOriginalPaths: false, includeExtractedText: false },
          items: [makeItem()]
        },
        {
          linkSync: () => {
            const err = new Error('EXDEV') as NodeJS.ErrnoException
            err.code = 'EXDEV'
            throw err
          },
          copyFileSync: (_src, dest) => {
            writeFileSync(dest, 'CORRUPT_DEST_BYTES', 'utf8')
          }
        }
      )

      expect(corruptCopyRes.status).toBe('failed')
      expect(corruptCopyRes.failedItems).toBe(1)
      expect(existsSync(join(corruptCopyRes.bundleDir, 'item.txt'))).toBe(false)

      // Opt-in privacy export + manifest tampering detection
      const optInRes = await exportBundle({
        exportJobId: 'job-opt-in',
        parentDir: exportParent,
        bundleFolderName: 'Bundle-OptIn',
        sourceRoots: [sourceRoot],
        vaultRoots: [],
        userDataDir,
        vaultPath: null,
        appVersion: '0.1.0',
        privacyOptions: { includeOriginalPaths: true, includeExtractedText: true },
        items: [makeItem()]
      })
      expect(optInRes.status).toBe('completed')
      expect(inspectExportBundleStatus(optInRes.bundleDir).isCompleteVerified).toBe(true)

      const sidecar = ExportSidecarV1Schema.parse(
        JSON.parse(readFileSync(join(optInRes.bundleDir, 'item.txt.pv-meta.json'), 'utf8'))
      )
      expect(sidecar.recordedFacts.originalSourcePath).toBe(filePath)
      if (sidecar.machineGenerated.kind === 'document') {
        expect(sidecar.machineGenerated.nativeExtraction.text).toBe('verified-source-bytes')
      }

      // Tamper with export-manifest.json after completion -> single completion rule detects mismatch
      const manifestPath = join(optInRes.bundleDir, 'export-manifest.json')
      writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8') + '\n', 'utf8')
      const tamperedInspection = inspectExportBundleStatus(optInRes.bundleDir)
      expect(tamperedInspection.isCompleteVerified).toBe(false)
      expect(tamperedInspection.reasons).toContain('manifest_hash_mismatch')
    })
  })
})
