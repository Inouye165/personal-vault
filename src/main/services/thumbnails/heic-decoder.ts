import sharp, { type Sharp } from 'sharp'

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'])

interface LibheifImageHandle {
  get_width: () => number
  get_height: () => number
  is_primary?: () => boolean
  display: (
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    callback: (result: unknown) => void
  ) => void
  free: () => void
}

interface LibheifDecoderInstance {
  decode: (data: Uint8Array) => LibheifImageHandle[]
}

let cachedDecoder: LibheifDecoderInstance | null = null

function getHeifDecoder(): LibheifDecoderInstance {
  if (!cachedDecoder) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const libheif = require('libheif-js/wasm-bundle') as {
      HeifDecoder: new () => LibheifDecoderInstance
    }
    cachedDecoder = new libheif.HeifDecoder()
  }
  return cachedDecoder
}

/**
 * Checks whether a buffer starts with an ISOBMFF `ftyp` box carrying a HEIC/HEIF brand
 * (excluding AVIF brands, which are decoded natively by sharp/libvips).
 */
export function isHeicBuffer(buf: Buffer): boolean {
  if (buf.length < 16) return false
  if (buf.subarray(4, 8).toString('ascii') !== 'ftyp') return false
  const boxSize = Math.min(buf.readUInt32BE(0), buf.length, 256)
  if (boxSize < 12) return false

  const brands = new Set<string>()
  brands.add(buf.subarray(8, 12).toString('ascii'))
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    brands.add(buf.subarray(offset, offset + 4).toString('ascii'))
  }
  if (brands.has('avif') || brands.has('avis')) {
    return false
  }
  for (const b of HEIC_BRANDS) {
    if (brands.has(b)) return true
  }
  return false
}

export class HeicDecodeError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HeicDecodeError'
    this.code = code
  }
}

/**
 * Selects the primary image handle from decoded HEIF images using `is_primary()`.
 * Fallback policy: if no handle reports `is_primary() === true`, falls back deterministically
 * to `images[0]` (or `null` when empty).
 */
export function selectPrimaryHeifImage<T extends { readonly is_primary?: () => boolean }>(
  images: readonly T[]
): T | null {
  if (!images || images.length === 0) {
    return null
  }
  const flagged = images.find((img) => {
    try {
      return typeof img.is_primary === 'function' && img.is_primary()
    } catch {
      return false
    }
  })
  return flagged ?? images[0] ?? null
}

/**
 * Decodes a HEIC/HEIF buffer to an RGBA buffer via `libheif-js` WASM while enforcing
 * pixel-count bounds before allocation and freeing all WASM image handles deterministically.
 * Note: `libheif` applies HEIF container `irot`/`imir` transforms during `display()`.
 */
export async function decodeHeicToRgba(
  fileBuffer: Buffer,
  maxInputPixels: number,
  decoderOverride?: LibheifDecoderInstance
): Promise<{ readonly data: Buffer; readonly width: number; readonly height: number }> {
  const decoder = decoderOverride ?? getHeifDecoder()
  let images: LibheifImageHandle[]
  try {
    images = decoder.decode(fileBuffer)
  } catch (err) {
    throw new HeicDecodeError(
      'CORRUPT_IMAGE',
      `Corrupt or unreadable HEIC image: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (!images || images.length === 0) {
    throw new HeicDecodeError('CORRUPT_IMAGE', 'Corrupt or empty HEIC image container')
  }

  try {
    const primary = selectPrimaryHeifImage(images)
    if (!primary) {
      throw new HeicDecodeError('CORRUPT_IMAGE', 'Corrupt or empty HEIC image container')
    }

    const width = primary.get_width()
    const height = primary.get_height()
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new HeicDecodeError('CORRUPT_IMAGE', `Invalid HEIC dimensions: ${width}x${height}`)
    }
    if (width * height > maxInputPixels) {
      throw new HeicDecodeError(
        'IMAGE_TOO_LARGE',
        `Image dimensions (${width}x${height} = ${width * height} px) exceed limit (${maxInputPixels} px)`
      )
    }

    const rgba = new Uint8ClampedArray(width * height * 4)
    await new Promise<void>((resolve, reject) => {
      primary.display({ data: rgba, width, height }, (result) => {
        if (!result) {
          reject(new HeicDecodeError('CORRUPT_IMAGE', 'HEIC pixel decoding returned null'))
        } else {
          resolve()
        }
      })
    })

    return {
      data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      width,
      height
    }
  } finally {
    for (const img of images) {
      try {
        img.free()
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Opens an image buffer as a normalized, upright `sharp` instance.
 * For HEIC/HEIF, `libheif` applies container `irot` during pixel decode so `.rotate()` is NOT
 * called again (preventing double-rotation when EXIF Orientation is also present).
 */
export async function openSharpFromImageBuffer(
  fileBuffer: Buffer,
  maxInputPixels: number
): Promise<{ readonly image: Sharp; readonly isHeic: boolean }> {
  if (isHeicBuffer(fileBuffer)) {
    const decoded = await decodeHeicToRgba(fileBuffer, maxInputPixels)
    return {
      image: sharp(decoded.data, {
        raw: { width: decoded.width, height: decoded.height, channels: 4 },
        limitInputPixels: maxInputPixels
      }),
      isHeic: true
    }
  }

  return {
    image: sharp(fileBuffer, { limitInputPixels: maxInputPixels }).rotate(),
    isHeic: false
  }
}
