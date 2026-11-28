// @vitest-environment node
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectMediaFileByContent } from '../../src/main/services/video/inspector'

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const vf = Buffer.alloc(4)
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0)
  return box(type, Buffer.concat([vf, payload]))
}

function buildSyntheticMovie(params: {
  brand: string
  videoCodecFourCc: string
  audioCodecFourCc?: string
  width: number
  height: number
  durationSec: number
  rotated90?: boolean
}): Buffer {
  const ftypPayload = Buffer.alloc(12)
  ftypPayload.write(params.brand, 0, 'ascii')
  ftypPayload.writeUInt32BE(0, 4)
  ftypPayload.write(params.brand, 8, 'ascii')
  const ftyp = box('ftyp', ftypPayload)

  const mvhdPayload = Buffer.alloc(96)
  mvhdPayload.writeUInt32BE(1000, 8) // timescale
  mvhdPayload.writeUInt32BE(Math.round(params.durationSec * 1000), 12) // duration
  const mvhd = fullBox('mvhd', 0, 0, mvhdPayload)

  const tkhdPayload = Buffer.alloc(80)
  tkhdPayload.writeUInt32BE(1, 8) // track_id
  tkhdPayload.writeUInt32BE(Math.round(params.durationSec * 1000), 16)
  if (params.rotated90) {
    // 90 deg rotation matrix at offset 36 (after version+flags, so 40 - 4 = 36)
    tkhdPayload.writeInt32BE(0, 36) // a
    tkhdPayload.writeInt32BE(0x00010000, 40) // b
    tkhdPayload.writeInt32BE(-0x00010000, 48) // c
    tkhdPayload.writeInt32BE(0, 52) // d
  } else {
    tkhdPayload.writeInt32BE(0x00010000, 36)
    tkhdPayload.writeInt32BE(0x00010000, 52)
  }
  tkhdPayload.writeUInt32BE(params.width << 16, 72)
  tkhdPayload.writeUInt32BE(params.height << 16, 76)
  const tkhd = fullBox('tkhd', 0, 3, tkhdPayload)

  const hdlrPayload = Buffer.alloc(24)
  hdlrPayload.write('vide', 4, 'ascii')
  const hdlr = fullBox('hdlr', 0, 0, hdlrPayload)

  const sampleEntryPayload = Buffer.alloc(24)
  const sampleEntry = box(params.videoCodecFourCc, sampleEntryPayload)
  const stsdCount = Buffer.alloc(4)
  stsdCount.writeUInt32BE(1, 0)
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([stsdCount, sampleEntry]))
  const stbl = box('stbl', stsd)
  const minf = box('minf', stbl)
  const mdia = box('mdia', Buffer.concat([hdlr, minf]))
  const videTrak = box('trak', Buffer.concat([tkhd, mdia]))

  const traks = [videTrak]
  if (params.audioCodecFourCc) {
    const aTkhd = fullBox('tkhd', 0, 3, Buffer.alloc(80))
    const aHdlrPayload = Buffer.alloc(24)
    aHdlrPayload.write('soun', 4, 'ascii')
    const aHdlr = fullBox('hdlr', 0, 0, aHdlrPayload)
    const aEntry = box(params.audioCodecFourCc, Buffer.alloc(20))
    const aStsd = fullBox('stsd', 0, 0, Buffer.concat([stsdCount, aEntry]))
    const aStbl = box('stbl', aStsd)
    const aMinf = box('minf', aStbl)
    const aMdia = box('mdia', Buffer.concat([aHdlr, aMinf]))
    traks.push(box('trak', Buffer.concat([aTkhd, aMdia])))
  }

  const moov = box('moov', Buffer.concat([mvhd, ...traks]))
  const mdat = box('mdat', Buffer.from([0, 0, 0, 1]))
  return Buffer.concat([ftyp, mdat, moov])
}

