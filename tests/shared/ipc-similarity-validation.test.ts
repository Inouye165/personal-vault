import { describe, it, expect } from 'vitest'
import {
  SimilarityJobStatusSchema,
  SimilarityAnalysisProgressSchema,
  SimilarityDecisionTypeSchema,
  SimilarityCandidatePairSchema,
  SimilarityGetPairsRequestSchema,
  SimilarityGetPairsResponseSchema,
  SimilaritySetDecisionRequestSchema,
  SimilaritySetDecisionResponseSchema,
  AnnotationJournalEntrySchema,
  validatePayload
} from '../../src/shared/validation/ipc-schemas'

describe('Stage 5C — IPC Similarity Schemas Validation', () => {
  it('validates similarity job status', () => {
    expect(SimilarityJobStatusSchema.safeParse('idle').success).toBe(true)
    expect(SimilarityJobStatusSchema.safeParse('running').success).toBe(true)
    expect(SimilarityJobStatusSchema.safeParse('completed').success).toBe(true)
    expect(SimilarityJobStatusSchema.safeParse('unknown').success).toBe(false)
  })

  it('validates similarity decision types', () => {
    expect(SimilarityDecisionTypeSchema.safeParse('unreviewed').success).toBe(true)
    expect(SimilarityDecisionTypeSchema.safeParse('edited_version').success).toBe(true)
    expect(SimilarityDecisionTypeSchema.safeParse('similar_scene').success).toBe(true)
    expect(SimilarityDecisionTypeSchema.safeParse('unrelated').success).toBe(true)
    expect(SimilarityDecisionTypeSchema.safeParse('other').success).toBe(false)
  })

  it('validates similarity analysis progress payload', () => {
    const valid = {
      jobId: 'job-123',
      status: 'running',
      algorithmVersion: 'dhash64_v1',
      totalPhotos: 100,
      processedPhotos: 45,
      errorPhotos: 1,
      unsupportedPhotos: 2,
      candidatePairsFound: 10,
      startedAtMs: 1000,
      updatedAtMs: 2000,
      completedAtMs: null
    }
    const res = validatePayload(SimilarityAnalysisProgressSchema, valid)
    expect(res.success).toBe(true)
  })

  it('validates candidate pair schema with photo metadata', () => {
    const validPair = {
      id: 1,
      jobId: 'job-123',
      locationIdA: 10,
      locationIdB: 20,
      photoA: {
        id: 10,
        fileName: 'img1.jpg',
        originalPath: '/photos/img1.jpg',
        byteSize: 1024,
        filesystemBirthtimeMs: 1000,
        filesystemMtimeMs: 1000,
        activeHash: 'a'.repeat(64),
        discoveryObservationId: 1,
        width: 1920,
        height: 1080,
        rating: 5,
        flag: 'pick'
      },
      photoB: {
        id: 20,
        fileName: 'img1_edit.jpg',
        originalPath: '/photos/img1_edit.jpg',
        byteSize: 2048,
        filesystemBirthtimeMs: 2000,
        filesystemMtimeMs: 2000,
        activeHash: 'b'.repeat(64),
        discoveryObservationId: 2,
        width: 1920,
        height: 1080,
        rating: null,
        flag: 'none'
      },
      distance: 3,
      similarityScore: 0.953125,
      algorithmVersion: 'dhash64_v1',
      decision: 'unreviewed',
      decisionVersion: null,
      decisionUpdatedAtMs: null,
      createdAtMs: 3000
    }
    const res = validatePayload(SimilarityCandidatePairSchema, validPair)
    expect(res.success).toBe(true)
  })

  it('validates pair query request with pagination and filtering', () => {
    const req = { page: 2, pageSize: 25, filter: 'edited_version' }
    const res = validatePayload(SimilarityGetPairsRequestSchema, req)
    expect(res.success).toBe(true)
    if (res.success) {
      expect(res.data.page).toBe(2)
      expect(res.data.pageSize).toBe(25)
      expect(res.data.filter).toBe('edited_version')
    }

    const pairResp = {
      pairs: [],
      totalCount: 0,
      page: 2,
      pageSize: 25,
      totalPages: 0
    }
    const respRes = validatePayload(SimilarityGetPairsResponseSchema, pairResp)
    expect(respRes.success).toBe(true)
  })

  it('validates decision submission request and response', () => {
    const req = {
      locationIdA: 5,
      locationIdB: 15,
      expectedRevisionA: 'rev:1:100:1000:hasha',
      expectedRevisionB: 'rev:2:200:2000:hashb',
      decision: 'edited_version'
    }
    const res = validatePayload(SimilaritySetDecisionRequestSchema, req)
    expect(res.success).toBe(true)

    const resp = {
      success: true,
      decision: 'edited_version',
      version: 1,
      persistencePending: false
    }
    const respRes = validatePayload(SimilaritySetDecisionResponseSchema, resp)
    expect(respRes.success).toBe(true)
  })

  it('validates similarity_decision journal entry format', () => {
    const entry = {
      formatVersion: 1,
      entrySeq: 42,
      entryTimestampMs: Date.now(),
      opId: 'op-sim-1',
      kind: 'similarity_decision',
      locationIdA: 10,
      locationIdB: 20,
      expectedRevisionA: 'rev:1:100:1000:hasha',
      expectedRevisionB: 'rev:2:200:2000:hashb',
      decision: 'similar_scene',
      version: 2
    }
    const res = validatePayload(AnnotationJournalEntrySchema, entry)
    expect(res.success).toBe(true)
  })
})
