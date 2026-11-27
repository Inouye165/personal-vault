/**
 * Personal Vault — Partitioned Candidate Search (Stage 5C)
 *
 * Implements bounded, bucket-indexed candidate retrieval to avoid unrestricted
 * all-pairs comparisons ($O(N^2)$) and prevent memory exhaustion.
 *
 * Enforces:
 * - Algorithmic similarity threshold (Hamming distance <= 10, >= 84.375% similarity).
 * - Exact byte duplicates exclusion (preserved for Stage 3 exact duplicate workflow).
 * - Strict canonical pair ordering (locationIdA < locationIdB, no reversed pairs).
 * - Bounded dense candidate limits (max 50 candidates per photo, max 10,000 candidate pairs per run).
 */

import type { CatalogDatabase } from '../catalog/database'
import {
  computeHammingDistance,
  computeAlgorithmicSimilarity,
  DHASH_ALGORITHM_VERSION
} from './fingerprint'

export const MAX_SIMILARITY_DISTANCE = 10 // Hamming distance <= 10 / 64 bits (>= 84.375% similarity)
export const MAX_CANDIDATES_PER_PHOTO = 50
export const MAX_TOTAL_CANDIDATE_PAIRS = 10_000

export interface CandidatePairCandidate {
  readonly locationIdA: number
  readonly locationIdB: number
  readonly distance: number
  readonly similarityScore: number
  readonly algorithmVersion: string
}

/**
 * Searches for and persists candidate pairs for a given set of photos within a job.
 * Avoids all-pairs comparisons by using indexed 4x16-bit bucket sub-keys.
 */
export function findAndPersistCandidatePairs(
  catalog: CatalogDatabase,
  jobId: string,
  photoLocationIds: readonly number[],
  options?: {
    maxDistance?: number
    maxCandidatesPerPhoto?: number
    maxTotalPairs?: number
    algorithmVersion?: string
  }
): number {
  const maxDistance = options?.maxDistance ?? MAX_SIMILARITY_DISTANCE
  const maxCandidatesPerPhoto = options?.maxCandidatesPerPhoto ?? MAX_CANDIDATES_PER_PHOTO
  const maxTotalPairs = options?.maxTotalPairs ?? MAX_TOTAL_CANDIDATE_PAIRS
  const algorithmVersion = options?.algorithmVersion ?? DHASH_ALGORITHM_VERSION

  const pairsToPersist: CandidatePairCandidate[] = []
  const seenPairKeys = new Set<string>()

  for (const locId of photoLocationIds) {
    if (pairsToPersist.length >= maxTotalPairs) {
      break
    }

    const hashRecord = catalog.getPhotoPerceptualHash(locId, algorithmVersion)
    if (!hashRecord || !hashRecord.isCurrent) {
      continue
    }

    // Query candidates matching at least one bucket where other.id > locId
    const bucketMatches = catalog.findFingerprintMatchesForBuckets(
      [hashRecord.bucket0, hashRecord.bucket1, hashRecord.bucket2, hashRecord.bucket3],
      locId,
      algorithmVersion
    )

    const candidatesForPhoto: Array<{
      otherLocId: number
      distance: number
      similarityScore: number
    }> = []

    for (const match of bucketMatches) {
      // 1. Exclude exact byte duplicates (preserved under Stage 3 exact duplicates workflow)
      if (
        hashRecord.contentSha256 &&
        match.contentSha256 &&
        hashRecord.contentSha256.toLowerCase() === match.contentSha256.toLowerCase()
      ) {
        continue
      }

      // 2. Compute exact Hamming distance
      const distance = computeHammingDistance(hashRecord.fingerprint, match.fingerprint)
      if (distance <= maxDistance) {
        candidatesForPhoto.push({
          otherLocId: match.fileLocationId,
          distance,
          similarityScore: computeAlgorithmicSimilarity(distance)
        })
      }
    }

    // Sort candidates for this photo by distance ascending (most similar first)
    candidatesForPhoto.sort((a, b) => a.distance - b.distance)

    // Bound candidates per photo
    const boundedCandidates = candidatesForPhoto.slice(0, maxCandidatesPerPhoto)

    for (const cand of boundedCandidates) {
      const locA = Math.min(locId, cand.otherLocId)
      const locB = Math.max(locId, cand.otherLocId)
      const key = `${locA}:${locB}`

      if (!seenPairKeys.has(key)) {
        seenPairKeys.add(key)
        pairsToPersist.push({
          locationIdA: locA,
          locationIdB: locB,
          distance: cand.distance,
          similarityScore: cand.similarityScore,
          algorithmVersion
        })

        if (pairsToPersist.length >= maxTotalPairs) {
          break
        }
      }
    }
  }

  // Persist candidate pairs in batches
  catalog.saveSimilarityCandidatePairs(jobId, pairsToPersist)
  return pairsToPersist.length
}
