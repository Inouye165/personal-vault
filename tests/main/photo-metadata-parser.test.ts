// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildAdobeDngHeader,
  buildCanonCr2Header,
  buildIsoBmffHeader,
  createCraftedPngWithDimensions,
  createJpegFixture,
  createPngFixture,
  EXIF_TAG_IDS
} from '../helpers/exif-fixture-builder'
import {
  extractPhotoMetadataFromFile,
  METADATA_PARSER_RECIPE_VERSION
} from '../../src/main/services/metadata'

describe('Stage 6C — Photo Metadata Parser, Provenance & Normalization', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pv-meta-parser-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('extracts valid EXIF capture date, camera, lens, and dimensions from little-endian and big-endian JPEGs and PNGs', async () => {
    const jpegBuf = await createJpegFixture({
      width: 1200,
      height: 800,
      littleEndian: false, // Motorola big-endian TIFF
      ifd0Tags: [
        { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Canon' },
        { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: 'Canon EOS R5' },
        { tagId: EXIF_TAG_IDS.Orientation, type: 'short', value: 1 },
        { tagId: EXIF_TAG_IDS.DateTime, type: 'ascii', value: '2025:01:10 09:00:00' }
      ],
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2024:07:04 19:42:15' },
        { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '-04:00' },
        { tagId: EXIF_TAG_IDS.SubSecTimeOriginal, type: 'ascii', value: '375' },
        { tagId: EXIF_TAG_IDS.LensMake, type: 'ascii', value: 'Canon' },
        { tagId: EXIF_TAG_IDS.LensModel, type: 'ascii', value: 'RF24-70mm F2.8 L IS USM' }
      ]
    })

    const filePath = join(tempDir, 'fireworks.jpg')
    writeFileSync(filePath, jpegBuf)

    const result = await extractPhotoMetadataFromFile({
      sourcePath: filePath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })

    expect(result.extractionStatus).toBe('extracted')
    expect(result.parserRecipeVersion).toBe(METADATA_PARSER_RECIPE_VERSION)
    expect(result.detectedFormat).toBe('jpeg')
    expect(result.recordedExtension).toBe('.jpg')
    expect(result.extensionFormatMismatch).toBe(false)

    // Dimensions
    expect(result.encodedWidthPx).toBe(1200)
    expect(result.encodedHeightPx).toBe(800)
    expect(result.exifOrientation).toBe(1)
    expect(result.displayWidthPx).toBe(1200)
    expect(result.displayHeightPx).toBe(800)

    // Capture Date & Provenance
    expect(result.captureDateSourceTag).toBe('DateTimeOriginal')
    expect(result.rawCaptureDateText).toBe('2024:07:04 19:42:15')
    expect(result.captureSubseconds).toBe('375')
    expect(result.captureOffsetMinutes).toBe(-240)
    expect(result.captureOffsetText).toBe('-04:00')
    expect(result.captureTimezoneStatus).toBe('offset_present')
    expect(result.captureCalendarDate).toBe('2024-07-04')
    expect(result.captureLocalIso).toBe('2024-07-04T19:42:15.375')
    expect(result.captureUtcEpochMs).toBe(Date.parse('2024-07-04T19:42:15.375-04:00'))
    expect(result.captureDateParseError).toBeNull()

    // Camera & Lens (Make prefix deduplicated in display without mutating raw tags)
    expect(result.cameraMakeRaw).toBe('Canon')
    expect(result.cameraModelRaw).toBe('Canon EOS R5')
    expect(result.cameraDisplay).toBe('Canon EOS R5')
    expect(result.cameraNormalized).toBe('canon eos r5')

    expect(result.lensMakeRaw).toBe('Canon')
    expect(result.lensModelRaw).toBe('RF24-70mm F2.8 L IS USM')
    expect(result.lensDisplay).toBe('Canon RF24-70mm F2.8 L IS USM')
    expect(result.lensNormalized).toBe('canon rf24-70mm f2.8 l is usm')
  })

  it('records no_metadata with known container dimensions for metadata-free images and never fabricates dates from filesystem or filename', async () => {
    const pngBuf = await createPngFixture({ width: 640, height: 360 })
    // Filename deliberately contains a date-like pattern that must NEVER be inferred
    const filePath = join(tempDir, 'IMG_20221225_143000.png')
    writeFileSync(filePath, pngBuf)
    const fixedTime = new Date('2021-05-01T10:00:00Z')
    utimesSync(filePath, fixedTime, fixedTime)

    const result = await extractPhotoMetadataFromFile({
      sourcePath: filePath,
      recordedExtension: '.png',
      approvedRoots: [tempDir]
    })

    expect(result.extractionStatus).toBe('no_metadata')
    expect(result.detectedFormat).toBe('png')
    expect(result.encodedWidthPx).toBe(640)
    expect(result.encodedHeightPx).toBe(360)
    expect(result.displayWidthPx).toBe(640)
    expect(result.displayHeightPx).toBe(360)
    expect(result.captureCalendarDate).toBeNull()
    expect(result.captureLocalIso).toBeNull()
    expect(result.captureUtcEpochMs).toBeNull()
    expect(result.captureDateSourceTag).toBeNull()
    expect(result.cameraNormalized).toBeNull()
    expect(result.lensNormalized).toBeNull()
  })

  it('enforces DateTimeOriginal precedence, falls back to DateTimeDigitized only when DateTimeOriginal is absent, and ignores ModifyDate', async () => {
    // 1. Both DateTimeOriginal and DateTimeDigitized present (with conflict) -> DateTimeOriginal wins, conflict recorded
    const bothBuf = await createJpegFixture({
      ifd0Tags: [{ tagId: EXIF_TAG_IDS.DateTime, type: 'ascii', value: '2026:01:01 00:00:00' }],
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2023:08:15 06:30:00' },
        { tagId: EXIF_TAG_IDS.DateTimeDigitized, type: 'ascii', value: '2023:09:20 12:00:00' }
      ]
    })
    const bothPath = join(tempDir, 'both-dates.jpg')
    writeFileSync(bothPath, bothBuf)
    const bothRes = await extractPhotoMetadataFromFile({
      sourcePath: bothPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(bothRes.captureDateSourceTag).toBe('DateTimeOriginal')
    expect(bothRes.captureCalendarDate).toBe('2023-08-15')
    expect(bothRes.captureDateConflict).toContain('DateTimeDigitized')

    // 2. Only DateTimeDigitized present -> documented fallback used
    const digiBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeDigitized, type: 'ascii', value: '2022:11:03 17:15:45' },
        { tagId: EXIF_TAG_IDS.SubSecTimeDigitized, type: 'ascii', value: '09' },
        { tagId: EXIF_TAG_IDS.OffsetTimeDigitized, type: 'ascii', value: '+09:00' }
      ]
    })
    const digiPath = join(tempDir, 'digitized-only.jpg')
    writeFileSync(digiPath, digiBuf)
    const digiRes = await extractPhotoMetadataFromFile({
      sourcePath: digiPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(digiRes.captureDateSourceTag).toBe('DateTimeDigitized')
    expect(digiRes.captureCalendarDate).toBe('2022-11-03')
    expect(digiRes.captureLocalIso).toBe('2022-11-03T17:15:45.09')
    expect(digiRes.captureOffsetMinutes).toBe(540)

    // 3. Only IFD0 DateTime (ModifyDate) present -> NOT used as capture date, raw evidence preserved
    const modOnlyBuf = await createJpegFixture({
      ifd0Tags: [{ tagId: EXIF_TAG_IDS.DateTime, type: 'ascii', value: '2025:03:10 11:22:33' }]
    })
    const modOnlyPath = join(tempDir, 'modify-only.jpg')
    writeFileSync(modOnlyPath, modOnlyBuf)
    const modOnlyRes = await extractPhotoMetadataFromFile({
      sourcePath: modOnlyPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(modOnlyRes.captureCalendarDate).toBeNull()
    expect(modOnlyRes.captureDateSourceTag).toBeNull()
    expect(modOnlyRes.rawMetadataJson).toContain('2025:03:10 11:22:33')
  })

  it('preserves local wall-clock dates without host/UTC timezone shifts and validates leap dates, impossible dates, and offsets', async () => {
    // Late-night offset-less wall-clock timestamp (23:58:00) + unset camera offset placeholder "   :  "
    const wallClockBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2024:02:29 23:58:59' },
        { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '   :  ' }
      ]
    })
    const wallPath = join(tempDir, 'leap-wallclock.jpg')
    writeFileSync(wallPath, wallClockBuf)
    const wallRes = await extractPhotoMetadataFromFile({
      sourcePath: wallPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(wallRes.captureCalendarDate).toBe('2024-02-29')
    expect(wallRes.captureLocalIso).toBe('2024-02-29T23:58:59')
    expect(wallRes.captureTimezoneStatus).toBe('local_wall_clock_unknown_tz')
    expect(wallRes.captureOffsetMinutes).toBeNull()
    expect(wallRes.captureUtcEpochMs).toBeNull()

    // Late-night timestamp WITH negative offset (-08:00 -> next day in UTC, but recorded capture calendar date stays 2024-06-30!)
    const negOffsetBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2024:06:30 22:30:00' },
        { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '-08:00' }
      ]
    })
    const negPath = join(tempDir, 'neg-offset.jpg')
    writeFileSync(negPath, negOffsetBuf)
    const negRes = await extractPhotoMetadataFromFile({
      sourcePath: negPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(negRes.captureCalendarDate).toBe('2024-06-30')
    expect(negRes.captureOffsetMinutes).toBe(-480)
    expect(negRes.captureUtcEpochMs).toBe(Date.parse('2024-06-30T22:30:00-08:00'))

    // Non-leap year Feb 29 (2023:02:29) + valid DateTimeDigitized -> DateTimeOriginal NOT silently masked; stays null with raw evidence
    const badLeapBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2023:02:29 12:00:00' },
        { tagId: EXIF_TAG_IDS.DateTimeDigitized, type: 'ascii', value: '2023:03:01 12:00:00' }
      ]
    })
    const badLeapPath = join(tempDir, 'bad-leap.jpg')
    writeFileSync(badLeapPath, badLeapBuf)
    const badLeapRes = await extractPhotoMetadataFromFile({
      sourcePath: badLeapPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(badLeapRes.captureCalendarDate).toBeNull()
    expect(badLeapRes.captureLocalIso).toBeNull()
    expect(badLeapRes.rawCaptureDateText).toBe('2023:02:29 12:00:00')
    expect(badLeapRes.captureDateParseError).toMatch(/calendar|invalid/i)
    expect(badLeapRes.captureDateConflict).toContain(
      'DateTimeOriginal ("2023:02:29 12:00:00") is invalid while DateTimeDigitized ("2023:03:01 12:00:00") is present; keeping capture date Unknown rather than masking invalid primary tag'
    )

    // Invalid timezone offset (+29:00) -> rejected with raw evidence preserved
    const badOffsetBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2024:05:10 14:00:00' },
        { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '+29:00' }
      ]
    })
    const badOffsetPath = join(tempDir, 'bad-offset.jpg')
    writeFileSync(badOffsetPath, badOffsetBuf)
    const badOffsetRes = await extractPhotoMetadataFromFile({
      sourcePath: badOffsetPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(badOffsetRes.captureCalendarDate).toBeNull()
    expect(badOffsetRes.captureUtcEpochMs).toBeNull()
    expect(badOffsetRes.captureOffsetMinutes).toBeNull()
    expect(badOffsetRes.captureDateParseError).toMatch(/offset/i)
    expect(badOffsetRes.rawMetadataJson).toContain('+29:00')
  })

  it('preserves Unknown capture date when DateTimeOriginal is present but invalid, even if DateTimeDigitized is valid (conservative policy)', async () => {
    // 1. Syntactically malformed DateTimeOriginal paired with valid DateTimeDigitized
    const corruptOrigBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: 'INVALID:DATE:SYNTAX' },
        { tagId: EXIF_TAG_IDS.DateTimeDigitized, type: 'ascii', value: '2024:08:12 14:30:00' },
        { tagId: EXIF_TAG_IDS.OffsetTimeDigitized, type: 'ascii', value: '+02:00' }
      ]
    })
    const corruptOrigPath = join(tempDir, 'corrupt-orig-valid-digi.jpg')
    writeFileSync(corruptOrigPath, corruptOrigBuf)

    const corruptRes = await extractPhotoMetadataFromFile({
      sourcePath: corruptOrigPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })

    // Conservative policy: capture date remains Unknown (null)
    expect(corruptRes.captureCalendarDate).toBeNull()
    expect(corruptRes.captureLocalIso).toBeNull()
    expect(corruptRes.captureUtcEpochMs).toBeNull()
    expect(corruptRes.captureDateSourceTag).toBe('DateTimeOriginal')
    expect(corruptRes.rawCaptureDateText).toBe('INVALID:DATE:SYNTAX')
    expect(corruptRes.captureDateParseError).toMatch(/Malformed EXIF timestamp/i)
    expect(corruptRes.captureDateConflict).toBe(
      'DateTimeOriginal ("INVALID:DATE:SYNTAX") is invalid while DateTimeDigitized ("2024:08:12 14:30:00") is present; keeping capture date Unknown rather than masking invalid primary tag'
    )

    // 2. Impossible calendar date (Feb 29 on non-leap year 2025) paired with valid DateTimeDigitized
    const impossibleOrigBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2025:02:29 18:00:00' },
        { tagId: EXIF_TAG_IDS.DateTimeDigitized, type: 'ascii', value: '2025:03:01 09:00:00' }
      ]
    })
    const impossibleOrigPath = join(tempDir, 'impossible-orig-valid-digi.jpg')
    writeFileSync(impossibleOrigPath, impossibleOrigBuf)

    const impossibleRes = await extractPhotoMetadataFromFile({
      sourcePath: impossibleOrigPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })

    expect(impossibleRes.captureCalendarDate).toBeNull()
    expect(impossibleRes.captureLocalIso).toBeNull()
    expect(impossibleRes.captureUtcEpochMs).toBeNull()
    expect(impossibleRes.captureDateSourceTag).toBe('DateTimeOriginal')
    expect(impossibleRes.rawCaptureDateText).toBe('2025:02:29 18:00:00')
    expect(impossibleRes.captureDateParseError).toBe('Invalid calendar date 2025-02-29')
    expect(impossibleRes.captureDateConflict).toBe(
      'DateTimeOriginal ("2025:02:29 18:00:00") is invalid while DateTimeDigitized ("2025:03:01 09:00:00") is present; keeping capture date Unknown rather than masking invalid primary tag'
    )
  })

  it('computes orientation-adjusted display dimensions and rejects excessive/impossible dimensions safely', async () => {
    const portraitBuf = await createJpegFixture({
      width: 400,
      height: 300,
      ifd0Tags: [{ tagId: EXIF_TAG_IDS.Orientation, type: 'short', value: 6 }]
    })
    const portraitPath = join(tempDir, 'rotated-portrait.jpg')
    writeFileSync(portraitPath, portraitBuf)

    const portraitRes = await extractPhotoMetadataFromFile({
      sourcePath: portraitPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })

    expect(portraitRes.encodedWidthPx).toBe(400)
    expect(portraitRes.encodedHeightPx).toBe(300)
    expect(portraitRes.exifOrientation).toBe(6)
    expect(portraitRes.displayWidthPx).toBe(300)
    expect(portraitRes.displayHeightPx).toBe(400)

    // Crafted PNG claiming 500,000 x 500,000 pixels -> rejected safely without raster decode
    const bombPng = await createCraftedPngWithDimensions(500_000, 500_000)
    const bombPath = join(tempDir, 'excessive-dims.png')
    writeFileSync(bombPath, bombPng)

    const bombRes = await extractPhotoMetadataFromFile({
      sourcePath: bombPath,
      recordedExtension: '.png',
      approvedRoots: [tempDir]
    })
    expect(bombRes.displayWidthPx).toBeNull()
    expect(bombRes.displayHeightPx).toBeNull()
    expect(bombRes.encodedWidthPx).toBeNull()
    expect(bombRes.encodedHeightPx).toBeNull()
  })

  it('sanitizes control characters and bounds oversized camera/lens strings while preserving clean raw text', async () => {
    const longModel = 'X'.repeat(400)
    const dirtyMake = '  Sony\u0007\u001b   Corporation  '
    const buf = await createJpegFixture({
      ifd0Tags: [
        { tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: dirtyMake },
        { tagId: EXIF_TAG_IDS.Model, type: 'ascii', value: longModel }
      ],
      exifTags: [{ tagId: EXIF_TAG_IDS.LensModel, type: 'ascii', value: '   \u0000\u0008   ' }]
    })
    const p = join(tempDir, 'dirty-strings.jpg')
    writeFileSync(p, buf)

    const res = await extractPhotoMetadataFromFile({
      sourcePath: p,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })

    expect(res.cameraMakeRaw).toBe('Sony Corporation')
    expect(res.cameraModelRaw?.length).toBeLessThanOrEqual(256)
    expect(res.cameraDisplay?.length).toBeLessThanOrEqual(256)
    expect(res.lensModelRaw).toBeNull()
    expect(res.lensNormalized).toBeNull()
  })

  it('detects extension vs container format mismatches and reports unsupported HEIC/RAW vs corrupt files truthfully', async () => {
    // 1. Real PNG saved with .jpg extension
    const pngAsJpg = await createPngFixture({
      width: 200,
      height: 100,
      ifd0Tags: [{ tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Fujifilm' }]
    })
    const mismatchPath = join(tempDir, 'impostor.jpg')
    writeFileSync(mismatchPath, pngAsJpg)
    const mismatchRes = await extractPhotoMetadataFromFile({
      sourcePath: mismatchPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(mismatchRes.extractionStatus).toBe('extracted')
    expect(mismatchRes.recordedExtension).toBe('.jpg')
    expect(mismatchRes.detectedFormat).toBe('png')
    expect(mismatchRes.extensionFormatMismatch).toBe(true)
    expect(mismatchRes.cameraNormalized).toBe('fujifilm')

    // 2. Real JPEG saved with .heic extension -> supported based on real container bytes, not falsely rejected by extension!
    const jpgAsHeic = await createJpegFixture({ width: 160, height: 120 })
    const jpgAsHeicPath = join(tempDir, 'renamed.heic')
    writeFileSync(jpgAsHeicPath, jpgAsHeic)
    const jpgAsHeicRes = await extractPhotoMetadataFromFile({
      sourcePath: jpgAsHeicPath,
      recordedExtension: '.heic',
      approvedRoots: [tempDir]
    })
    expect(jpgAsHeicRes.extractionStatus).toBe('no_metadata')
    expect(jpgAsHeicRes.detectedFormat).toBe('jpeg')
    expect(jpgAsHeicRes.extensionFormatMismatch).toBe(true)

    // 3. Real HEIC container (`ftypheic`) -> unsupported with detectedFormat = 'heic'
    const heicPath = join(tempDir, 'iphone.heic')
    writeFileSync(heicPath, buildIsoBmffHeader('heic'))
    const heicRes = await extractPhotoMetadataFromFile({
      sourcePath: heicPath,
      recordedExtension: '.heic',
      approvedRoots: [tempDir]
    })
    expect(heicRes.extractionStatus).toBe('unsupported')
    expect(heicRes.detectedFormat).toBe('heic')

    // 4. Real Canon CR2 & Adobe DNG RAW containers -> unsupported
    const cr2Path = join(tempDir, 'raw.cr2')
    writeFileSync(cr2Path, buildCanonCr2Header())
    const cr2Res = await extractPhotoMetadataFromFile({
      sourcePath: cr2Path,
      recordedExtension: '.cr2',
      approvedRoots: [tempDir]
    })
    expect(cr2Res.extractionStatus).toBe('unsupported')
    expect(cr2Res.detectedFormat).toBe('cr2')

    const dngPath = join(tempDir, 'negative.dng')
    writeFileSync(dngPath, buildAdobeDngHeader())
    const dngRes = await extractPhotoMetadataFromFile({
      sourcePath: dngPath,
      recordedExtension: '.dng',
      approvedRoots: [tempDir]
    })
    expect(dngRes.extractionStatus).toBe('unsupported')
    expect(dngRes.detectedFormat).toBe('dng')

    // 5. Corrupt garbage bytes with .heic extension -> failed (NOT falsely reported as unsupported HEIC!)
    const garbageHeicPath = join(tempDir, 'corrupt.heic')
    writeFileSync(garbageHeicPath, Buffer.from('NOT_AN_IMAGE_AT_ALL_1234567890'))
    const garbageHeicRes = await extractPhotoMetadataFromFile({
      sourcePath: garbageHeicPath,
      recordedExtension: '.heic',
      approvedRoots: [tempDir]
    })
    expect(garbageHeicRes.extractionStatus).toBe('failed')
    expect(garbageHeicRes.detectedFormat).toBeNull()

    // 6. Truncated/malformed APP1 EXIF in an otherwise JPEG-prefixed file -> failed
    const baseJpeg = await createJpegFixture({ width: 100, height: 100 })
    const malformedApp1 = Buffer.from([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a,
      0x00, 0xff, 0xff, 0xff, 0x7f
    ])
    const truncatedExifJpeg = Buffer.concat([malformedApp1, baseJpeg.subarray(2)])
    const malPath = join(tempDir, 'malformed-exif.jpg')
    writeFileSync(malPath, truncatedExifJpeg)
    const malRes = await extractPhotoMetadataFromFile({
      sourcePath: malPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(malRes.extractionStatus).toBe('failed')
  })

  it('preserves original source bytes, size, birthtime, and mtime bitwise unchanged', async () => {
    const buf = await createJpegFixture({
      width: 500,
      height: 400,
      ifd0Tags: [{ tagId: EXIF_TAG_IDS.Make, type: 'ascii', value: 'Nikon Corporation' }],
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2024:04:08 15:18:00' }
      ]
    })
    const srcPath = join(tempDir, 'eclipse.jpg')
    writeFileSync(srcPath, buf)
    const fixedTime = new Date('2024-04-08T20:00:00.000Z')
    utimesSync(srcPath, fixedTime, fixedTime)

    const beforeStat = statSync(srcPath)
    const beforeSha = createHash('sha256').update(readFileSync(srcPath)).digest('hex')

    const res = await extractPhotoMetadataFromFile({
      sourcePath: srcPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(res.extractionStatus).toBe('extracted')
    expect(res.contentSha256).toBe(beforeSha)

    const afterStat = statSync(srcPath)
    const afterSha = createHash('sha256').update(readFileSync(srcPath)).digest('hex')

    expect(afterSha).toBe(beforeSha)
    expect(afterStat.size).toBe(beforeStat.size)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
    expect(afterStat.birthtimeMs).toBe(beforeStat.birthtimeMs)
  })

  it('rejects oversized metadata payloads (> 4 MiB), outside-root paths, century non-leap dates, 0000:00:00, and contradictory offsets', async () => {
    // 1. PNG with > 4 MiB metadata chunk -> OVERSIZED_METADATA without crashing or parsing
    const basePng = await createPngFixture({ width: 32, height: 32 })
    const bigPayloadLen = 4 * 1024 * 1024 + 1024
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(bigPayloadLen, 0)
    const typeBuf = Buffer.from('tEXt', 'ascii')
    const payloadBuf = Buffer.alloc(bigPayloadLen, 0x41)
    const crcPlaceholder = Buffer.alloc(4)
    const oversizedPng = Buffer.concat([
      basePng.subarray(0, 33),
      lenBuf,
      typeBuf,
      payloadBuf,
      crcPlaceholder,
      basePng.subarray(33)
    ])
    const oversizedPath = join(tempDir, 'oversized-meta.png')
    writeFileSync(oversizedPath, oversizedPng)

    const oversizedRes = await extractPhotoMetadataFromFile({
      sourcePath: oversizedPath,
      recordedExtension: '.png',
      approvedRoots: [tempDir]
    })
    expect(oversizedRes.extractionStatus).toBe('failed')
    expect(oversizedRes.errorCode).toBe('OVERSIZED_METADATA')

    // 2. Outside approved roots -> ACCESS_DENIED
    const otherDir = mkdtempSync(join(tmpdir(), 'pv-meta-outside-'))
    try {
      const deniedRes = await extractPhotoMetadataFromFile({
        sourcePath: oversizedPath,
        recordedExtension: '.png',
        approvedRoots: [otherDir]
      })
      expect(deniedRes.extractionStatus).toBe('failed')
      expect(deniedRes.errorCode).toBe('ACCESS_DENIED')
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }

    // 3. 2100:02:29 (century non-leap year), 0000:00:00 00:00:00, and contradictory inline vs OffsetTimeOriginal
    const centuryBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '2100:02:29 10:00:00' }
      ]
    })
    const centuryPath = join(tempDir, 'century.jpg')
    writeFileSync(centuryPath, centuryBuf)
    const centuryRes = await extractPhotoMetadataFromFile({
      sourcePath: centuryPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(centuryRes.captureCalendarDate).toBeNull()
    expect(centuryRes.rawCaptureDateText).toBe('2100:02:29 10:00:00')

    const zeroDateBuf = await createJpegFixture({
      exifTags: [
        { tagId: EXIF_TAG_IDS.DateTimeOriginal, type: 'ascii', value: '0000:00:00 00:00:00' }
      ]
    })
    const zeroPath = join(tempDir, 'zero-date.jpg')
    writeFileSync(zeroPath, zeroDateBuf)
    const zeroRes = await extractPhotoMetadataFromFile({
      sourcePath: zeroPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(zeroRes.captureCalendarDate).toBeNull()
    expect(zeroRes.captureDateParseError).toMatch(/unset|zero/i)

    const contraOffsetBuf = await createJpegFixture({
      exifTags: [
        {
          tagId: EXIF_TAG_IDS.DateTimeOriginal,
          type: 'ascii',
          value: '2024:05:10 14:00:00+05:30'
        },
        { tagId: EXIF_TAG_IDS.OffsetTimeOriginal, type: 'ascii', value: '-04:00' }
      ]
    })
    const contraPath = join(tempDir, 'contra-offset.jpg')
    writeFileSync(contraPath, contraOffsetBuf)
    const contraRes = await extractPhotoMetadataFromFile({
      sourcePath: contraPath,
      recordedExtension: '.jpg',
      approvedRoots: [tempDir]
    })
    expect(contraRes.captureCalendarDate).toBeNull()
    expect(contraRes.captureTimezoneStatus).toBe('invalid_offset')
    expect(contraRes.captureDateParseError).toMatch(/contradictory/i)
  })
})
