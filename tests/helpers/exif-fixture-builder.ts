/**
 * Independent binary TIFF/EXIF 2.32 + container fixture builder for Stage 6C tests.
 *
 * Constructs real binary JPEG APP1 (`Exif\0\0`), PNG `IHDR`/`eXIf` chunks, ISO-BMFF
 * (`ftypheic`, `ftypcrx `), Canon CR2, Adobe DNG, and BMP headers directly from
 * published format specifications without sharing any code with production parsers.
 */

import sharp from 'sharp'

export interface RawTiffTagEntry {
  readonly tagId: number
  readonly type: 'ascii' | 'short' | 'long'
  readonly value: string | number
}

const TIFF_TYPE_SHORT = 3 // 2 bytes
const TIFF_TYPE_LONG = 4 // 4 bytes
const TIFF_TYPE_ASCII = 2 // 1 byte per char including trailing NUL

export const EXIF_TAG_IDS = {
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  DateTime: 0x0132,
  ExifIFDPointer: 0x8769,
  DNGVersion: 0xc612,
  DateTimeOriginal: 0x9003,
  DateTimeDigitized: 0x9004,
  OffsetTime: 0x9010,
  OffsetTimeOriginal: 0x9011,
  OffsetTimeDigitized: 0x9012,
  SubSecTime: 0x9290,
  SubSecTimeOriginal: 0x9291,
  SubSecTimeDigitized: 0x9292,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
  LensMake: 0xa433,
  LensModel: 0xa434
} as const

function writeUInt16(buf: Buffer, value: number, offset: number, littleEndian: boolean): void {
  if (littleEndian) {
    buf.writeUInt16LE(value, offset)
  } else {
    buf.writeUInt16BE(value, offset)
  }
}

function writeUInt32(buf: Buffer, value: number, offset: number, littleEndian: boolean): void {
  if (littleEndian) {
    buf.writeUInt32LE(value, offset)
  } else {
    buf.writeUInt32BE(value, offset)
  }
}

/**
 * Builds a raw TIFF header + IFD0 + optional Exif SubIFD byte buffer.
 */
export function buildRawTiffExifBuffer(options: {
  ifd0Tags?: readonly RawTiffTagEntry[]
  exifTags?: readonly RawTiffTagEntry[]
  littleEndian?: boolean
  appendRawAsciiWithoutNull?: boolean
}): Buffer {
  const littleEndian = options.littleEndian ?? true
  const exifTags = [...(options.exifTags ?? [])]
  const ifd0Tags = [...(options.ifd0Tags ?? [])]

  const hasExifSubIfd = exifTags.length > 0
  // Reserve ExifIFDPointer in IFD0 if Exif SubIFD is populated
  const sortedIfd0 = [
    ...ifd0Tags,
    ...(hasExifSubIfd
      ? [{ tagId: EXIF_TAG_IDS.ExifIFDPointer, type: 'long' as const, value: 0 }]
      : [])
  ].sort((a, b) => a.tagId - b.tagId)

  const sortedExif = [...exifTags].sort((a, b) => a.tagId - b.tagId)

  const ifd0Offset = 8
  const ifd0ByteLen = 2 + sortedIfd0.length * 12 + 4
  let heapCursor = ifd0Offset + ifd0ByteLen

  const heapChunks: Buffer[] = []

  const encodeIfd = (
    entries: readonly RawTiffTagEntry[],
    pointerValueOverride?: number
  ): Buffer => {
    const dirBuf = Buffer.alloc(2 + entries.length * 12 + 4)
    writeUInt16(dirBuf, entries.length, 0, littleEndian)

    entries.forEach((entry, idx) => {
      const entryOffset = 2 + idx * 12
      writeUInt16(dirBuf, entry.tagId, entryOffset, littleEndian)

      if (entry.type === 'short') {
        writeUInt16(dirBuf, TIFF_TYPE_SHORT, entryOffset + 2, littleEndian)
        writeUInt32(dirBuf, 1, entryOffset + 4, littleEndian)
        writeUInt16(dirBuf, Number(entry.value) & 0xffff, entryOffset + 8, littleEndian)
      } else if (entry.type === 'long') {
        const val =
          entry.tagId === EXIF_TAG_IDS.ExifIFDPointer && pointerValueOverride !== undefined
            ? pointerValueOverride
            : Number(entry.value)
        writeUInt16(dirBuf, TIFF_TYPE_LONG, entryOffset + 2, littleEndian)
        writeUInt32(dirBuf, 1, entryOffset + 4, littleEndian)
        writeUInt32(dirBuf, val >>> 0, entryOffset + 8, littleEndian)
      } else {
        const strBytes = Buffer.from(
          options.appendRawAsciiWithoutNull ? String(entry.value) : `${String(entry.value)}\0`,
          'latin1'
        )
        writeUInt16(dirBuf, TIFF_TYPE_ASCII, entryOffset + 2, littleEndian)
        writeUInt32(dirBuf, strBytes.length, entryOffset + 4, littleEndian)
        if (strBytes.length <= 4) {
          strBytes.copy(dirBuf, entryOffset + 8)
        } else {
          writeUInt32(dirBuf, heapCursor, entryOffset + 8, littleEndian)
          const padded =
            strBytes.length % 2 === 1 ? Buffer.concat([strBytes, Buffer.from([0])]) : strBytes
          heapChunks.push(padded)
          heapCursor += padded.length
        }
      }
    })

    // Next IFD offset = 0
    writeUInt32(dirBuf, 0, 2 + entries.length * 12, littleEndian)
    return dirBuf
  }

  // First encode IFD0 with placeholder ExifIFD pointer so we know IFD0's heap size
  // Wait: simpler—reserve Exif SubIFD immediately after IFD0 before any heap strings!
  const exifIfdOffset = hasExifSubIfd ? ifd0Offset + ifd0ByteLen : 0
  const exifIfdByteLen = hasExifSubIfd ? 2 + sortedExif.length * 12 + 4 : 0
  heapCursor = ifd0Offset + ifd0ByteLen + exifIfdByteLen

  const ifd0Buf = encodeIfd(sortedIfd0, exifIfdOffset)
  const exifBuf = hasExifSubIfd ? encodeIfd(sortedExif) : Buffer.alloc(0)

  const header = Buffer.alloc(8)
  if (littleEndian) {
    header.write('II', 0, 'ascii')
    header.writeUInt16LE(0x002a, 2)
    header.writeUInt32LE(ifd0Offset, 4)
  } else {
    header.write('MM', 0, 'ascii')
    header.writeUInt16BE(0x002a, 2)
    header.writeUInt32BE(ifd0Offset, 4)
  }

  return Buffer.concat([header, ifd0Buf, exifBuf, ...heapChunks])
}

