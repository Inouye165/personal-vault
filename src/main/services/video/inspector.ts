import { open } from 'node:fs/promises'
import { detectVideoContainerFromHeader, type VideoContainerKind } from '../thumbnails/file-content'

export interface VideoContentMetadata {
  readonly container: VideoContainerKind
  readonly mimeType: 'video/mp4' | 'video/webm'
  readonly recommendedExtension: '.mp4' | '.mov' | '.webm'
  readonly videoCodec: string | null
  readonly audioCodec: string | null
  readonly durationMs: number | null
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly hasVideoTrack: boolean
  readonly hasAudioTrack: boolean
  readonly isPlayableStructure: boolean
  readonly structureError: string | null
}

export type MediaContentInspection =
  | { readonly mediaKind: 'photo' }
  | { readonly mediaKind: 'video'; readonly video: VideoContentMetadata }

const HEADER_SLICE_BYTES = 64 * 1024
const MAX_TOP_LEVEL_ATOMS = 128
const MAX_MOOV_BYTES = 8 * 1024 * 1024

interface AtomSpan {
  readonly type: string
  readonly start: number
  readonly headerSize: number
  readonly size: number
}

function readAtomHeader(buf: Buffer, offset: number, remainingTotal: number): AtomSpan | null {
  if (offset + 8 > buf.length) return null
  const size32 = buf.readUInt32BE(offset)
  const type = buf.toString('ascii', offset + 4, offset + 8)
  if (size32 === 1) {
    if (offset + 16 > buf.length) return null
    const size64 = Number(buf.readBigUInt64BE(offset + 8))
    if (!Number.isFinite(size64) || size64 < 16) return null
    return { type, start: offset, headerSize: 16, size: size64 }
  }
  if (size32 === 0) {
    return { type, start: offset, headerSize: 8, size: remainingTotal }
  }
  if (size32 < 8) return null
  return { type, start: offset, headerSize: 8, size: size32 }
}

function normalizeVideoCodecFourCc(fourCc: string): string {
  switch (fourCc) {
    case 'hvc1':
    case 'hev1':
      return 'hevc'
    case 'avc1':
    case 'avc3':
      return 'h264'
    case 'vp09':
      return 'vp9'
    case 'vp08':
      return 'vp8'
    case 'av01':
      return 'av1'
    case 'mp4v':
      return 'mpeg4'
    case 'jpeg':
    case 'mjpa':
    case 'mjpb':
      return 'mjpeg'
    case 'apch':
    case 'apcn':
    case 'apcs':
    case 'apco':
    case 'ap4h':
    case 'ap4x':
      return 'prores'
    default:
      return fourCc.trim().toLowerCase()
  }
}

function normalizeAudioCodecFourCc(fourCc: string): string {
  switch (fourCc) {
    case 'mp4a':
      return 'aac'
    case 'Opus':
      return 'opus'
    case 'ac-3':
    case 'ec-3':
      return 'ac3'
    case '.mp3':
      return 'mp3'
    case 'fLaC':
      return 'flac'
    case 'lpcm':
    case 'sowt':
    case 'twos':
    case 'raw ':
      return 'pcm'
    default:
      return fourCc.trim().toLowerCase()
  }
}

function iterBufferAtoms(buf: Buffer, start: number, end: number): AtomSpan[] {
  const atoms: AtomSpan[] = []
  let offset = start
  while (offset + 8 <= end && atoms.length < 256) {
    const atom = readAtomHeader(buf, offset, end - offset)
    if (!atom || atom.size < atom.headerSize || offset + atom.size > end) {
      break
    }
    atoms.push(atom)
    offset += atom.size
  }
  return atoms
}

