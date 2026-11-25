/**
 * Independent binary TIFF/EXIF 2.32 + container fixture builder for Stage 6C tests.
 *
 * Constructs real binary JPEG APP1 (`Exif\0\0`), PNG `IHDR`/`eXIf` chunks, ISO-BMFF
 * (`ftypheic`, `ftypcrx `), Canon CR2, Adobe DNG, and BMP headers directly from
 * published format specifications without sharing any code with production parsers.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

export interface RawTiffTagEntry {
  readonly tagId: number
  readonly type: 'ascii' | 'short' | 'long' | 'rational' | 'byte' | 'undefined'
  readonly value:
    string | number | readonly number[] | readonly (readonly [number, number])[] | Buffer
}

const TIFF_TYPE_BYTE = 1 // 1 byte per element
const TIFF_TYPE_ASCII = 2 // 1 byte per char including trailing NUL
const TIFF_TYPE_SHORT = 3 // 2 bytes
const TIFF_TYPE_LONG = 4 // 4 bytes
const TIFF_TYPE_RATIONAL = 5 // 2 x 4-byte uint32 (numerator, denominator)
const TIFF_TYPE_UNDEFINED = 7 // 1 byte per element

export const EXIF_TAG_IDS = {
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  ImageDescription: 0x010e,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  Software: 0x0131,
  DateTime: 0x0132,
  Artist: 0x013b,
  Copyright: 0x8298,
  ExifIFDPointer: 0x8769,
  GPSInfoIFDPointer: 0x8825,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ISOSpeedRatings: 0x8827,
  DNGVersion: 0xc612,
  DateTimeOriginal: 0x9003,
  DateTimeDigitized: 0x9004,
  OffsetTime: 0x9010,
  OffsetTimeOriginal: 0x9011,
  OffsetTimeDigitized: 0x9012,
  FocalLength: 0x920a,
  MakerNote: 0x927c,
  UserComment: 0x9286,
  SubSecTime: 0x9290,
  SubSecTimeOriginal: 0x9291,
  SubSecTimeDigitized: 0x9292,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
  LensMake: 0xa433,
  LensModel: 0xa434
} as const

export const GPS_TAG_IDS = {
  GPSVersionID: 0x0000,
  GPSLatitudeRef: 0x0001,
  GPSLatitude: 0x0002,
  GPSLongitudeRef: 0x0003,
  GPSLongitude: 0x0004,
  GPSAltitudeRef: 0x0005,
  GPSAltitude: 0x0006
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
 * Builds a raw TIFF header + IFD0 + optional Exif SubIFD + optional GPS SubIFD byte buffer.
 */