/**
 * Injects a raw TIFF EXIF buffer into a JPEG APP1 (`FF E1`) segment immediately after SOI (`FF D8`).
 */
export function injectApp1ExifIntoJpeg(jpegBuffer: Buffer, tiffExifBuffer: Buffer): Buffer {
  if (jpegBuffer.length < 4 || jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) {
    throw new Error('Expected valid JPEG SOI marker')
  }
  const exifHeader = Buffer.from('Exif\0\0', 'ascii')
  const payloadLen = 2 + exifHeader.length + tiffExifBuffer.length
  if (payloadLen > 0xffff) {
    throw new Error(`APP1 segment length ${payloadLen} exceeds 65535-byte JPEG marker limit`)
  }
  const app1Marker = Buffer.alloc(4)
  app1Marker[0] = 0xff
  app1Marker[1] = 0xe1
  app1Marker.writeUInt16BE(payloadLen, 2)

  return Buffer.concat([
    jpegBuffer.subarray(0, 2),
    app1Marker,
    exifHeader,
    tiffExifBuffer,
    jpegBuffer.subarray(2)
  ])
}

/**
 * Creates a real decodable JPEG image with optional raw TIFF/EXIF tags.
 */
export async function createJpegFixture(options: {
  width?: number
  height?: number
  color?: { r: number; g: number; b: number }
  ifd0Tags?: readonly RawTiffTagEntry[]
  exifTags?: readonly RawTiffTagEntry[]
  littleEndian?: boolean
}): Promise<Buffer> {
  const width = options.width ?? 640
  const height = options.height ?? 480
  const color = options.color ?? { r: 42, g: 110, b: 185 }

  const baseJpeg = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color
    }
  })
    .jpeg({ quality: 82 })
    .toBuffer()

  if (!options.ifd0Tags && !options.exifTags) {
    return baseJpeg
  }

  const tiff = buildRawTiffExifBuffer({
    ifd0Tags: options.ifd0Tags,
    exifTags: options.exifTags,
    littleEndian: options.littleEndian
  })
  return injectApp1ExifIntoJpeg(baseJpeg, tiff)
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Injects a raw `eXIf` chunk into a PNG image before `IDAT`.
 */