function isRotation90Or270(tkhdBuf: Buffer, start: number, end: number, version: number): boolean {
  // Matrix starts at offset 40 (v0) or 52 (v1) after tkhd payload start (version+flags)
  const matrixOffset = start + (version === 1 ? 52 : 40)
  if (matrixOffset + 36 > end) return false
  // 3x3 matrix of 16.16 fixed-point ints: [a, b, u, c, d, v, tx, ty, w]
  const a = tkhdBuf.readInt32BE(matrixOffset)
  const b = tkhdBuf.readInt32BE(matrixOffset + 4)
  const c = tkhdBuf.readInt32BE(matrixOffset + 12)
  const d = tkhdBuf.readInt32BE(matrixOffset + 16)
  // 90 deg or 270 deg rotation has a ~= 0, d ~= 0, and non-zero b/c
  return a === 0 && d === 0 && b !== 0 && c !== 0
}

function parseMoovMetadata(moovBuf: Buffer): {
  durationMs: number | null
  widthPx: number | null
  heightPx: number | null
  videoCodec: string | null
  audioCodec: string | null
  hasVideoTrack: boolean
  hasAudioTrack: boolean
} {
  const topAtoms = iterBufferAtoms(moovBuf, 0, moovBuf.length)
  let durationMs: number | null = null
  let widthPx: number | null = null
  let heightPx: number | null = null
  let videoCodec: string | null = null
  let audioCodec: string | null = null
  let hasVideoTrack = false
  let hasAudioTrack = false

  for (const atom of topAtoms) {
    const payloadStart = atom.start + atom.headerSize
    const payloadEnd = atom.start + atom.size

    if (atom.type === 'mvhd' && payloadStart + 20 <= payloadEnd) {
      const version = moovBuf[payloadStart]!
      if (version === 0 && payloadStart + 20 <= payloadEnd) {
        const timescale = moovBuf.readUInt32BE(payloadStart + 12)
        const duration = moovBuf.readUInt32BE(payloadStart + 16)
        if (timescale > 0 && duration > 0) {
          durationMs = Math.round((duration / timescale) * 1000)
        }
      } else if (version === 1 && payloadStart + 32 <= payloadEnd) {
        const timescale = moovBuf.readUInt32BE(payloadStart + 20)
        const duration = Number(moovBuf.readBigUInt64BE(payloadStart + 24))
        if (timescale > 0 && Number.isFinite(duration) && duration > 0) {
          durationMs = Math.round((duration / timescale) * 1000)
        }
      }
    }

    if (atom.type === 'trak') {
      const trakAtoms = iterBufferAtoms(moovBuf, payloadStart, payloadEnd)
      let trackWidth: number | null = null
      let trackHeight: number | null = null
      let handlerType: string | null = null
      let codecFourCc: string | null = null

      for (const tAtom of trakAtoms) {
        const tStart = tAtom.start + tAtom.headerSize
        const tEnd = tAtom.start + tAtom.size

        if (tAtom.type === 'tkhd' && tStart + 4 <= tEnd) {
          const version = moovBuf[tStart]!
          const dimOffset = tStart + (version === 1 ? 88 : 76)
          if (dimOffset + 8 <= tEnd) {
            const rawW = moovBuf.readUInt32BE(dimOffset) >>> 16
            const rawH = moovBuf.readUInt32BE(dimOffset + 4) >>> 16
            if (rawW > 0 && rawH > 0) {
              const rotated = isRotation90Or270(moovBuf, tStart, tEnd, version)
              trackWidth = rotated ? rawH : rawW
              trackHeight = rotated ? rawW : rawH
            }
          }
        }

        if (tAtom.type === 'mdia') {
          const mdiaAtoms = iterBufferAtoms(moovBuf, tStart, tEnd)
          for (const mAtom of mdiaAtoms) {
            const mStart = mAtom.start + mAtom.headerSize
            const mEnd = mAtom.start + mAtom.size

            if (mAtom.type === 'hdlr' && mStart + 12 <= mEnd) {
              handlerType = moovBuf.toString('ascii', mStart + 8, mStart + 12)
            }

            if (mAtom.type === 'minf') {
              const minfAtoms = iterBufferAtoms(moovBuf, mStart, mEnd)
              for (const minfAtom of minfAtoms) {
                if (minfAtom.type !== 'stbl') continue
                const stblAtoms = iterBufferAtoms(
                  moovBuf,
                  minfAtom.start + minfAtom.headerSize,
                  minfAtom.start + minfAtom.size
                )
                for (const sAtom of stblAtoms) {
                  if (sAtom.type !== 'stsd') continue
                  const stsdPayload = sAtom.start + sAtom.headerSize
                  const stsdEnd = sAtom.start + sAtom.size
                  // FullBox: version(1)+flags(3)+entry_count(4), then first sample entry size(4)+format(4)
                  if (stsdPayload + 16 <= stsdEnd) {
                    const entryCount = moovBuf.readUInt32BE(stsdPayload + 4)
                    if (entryCount >= 1) {
                      codecFourCc = moovBuf.toString('ascii', stsdPayload + 12, stsdPayload + 16)
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (handlerType === 'vide') {
        hasVideoTrack = true
        if (widthPx === null && trackWidth !== null && trackHeight !== null) {
          widthPx = trackWidth
          heightPx = trackHeight
        }
        if (videoCodec === null && codecFourCc) {
          videoCodec = normalizeVideoCodecFourCc(codecFourCc)
        }
      } else if (handlerType === 'soun') {
        hasAudioTrack = true
        if (audioCodec === null && codecFourCc) {
          audioCodec = normalizeAudioCodecFourCc(codecFourCc)
        }
      }
    }
  }

  return {
    durationMs,
    widthPx,
    heightPx,
    videoCodec,
    audioCodec,
    hasVideoTrack,
    hasAudioTrack
  }
}

/**
 * Inspects a media file's actual contents in strict read-only mode to distinguish
 * videos (including files with misleading photo extensions such as `IMG_1450.JPG`)
 * from still photos, and extracts container, codec, duration, and structural health.
 */
export async function inspectMediaFileByContent(filePath: string): Promise<MediaContentInspection> {
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 16) {
      return { mediaKind: 'photo' }
    }

    const headLen = Math.min(HEADER_SLICE_BYTES, stat.size)
    const headBuf = Buffer.allocUnsafe(headLen)
    const { bytesRead } = await handle.read(headBuf, 0, headLen, 0)
    const header = headBuf.subarray(0, bytesRead)

    const detected = detectVideoContainerFromHeader(header, stat.size)
    if (!detected) {
      return { mediaKind: 'photo' }
    }

    if (detected.incompleteReason) {
      return {
        mediaKind: 'video',
        video: {
          container: detected.container,
          mimeType: detected.mimeType,
          recommendedExtension: detected.recommendedExtension,
          videoCodec: null,
          audioCodec: null,
          durationMs: null,
          widthPx: null,
          heightPx: null,
          hasVideoTrack: false,
          hasAudioTrack: false,
          isPlayableStructure: false,
          structureError: detected.incompleteReason
        }
      }
    }

    if (detected.container === 'webm') {
      const hasSegment = header.includes(Buffer.from([0x18, 0x53, 0x80, 0x67]))
      return {
        mediaKind: 'video',
        video: {
          container: 'webm',
          mimeType: 'video/webm',
          recommendedExtension: '.webm',
          videoCodec: header.includes(Buffer.from('V_VP9', 'ascii'))
            ? 'vp9'
            : header.includes(Buffer.from('V_VP8', 'ascii'))
              ? 'vp8'
              : header.includes(Buffer.from('V_AV1', 'ascii'))
                ? 'av1'
                : null,
          audioCodec: header.includes(Buffer.from('A_OPUS', 'ascii'))
            ? 'opus'
            : header.includes(Buffer.from('A_VORBIS', 'ascii'))
              ? 'vorbis'
              : null,
          durationMs: null,
          widthPx: null,
          heightPx: null,
          hasVideoTrack: true,
          hasAudioTrack: true,
          isPlayableStructure: hasSegment,
          structureError: hasSegment ? null : 'WebM file is missing media segment data'
        }
      }
    }

    // Walk top-level ISOBMFF atoms safely without loading mdat payloads into memory.
    let offset = 0
    let moovSpan: AtomSpan | null = null
    let hasMdat = false
    let structureError: string | null = null
    const atomHeaderBuf = Buffer.allocUnsafe(16)

    for (let i = 0; i < MAX_TOP_LEVEL_ATOMS && offset + 8 <= stat.size; i++) {
      const toRead = Math.min(16, stat.size - offset)
      const res = await handle.read(atomHeaderBuf, 0, toRead, offset)
      if (res.bytesRead < 8) {
        structureError = `${detected.label} ended unexpectedly`
        break
      }
      const atom = readAtomHeader(atomHeaderBuf.subarray(0, res.bytesRead), 0, stat.size - offset)
      if (!atom) {
        structureError = `${detected.label} has an invalid container box`
        break
      }
      if (offset + atom.size > stat.size) {
        structureError = `${detected.label} with incomplete data`
        break
      }
      if (atom.type === 'moov') {
        moovSpan = { ...atom, start: offset }
      } else if (atom.type === 'mdat') {
        hasMdat = true
      }
      offset += atom.size
    }

    if (!structureError && !moovSpan) {
      structureError = `${detected.label} is missing movie header metadata`
    } else if (!structureError && !hasMdat) {
      structureError = `${detected.label} contains no video or audio data`
    }

    if (structureError || !moovSpan) {
      return {
        mediaKind: 'video',
        video: {
          container: detected.container,
          mimeType: detected.mimeType,
          recommendedExtension: detected.recommendedExtension,
          videoCodec: null,
          audioCodec: null,
          durationMs: null,
          widthPx: null,
          heightPx: null,
          hasVideoTrack: false,
          hasAudioTrack: false,
          isPlayableStructure: false,
          structureError: structureError ?? `${detected.label} cannot be read`
        }
      }
    }

    const moovPayloadLen = moovSpan.size - moovSpan.headerSize
    if (moovPayloadLen <= 0 || moovPayloadLen > MAX_MOOV_BYTES) {
      return {
        mediaKind: 'video',
        video: {
          container: detected.container,
          mimeType: detected.mimeType,
          recommendedExtension: detected.recommendedExtension,
          videoCodec: null,
          audioCodec: null,
          durationMs: null,
          widthPx: null,
          heightPx: null,
          hasVideoTrack: false,
          hasAudioTrack: false,
          isPlayableStructure: false,
          structureError: `${detected.label} movie header is empty or exceeds safe inspection bounds`
        }
      }
    }

    const moovBuf = Buffer.allocUnsafe(moovPayloadLen)
    const moovRead = await handle.read(
      moovBuf,
      0,
      moovPayloadLen,
      moovSpan.start + moovSpan.headerSize
    )
    const parsed = parseMoovMetadata(moovBuf.subarray(0, moovRead.bytesRead))
    const playable = parsed.hasVideoTrack || parsed.hasAudioTrack

    return {
      mediaKind: 'video',
      video: {
        container: detected.container,
        mimeType: detected.mimeType,
        recommendedExtension: detected.recommendedExtension,
        videoCodec: parsed.videoCodec,
        audioCodec: parsed.audioCodec,
        durationMs: parsed.durationMs,
        widthPx: parsed.widthPx,
        heightPx: parsed.heightPx,
        hasVideoTrack: parsed.hasVideoTrack,
        hasAudioTrack: parsed.hasAudioTrack,
        isPlayableStructure: playable,
        structureError: playable ? null : `${detected.label} has no readable audio or video tracks`
      }
    }
  } finally {
    await handle.close()
  }
}
