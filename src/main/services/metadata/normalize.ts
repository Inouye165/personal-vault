/**
 * Personal Vault — Stage 6C Metadata Normalization (Dimensions, Camera/Lens, Format vs Extension)
 */

import {
  METADATA_LIMITS,
  type CameraLensResolution,
  type DetectedContainerFormat,
  type DimensionResolution
} from './types'

/**
 * Strips C0/C1 control characters, NUL bytes, and replacement noise, collapses internal
 * whitespace, and bounds output to `MAX_TEXT_LENGTH` UTF-16 code units.
 */
export function cleanMetadataString(input: unknown): {
  readonly cleaned: string | null
  readonly truncated: boolean
} {
  if (input === null || input === undefined) {
    return { cleaned: null, truncated: false }
  }

  let rawStr: string
  if (typeof input === 'string') {
    rawStr = input
  } else if (Array.isArray(input)) {
    const firstStr = input.find((item) => typeof item === 'string' && item.trim().length > 0)
    if (typeof firstStr !== 'string') {
      return { cleaned: null, truncated: false }
    }
    rawStr = firstStr
  } else {
    return { cleaned: null, truncated: false }
  }

  // Replace control characters (0x00..0x1F, 0x7F..0x9F) and U+FFFD replacement chars with spaces
  let chars = ''
  for (let i = 0; i < rawStr.length; i++) {
    const code = rawStr.charCodeAt(i)
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159) || code === 0xfffd) {
      chars += ' '
    } else {
      chars += rawStr[i]
    }
  }

  const collapsed = chars.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) {
    return { cleaned: null, truncated: false }
  }

  if (collapsed.length > METADATA_LIMITS.MAX_TEXT_LENGTH) {
    return {
      cleaned: collapsed.slice(0, METADATA_LIMITS.MAX_TEXT_LENGTH).trimEnd(),
      truncated: true
    }
  }

  return { cleaned: collapsed, truncated: false }
}

function combineMakeAndModel(
  make: string | null,
  model: string | null
): { readonly display: string | null; readonly truncated: boolean } {
  if (!make && !model) {
    return { display: null, truncated: false }
  }
  if (!make) {
    return { display: model, truncated: false }
  }
  if (!model) {
    return { display: make, truncated: false }
  }

  const lowerMake = make.toLowerCase()
  const lowerModel = model.toLowerCase()

  // Also strip common corporate suffixes ("Canon Inc." -> "Canon", "Nikon Corporation" -> "Nikon")
  // when checking whether Model already begins with the manufacturer name.
  const baseMakeToken = lowerMake.split(/[\s,]+/)[0] ?? lowerMake
  const modelStartsWithMake =
    lowerModel === lowerMake ||
    lowerModel.startsWith(`${lowerMake} `) ||
    lowerModel.startsWith(`${lowerMake}-`) ||
    (baseMakeToken.length >= 3 &&
      (lowerModel === baseMakeToken ||
        lowerModel.startsWith(`${baseMakeToken} `) ||
        lowerModel.startsWith(`${baseMakeToken}-`)))

  const combined = modelStartsWithMake ? model : `${make} ${model}`
  if (combined.length > METADATA_LIMITS.MAX_TEXT_LENGTH) {
    return {
      display: combined.slice(0, METADATA_LIMITS.MAX_TEXT_LENGTH).trimEnd(),
      truncated: true
    }
  }
  return { display: combined, truncated: false }
}

export function normalizeCameraAndLens(params: {
  cameraMake?: unknown
  cameraModel?: unknown
  lensMake?: unknown
  lensModel?: unknown
}): CameraLensResolution {
  const cMake = cleanMetadataString(params.cameraMake)
  const cModel = cleanMetadataString(params.cameraModel)
  const lMake = cleanMetadataString(params.lensMake)
  const lModel = cleanMetadataString(params.lensModel)

  const camCombined = combineMakeAndModel(cMake.cleaned, cModel.cleaned)
  const lensCombined = combineMakeAndModel(lMake.cleaned, lModel.cleaned)

  return {
    cameraMakeRaw: cMake.cleaned,
    cameraModelRaw: cModel.cleaned,
    cameraDisplay: camCombined.display,
    cameraNormalized: camCombined.display ? camCombined.display.toLowerCase() : null,
    lensMakeRaw: lMake.cleaned,
    lensModelRaw: lModel.cleaned,
    lensDisplay: lensCombined.display,
    lensNormalized: lensCombined.display ? lensCombined.display.toLowerCase() : null,
    wasTruncated:
      cMake.truncated ||
      cModel.truncated ||
      lMake.truncated ||
      lModel.truncated ||
      camCombined.truncated ||
      lensCombined.truncated
  }
}