export function buildRawTiffExifBuffer(options: {
  ifd0Tags?: readonly RawTiffTagEntry[]
  exifTags?: readonly RawTiffTagEntry[]
  gpsTags?: readonly RawTiffTagEntry[]
  littleEndian?: boolean
  appendRawAsciiWithoutNull?: boolean
}): Buffer {
  const littleEndian = options.littleEndian ?? true
  const exifTags = [...(options.exifTags ?? [])]
  const gpsTags = [...(options.gpsTags ?? [])]
  const ifd0Tags = [...(options.ifd0Tags ?? [])]

  const hasExifSubIfd = exifTags.length > 0
  const hasGpsSubIfd = gpsTags.length > 0

  const sortedIfd0 = [
    ...ifd0Tags,
    ...(hasExifSubIfd
      ? [{ tagId: EXIF_TAG_IDS.ExifIFDPointer, type: 'long' as const, value: 0 }]
      : []),
    ...(hasGpsSubIfd
      ? [{ tagId: EXIF_TAG_IDS.GPSInfoIFDPointer, type: 'long' as const, value: 0 }]
      : [])
  ].sort((a, b) => a.tagId - b.tagId)

  const sortedExif = [...exifTags].sort((a, b) => a.tagId - b.tagId)
  const sortedGps = [...gpsTags].sort((a, b) => a.tagId - b.tagId)

  const ifd0Offset = 8
  const ifd0ByteLen = 2 + sortedIfd0.length * 12 + 4
  const exifIfdOffset = hasExifSubIfd ? ifd0Offset + ifd0ByteLen : 0
  const exifIfdByteLen = hasExifSubIfd ? 2 + sortedExif.length * 12 + 4 : 0
  const gpsIfdOffset = hasGpsSubIfd ? ifd0Offset + ifd0ByteLen + exifIfdByteLen : 0
  const gpsIfdByteLen = hasGpsSubIfd ? 2 + sortedGps.length * 12 + 4 : 0
  let heapCursor = ifd0Offset + ifd0ByteLen + exifIfdByteLen + gpsIfdByteLen

  const heapChunks: Buffer[] = []

  const pushHeap = (raw: Buffer): number => {
    const start = heapCursor
    const padded = raw.length % 2 === 1 ? Buffer.concat([raw, Buffer.from([0])]) : raw
    heapChunks.push(padded)
    heapCursor += padded.length
    return start
  }

  const encodeIfd = (entries: readonly RawTiffTagEntry[]): Buffer => {
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
        let val = Number(entry.value)
        if (entry.tagId === EXIF_TAG_IDS.ExifIFDPointer) {
          val = exifIfdOffset
        } else if (entry.tagId === EXIF_TAG_IDS.GPSInfoIFDPointer) {
          val = gpsIfdOffset
        }
        writeUInt16(dirBuf, TIFF_TYPE_LONG, entryOffset + 2, littleEndian)
        writeUInt32(dirBuf, 1, entryOffset + 4, littleEndian)
        writeUInt32(dirBuf, val >>> 0, entryOffset + 8, littleEndian)
      } else if (entry.type === 'rational') {
        const pairs: readonly (readonly [number, number])[] = Array.isArray(
          (entry.value as readonly unknown[])[0]
        )
          ? (entry.value as readonly (readonly [number, number])[])
          : [entry.value as readonly [number, number]]
        const ratBuf = Buffer.alloc(pairs.length * 8)
        pairs.forEach(([num, den], pIdx) => {
          writeUInt32(ratBuf, num >>> 0, pIdx * 8, littleEndian)
          writeUInt32(ratBuf, den >>> 0, pIdx * 8 + 4, littleEndian)
        })
        writeUInt16(dirBuf, TIFF_TYPE_RATIONAL, entryOffset + 2, littleEndian)
        writeUInt32(dirBuf, pairs.length, entryOffset + 4, littleEndian)
        const offsetInTiff = pushHeap(ratBuf)
        writeUInt32(dirBuf, offsetInTiff, entryOffset + 8, littleEndian)
      } else if (entry.type === 'byte' || entry.type === 'undefined') {
        const rawBytes = Buffer.isBuffer(entry.value)
          ? entry.value
          : Array.isArray(entry.value)
            ? Buffer.from(entry.value as readonly number[])
            : Buffer.from(String(entry.value), 'latin1')
        const tiffType = entry.type === 'byte' ? TIFF_TYPE_BYTE : TIFF_TYPE_UNDEFINED
        writeUInt16(dirBuf, tiffType, entryOffset + 2, littleEndian)
        writeUInt32(dirBuf, rawBytes.length, entryOffset + 4, littleEndian)
        if (rawBytes.length <= 4) {
          rawBytes.copy(dirBuf, entryOffset + 8)
        } else {
          const offsetInTiff = pushHeap(rawBytes)
          writeUInt32(dirBuf, offsetInTiff, entryOffset + 8, littleEndian)
        }
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
          const offsetInTiff = pushHeap(strBytes)
          writeUInt32(dirBuf, offsetInTiff, entryOffset + 8, littleEndian)
        }
      }
    })

    // Next IFD offset = 0
    writeUInt32(dirBuf, 0, 2 + entries.length * 12, littleEndian)
    return dirBuf
  }

  const ifd0Buf = encodeIfd(sortedIfd0)
  const exifBuf = hasExifSubIfd ? encodeIfd(sortedExif) : Buffer.alloc(0)
  const gpsBuf = hasGpsSubIfd ? encodeIfd(sortedGps) : Buffer.alloc(0)

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

  return Buffer.concat([header, ifd0Buf, exifBuf, gpsBuf, ...heapChunks])
}

/**
 * Converts decimal degrees into EXIF DMS rational triples + hemisphere reference tags.
 */
