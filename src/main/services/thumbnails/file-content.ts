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

  if (buffer.length >= 16 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const majorBrand = buffer.toString('ascii', 8, 12)
    if (majorBrand === 'qt  ') return 'QuickTime movie'
    if (majorBrand === 'mp41' || majorBrand === 'mp42') return 'MP4 file'
  }

  // Older QuickTime files can start with a wide atom instead of a file-type box.
  if (
    buffer.length >= 24 &&
    buffer.readUInt32BE(0) === 8 &&
    buffer.toString('ascii', 4, 8) === 'wide'
  ) {
    let hasMovieData = false
    let hasMovieHeader = false
    let offset = 8
    for (let boxes = 0; boxes < 64 && offset + 8 <= buffer.length; boxes++) {
      const size = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)
      if (offset === 8 && type === 'mdat' && size > buffer.length - offset) {
        return 'QuickTime movie with incomplete data'
      }
      if (size < 8 || size > buffer.length - offset) break
      hasMovieData ||= type === 'mdat'
      hasMovieHeader ||= type === 'moov'
      if (hasMovieData && hasMovieHeader) return 'QuickTime movie'
      offset += size
    }
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