export function resolveDimensions(params: {
  encodedWidth?: unknown
  encodedHeight?: unknown
  exifOrientation?: unknown
}): DimensionResolution {
  let validOrientation: number | null = null
  let warning: string | null = null

  if (params.exifOrientation !== null && params.exifOrientation !== undefined) {
    const num = Number(params.exifOrientation)
    if (Number.isInteger(num) && num >= 1 && num <= 8) {
      validOrientation = num
    } else {
      warning = `Ignored invalid EXIF Orientation value: ${String(params.exifOrientation)}`
    }
  }

  const w =
    params.encodedWidth !== null && params.encodedWidth !== undefined
      ? Number(params.encodedWidth)
      : NaN
  const h =
    params.encodedHeight !== null && params.encodedHeight !== undefined
      ? Number(params.encodedHeight)
      : NaN

  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    return {
      encodedWidthPx: null,
      encodedHeightPx: null,
      exifOrientation: validOrientation,
      displayWidthPx: null,
      displayHeightPx: null,
      dimensionWarning: warning
    }
  }

  if (
    w > METADATA_LIMITS.MAX_DIMENSION_EDGE_PX ||
    h > METADATA_LIMITS.MAX_DIMENSION_EDGE_PX ||
    w * h > METADATA_LIMITS.MAX_DIMENSION_AREA_PX
  ) {
    return {
      encodedWidthPx: null,
      encodedHeightPx: null,
      exifOrientation: validOrientation,
      displayWidthPx: null,
      displayHeightPx: null,
      dimensionWarning: `Rejected excessive dimensions (${w}x${h} px)`
    }
  }

  const swapsAxes =
    validOrientation === 5 ||
    validOrientation === 6 ||
    validOrientation === 7 ||
    validOrientation === 8

  return {
    encodedWidthPx: w,
    encodedHeightPx: h,
    exifOrientation: validOrientation,
    displayWidthPx: swapsAxes ? h : w,
    displayHeightPx: swapsAxes ? w : h,
    dimensionWarning: warning
  }
}

const FORMAT_EXPECTED_EXTENSIONS: Readonly<Record<DetectedContainerFormat, ReadonlySet<string>>> = {
  jpeg: new Set(['.jpg', '.jpeg', '.jpe', '.jfif']),
  png: new Set(['.png']),
  webp: new Set(['.webp']),
  gif: new Set(['.gif']),
  avif: new Set(['.avif']),
  tiff: new Set(['.tif', '.tiff']),
  heic: new Set(['.heic', '.heif']),
  cr2: new Set(['.cr2']),
  cr3: new Set(['.cr3']),
  dng: new Set(['.dng']),
  nef: new Set(['.nef', '.nrw']),
  arw: new Set(['.arw', '.srf', '.sr2']),
  orf: new Set(['.orf']),
  rw2: new Set(['.rw2']),
  raf: new Set(['.raf']),
  pef: new Set(['.pef']),
  bmp: new Set(['.bmp']),
  raw_tiff: new Set(['.nef', '.nrw', '.arw', '.srf', '.sr2', '.pef', '.rwl', '.dng', '.cr2'])
}

export function normalizeRecordedExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

export function computeExtensionFormatMismatch(
  recordedExtension: string,
  detectedFormat: string | null
): boolean {
  if (!detectedFormat) return false
  const normExt = normalizeRecordedExtension(recordedExtension)
  if (!normExt) return true
  if (!Object.prototype.hasOwnProperty.call(FORMAT_EXPECTED_EXTENSIONS, detectedFormat)) {
    return false
  }
  const expectedSet = FORMAT_EXPECTED_EXTENSIONS[detectedFormat as DetectedContainerFormat]
  return !expectedSet.has(normExt)
}
