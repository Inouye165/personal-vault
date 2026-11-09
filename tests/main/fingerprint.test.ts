/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  computeDHash64FromRawGrayscale,
  computeHammingDistance,
  computeAlgorithmicSimilarity,
  extractDHash64FromImageBuffer,
  DHASH_ALGORITHM_VERSION
} from '../../src/main/services/similarity/fingerprint'

describe('Stage 5C — Perceptual Fingerprinting (dHash64)', () => {
  it('computes deterministic 64-bit dHash and 4 bucket values from 72-byte raw grayscale buffer', () => {
    // 72 bytes = 9 columns x 8 rows
    // Create an image where every pixel in a row is brighter than the next (left > right)
    const leftBrighter = Buffer.alloc(72)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 9; x++) {
        leftBrighter[y * 9 + x] = 255 - x * 20
      }
    }

    const res = computeDHash64FromRawGrayscale(leftBrighter)
    expect(res.algorithmVersion).toBe(DHASH_ALGORITHM_VERSION)
    expect(res.fingerprint).toBe('ffffffffffffffff')
    expect(res.bucket0).toBe(0xffff)
    expect(res.bucket1).toBe(0xffff)
    expect(res.bucket2).toBe(0xffff)
    expect(res.bucket3).toBe(0xffff)

    // Create an image where right is brighter than left (left < right)
    const rightBrighter = Buffer.alloc(72)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 9; x++) {
        rightBrighter[y * 9 + x] = x * 20
      }
    }
    const res2 = computeDHash64FromRawGrayscale(rightBrighter)
    expect(res2.fingerprint).toBe('0000000000000000')
    expect(res2.bucket0).toBe(0)
    expect(res2.bucket1).toBe(0)
    expect(res2.bucket2).toBe(0)
    expect(res2.bucket3).toBe(0)
  })

  it('calculates Hamming distance and uncalibrated algorithmic similarity score', () => {
    const d0 = computeHammingDistance('ffffffffffffffff', 'ffffffffffffffff')
    expect(d0).toBe(0)
    expect(computeAlgorithmicSimilarity(d0)).toBe(1.0)

    const d64 = computeHammingDistance('ffffffffffffffff', '0000000000000000')
    expect(d64).toBe(64)
    expect(computeAlgorithmicSimilarity(d64)).toBe(0.0)

    const d4 = computeHammingDistance('ffffffffffffffff', 'ffffffffffffff0f') // 4 bits diff (0xf vs 0x0)
    expect(d4).toBe(4)
    expect(computeAlgorithmicSimilarity(d4)).toBe((64 - 4) / 64)
  })

  it('generates consistent fingerprints across recompression and resizing derivatives', async () => {
    // Generate a 200x200 test image with distinct gradient patterns
    const svgBase = `
      <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ff0000" />
            <stop offset="50%" stop-color="#00ff00" />
            <stop offset="100%" stop-color="#0000ff" />
          </linearGradient>
        </defs>
        <rect width="200" height="200" fill="url(#g)" />
        <circle cx="100" cy="100" r="40" fill="#ffff00" />
      </svg>
    `
    const originalBuf = await sharp(Buffer.from(svgBase)).jpeg({ quality: 90 }).toBuffer()

    // Derivative 1: Recompressed with lower quality (JPEG 50)
    const recompressedBuf = await sharp(originalBuf).jpeg({ quality: 50 }).toBuffer()

    // Derivative 2: Resized to 100x100 and converted to PNG
    const resizedBuf = await sharp(originalBuf).resize(100, 100).png().toBuffer()

    // Unrelated image: completely different pattern (vertical stripes)
    const svgUnrelated = `
      <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" width="50" height="200" fill="#000000" />
        <rect x="50" width="50" height="200" fill="#ffffff" />
        <rect x="100" width="50" height="200" fill="#000000" />
        <rect x="150" width="50" height="200" fill="#ffffff" />
      </svg>
    `
    const unrelatedBuf = await sharp(Buffer.from(svgUnrelated)).jpeg().toBuffer()

    const fpOriginal = await extractDHash64FromImageBuffer(originalBuf)
    const fpRecompressed = await extractDHash64FromImageBuffer(recompressedBuf)
    const fpResized = await extractDHash64FromImageBuffer(resizedBuf)
    const fpUnrelated = await extractDHash64FromImageBuffer(unrelatedBuf)

    expect(fpOriginal.width).toBe(200)
    expect(fpOriginal.height).toBe(200)

    const distRecompressed = computeHammingDistance(
      fpOriginal.fingerprint,
      fpRecompressed.fingerprint
    )
    const distResized = computeHammingDistance(fpOriginal.fingerprint, fpResized.fingerprint)
    const distUnrelated = computeHammingDistance(fpOriginal.fingerprint, fpUnrelated.fingerprint)

    // Recompressed and resized should have very low Hamming distance (<= 4 bits)
    expect(distRecompressed).toBeLessThanOrEqual(4)
    expect(distResized).toBeLessThanOrEqual(4)

    // Unrelated image should have significant Hamming distance (> 15 bits)
    expect(distUnrelated).toBeGreaterThan(15)
  })
})
