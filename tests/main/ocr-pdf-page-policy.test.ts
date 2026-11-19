// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyPdfPageForOcr,
  inspectPdfPageForOcr,
  mergeNativeAndOcrPageText
} from '../../src/main/services/documents/ocr/pdf-page-policy'
import { createOcrFoundationTestFixtures } from '../helpers/ocr-synthetic-fixtures'

describe('Conservative Mixed-PDF Page OCR Policy', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pv-ocr-pdf-policy-'))
  })

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('never treats a selectable native header as proof that a scanned body needs no OCR', async () => {
    const fixtures = await createOcrFoundationTestFixtures(tempDir)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const bytes = await readFile(fixtures.headerPlusScannedBodyPdf.filePath)
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableStream: true,
      disableAutoFetch: true,
      verbosity: 0
    } as Parameters<typeof pdfjs.getDocument>[0])

    const doc = await task.promise
    try {
      const page = await doc.getPage(1)
      const inspection = await inspectPdfPageForOcr(page)
      expect(inspection.selectableCharCount).toBeGreaterThan(60)
      expect(inspection.rasterImageOpCount).toBe(1)
      expect(inspection.maxSingleRasterAreaRatio).toBeGreaterThan(0.5)

      const decision = classifyPdfPageForOcr(inspection)
      expect(decision.needsOcr).toBe(true)
      expect(decision.reason).toBe('substantial_raster_with_native_text')
      page.cleanup()
    } finally {
      await doc.cleanup?.()
      await task.destroy()
    }
  })

  it('exempts digital native body pages that only contain a small decorative corner logo', async () => {
    const fixtures = await createOcrFoundationTestFixtures(tempDir)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const bytes = await readFile(fixtures.nativeBodyPlusSmallLogoPdf.filePath)
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableStream: true,
      disableAutoFetch: true,
      verbosity: 0
    } as Parameters<typeof pdfjs.getDocument>[0])

    const doc = await task.promise
    try {
      const page = await doc.getPage(1)
      const inspection = await inspectPdfPageForOcr(page)
      expect(inspection.selectableCharCount).toBeGreaterThan(80)
      expect(inspection.rasterImageOpCount).toBe(1)
      expect(inspection.maxSingleRasterAreaRatio).toBeLessThan(0.02)

      const decision = classifyPdfPageForOcr(inspection)
      expect(decision.needsOcr).toBe(false)
      expect(decision.reason).toBe('native_text_with_small_raster')
      page.cleanup()
    } finally {
      await doc.cleanup?.()
      await task.destroy()
    }
  })

  it('handles image-only pages, blank vector pages, sparse text + small rasters, and unbounded ops conservatively', () => {
    expect(
      classifyPdfPageForOcr({
        selectableCharCount: 0,
        nativeText: '',
        rasterImageOpCount: 1,
        maxSingleRasterAreaRatio: 0.03,
        totalRasterAreaRatio: 0.03,
        hasUnboundedRasterOp: false
      })
    ).toEqual({
      needsOcr: true,
      reason: 'image_only_page'
    })

    expect(
      classifyPdfPageForOcr({
        selectableCharCount: 0,
        nativeText: '',
        rasterImageOpCount: 0,
        maxSingleRasterAreaRatio: 0,
        totalRasterAreaRatio: 0,
        hasUnboundedRasterOp: false
      })
    ).toEqual({
      needsOcr: false,
      reason: 'blank_or_vector_only'
    })

    expect(
      classifyPdfPageForOcr({
        selectableCharCount: 12,
        nativeText: 'Page 1 of 4',
        rasterImageOpCount: 1,
        maxSingleRasterAreaRatio: 0.04,
        totalRasterAreaRatio: 0.04,
        hasUnboundedRasterOp: false
      })
    ).toEqual({
      needsOcr: true,
      reason: 'sparse_native_text_with_raster'
    })

    expect(
      classifyPdfPageForOcr({
        selectableCharCount: 250,
        nativeText: 'Long native text block',
        rasterImageOpCount: 1,
        maxSingleRasterAreaRatio: 0.01,
        totalRasterAreaRatio: 0.01,
        hasUnboundedRasterOp: true
      })
    ).toEqual({
      needsOcr: true,
      reason: 'unbounded_raster_op_conservative'
    })
  })

  it('merges native selectable text with OCR body text without losing either or duplicating identical header lines', () => {
    const merged = mergeNativeAndOcrPageText(
      'PERSONAL VAULT ARCHIVE HEADER\nSubheader Stamp 2026',
      'PERSONAL VAULT ARCHIVE HEADER\nSCANNED BODY CLAUSE 4410\nCOUNTERSIGNED CODE ZETA88'
    )
    expect(merged).toContain('PERSONAL VAULT ARCHIVE HEADER')
    expect(merged).toContain('Subheader Stamp 2026')
    expect(merged).toContain('SCANNED BODY CLAUSE 4410')
    expect(merged).toContain('COUNTERSIGNED CODE ZETA88')
    expect(merged.match(/PERSONAL VAULT ARCHIVE HEADER/g)?.length).toBe(1)
  })
})
