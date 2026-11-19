/**
 * Personal Vault — Stage 7C Conservative Mixed-PDF Page OCR Policy
 *
 * Policy Principles:
 * 1. NEVER treat selectable native text (such as a running header, letterhead,
 *    footer, or Bates stamp) as proof that a scanned body on the same page needs no OCR.
 * 2. Track the PDF graphics-state CTM (`save`, `restore`, `transform`, Form XObject matrix)
 *    across `page.getOperatorList()` to bound the painted area of raster image XObjects
 *    on the page.
 * 3. Any page with a substantial raster image (`maxSingleRasterAreaRatio >= 8%`,
 *    `totalRasterAreaRatio >= 12%`, `>= 4` raster ops, or any group/repeat/unbounded
 *    image op) ALWAYS runs OCR — even if hundreds of selectable characters are present —
 *    and merges lossless native text with OCR text without duplicating identical lines.
 * 4. Pages with sufficient native text (`>= 32` non-whitespace chars) and ONLY small
 *    decorative/logo rasters (`< 8%` single, `< 12%` total, `<= 3` ops) retain clean
 *    native text without unnecessary page rasterization.
 * 5. Vector-only blank spacer pages (`0` selectable chars, `0` raster ops) skip OCR cleanly.
 */

import {
  DOCUMENT_OCR_LIMITS,
  type PdfPageOcrClassification,
  type PdfPageOcrInspection
} from './types'

// PDF.js OPS numeric constants (pdfjs-dist@6.5.438)
const OPS_SAVE = 10
const OPS_RESTORE = 11
const OPS_TRANSFORM = 12
const OPS_PAINT_FORM_XOBJECT_BEGIN = 74
const OPS_PAINT_FORM_XOBJECT_END = 75

const BOUNDED_SINGLE_IMAGE_OPS = new Set<number>([
  83, // paintImageMaskXObject
  85, // paintImageXObject
  86 // paintInlineImageXObject
])

const UNBOUNDED_MULTI_IMAGE_OPS = new Set<number>([
  84, // paintImageMaskXObjectGroup
  87, // paintInlineImageXObjectGroup
  88, // paintImageXObjectRepeat
  89 // paintImageMaskXObjectRepeat
])

type Matrix2D = readonly [number, number, number, number, number, number]

const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0]

function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

function toMatrix2D(candidate: unknown): Matrix2D | null {
  if (!Array.isArray(candidate) && !ArrayBuffer.isView(candidate)) {
    return null
  }
  const arr = candidate as ArrayLike<unknown>
  if (arr.length < 6) return null
  const vals = [arr[0], arr[1], arr[2], arr[3], arr[4], arr[5]].map(Number)
  if (vals.some((v) => !Number.isFinite(v))) return null
  return [vals[0]!, vals[1]!, vals[2]!, vals[3]!, vals[4]!, vals[5]!]
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number }
  getTextContent(): Promise<{ items: ReadonlyArray<Record<string, unknown>> }>
  getOperatorList(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>
}

