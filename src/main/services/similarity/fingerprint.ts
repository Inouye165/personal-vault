/**
 * Personal Vault — Deterministic Perceptual Fingerprinting (Stage 5C)
 *
 * Implements deterministic difference hashing (dHash64_v1) and Hamming distance
 * comparison. Robust against recompression, format conversion, and modest resizing.
 *
 * Documented limits:
 * - Crops: changes the relative gradient structure across the 9x8 matrix and may be missed.
 * - Rotations: non-EXIF 90/180/270 degree rotations alter row adjacency and will be missed.
 * - Burst shots: sequential shots with minimal camera movement produce close distances,
 *   which is why algorithmic suggestions require explicit user classification.
 * - Difficult images (solid colors, pure noise) may produce degenerate or colliding hashes.
 */

import sharp from 'sharp'
import { openSharpFromImageBuffer } from '../thumbnails/heic-decoder'

export const DHASH_ALGORITHM_VERSION = 'dhash64_v1'

export interface DHash64Result {
  readonly fingerprint: string
  readonly bucket0: number
  readonly bucket1: number
  readonly bucket2: number
  readonly bucket3: number
  readonly algorithmVersion: string
}

export interface ImageFingerprintResult extends DHash64Result {
  readonly width: number
  readonly height: number
}

/**
 * Computes 64-bit dHash from 72 bytes of raw 9x8 grayscale pixels.
 * (9 columns x 8 rows).
 *
 * For each row y in 0..7:
 *   For each col x in 0..7:
 *     bit is 1 if pixel(x, y) > pixel(x + 1, y), else 0.
 */
export function computeDHash64FromRawGrayscale(buffer: Buffer | Uint8Array): DHash64Result {
  if (buffer.length < 72) {
    throw new Error(`Raw grayscale buffer must be at least 72 bytes, received ${buffer.length}`)
  }

  let hashBigInt = 0n

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const pLeft = buffer[y * 9 + x]!
      const pRight = buffer[y * 9 + x + 1]!
      hashBigInt <<= 1n
      if (pLeft > pRight) {
        hashBigInt |= 1n
      }
    }
  }

  // Format as 16 hexadecimal lowercase characters (padded with leading zeros)
  const hex = hashBigInt.toString(16).padStart(16, '0')

  // Extract 4 16-bit bucket integers (each 4 hex characters)
  const bucket0 = Number((hashBigInt >> 48n) & 0xffffn)
  const bucket1 = Number((hashBigInt >> 32n) & 0xffffn)
  const bucket2 = Number((hashBigInt >> 16n) & 0xffffn)
  const bucket3 = Number(hashBigInt & 0xffffn)

  return {
    fingerprint: hex,
    bucket0,
    bucket1,
    bucket2,
    bucket3,
    algorithmVersion: DHASH_ALGORITHM_VERSION
  }
}

/**
 * Computes Hamming distance between two 16-hex character 64-bit fingerprints.
 * Returns an integer between 0 (identical) and 64 (all bits different).
 */
export function computeHammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== 16 || hexB.length !== 16) {
    throw new Error(`Fingerprints must be 16 hex characters: got '${hexA}' and '${hexB}'`)
  }

  const valA = BigInt(`0x${hexA}`)
  const valB = BigInt(`0x${hexB}`)
  let diff = valA ^ valB
  let distance = 0

  while (diff > 0n) {
    diff &= diff - 1n
    distance++
  }

  return distance
}

/**
 * Computes uncalibrated algorithmic similarity score between 0.0 and 1.0.
 * Score = (64 - distance) / 64.
 *
 * NOTE: This is an uncalibrated machine inference score, NOT a calibrated probability.
 */
export function computeAlgorithmicSimilarity(distance: number): number {
  const boundedDist = Math.max(0, Math.min(64, distance))
  return (64 - boundedDist) / 64
}

/**
 * Extracts 9x8 grayscale raw buffer using Sharp (normalizing EXIF orientation)
 * and computes 64-bit dHash along with image dimensions.
 */
export async function extractDHash64FromImageBuffer(
  imageBuffer: Buffer,
  maxInputPixels: number = 100_000_000
): Promise<ImageFingerprintResult> {
  const meta = await sharp(imageBuffer, { limitInputPixels: maxInputPixels }).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  const { image } = await openSharpFromImageBuffer(imageBuffer, maxInputPixels)
  const rawGrayscale = await image
    .resize(9, 8, { fit: 'fill' }) // exact 9 cols x 8 rows
    .grayscale()
    .raw()
    .toBuffer()

  const dhash = computeDHash64FromRawGrayscale(rawGrayscale)

  return {
    ...dhash,
    width,
    height
  }
}
