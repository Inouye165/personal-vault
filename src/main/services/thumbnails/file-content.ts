import { open } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type VideoContainerKind = 'mp4' | 'quicktime' | 'webm'

export interface DetectedVideoContainerHeader {
  readonly container: VideoContainerKind
  readonly label: string
  readonly mimeType: 'video/mp4' | 'video/webm'
  readonly recommendedExtension: '.mp4' | '.mov' | '.webm'
  readonly incompleteReason?: string
}

const STILL_IMAGE_ISOBMFF_BRANDS = new Set([
  'heic',
  'heix',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'hevc',
  'hevx'
])

const QUICKTIME_BRANDS = new Set(['qt  '])

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'M4VH',
  'M4VP',
  'f4v ',
  '3gp4',
  '3gp5',
  '3gp6',
  '3g2a',
  'MSNV',
  'NDAS',
  'NDSC',
  'NDSH',
  'NDSM',
  'NDSP',
  'NDSS',
  'NDXC',
  'NDXH',
  'NDXM',
  'NDXP',
  'NDXS'
])

function extractFtypBrands(buffer: Buffer): {
  majorBrand: string
  compatibleBrands: string[]
} | null {
  if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') {
    return null
  }
  const declaredSize = buffer.readUInt32BE(0)
  const boxEnd = Math.min(declaredSize < 16 ? buffer.length : declaredSize, buffer.length, 256)
  const majorBrand = buffer.toString('ascii', 8, 12)
  const compatibleBrands: string[] = [majorBrand]
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    compatibleBrands.push(buffer.toString('ascii', offset, offset + 4))
  }
  return { majorBrand, compatibleBrands }
}

/**
 * Detects whether a file's initial bytes represent a supported video container
 * (MP4, QuickTime MOV, or WebM) by contents rather than filename extension.
 * Still-image ISOBMFF containers (HEIC/HEIF/AVIF) are explicitly excluded.
 */
export function detectVideoContainerFromHeader(
  buffer: Buffer,
  totalFileSize?: number
): DetectedVideoContainerHeader | null {
  const ftyp = extractFtypBrands(buffer)
  if (ftyp) {
    // Still-image brands must remain photos unless a video brand is explicitly primary
    if (
      STILL_IMAGE_ISOBMFF_BRANDS.has(ftyp.majorBrand) ||
      ftyp.compatibleBrands.some((b) => STILL_IMAGE_ISOBMFF_BRANDS.has(b))
    ) {
      if (!QUICKTIME_BRANDS.has(ftyp.majorBrand) && !MP4_BRANDS.has(ftyp.majorBrand)) {
        return null
      }
    }

    if (
      QUICKTIME_BRANDS.has(ftyp.majorBrand) ||
      ftyp.compatibleBrands.some((b) => QUICKTIME_BRANDS.has(b))
    ) {
      return {
        container: 'quicktime',
        label: 'QuickTime movie',
        mimeType: 'video/mp4',
        recommendedExtension: '.mov'
      }
    }

    if (MP4_BRANDS.has(ftyp.majorBrand) || ftyp.compatibleBrands.some((b) => MP4_BRANDS.has(b))) {
      return {
        container: 'mp4',
        label: 'MP4 file',
        mimeType: 'video/mp4',
        recommendedExtension: '.mp4'
      }
    }
  }

  // Older QuickTime files can start with a `wide` atom instead of an `ftyp` box.
  if (
    buffer.length >= 16 &&
    buffer.readUInt32BE(0) === 8 &&
    buffer.toString('ascii', 4, 8) === 'wide'
  ) {
    const effectiveTotal = totalFileSize ?? buffer.length
    let hasMovieData = false
    let hasMovieHeader = false
    let offset = 8
    for (let boxes = 0; boxes < 64 && offset + 8 <= buffer.length; boxes++) {
      const size = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)
      if (offset === 8 && type === 'mdat' && size > effectiveTotal - offset) {
        return {
          container: 'quicktime',
          label: 'QuickTime movie with incomplete data',
          mimeType: 'video/mp4',
          recommendedExtension: '.mov',
          incompleteReason: 'QuickTime movie with incomplete data'
        }
      }
      if (size < 8 || size > effectiveTotal - offset) break
      hasMovieData ||= type === 'mdat'
      hasMovieHeader ||= type === 'moov'
      if (hasMovieData && hasMovieHeader) {
        return {
          container: 'quicktime',
          label: 'QuickTime movie',
          mimeType: 'video/mp4',
          recommendedExtension: '.mov'
        }
      }
      if (offset + size <= buffer.length) {
        offset += size
      } else {
        // Large mdat extends past the initial header slice but within totalFileSize
        if (type === 'mdat' && effectiveTotal > buffer.length) {
          return {
            container: 'quicktime',
            label: 'QuickTime movie',
            mimeType: 'video/mp4',
            recommendedExtension: '.mov'
          }
        }
        break
      }
    }
  }

  // WebM / EBML header: 0x1A 0x45 0xDF 0xA3 with DocType 'webm' in initial EBML header.
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    const headerSlice = buffer.subarray(0, Math.min(buffer.length, 128))
    if (headerSlice.includes(Buffer.from('webm', 'ascii'))) {
      return {
        container: 'webm',
        label: 'WebM video',
        mimeType: 'video/webm',
        recommendedExtension: '.webm'
      }
    }
  }

  return null
}

