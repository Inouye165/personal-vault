import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { extractPhotoMetadataFromBuffer } from '../../src/main/services/metadata/extractor'
import {
  decodeSemanticEmbedding,
  decodeThumbnail
} from '../../src/main/services/thumbnails/decoder'

function box(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, payload])
}

describe('photo files whose contents are not supported images', () => {
  const psd = Buffer.alloc(26)
  psd.write('8BPS')
  psd.writeUInt16BE(1, 4)
  const truncatedMovieData = box('mdat')
  truncatedMovieData.writeUInt32BE(1024)
  const fixtures = [
    [
      'QuickTime movie with incomplete data',
      Buffer.concat([box('wide'), truncatedMovieData, Buffer.alloc(8)])
    ],
    ['QuickTime movie', box('ftyp', Buffer.from('qt  \0\0\0\0qt  '))],
    ['MP4 file', box('ftyp', Buffer.from('mp42\0\0\0\0mp42'))],
    ['QuickTime movie', Buffer.concat([box('wide'), box('mdat'), box('moov')])],
    ['Photoshop document', psd],
    ['XML document', Buffer.from('<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>')]
  ] as const

  it.each(fixtures)('recognizes a %s behind a .jpg extension', async (label, bytes) => {
    const directory = await mkdtemp(join(tmpdir(), 'pv-photo-format-'))
    const sourcePath = join(directory, 'mislabeled.jpg')
    try {
      await writeFile(sourcePath, bytes)
      const metadata = await extractPhotoMetadataFromBuffer({
        fileBuffer: bytes,
        recordedExtension: '.jpg',
        computedSha256: 'a'.repeat(64),
        observedByteSize: bytes.length,
        observedMtimeMs: 0
      })
      expect(metadata.extractionStatus).toBe('unsupported')
      expect(metadata.errorMessage).toContain(label)
      for (const result of [
        await decodeThumbnail({ sourcePath }),
        await decodeSemanticEmbedding({ sourcePath, modelInstallDir: directory })
      ]) {
        expect(result).toMatchObject({
          status: 'unsupported',
          reason: expect.stringContaining(label)
        })
      }
    } finally {
      await rm(sourcePath, { force: true })
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('uses the embedded JPEG for a Photoshop preview but leaves visual indexing unsupported', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pv-photo-format-'))
    const sourcePath = join(directory, 'mislabeled.jpg')
    try {
      const jpeg = await sharp({
        create: { width: 8, height: 5, channels: 3, background: 'blue' }
      })
        .jpeg()
        .toBuffer()
      // Image resource 1036, empty Pascal name including padding, JPEG thumbnail format.
      const resource = Buffer.alloc(12 + 28 + jpeg.length + (jpeg.length % 2))
      resource.write('8BIM')
      resource.writeUInt16BE(1036, 4)
      resource.writeUInt32BE(28 + jpeg.length, 8)
      resource.writeUInt32BE(1, 12)
      resource.writeUInt32BE(jpeg.length, 32)
      jpeg.copy(resource, 40)
      const sectionHeader = Buffer.alloc(8)
      sectionHeader.writeUInt32BE(resource.length, 4)
      await writeFile(sourcePath, Buffer.concat([psd, sectionHeader, resource]))
      expect(await decodeThumbnail({ sourcePath })).toMatchObject({
        status: 'ready',
        width: 8,
        height: 5
      })
      expect(
        await decodeSemanticEmbedding({ sourcePath, modelInstallDir: directory })
      ).toMatchObject({
        status: 'unsupported',
        reason: expect.stringContaining('Photoshop document')
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('still produces a photo preview for a readable PNG named .jpg', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pv-photo-format-'))
    const sourcePath = join(directory, 'mislabeled.jpg')
    try {
      const bytes = await sharp({
        create: { width: 3, height: 2, channels: 3, background: 'red' }
      })
        .png()
        .toBuffer()
      await writeFile(sourcePath, bytes)
      expect(await decodeThumbnail({ sourcePath })).toMatchObject({
        status: 'ready',
        width: 3,
        height: 2
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