describe('video content inspector', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pv-vid-inspect-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('recognizes a QuickTime HEVC+AAC movie disguised as .JPG without altering it', async () => {
    const filePath = join(workDir, 'IMG_1450.JPG')
    const bytes = buildSyntheticMovie({
      brand: 'qt  ',
      videoCodecFourCc: 'hvc1',
      audioCodecFourCc: 'mp4a',
      width: 1920,
      height: 1080,
      durationSec: 4.5,
      rotated90: true
    })
    writeFileSync(filePath, bytes)

    const result = await inspectMediaFileByContent(filePath)
    expect(result.mediaKind).toBe('video')
    if (result.mediaKind === 'video') {
      expect(result.video).toMatchObject({
        container: 'quicktime',
        mimeType: 'video/mp4',
        recommendedExtension: '.mov',
        videoCodec: 'hevc',
        audioCodec: 'aac',
        durationMs: 4500,
        widthPx: 1080,
        heightPx: 1920,
        hasVideoTrack: true,
        hasAudioTrack: true,
        isPlayableStructure: true,
        structureError: null
      })
    }
  })

  it('recognizes standard MP4 H.264+AAC and WebM containers', async () => {
    const mp4Path = join(workDir, 'clip.mp4')
    writeFileSync(
      mp4Path,
      buildSyntheticMovie({
        brand: 'mp42',
        videoCodecFourCc: 'avc1',
        audioCodecFourCc: 'mp4a',
        width: 1280,
        height: 720,
        durationSec: 2
      })
    )
    const mp4Res = await inspectMediaFileByContent(mp4Path)
    expect(mp4Res.mediaKind).toBe('video')
    if (mp4Res.mediaKind === 'video') {
      expect(mp4Res.video.container).toBe('mp4')
      expect(mp4Res.video.videoCodec).toBe('h264')
      expect(mp4Res.video.audioCodec).toBe('aac')
      expect(mp4Res.video.isPlayableStructure).toBe(true)
    }

    const webmPath = join(workDir, 'clip.webm')
    const ebmlHeader = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]),
      Buffer.from('webm', 'ascii'),
      Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00, 0x00]),
      Buffer.from('V_VP9', 'ascii')
    ])
    writeFileSync(webmPath, ebmlHeader)
    const webmRes = await inspectMediaFileByContent(webmPath)
    expect(webmRes.mediaKind).toBe('video')
    if (webmRes.mediaKind === 'video') {
      expect(webmRes.video.container).toBe('webm')
      expect(webmRes.video.mimeType).toBe('video/webm')
      expect(webmRes.video.videoCodec).toBe('vp9')
      expect(webmRes.video.isPlayableStructure).toBe(true)
    }
  })

  it('marks truncated or missing-moov movies as unreadable structure', async () => {
    const truncatedPath = join(workDir, 'broken.mov')
    const truncatedMdat = box('mdat', Buffer.alloc(16))
    truncatedMdat.writeUInt32BE(50000, 0)
    writeFileSync(truncatedPath, Buffer.concat([box('wide'), truncatedMdat]))

    const truncatedRes = await inspectMediaFileByContent(truncatedPath)
    expect(truncatedRes.mediaKind).toBe('video')
    if (truncatedRes.mediaKind === 'video') {
      expect(truncatedRes.video.isPlayableStructure).toBe(false)
      expect(truncatedRes.video.structureError).toMatch(/incomplete/i)
    }

    const noMoovPath = join(workDir, 'nomoov.mp4')
    const ftypPayload = Buffer.alloc(12)
    ftypPayload.write('mp42', 0, 'ascii')
    writeFileSync(
      noMoovPath,
      Buffer.concat([box('ftyp', ftypPayload), box('mdat', Buffer.alloc(16))])
    )

    const noMoovRes = await inspectMediaFileByContent(noMoovPath)
    expect(noMoovRes.mediaKind).toBe('video')
    if (noMoovRes.mediaKind === 'video') {
      expect(noMoovRes.video.isPlayableStructure).toBe(false)
      expect(noMoovRes.video.structureError).toMatch(/missing movie header/i)
    }
  })

  it('never misclassifies HEIC still photos as videos', async () => {
    const heicSrc = resolve(__dirname, '../fixtures/heic/portrait_exif6.heic')
    const heicCopy = join(workDir, 'portrait_exif6.heic')
    copyFileSync(heicSrc, heicCopy)

    const res = await inspectMediaFileByContent(heicCopy)
    expect(res).toEqual({ mediaKind: 'photo' })
  })
})