export function injectExifChunkIntoPng(pngBuffer: Buffer, tiffExifBuffer: Buffer): Buffer {
  // PNG signature is 8 bytes, followed by IHDR chunk (4 len + 4 type + 13 data + 4 crc = 25 bytes => offset 33)
  const insertOffset = 8 + 25
  const chunkType = Buffer.from('eXIf', 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(tiffExifBuffer.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([chunkType, tiffExifBuffer])), 0)

  return Buffer.concat([
    pngBuffer.subarray(0, insertOffset),
    lenBuf,
    chunkType,
    tiffExifBuffer,
    crcBuf,
    pngBuffer.subarray(insertOffset)
  ])
}

export async function createPngFixture(options: {
  width?: number
  height?: number
  ifd0Tags?: readonly RawTiffTagEntry[]
  exifTags?: readonly RawTiffTagEntry[]
}): Promise<Buffer> {
  const png = await sharp({
    create: {
      width: options.width ?? 320,
      height: options.height ?? 240,
      channels: 3,
      background: { r: 90, g: 160, b: 80 }
    }
  })
    .png()
    .toBuffer()

  if (!options.ifd0Tags && !options.exifTags) {
    return png
  }

  const tiff = buildRawTiffExifBuffer({
    ifd0Tags: options.ifd0Tags,
    exifTags: options.exifTags
  })
  return injectExifChunkIntoPng(png, tiff)
}

/**
 * Crafts a PNG header claiming impossible/excessive dimensions without allocating pixel memory,
 * by patching IHDR width/height + recomputing IHDR CRC32.
 */
export async function createCraftedPngWithDimensions(
  claimedWidth: number,
  claimedHeight: number
): Promise<Buffer> {
  const validPng = await createPngFixture({ width: 8, height: 8 })
  const copy = Buffer.from(validPng)
  // IHDR starts at byte 8: [8..12]=len(13), [12..16]='IHDR', [16..20]=width, [20..24]=height, [29..33]=crc
  copy.writeUInt32BE(claimedWidth >>> 0, 16)
  copy.writeUInt32BE(claimedHeight >>> 0, 20)
  const typeAndData = copy.subarray(12, 29)
  copy.writeUInt32BE(crc32(typeAndData), 29)
  return copy
}

/**
 * Builds a minimal valid ISO-BMFF `ftyp` header for HEIC or CR3 container testing.
 */
export function buildIsoBmffHeader(majorBrand: 'heic' | 'mif1' | 'crx ' | 'avif'): Buffer {
  const ftypBox = Buffer.alloc(24)
  ftypBox.writeUInt32BE(24, 0)
  ftypBox.write('ftyp', 4, 'ascii')
  ftypBox.write(majorBrand, 8, 'ascii')
  ftypBox.writeUInt32BE(0, 12)
  ftypBox.write('mif1', 16, 'ascii')
  ftypBox.write(majorBrand, 20, 'ascii')
  const mdatBox = Buffer.alloc(16)
  mdatBox.writeUInt32BE(16, 0)
  mdatBox.write('mdat', 4, 'ascii')
  return Buffer.concat([ftypBox, mdatBox])
}

/**
 * Builds a Canon CR2 signature header (`II\x2a\x00` + `CR\x02\x00`).
 */
export function buildCanonCr2Header(): Buffer {
  const buf = Buffer.alloc(32)
  buf.write('II', 0, 'ascii')
  buf.writeUInt16LE(0x002a, 2)
  buf.writeUInt32LE(16, 4)
  buf.write('CR', 8, 'ascii')
  buf[10] = 0x02
  buf[11] = 0x00
  buf.writeUInt16LE(0, 16) // 0 IFD entries
  return buf
}

/**
 * Builds an Adobe DNG TIFF header containing `DNGVersion` tag (`0xC612`).
 */
export function buildAdobeDngHeader(): Buffer {
  const buf = Buffer.alloc(32)
  buf.write('II', 0, 'ascii')
  buf.writeUInt16LE(0x002a, 2)
  buf.writeUInt32LE(8, 4)
  buf.writeUInt16LE(1, 8) // 1 entry
  buf.writeUInt16LE(EXIF_TAG_IDS.DNGVersion, 10)
  buf.writeUInt16LE(1, 12) // BYTE
  buf.writeUInt32LE(4, 14) // count = 4
  buf[18] = 1
  buf[19] = 4
  buf[20] = 0
  buf[21] = 0
  buf.writeUInt32LE(0, 22)
  return buf
}