export function buildGpsTags(gps: {
  readonly lat: number
  readonly lon: number
  readonly altitudeM?: number
}): RawTiffTagEntry[] {
  const toDms = (
    degAbs: number
  ): readonly [readonly [number, number], readonly [number, number], readonly [number, number]] => {
    const d = Math.floor(degAbs)
    const mFloat = (degAbs - d) * 60
    const m = Math.floor(mFloat)
    const s = Math.round((mFloat - m) * 60 * 10000)
    return [
      [d, 1],
      [m, 1],
      [s, 10000]
    ]
  }

  const tags: RawTiffTagEntry[] = [
    { tagId: GPS_TAG_IDS.GPSVersionID, type: 'byte', value: [2, 3, 0, 0] },
    { tagId: GPS_TAG_IDS.GPSLatitudeRef, type: 'ascii', value: gps.lat >= 0 ? 'N' : 'S' },
    { tagId: GPS_TAG_IDS.GPSLatitude, type: 'rational', value: toDms(Math.abs(gps.lat)) },
    { tagId: GPS_TAG_IDS.GPSLongitudeRef, type: 'ascii', value: gps.lon >= 0 ? 'E' : 'W' },
    { tagId: GPS_TAG_IDS.GPSLongitude, type: 'rational', value: toDms(Math.abs(gps.lon)) }
  ]

  if (typeof gps.altitudeM === 'number' && Number.isFinite(gps.altitudeM)) {
    tags.push({
      tagId: GPS_TAG_IDS.GPSAltitudeRef,
      type: 'byte',
      value: [gps.altitudeM < 0 ? 1 : 0]
    })
    tags.push({
      tagId: GPS_TAG_IDS.GPSAltitude,
      type: 'rational',
      value: [Math.round(Math.abs(gps.altitudeM) * 100), 100]
    })
  }

  return tags
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
  gpsTags?: readonly RawTiffTagEntry[]
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

  if (!options.ifd0Tags && !options.exifTags && !options.gpsTags) {
    return baseJpeg
  }

  const tiff = buildRawTiffExifBuffer({
    ifd0Tags: options.ifd0Tags,
    exifTags: options.exifTags,
    gpsTags: options.gpsTags,
    littleEndian: options.littleEndian
  })
  return injectApp1ExifIntoJpeg(baseJpeg, tiff)
}

/**
 * Builds a valid synthetic HEIC container by replacing the `Exif` item inside
 * `tests/fixtures/heic/portrait_exif6.heic` with custom TIFF/EXIF/GPS bytes while
 * preserving the valid HEVC bitstream and ISOBMFF box structure.
 */
export function createHeicWithExif(
  tiffExifBuffer: Buffer,
  baseFixturePath = resolve(__dirname, '..', 'fixtures', 'heic', 'portrait_exif6.heic')
): Buffer {
  const base = Buffer.from(readFileSync(baseFixturePath))
  // Locate `meta` -> `iloc` and `mdat`
  let off = 0
  let ilocOff = -1
  let ilocSize = 0
  let mdatOff = -1
  while (off + 8 <= base.length) {
    const size = base.readUInt32BE(off)
    const type = base.toString('ascii', off + 4, off + 8)
    if (type === 'meta') {
      let moff = off + 12
      while (moff + 8 <= off + size) {
        const ms = base.readUInt32BE(moff)
        const mt = base.toString('ascii', moff + 4, moff + 8)
        if (mt === 'iloc') {
          ilocOff = moff
          ilocSize = ms
        }
        moff += ms
      }
    } else if (type === 'mdat') {
      mdatOff = off
    }
    off += size
  }

  if (ilocOff < 0 || ilocSize !== 52 || mdatOff < 0) {
    throw new Error('Unexpected base HEIC fixture layout for createHeicWithExif')
  }

  // Item 2 (Exif) sits at ilocOff + 34: [item_id(2), data_ref(2), base_offset(4), extent_count(2), extent_offset(4), extent_len(4)]
  const item2BaseOffset = base.readUInt32BE(ilocOff + 38)
  const exifHeaderPrefix = Buffer.from([0x00, 0x00, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  const newExifItem = Buffer.concat([exifHeaderPrefix, tiffExifBuffer])

  const prefixBytes = Buffer.from(base.subarray(0, item2BaseOffset))
  // Update Item 2 extent_length at ilocOff + 48
  prefixBytes.writeUInt32BE(newExifItem.length, ilocOff + 48)
  // Update mdat box size
  const hevcLen = item2BaseOffset - (mdatOff + 8)
  prefixBytes.writeUInt32BE(8 + hevcLen + newExifItem.length, mdatOff)

  return Buffer.concat([prefixBytes, newExifItem])
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