export function extractNormalizedPdfPageNativeText(
  items: ReadonlyArray<Record<string, unknown>>
): string {
  const parts: string[] = []
  for (const item of items) {
    if (item && typeof item.str === 'string') {
      parts.push(item.str)
      parts.push(item.hasEOL === true ? '\n' : ' ')
    }
  }
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function inspectPdfPageForOcr(page: PdfPageLike): Promise<PdfPageOcrInspection> {
  const viewport = page.getViewport({ scale: 1 })
  const pageAreaPt2 = Math.max(1, viewport.width * viewport.height)

  const [textContent, opList] = await Promise.all([page.getTextContent(), page.getOperatorList()])

  const nativeText = extractNormalizedPdfPageNativeText(textContent.items)
  const selectableCharCount = nativeText.replace(/\s+/g, '').length

  let ctm: Matrix2D = IDENTITY_MATRIX
  const stack: Matrix2D[] = []

  let rasterImageOpCount = 0
  let maxSingleRasterAreaRatio = 0
  let totalRasterAreaRatio = 0
  let hasUnboundedRasterOp = false

  const fnLen = opList.fnArray.length
  for (let i = 0; i < fnLen; i++) {
    const fnId = opList.fnArray[i]!
    const opArgs = opList.argsArray[i] as ReadonlyArray<unknown> | undefined

    if (fnId === OPS_SAVE) {
      stack.push(ctm)
      continue
    }
    if (fnId === OPS_RESTORE) {
      ctm = stack.pop() ?? IDENTITY_MATRIX
      continue
    }
    if (fnId === OPS_TRANSFORM) {
      const m = toMatrix2D(opArgs)
      if (m) {
        ctm = multiplyMatrix(ctm, m)
      }
      continue
    }
    if (fnId === OPS_PAINT_FORM_XOBJECT_BEGIN) {
      stack.push(ctm)
      const formMatrix = toMatrix2D(opArgs?.[0])
      if (formMatrix) {
        ctm = multiplyMatrix(ctm, formMatrix)
      }
      continue
    }
    if (fnId === OPS_PAINT_FORM_XOBJECT_END) {
      ctm = stack.pop() ?? IDENTITY_MATRIX
      continue
    }

    if (UNBOUNDED_MULTI_IMAGE_OPS.has(fnId)) {
      rasterImageOpCount += 1
      hasUnboundedRasterOp = true
      maxSingleRasterAreaRatio = 1
      totalRasterAreaRatio = 1
      continue
    }

    if (BOUNDED_SINGLE_IMAGE_OPS.has(fnId)) {
      rasterImageOpCount += 1
      const detArea = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])
      if (!Number.isFinite(detArea) || detArea <= 0) {
        hasUnboundedRasterOp = true
        maxSingleRasterAreaRatio = 1
        totalRasterAreaRatio = 1
      } else {
        const ratio = Math.min(1, detArea / pageAreaPt2)
        if (ratio > maxSingleRasterAreaRatio) {
          maxSingleRasterAreaRatio = ratio
        }
        totalRasterAreaRatio = Math.min(1, totalRasterAreaRatio + ratio)
      }
    }
  }

  return {
    selectableCharCount,
    nativeText,
    rasterImageOpCount,
    maxSingleRasterAreaRatio,
    totalRasterAreaRatio,
    hasUnboundedRasterOp
  }
}

export function classifyPdfPageForOcr(inspection: PdfPageOcrInspection): PdfPageOcrClassification {
  if (inspection.rasterImageOpCount <= 0) {
    return {
      needsOcr: false,
      reason: inspection.selectableCharCount > 0 ? 'native_text_only' : 'blank_or_vector_only'
    }
  }

  if (inspection.selectableCharCount === 0) {
    return {
      needsOcr: true,
      reason: 'image_only_page'
    }
  }

  if (inspection.hasUnboundedRasterOp) {
    return {
      needsOcr: true,
      reason: 'unbounded_raster_op_conservative'
    }
  }

  if (
    inspection.maxSingleRasterAreaRatio >=
      DOCUMENT_OCR_LIMITS.SUBSTANTIAL_SINGLE_RASTER_AREA_RATIO ||
    inspection.totalRasterAreaRatio >= DOCUMENT_OCR_LIMITS.SUBSTANTIAL_TOTAL_RASTER_AREA_RATIO ||
    inspection.rasterImageOpCount > DOCUMENT_OCR_LIMITS.MAX_DECORATIVE_RASTER_OPS
  ) {
    return {
      needsOcr: true,
      reason: 'substantial_raster_with_native_text'
    }
  }

  if (inspection.selectableCharCount < DOCUMENT_OCR_LIMITS.MIN_NATIVE_CHARS_FOR_LOGO_EXEMPTION) {
    return {
      needsOcr: true,
      reason: 'sparse_native_text_with_raster'
    }
  }

  return {
    needsOcr: false,
    reason: 'native_text_with_small_raster'
  }
}

function normalizeLineForDedup(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function mergeNativeAndOcrPageText(nativeText: string, ocrText: string): string {
  const cleanNative = nativeText.trim()
  const cleanOcr = ocrText.trim()
  if (!cleanNative) return cleanOcr
  if (!cleanOcr) return cleanNative

  const nativeLines = cleanNative
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const seenNormalized = new Set<string>()
  for (const line of nativeLines) {
    const key = normalizeLineForDedup(line)
    if (key.length > 0) {
      seenNormalized.add(key)
    }
  }

  const extraOcrLines: string[] = []
  for (const rawLine of cleanOcr.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    const key = normalizeLineForDedup(trimmed)
    if (key.length > 0 && seenNormalized.has(key)) {
      continue
    }
    extraOcrLines.push(trimmed)
  }

  return extraOcrLines.length > 0
    ? `${nativeLines.join('\n')}\n${extraOcrLines.join('\n')}`
    : nativeLines.join('\n')
}