/** Identifies supported-lookalike files by their contents, regardless of their filename. */
export function identifyNonPhotoImage(buffer: Buffer): string | null {
  if (
    buffer.length >= 26 &&
    buffer.toString('ascii', 0, 4) === '8BPS' &&
    [1, 2].includes(buffer.readUInt16BE(4))
  ) {
    return 'Photoshop document'
  }

  if (/^\s*<\?xml(?:\s|\?)/.test(buffer.toString('utf8', 0, 128))) {
    return 'XML document'
  }

  const videoHeader = detectVideoContainerFromHeader(buffer)
  if (videoHeader) {
    return videoHeader.label
  }

  return null
}

/** Reads the JPEG thumbnail in a Photoshop image resource without rendering its layers. */
export function readPhotoshopThumbnail(buffer: Buffer): Buffer | null {
  // PSD/PSB header, then a length-prefixed color mode section and image resources section.
  if (buffer.length < 34) return null
  const resourcesLengthOffset = 30 + buffer.readUInt32BE(26)
  if (resourcesLengthOffset + 4 > buffer.length) return null
  const resourcesEnd = resourcesLengthOffset + 4 + buffer.readUInt32BE(resourcesLengthOffset)
  if (resourcesEnd > buffer.length) return null

  let offset = resourcesLengthOffset + 4
  while (offset + 12 <= resourcesEnd) {
    if (buffer.toString('ascii', offset, offset + 4) !== '8BIM') return null
    const id = buffer.readUInt16BE(offset + 4)
    const nameBytes = 1 + buffer[offset + 6]!
    const sizeOffset = offset + 6 + nameBytes + (nameBytes % 2)
    if (sizeOffset + 4 > resourcesEnd) return null
    const dataOffset = sizeOffset + 4
    const size = buffer.readUInt32BE(sizeOffset)
    if (dataOffset + size > resourcesEnd) return null
    if (id === 1036 && size >= 30 && buffer.readUInt32BE(dataOffset) === 1) {
      const jpegSize = buffer.readUInt32BE(dataOffset + 20)
      const jpegStart = dataOffset + 28
      if (jpegSize >= 2 && jpegSize <= size - 28 && buffer.readUInt16BE(jpegStart) === 0xffd8) {
        return buffer.subarray(jpegStart, jpegStart + jpegSize)
      }
    }
    offset = dataOffset + size + (size % 2)
  }
  return null
}

export function unsupportedPhotoReason(format: string): string {
  return `This file is a ${format}. Photo search and metadata extraction do not support this format.`
}

/** Checks whether a canonical file path is contained inside one of the approved roots. */
export function isPathInsideApprovedRoots(
  canonicalFilePath: string,
  canonicalRoots: readonly string[]
): boolean {
  const norm = (p: string): string =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
  const normFile = norm(canonicalFilePath)
  return canonicalRoots.some((root) => {
    const normRoot = norm(root)
    const rel = relative(normRoot, normFile)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  })
}

export async function readInitialFileSlice(
  filePath: string,
  maxBytes = 64 * 1024
): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const bytesToRead = Math.min(maxBytes, stat.size)
    if (bytesToRead <= 0) return Buffer.alloc(0)
    const buf = Buffer.allocUnsafe(bytesToRead)
    const { bytesRead } = await handle.read(buf, 0, bytesToRead, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
