import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Untyped ESM spike corpus module
import { SYNTHETIC_CLASSIFICATION_CORPUS } from '../../spikes/doc-classification-eval/corpus.mjs'
import {
  classifyWithDeterministicRules,
  DETERMINISTIC_RULE_VERSION,
  MAX_INSPECTED_HEAD_CHARS,
  MAX_INSPECTED_TAIL_CHARS,
  scanTextWithFenceContext
} from '../../src/main/services/documents/classification/rules'
import {
  DocumentClassificationInputSchema,
  DocumentClassificationResultSchema,
  DocumentClutterOverrideSchema,
  type DocumentClassificationInput
} from '../../src/shared/validation/document-schemas'

const SUPPORTED_EXTRACTION_BOUND_CHARS = 500_000
const NEUTRAL_PROSE_PAD =
  'General archival paragraph with neutral observations about weather patterns and afternoon light over the harbor water. '

function makeDoc(
  overrides: Partial<DocumentClassificationInput> = {}
): DocumentClassificationInput {
  return {
    fileName: 'note.md',
    extension: '.md',
    relativePath: 'Documents/note.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    nativeTruncated: false,
    ocrTruncated: false,
    text: NEUTRAL_PROSE_PAD,
    ...overrides
  }
}

describe('Stage 7E Slice 1 — Deterministic Rules, Contracts, I1/I2 & Adversarial Regressions', () => {
  it('validates multi-label input/output/override Zod contracts and provenance', () => {
    expect(DocumentClutterOverrideSchema.parse('inherit')).toBe('inherit')
    expect(DocumentClutterOverrideSchema.parse('force_keep')).toBe('force_keep')
    expect(DocumentClutterOverrideSchema.parse('force_clutter')).toBe('force_clutter')
    expect(() => DocumentClutterOverrideSchema.parse('invalid')).toThrow()

    const input = DocumentClassificationInputSchema.parse(
      makeDoc({
        fileLocationId: 42,
        fileName: 'lease.txt',
        extension: '.txt',
        relativePath: 'Personal/lease.txt',
        byteSize: 1024,
        text: 'RESIDENTIAL LEASE AGREEMENT\n\nWHEREAS Landlord and Tenant agree to the following terms.\nGoverning law: State of Oregon.\nSigned: Alex Rivera'
      })
    )

    const result = classifyWithDeterministicRules(input)
    const parsed = DocumentClassificationResultSchema.parse(result)

    expect(parsed.classifierKind).toBe('deterministic_rules')
    expect(parsed.ruleVersion).toBe(DETERMINISTIC_RULE_VERSION)
    expect(parsed.ruleVersion).toBe('doc_classify_rules_v1')
    expect(parsed.textSourceKind).toBe('native')
    expect(parsed.purposeStatus).toBe('classified')
    expect(parsed.purposeLabels).toContain('legal')
    expect(parsed.originLabels).toContain('personal')
    expect(parsed.isClutterCandidate).toBe(false)
  })

  it('distinguishes purposeStatus "other" (readable abstention) from "unknown" (unreadable/short)', () => {
    const readableOther = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'harbor.txt',
        extension: '.txt',
        text: NEUTRAL_PROSE_PAD.repeat(2)
      })
    )
    expect(readableOther.purposeStatus).toBe('other')
    expect(readableOther.purposeLabels).toEqual([])
    expect(readableOther.isClutterCandidate).toBe(false)

    const unreadable = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'encrypted.pdf',
        extension: '.pdf',
        extractionStatus: 'password_protected',
        textSourceKind: 'none',
        text: null
      })
    )
    expect(unreadable.purposeStatus).toBe('unknown')
    expect(unreadable.originStatus).toBe('unknown')
    expect(unreadable.confidenceBand).toBe('low')
    expect(unreadable.uncertaintyReasons).toContain('no_extracted_text')
    expect(unreadable.isClutterCandidate).toBe(false)
  })

  it('matches the 32-document development tuning corpus with 0 false-hides and 100% clutter/purpose precision', () => {
    let valuablePersonalCount = 0
    let falseHides = 0
    let clutterTp = 0
    let clutterFp = 0
    let clutterFn = 0
    let specificPurposeFp = 0
    let unknownExpected = 0
    let unknownTp = 0

    for (const fixture of SYNTHETIC_CLASSIFICATION_CORPUS) {
      const input = DocumentClassificationInputSchema.parse({
        fileName: fixture.fileName,
        extension: fixture.extension,
        relativePath: fixture.relativePath,
        extractionStatus: fixture.extractionStatus,
        textSourceKind: fixture.textSourceKind ?? 'none',
        ocrMeanConfidence: fixture.ocrMeanConfidence,
        nativeTruncated: fixture.nativeTruncated,
        ocrTruncated: fixture.ocrTruncated,
        text: fixture.text
      })
      const result = DocumentClassificationResultSchema.parse(classifyWithDeterministicRules(input))

      if (fixture.valuablePersonal) {
        valuablePersonalCount += 1
        if (result.isClutterCandidate) {
          falseHides += 1
        }
      }

      if (fixture.expectedClutterCandidate && result.isClutterCandidate) clutterTp += 1
      if (!fixture.expectedClutterCandidate && result.isClutterCandidate) clutterFp += 1
      if (fixture.expectedClutterCandidate && !result.isClutterCandidate) clutterFn += 1

      for (const predictedPurpose of result.purposeLabels) {
        if (!fixture.expectedPurposes.includes(predictedPurpose)) {
          specificPurposeFp += 1
        }
      }

      if (fixture.expectedFallbackStatus === 'unknown') {
        unknownExpected += 1
        if (result.purposeStatus === 'unknown') {
          unknownTp += 1
        }
      }
    }

    expect(valuablePersonalCount).toBe(23)
    expect(falseHides).toBe(0)
    expect(clutterTp).toBe(5)
    expect(clutterFp).toBe(0)
    expect(clutterFn).toBe(4)
    expect(specificPurposeFp).toBe(0)
    expect(unknownTp).toBe(unknownExpected)
  })

  it('satisfies Tier 1 (< 2 ms warm / < 5 ms cold) and Tier 2 500k pathological runtime bounds (1A-1E)', () => {
    // Tier 1 small-input probe
    const smallDoc = makeDoc({
      fileName: 'receipt.txt',
      extension: '.txt',
      text: 'RECEIPT #4491\nItem A $12.00\nItem B $8.50\nItem C $4.25\nSales Tax $1.98\nTotal: $26.73\nVISA ending 1234'
    })
    const t1ColdStart = performance.now()
    classifyWithDeterministicRules(smallDoc)
    const t1ColdMs = performance.now() - t1ColdStart
    expect(t1ColdMs).toBeLessThan(5)

    const t1WarmTimes: number[] = []
    for (let i = 0; i < 10; i += 1) {
      const s = performance.now()
      classifyWithDeterministicRules(smallDoc)
      t1WarmTimes.push(performance.now() - s)
    }
    t1WarmTimes.sort((a, b) => a - b)
    const t1P95 =
      t1WarmTimes[Math.min(t1WarmTimes.length - 1, Math.floor(t1WarmTimes.length * 0.95))]
    expect(t1P95).toBeLessThan(2)

    // Tier 2: 500,000-char pathological probes (1A-1E)
    const probes: Array<{ name: string; text: string }> = [
      {
        name: 'short_repeated_lines_500k',
        text: (() => {
          const unit = '   \n  - item alpha beta\n## section note\n'
          return unit
            .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
            .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
        })()
      },
      {
        name: 'long_single_line_500k',
        text: (() => {
          const unit = 'installation setup ingredients checklist agreement executed this '
          return (
            '# ' +
            unit
              .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
              .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS - 3) +
            '!'
          )
        })()
      },
      {
        name: 'near_matching_headings_500k',
        text: (() => {
          const unit =
            '### fresh-harbor-relish-almost-ingredientz-and-setup-almost-guide-not-matching!\n'
          return unit
            .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
            .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
        })()
      },
      {
        name: 'punctuation_and_partial_clauses_500k',
        text: (() => {
          const unit =
            ':::---[[[$$$###~~~,,,;;;00.00 Permission is hereby granted, free of charge : END-USER LICENSE AGREEMENT : Loaded Modules: \n'
          return unit
            .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
            .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
        })()
      },
      {
        name: 'total_long_whitespace_near_match_500k',
        text: (() => {
          const totalLine = 'Total' + ' '.repeat(50_000) + 'abc\n'
          const subtotalLine = 'Subtotal' + ' '.repeat(50_000) + 'paid\n'
          const unit = totalLine + subtotalLine
          return unit
            .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
            .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
        })()
      }
    ]

    for (const probe of probes) {
      const doc = makeDoc({ fileName: `${probe.name}.md`, text: probe.text })
      const coldStart = performance.now()
      const res = classifyWithDeterministicRules(doc)
      const coldMs = performance.now() - coldStart
      expect(res.totalNormalizedChars).toBeGreaterThan(400_000)
      expect(res.inspectedHeadChars + res.omittedChars + res.inspectedTailChars).toBe(
        res.totalNormalizedChars
      )
      expect(coldMs).toBeLessThan(50)

      const warmRuns: number[] = []
      for (let i = 0; i < 5; i += 1) {
        const s = performance.now()
        classifyWithDeterministicRules(doc)
        warmRuns.push(performance.now() - s)
      }
      warmRuns.sort((a, b) => a - b)
      const warmMedian = warmRuns[Math.floor(warmRuns.length / 2)]
      expect(warmMedian).toBeLessThan(25)
    }
  })

  it('tracks full-stream CommonMark fenced code across head/omitted/tail and exact boundaries (2A-2F)', () => {
    const pad = 'x'.repeat(200) + '\n'
    const fillTo = (target: number, current: string) =>
      current + pad.repeat(Math.max(0, Math.ceil((target - current.length) / pad.length)))

    // 2A: Fence opened in head, closed in tail
    let doc2A = '# Personal Note\n\n```ts\n'
    doc2A = fillTo(90_000, doc2A)
    doc2A +=
      'export const step1 = true\nStep 1: Fake step inside code\n' +
      '```\n\n' +
      '## Ingredients\n- 2 tbsp olive oil\n- 1 cup broth\nPreheat the oven to 375°F and simmer for 15 minutes.\n'
    const res2A = classifyWithDeterministicRules(makeDoc({ fileName: '2a.md', text: doc2A }))
    expect(res2A.tailEnteredInsideFence).toBe(true)
    expect(res2A.unclosedFenceAtEof).toBe(false)
    expect(res2A.purposeLabels).toContain('recipes')
    expect(res2A.purposeLabels).not.toContain('instructions')

    // 2B: Fence opened in omitted middle, closed in tail
    let doc2B = fillTo(70_000, '# Archive Log\n\n' + NEUTRAL_PROSE_PAD + '\n')
    doc2B += '~~~bash\n'
    doc2B = fillTo(90_000, doc2B)
    doc2B += 'npm run build\n~~~\n\nAfter closing fence prose.\n'
    const res2B = classifyWithDeterministicRules(makeDoc({ fileName: '2b.md', text: doc2B }))
    expect(res2B.tailEnteredInsideFence).toBe(true)
    expect(res2B.unclosedFenceAtEof).toBe(false)
    expect(res2B.fenceLanguages).toContain('bash')

    // 2C: Unclosed fence at EOF
    let doc2C = '# Draft Code\n\n~~~~ts\n'
    doc2C = fillTo(90_000, doc2C)
    doc2C += 'export const openFence = 1\n'
    const res2C = classifyWithDeterministicRules(makeDoc({ fileName: '2c.md', text: doc2C }))
    expect(res2C.unclosedFenceAtEof).toBe(true)
    expect(res2C.uncertaintyReasons).toContain('unclosed_code_fence')
    expect(res2C.isClutterCandidate).toBe(false)

    // 2D: 4-backtick outer fence containing 3-backtick inner marker
    const doc2D =
      '# Wrapper\n\n````markdown\n```\nStep 1: Should stay fenced\n```\n```\n```\n````\n' +
      NEUTRAL_PROSE_PAD
    const res2D = classifyWithDeterministicRules(makeDoc({ fileName: '2d.md', text: doc2D }))
    expect(res2D.unclosedFenceAtEof).toBe(false)
    expect(res2D.fenceCount).toBe(1)

    // 2E: > 256-char delimiter & info string
    const longOpen = '`'.repeat(300) + ' ' + 'a'.repeat(400) + '\n'
    const longClose = '`'.repeat(300) + ' '.repeat(300) + '\n'
    const doc2E =
      '# Long Fence\n\n' +
      longOpen +
      'Step 1: Inside 300-char fence\n' +
      longClose +
      '\n## Ingredients\n- 2 tbsp butter\n- 1 cup flour\nPreheat oven to 350°F and bake for 20 minutes.\n'
    const res2E = classifyWithDeterministicRules(makeDoc({ fileName: '2e.md', text: doc2E }))
    expect(res2E.unclosedFenceAtEof).toBe(false)
    expect(res2E.purposeLabels).toContain('recipes')
    expect(res2E.purposeLabels).not.toContain('instructions')

    // 2F: Exact lineEnd === tailStart vs lineStart === tailStart
    const targetTailStart = 70_000
    const prefix = 'a'.repeat(targetTailStart - 1) + '\n'
    const fenceAtTailStart = '```ts\n'
    const tailContent =
      'export const x = 1\n```\n' + 'b'.repeat(16_000 - fenceAtTailStart.length - 23)
    const doc2F = prefix + fenceAtTailStart + tailContent
    const scanned2F = scanTextWithFenceContext(doc2F)
    expect(scanned2F.tailRange?.startChar).toBe(targetTailStart)
    expect(scanned2F.tailEnteredInsideFence).toBe(false)
  })

  it('prevents I1 partial head/tail line fragments from becoming false line-start or heading evidence', () => {
    // Build a document > 80,000 chars where a single long line crosses `tailStart` (N - 16,000)
    // and right at `tailStart` the substring begins with `"- [ ] "` or `"Step 1: "` or `"[2026-01-01T00:00:00Z] [INFO] "`.
    const headPad = 'Neutral narrative sentence without structure.\n'.repeat(1500) // ~69,000 chars
    const midPrefix = 'This is the middle of a long paragraph that crosses the tail boundary: '
    // Calculate exact padding so tailStart lands inside the line right before `- [ ]`
    const exactTailAfterLen =
      MAX_INSPECTED_TAIL_CHARS - '- [ ] should not be treated as line-start'.length
    const fillerCount = Math.floor(exactTailAfterLen / 'Neutral trailing line.\n'.length)
    const remainder = exactTailAfterLen - fillerCount * 'Neutral trailing line.\n'.length
    const exactTailAfter =
      '\n' + 'Neutral trailing line.\n'.repeat(fillerCount) + 'x'.repeat(Math.max(0, remainder - 1))
    const docText =
      headPad +
      midPrefix +
      'mid-line-prefix-text-' +
      '- [ ] should not be treated as line-start' +
      exactTailAfter

    const scanned = scanTextWithFenceContext(docText)
    expect(scanned.truncatedForInspection).toBe(true)
    // Verify that the tail fragment starting with `- [ ] ` is NOT in lineStartIntact prose lines
    const intactStartLines = scanned.proseLineEntries
      .filter((e) => !e.partialStart)
      .map((e) => e.text)
    expect(
      intactStartLines.some((l) => l.startsWith('- [ ] should not be treated as line-start'))
    ).toBe(false)

    // Also test I1 at headEnd (64,000): a long line starting with `Ingredients` at char 63,989
    // and continuing past 64,000 with ` of the long prose sentence that continues well past 120 chars...`
    const beforeHeadEnd = 'Neutral narrative line.\n'.repeat(2666) // ~63,984 chars
    const prefixTo64k = beforeHeadEnd.slice(0, MAX_INSPECTED_HEAD_CHARS - 'Ingredients'.length)
    const crossingHeadEnd =
      'Ingredients' +
      ' of this very long prose sentence that continues past the sixty-four thousand character boundary and is definitely not a standalone heading.\n'
    const afterCrossing = 'More neutral prose.\n'.repeat(1000)
    const headTestDoc = prefixTo64k + crossingHeadEnd + afterCrossing
    const headRes = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'head-boundary.md',
        text: headTestDoc + '\n2 tbsp olive oil\n1 cup water\n'
      })
    )
    expect(headRes.purposeLabels).not.toContain('recipes')

    // I1 receipt boundary: partialStart at tailStart must not trigger SUMMARY_TOTAL_LINE_RE
    const receiptTailPad = 'Neutral narrative sentence without structure.\n'.repeat(1500)
    const receiptTailTarget = 'Total: $45.00\nSales Tax $3.60\n'
    const receiptTailAfter =
      'Neutral trailing line.\n'.repeat(
        Math.floor(
          (MAX_INSPECTED_TAIL_CHARS - receiptTailTarget.length) / 'Neutral trailing line.\n'.length
        )
      ) + 'x'.repeat(100)
    const receiptTailDoc =
      receiptTailPad +
      'mid-line-word-prefix-' +
      receiptTailTarget +
      receiptTailAfter.slice(0, MAX_INSPECTED_TAIL_CHARS - receiptTailTarget.length)
    const receiptTailRes = classifyWithDeterministicRules(
      makeDoc({ fileName: 'tail-receipt.txt', extension: '.txt', text: receiptTailDoc })
    )
    expect(receiptTailRes.purposeLabels).not.toContain('receipts')

    // I1 receipt boundary: partialEnd at headEnd must not trigger SUMMARY_TOTAL_LINE_RE
    const receiptHeadPrefix = 'Neutral narrative line.\n'
      .repeat(2666)
      .slice(0, MAX_INSPECTED_HEAD_CHARS - 'Total: $12.34'.length)
    const receiptHeadDoc =
      receiptHeadPrefix +
      'Total: $12.34' +
      '56 per unit across the annual report.\nSales Tax $1.00\n' +
      'More neutral prose.\n'.repeat(1000)
    const receiptHeadRes = classifyWithDeterministicRules(
      makeDoc({ fileName: 'head-receipt.txt', extension: '.txt', text: receiptHeadDoc })
    )
    expect(receiptHeadRes.purposeLabels).not.toContain('receipts')
  })

  it('recognizes procedural headings paired with fenced CLI commands as instructions without promoting clutter', () => {
    // 1. Command-only setup guide (single-signal software repo -> instructions, NOT clutter)
    const cmdOnlyGuide = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/csv-helper/README.md',
        text: '# CSV Helper\n\n## Usage\n```bash\nnpm install csv-helper\nnpm test\n```\n'
      })
    )
    expect(cmdOnlyGuide.purposeLabels).toContain('instructions')
    expect(cmdOnlyGuide.isClutterCandidate).toBe(false)

    // 2. Prose-plus-command guide
    const prosePlusCmd = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'INSTALL.md',
        relativePath: 'Notes/INSTALL.md',
        text: '# Local Setup\n\n## Installation\nPrepare your environment.\n\n```sh\npip install my-tool\npytest\n```\n'
      })
    )
    expect(prosePlusCmd.purposeLabels).toContain('instructions')

    // 3. Quoted example in prose (no fence, no procedural heading) -> NOT instructions
    const quotedExample = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'meeting-notes.md',
        text: '# Project Notes\n\n> Someone mentioned we should run "npm install" before testing the build.\n'
      })
    )
    expect(quotedExample.purposeLabels).not.toContain('instructions')

    // 4. Unrelated code snippet under procedural heading (JSON/TS config, not CLI commands) -> NOT instructions
    const unrelatedSnippet = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'config-ref.md',
        text: '# Service Reference\n\n## Configuration\n```ts\nexport interface PoolConfig {\n  readonly maxWorkers: number\n}\n```\n'
      })
    )
    expect(unrelatedSnippet.purposeLabels).not.toContain('instructions')

    // 5. Personal troubleshooting note with fenced command -> instructions, NOT clutter
    const personalTroubleshoot = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'wifi-reset.md',
        relativePath: 'Household/wifi-reset.md',
        text: '# Living Room Router Reset\n\n## Troubleshooting\nCheck the kitchen gateway.\n\n```bash\nping 192.168.1.1\n```\n'
      })
    )
    expect(personalTroubleshoot.purposeLabels).toContain('instructions')
    expect(personalTroubleshoot.isClutterCandidate).toBe(false)
  })

  it('enforces OCR confidence caps (3A-3E) and multi-reason uncertainty clutter blocking', () => {
    const strongBoilerplateText =
      'SPDX-License-Identifier: MIT\n' +
      'Permission is hereby granted, free of charge, to any person obtaining a copy of the "Software".\n' +
      '```bash\nnpm install\nnpm test\n```\n'

    const c80 = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'LICENSE.txt',
        extension: '.txt',
        textSourceKind: 'ocr',
        ocrMeanConfidence: 80,
        text: strongBoilerplateText
      })
    )
    expect(c80.confidenceBand).toBe('high')
    expect(c80.uncertaintyReasons).not.toContain('ocr_low_confidence')
    expect(c80.isClutterCandidate).toBe(true)

    const c79 = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'LICENSE.txt',
        extension: '.txt',
        textSourceKind: 'ocr',
        ocrMeanConfidence: 79.99,
        text: strongBoilerplateText
      })
    )
    expect(c79.confidenceBand).toBe('medium')
    expect(c79.uncertaintyReasons).toContain('ocr_low_confidence')
    expect(c79.isClutterCandidate).toBe(false)

    const c59 = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'LICENSE.txt',
        extension: '.txt',
        textSourceKind: 'ocr',
        ocrMeanConfidence: 59.99,
        text: strongBoilerplateText
      })
    )
    expect(c59.confidenceBand).toBe('low')
    expect(c59.uncertaintyReasons).toContain('ocr_low_confidence')
    expect(c59.isClutterCandidate).toBe(false)

    const cMissing = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'LICENSE.txt',
        extension: '.txt',
        textSourceKind: 'ocr',
        ocrMeanConfidence: null,
        text: strongBoilerplateText
      })
    )
    expect(cMissing.confidenceBand).toBe('medium')
    expect(cMissing.uncertaintyReasons).toContain('ocr_confidence_missing')
    expect(cMissing.isClutterCandidate).toBe(false)

    // Multi-reason preservation on short + upstream truncated OCR
    const cMulti = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'short.pdf',
        extension: '.pdf',
        textSourceKind: 'ocr',
        ocrMeanConfidence: 50,
        ocrTruncated: true,
        text: 'Short text'
      })
    )
    expect(cMulti.purposeStatus).toBe('unknown')
    expect(cMulti.uncertaintyReasons).toEqual(
      expect.arrayContaining([
        'insufficient_text_length',
        'upstream_truncated_input',
        'ocr_low_confidence'
      ])
    )
    expect(cMulti.isClutterCandidate).toBe(false)
  })

  it('enforces I2 pairwise evidence independence and zero banned corpus literals (4A-4C, 5A-5D)', () => {
    // 4A: "living room" activates only 1 personal family, never 2; mixed-repo sets personal veto without asserting 'personal'
    const livingRoomDoc = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/sensor/README.md',
        text:
          '# Sensor Node\n\nReads temperature in the living room.\n' +
          '```bash\nnpm install\nnpm test\n```\n' +
          'Repository: github.com/example/sensor with package.json.\n'
      })
    )
    expect(livingRoomDoc.originLabels).not.toContain('personal')
    expect(livingRoomDoc.hasPersonalVeto).toBe(true)
    expect(livingRoomDoc.isClutterCandidate).toBe(false)
    expect(livingRoomDoc.uncertaintyReasons).toContain('overlapping_origin_signals')

    // 4B: Isolated single-trigger probes never trigger >= 2 families or clutter
    const singleTriggers = [
      'Total: $12.50',
      '## Ingredients',
      'WHEREAS the parties agree.',
      '- [ ] single checkbox',
      '## Installation',
      '2026-01-01T10:00:00Z [INFO] started pid:1234',
      'End-User License Agreement for Setup Wizard'
    ]
    for (const trigger of singleTriggers) {
      const res = classifyWithDeterministicRules(
        makeDoc({ text: `${trigger}\n${NEUTRAL_PROSE_PAD}` })
      )
      expect(res.isClutterCandidate).toBe(false)
    }

    // 4C & zero fs/network audit on rules.ts
    const rulesSource = readFileSync(
      resolve('src/main/services/documents/classification/rules.ts'),
      'utf8'
    )
    expect(rulesSource).not.toMatch(/node:fs|node:http|node:https|node:net|worker_threads/)
    const bannedLiterals = [
      'pat turkey dry',
      'position the rack',
      'cranberry-orange',
      'hosting plan',
      'descaling guide',
      'notes for our cpa',
      'run robocopy',
      'nonna',
      'parmigiano',
      'bread flour',
      'granulated sugar',
      'canine',
      'rabies',
      'ibuprofen',
      'dry cleaning',
      'library books',
      'steam wand',
      'water tank',
      'KERNEL32.DLL',
      'NamedPipe IPC'
    ]
    for (const literal of bannedLiterals) {
      expect(rulesSource.toLowerCase()).not.toContain(literal.toLowerCase())
    }

    // 5A-5D: Reviewer mixture & clutter-safety regressions
    const todoSummer = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'TODO.md',
        relativePath: 'Notes/TODO.md',
        text: '# Summer Goals\n- [ ] Paint the porch\n- [ ] Fix garden gate\n- [ ] Plan weekend trip\n- [ ] Organize garage\n'
      })
    )
    expect(todoSummer.purposeLabels).toContain('lists')
    expect(todoSummer.isClutterCandidate).toBe(false)

    const printerFenced = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'printer-fix.md',
        text:
          '# Printer Troubleshooting\n\nStep 1: Restart spooler.\nStep 2: Check output.\n\n' +
          '```log\n2026-02-01T12:00:00Z [INFO] spooler pid:4412\n2026-02-01T12:00:01Z [ERROR] timeout pid:4412\n2026-02-01T12:00:02Z [WARN] retry pid:4412\n```\n'
      })
    )
    expect(printerFenced.originLabels).not.toContain('application_system')
    expect(printerFenced.isClutterCandidate).toBe(false)

    const genuineLog = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'daemon.log',
        extension: '.log',
        relativePath: 'AppLogs/daemon.log',
        text:
          '2026-02-01T12:00:00Z [INFO] service started pid:4412\n' +
          '2026-02-01T12:00:01Z [INFO] socket bound pid:4412\n' +
          '2026-02-01T12:00:02Z [WARN] queue high pid:4412\n' +
          '2026-02-01T12:00:03Z [ERROR] write failed pid:4412\n' +
          '2026-02-01T12:00:04Z [INFO] recovered pid:4412\n'
      })
    )
    expect(genuineLog.originLabels).toContain('application_system')
    expect(genuineLog.isClutterCandidate).toBe(true)
  })
})
