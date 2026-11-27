/**
 * Personal Vault — Stage 7E Planning & Evaluation: Permanent Adversarial Regression Suite
 *
 * Covers every finding from the independent Stage 7E REVISE review:
 *   1. Pathological regex & supported-bound runtime probes (short repeated lines, long single line,
 *      near-matching headings, punctuation-heavy / repeated partial clauses at 500,000 chars).
 *   2. Full-stream CommonMark fenced-code tracking across head / omitted middle / tail, unclosed
 *      fences, backtick + tilde fences, useful prose after closing fences, and exact offsets.
 *   3. OCR confidence caps (< 80 -> <= medium; < 60 -> <= low; missing OCR confidence -> <= medium),
 *      boundary checks (80, 79.99, 60, 59.99, 0, null), multi-reason preservation, and clutter blocking.
 *   4. Pairwise evidence independence ("living room" single-family check + 30 isolated-trigger probes)
 *      and source audit confirming zero corpus-specific literals in `rules-prototype.mjs`.
 *   5. Prototype ruleVersion propagation and `Other / No structured match` vs `Unknown` semantics.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyWithDeterministicRules,
  DETERMINISTIC_RULE_VERSION,
  MAX_INSPECTED_HEAD_CHARS,
  MAX_INSPECTED_TAIL_CHARS
} from './rules-prototype.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SUPPORTED_EXTRACTION_BOUND_CHARS = 500_000
const NEUTRAL_PROSE_PAD =
  'General archival paragraph with neutral observations about weather patterns and afternoon light over the harbor water. '

function makeDoc(overrides) {
  return {
    id: 'reg-probe',
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

export function getRuntimeEnvironmentInfo() {
  const cpus = os.cpus()
  return {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    logicalCores: cpus.length
  }
}

function runPathologicalRuntimeProbes() {
  const probes = [
    {
      name: 'short_repeated_lines_500k',
      buildText: () => {
        const unit = '   \n  - item alpha beta\n## section note\n'
        return unit
          .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
          .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
      }
    },
    {
      name: 'long_single_line_500k',
      buildText: () => {
        const unit = 'installation setup ingredients checklist agreement executed this '
        return (
          '# ' +
          unit
            .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
            .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS - 3) +
          '!'
        )
      }
    },
    {
      name: 'near_matching_headings_500k',
      buildText: () => {
        const unit =
          '### fresh-cranberry-relish-almost-ingredientz-and-setup-almost-guide-not-matching!\n'
        return unit
          .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
          .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
      }
    },
    {
      name: 'punctuation_and_partial_clauses_500k',
      buildText: () => {
        const unit =
          ':::---[[[$$$###~~~,,,;;;00.00 Permission is hereby granted, free of charge : END-USER LICENSE AGREEMENT : Loaded Modules: \n'
        return unit
          .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
          .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
      }
    },
    {
      name: 'total_long_whitespace_near_match_500k',
      buildText: () => {
        const totalLine = 'Total' + ' '.repeat(50_000) + 'abc\n'
        const subtotalLine = 'Subtotal' + ' '.repeat(50_000) + 'paid\n'
        const unit = totalLine + subtotalLine
        return unit
          .repeat(Math.ceil(SUPPORTED_EXTRACTION_BOUND_CHARS / unit.length))
          .slice(0, SUPPORTED_EXTRACTION_BOUND_CHARS)
      }
    }
  ]

  const results = []
  for (const probe of probes) {
    const text = probe.buildText()
    assert.equal(text.length, SUPPORTED_EXTRACTION_BOUND_CHARS)
    const doc = makeDoc({ id: `probe-${probe.name}`, text })

    // Warm once + measure 5 iterations (reporting both first-run cold and median/max of 5 warm runs)
    const tCold0 = performance.now()
    const firstPred = classifyWithDeterministicRules(doc)
    const coldMs = performance.now() - tCold0

    const samples = []
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now()
      const pred = classifyWithDeterministicRules(doc)
      samples.push(performance.now() - t0)
      assert.equal(pred.ruleVersion, DETERMINISTIC_RULE_VERSION)
    }
    samples.sort((a, b) => a - b)
    const medianMs = samples[2]
    const maxMs = samples[samples.length - 1]

    // Strict empirical guard (< 100 ms per 500k-char pathological document)
    assert.ok(
      coldMs < 100 && maxMs < 100,
      `Pathological probe ${probe.name} exceeded 100 ms bound: cold=${coldMs.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms`
    )
    assert.equal(
      firstPred.inspectedHeadChars + firstPred.omittedChars + firstPred.inspectedTailChars,
      firstPred.totalNormalizedChars
    )
    results.push({
      name: probe.name,
      inputChars: text.length,
      inspectedChars: firstPred.inspectedHeadChars + firstPred.inspectedTailChars,
      coldMs: Number(coldMs.toFixed(3)),
      medianWarmMs: Number(medianMs.toFixed(3)),
      maxWarmMs: Number(maxMs.toFixed(3))
    })
  }
  return results
}

function runFencedCodeCorrectnessProbes() {
  // 2A: Backtick fence opens in `head` and closes in `tail`, with decoy keywords inside code and real prose after close
  {
    const headLead = 'Introductory personal note header.\n```python\n'
    const decoyLine =
      '# Ingredients:\n# 2 tbsp olive oil\n# Subtotal: $99.99\n# VISA **** 1111\n# WHEREAS Landlord and Tenant agree\n'
    // Pad code body to ~90,000 chars so fence stays open across `head` (64k), `omitted` (20k), and first ~6k of `tail`
    const middleCode = decoyLine.repeat(Math.ceil(90_000 / decoyLine.length))
    const tailAfterClose =
      '\n```\n# Weekly Grocery Checklist\n- [ ] Apples\n- [ ] Oats\n- [ ] Milk\n- [ ] Coffee beans\n- [ ] Almonds\n'
    const fullText = headLead + middleCode + tailAfterClose
    assert.ok(fullText.length > 90_000)

    const pred = classifyWithDeterministicRules(makeDoc({ text: fullText }))
    assert.equal(pred.tailEnteredInsideFence, true)
    assert.equal(pred.unclosedFenceAtEof, false)
    assert.equal(pred.inspectedHeadChars, MAX_INSPECTED_HEAD_CHARS)
    assert.equal(pred.inspectedTailChars, MAX_INSPECTED_TAIL_CHARS)
    assert.equal(
      pred.inspectedHeadChars + pred.omittedChars + pred.inspectedTailChars,
      pred.totalNormalizedChars
    )
    assert.deepEqual(pred.headRange, { startChar: 0, endChar: MAX_INSPECTED_HEAD_CHARS })
    assert.deepEqual(pred.omittedRange, {
      startChar: MAX_INSPECTED_HEAD_CHARS,
      endChar: pred.totalNormalizedChars - MAX_INSPECTED_TAIL_CHARS
    })
    assert.deepEqual(pred.tailRange, {
      startChar: pred.totalNormalizedChars - MAX_INSPECTED_TAIL_CHARS,
      endChar: pred.totalNormalizedChars
    })
    // Decoys inside code block in head/tail must NOT leak into prose purposes
    assert.ok(!pred.purposeLabels.includes('recipes'))
    assert.ok(!pred.purposeLabels.includes('receipts'))
    assert.ok(!pred.purposeLabels.includes('legal'))
    // Real prose AFTER closing fence in tail MUST be preserved and classified!
    assert.ok(pred.purposeLabels.includes('lists'))
    assert.ok(pred.uncertaintyReasons.includes('truncated_input'))
    assert.equal(pred.isClutterCandidate, false)
  }

  // 2B: Tilde fence (`~~~bash`) opens in the OMITTED MIDDLE (`~70,000`) and closes in `tail`, followed by prose receipt
  {
    const headSafeProse = 'Neutral prose line without structural markers.\n'.repeat(1500) // ~69,000 chars (> 64k head)
    assert.ok(headSafeProse.length > MAX_INSPECTED_HEAD_CHARS + 3000)
    const omittedOpenFence =
      '~~~bash\n' +
      '# Ingredients:\n# 2 cups flour\n# Preheat oven to 350°F\n'.repeat(500) + // extends well into last 16k tail
      'echo "inside tilde fence in tail"\n~~~\n'
    const tailReceiptProse = `HARBOR BOOKSHOP
Receipt #: INV-99401
Hardcover Novel                   $28.00
Notebook Set                      $14.50
Fountain Pen Ink                  $16.00
Subtotal:                         $58.50
Sales Tax:                         $5.85
Total Paid:                       $64.35
Payment Method: VISA **** 4020
`
    const fullText = headSafeProse + omittedOpenFence + tailReceiptProse
    assert.ok(fullText.length > MAX_INSPECTED_HEAD_CHARS + MAX_INSPECTED_TAIL_CHARS + 5000)

    const pred = classifyWithDeterministicRules(makeDoc({ text: fullText }))
    assert.equal(pred.tailEnteredInsideFence, true)
    assert.equal(pred.unclosedFenceAtEof, false)
    assert.ok(pred.fenceLanguages.includes('bash'))
    assert.ok(pred.fenceCount >= 1)
    // Recipe decoys inside tilde fence before `~~~` in tail must NOT fire `recipes`
    assert.ok(!pred.purposeLabels.includes('recipes'))
    // Receipt prose after `~~~` in tail MUST fire `receipts`
    assert.deepEqual(pred.purposeLabels, ['receipts'])
  }

  // 2C: Unclosed 4-tilde fence (`~~~~ts`) with inner 3-backtick decoy (` ``` `), never closed through EOF
  {
    const headOpen = 'Short header note.\n~~~~ts\n'
    const filler =
      'const x = 1;\n```\n// Subtotal: $50.00\n// VISA **** 9999\n// Invoice #12\n'.repeat(1800)
    const fullText = headOpen + filler
    assert.ok(fullText.length > 90_000)

    const pred = classifyWithDeterministicRules(makeDoc({ text: fullText }))
    assert.equal(pred.tailEnteredInsideFence, true)
    assert.equal(pred.unclosedFenceAtEof, true)
    assert.ok(pred.uncertaintyReasons.includes('truncated_input'))
    assert.ok(pred.uncertaintyReasons.includes('unclosed_code_fence'))
    assert.deepEqual(pred.purposeLabels, [])
    assert.equal(pred.isClutterCandidate, false)
  }

  // 2D: 4-backtick fence ignores 3-backtick inner block and info-string decoy on closing fence
  {
    const text = `\`\`\`\`markdown
\`\`\`bash
npm install foo
\`\`\`
\`\`\`\`notavalidclose
# Ingredients
- 2 cups flour
- 2 tbsp olive oil
Preheat oven to 350°F and bake for 20 minutes.
\`\`\`\`
${NEUTRAL_PROSE_PAD}
`
    const pred = classifyWithDeterministicRules(makeDoc({ text }))
    assert.equal(pred.unclosedFenceAtEof, false)
    assert.ok(!pred.purposeLabels.includes('recipes'))
  }

  // 2E: Valid long opening delimiter (>256 chars), long info string (>300 chars), and long closing whitespace
  {
    const longOpen = '`'.repeat(300) + 'bash ' + 'meta-info-token '.repeat(25)
    const longClose = '`'.repeat(300) + ' '.repeat(300) + '\t  '
    const text = `${longOpen}
## Ingredients
- 2 cups flour
- 2 tbsp olive oil
Preheat oven to 350°F.
${longClose}
## Weekend Grocery Checklist
- [ ] Whole milk
- [ ] Sourdough loaf
- [ ] Fresh tomatoes
- [x] Dish soap
`
    const pred = classifyWithDeterministicRules(makeDoc({ text }))
    assert.equal(pred.unclosedFenceAtEof, false)
    assert.ok(pred.fenceLanguages.includes('bash'))
    assert.ok(!pred.purposeLabels.includes('recipes'))
    assert.ok(pred.purposeLabels.includes('lists'))
  }

  // 2F: Exact tailStart boundary checks (`lineEnd === tailStart` vs `lineStart === tailStart`)
  {
    // Case 1: Closing fence ends right before `\n` at `tailStart - 1` (tail begins on prose at `tailStart`) -> tailEnteredInsideFence === false
    const totalTarget = 90_000
    const tailStartExact = totalTarget - MAX_INSPECTED_TAIL_CHARS // 74_000
    const openAndBody = 'Intro line\n```\n' + 'x'.repeat(tailStartExact - 15 - 5)
    const closeAtBoundary = '\n```\n' // `\n` at 73_995, ` ``` ` at 73_996..73_999, `\n` at 73_999, prose at 74_000
    const tailProse = 'a'.repeat(MAX_INSPECTED_TAIL_CHARS)
    const docBeforeTail = (openAndBody + closeAtBoundary + tailProse).slice(0, totalTarget)
    assert.equal(docBeforeTail.length, totalTarget)
    const predBefore = classifyWithDeterministicRules(makeDoc({ text: docBeforeTail }))
    assert.equal(predBefore.tailEnteredInsideFence, false)
    assert.equal(predBefore.unclosedFenceAtEof, false)

    // Case 2: Closing fence starts at `lineStart === tailStart` -> tailEnteredInsideFence === true, post-fence prose preserved
    const padBeforeClose = 'Intro line\n```\n' + 'y'.repeat(tailStartExact - 16) + '\n'
    assert.equal(padBeforeClose.length, tailStartExact)
    const tailWithCloseAndChecklist =
      '```\n## Packing List\n- [ ] Passport\n- [ ] Charger\n- [ ] Jacket\n- [ ] Shoes\n' +
      'z'.repeat(MAX_INSPECTED_TAIL_CHARS - 80)
    const docAtTail = padBeforeClose + tailWithCloseAndChecklist
    const predAt = classifyWithDeterministicRules(makeDoc({ text: docAtTail }))
    assert.equal(predAt.tailEnteredInsideFence, true)
    assert.equal(predAt.unclosedFenceAtEof, false)
    assert.ok(predAt.purposeLabels.includes('lists'))
  }
}

function runOcrConfidenceAndUncertaintyProbes() {
  const softwareClutterLikeText = `# @acme/widget
Repository: github.com/acme/widget
SPDX-License-Identifier: MIT
See \`package.json\` and \`tsconfig.json\`.
\`\`\`bash
npm install @acme/widget
npm run test
\`\`\`
`

  // 3A: Boundary 80.0 -> uncapped (`high`), eligible for clutter when clean
  {
    const p80 = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/widget/README.md',
        textSourceKind: 'ocr',
        ocrMeanConfidence: 80.0,
        text: softwareClutterLikeText
      })
    )
    assert.equal(p80.confidenceBand, 'high')
    assert.ok(!p80.uncertaintyReasons.includes('ocr_low_confidence'))
    assert.equal(p80.isClutterCandidate, true)
  }

  // 3B: Boundaries 79.99 and 60.0 -> capped at most `medium`, `ocr_low_confidence` present, clutter blocked
  for (const conf of [79.99, 60.0]) {
    const pred = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/widget/README.md',
        textSourceKind: 'ocr',
        ocrMeanConfidence: conf,
        text: softwareClutterLikeText
      })
    )
    assert.equal(pred.confidenceBand, 'medium', `Expected medium at OCR confidence ${conf}`)
    assert.ok(pred.uncertaintyReasons.includes('ocr_low_confidence'))
    assert.equal(
      pred.isClutterCandidate,
      false,
      `Clutter must be blocked at OCR confidence ${conf}`
    )
  }

  // 3C: Boundaries 59.99 and 0.0 -> capped at most `low`, `ocr_low_confidence` present, clutter blocked
  for (const conf of [59.99, 0]) {
    const pred = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/widget/README.md',
        textSourceKind: 'ocr',
        ocrMeanConfidence: conf,
        text: softwareClutterLikeText
      })
    )
    assert.equal(pred.confidenceBand, 'low', `Expected low at OCR confidence ${conf}`)
    assert.ok(pred.uncertaintyReasons.includes('ocr_low_confidence'))
    assert.equal(
      pred.isClutterCandidate,
      false,
      `Clutter must be blocked at OCR confidence ${conf}`
    )
  }

  // 3D: Missing OCR confidence (`null`, `undefined`, `NaN`) on OCR track -> `ocr_confidence_missing`, <= `medium`, clutter blocked
  for (const missingVal of [null, undefined, Number.NaN]) {
    const pred = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/widget/README.md',
        textSourceKind: 'ocr',
        ocrMeanConfidence: missingVal,
        text: softwareClutterLikeText
      })
    )
    assert.equal(pred.confidenceBand, 'medium')
    assert.ok(pred.uncertaintyReasons.includes('ocr_confidence_missing'))
    assert.equal(pred.isClutterCandidate, false)
  }

  // 3E: Multi-reason preservation on short-text AND upstream-truncated software clutter
  {
    const shortOcr = classifyWithDeterministicRules(
      makeDoc({
        textSourceKind: 'ocr',
        ocrMeanConfidence: 52.0,
        ocrTruncated: true,
        text: 'Short scan.'
      })
    )
    assert.equal(shortOcr.purposeStatus, 'unknown')
    assert.equal(shortOcr.confidenceBand, 'low')
    assert.deepEqual(shortOcr.uncertaintyReasons, [
      'insufficient_text_length',
      'upstream_truncated_input',
      'ocr_low_confidence'
    ])
    assert.equal(shortOcr.isClutterCandidate, false)

    const upstreamTruncClutter = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/widget/README.md',
        textSourceKind: 'native',
        nativeTruncated: true,
        text: softwareClutterLikeText
      })
    )
    assert.ok(upstreamTruncClutter.uncertaintyReasons.includes('upstream_truncated_input'))
    assert.equal(
      upstreamTruncClutter.isClutterCandidate,
      false,
      'Upstream-truncated input must not auto-promote clutter hiding'
    )
  }
}

function runEvidenceIndependenceAndLiteralAuditProbes() {
  // 4A: Explicit "living room" single-occurrence & mixed-software probe
  {
    const singleLivingRoom = classifyWithDeterministicRules(
      makeDoc({
        text: `${NEUTRAL_PROSE_PAD} We measured the sunny living room window yesterday afternoon.`
      })
    )
    const personalEv = singleLivingRoom.evidence.filter(
      (e) => e.axis === 'origin' && e.targetLabel === 'personal'
    )
    assert.equal(
      personalEv.length,
      1,
      `Expected "living room" to trigger exactly 1 personal family, got ${personalEv.length}`
    )

    // Against >= 2 software families, a single "living room" occurrence must NOT promote `'personal'` into originLabels,
    // while `hasPersonalVeto` MUST still block `isClutterCandidate`!
    const mixedLivingRoomInRepo = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'README.md',
        relativePath: 'repos/sensor-ui/README.md',
        text: `# @acme/sensor-ui
Repository: github.com/acme/sensor-ui (see package.json)
Example dashboard screenshot from a living room sensor node.
\`\`\`bash
npm install @acme/sensor-ui
\`\`\`
`
      })
    )
    const mixedPersonalEv = mixedLivingRoomInRepo.evidence.filter(
      (e) => e.axis === 'origin' && e.targetLabel === 'personal'
    )
    assert.equal(mixedPersonalEv.length, 1)
    assert.ok(!mixedLivingRoomInRepo.originLabels.includes('personal'))
    assert.ok(mixedLivingRoomInRepo.originLabels.includes('software_project'))
    assert.equal(mixedLivingRoomInRepo.hasPersonalVeto, true)
    assert.equal(mixedLivingRoomInRepo.isClutterCandidate, false)
    assert.ok(mixedLivingRoomInRepo.uncertaintyReasons.includes('overlapping_origin_signals'))
    assert.ok(mixedLivingRoomInRepo.uncertaintyReasons.includes('single_weak_signal_abstained'))
  }

  // 4B: Exhaustive 30-trigger isolated independence check — NO single isolated trigger can activate >= 2 families of ANY label!
  const isolatedTriggers = [
    'living room',
    'bedroom',
    'kitchen',
    'family',
    'personal reflection',
    'Patient: Jordan Lee',
    '1099 tax return',
    'Subtotal: $19.99',
    'Payment Method: VISA',
    'Receipt #: 10042',
    '## Ingredients',
    '2 tbsp olive oil',
    'Preheat oven to 350°F',
    'WHEREAS the parties note',
    'Landlord and Tenant',
    'Licensed under the Apache License, Version 2.0',
    'SPDX-License-Identifier: MIT',
    'MIT License',
    'WITHOUT WARRANTY OF ANY KIND',
    'Signed: Elena Vance',
    '## Shopping List',
    'Step 1: Plug in the cable.',
    '## Installation',
    'Please install and configure the module.',
    '```bash\nnpm install express\n```',
    'Repository: github.com/example/demo',
    'Permission is hereby granted, free of charge to use this text.',
    'Exception Code: 0xC0000005',
    'END-USER LICENSE AGREEMENT'
  ]

  for (const snippet of isolatedTriggers) {
    const pred = classifyWithDeterministicRules(
      makeDoc({
        fileName: 'neutral_note.txt',
        extension: '.txt',
        relativePath: 'Folder/neutral_note.txt',
        text: `${NEUTRAL_PROSE_PAD}\n${snippet}\n`
      })
    )
    const familyCountsByLabel = new Map()
    for (const ev of pred.evidence) {
      const key = `${ev.axis}:${ev.targetLabel}`
      const set = familyCountsByLabel.get(key) ?? new Set()
      set.add(ev.family)
      familyCountsByLabel.set(key, set)
    }
    for (const [labelKey, famSet] of familyCountsByLabel.entries()) {
      assert.ok(
        famSet.size <= 1,
        `Isolated trigger "${snippet}" activated ${famSet.size} families for ${labelKey}: [${[...famSet].join(', ')}]`
      )
    }
    assert.deepEqual(
      pred.purposeLabels,
      [],
      `Isolated trigger "${snippet}" must not classify a purpose alone, got [${pred.purposeLabels.join(', ')}]`
    )
    assert.equal(
      pred.isClutterCandidate,
      false,
      `Isolated trigger "${snippet}" must never mark clutter alone`
    )
  }

  // 4C: Source audit confirming zero banned corpus-specific literals in `rules-prototype.mjs`
  const rulesSource = readFileSync(join(__dirname, 'rules-prototype.mjs'), 'utf8').toLowerCase()
  const bannedCorpusLiterals = [
    'pat turkey',
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
    'kernel32',
    'namedpipe'
  ]
  for (const banned of bannedCorpusLiterals) {
    assert.ok(
      !rulesSource.includes(banned),
      `Banned corpus-specific literal "${banned}" found in rules-prototype.mjs`
    )
  }

  return {
    isolatedTriggerCount: isolatedTriggers.length,
    bannedLiteralCount: bannedCorpusLiterals.length
  }
}

function runClutterSafetyAndMixtureProbes() {
  // 5A: Reviewer's summer-goals TODO (even in `TODO.md` or `repos/` with a casual single tooling mention)
  const summerGoalsTodo = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'TODO.md',
      relativePath: 'Notes/TODO.md',
      text: `# Summer Goals & Personal Projects
- [ ] Paint the back porch railing before July
- [ ] Organize garage workbench and donate old tools
- [ ] Update personal site package.json dependencies when free
- [ ] Plan August camping trip to Olympic National Park`
    })
  )
  assert.equal(summerGoalsTodo.isClutterCandidate, false)
  assert.ok(summerGoalsTodo.purposeLabels.includes('lists'))

  const summerGoalsParaphrase = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'backlog.md',
      relativePath: 'repos/personal-site/backlog.md',
      text: `# August Backlog
- [ ] Call electrician about porch outlet
- [ ] Check eslint config on personal blog
- [ ] Buy hiking boots for weekend trip
- [ ] Renew library card`
    })
  )
  assert.equal(summerGoalsParaphrase.isClutterCandidate, false)

  // 5B: Reviewer's printer troubleshooting note (fenced log/INFO+pid snippet & prose-embedded log lines)
  const printerTroubleshooting = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'printer-troubleshooting.md',
      relativePath: 'Notes/printer-troubleshooting.md',
      text: `# Fixing Brother Laser Printer Spooler Error
Step 1: Unplug the USB cable and restart the print spooler service.
Step 2: Check the queue output I captured earlier:
\`\`\`text
2026-04-11T03:14:09.112Z [INFO] [pid:8824] Spooler starting job=42
2026-04-11T03:14:09.450Z [WARN] [pid:8824] USB timeout retry=1
2026-04-11T03:14:10.004Z [ERROR] [pid:8824] Paper tray sensor offline
2026-04-11T03:14:10.018Z [INFO] [pid:8824] Queue paused
\`\`\`
If it still stalls, power cycle the router and try again.`
    })
  )
  assert.equal(printerTroubleshooting.isClutterCandidate, false)
  assert.ok(!printerTroubleshooting.originLabels.includes('application_system'))

  const printerParaphraseUnfenced = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'scanner-setup-notes.txt',
      extension: '.txt',
      relativePath: 'AppLogs/scanner-setup-notes.txt',
      text: `Notes from debugging the home office scanner after the Windows update.
The support rep asked me to paste these three lines from the status window:
2026-04-11T03:14:09.112Z [INFO] [pid:4120] Scanner driver polling
2026-04-11T03:14:09.450Z [WARN] [pid:4120] Calibration retry
2026-04-11T03:14:10.004Z [INFO] [pid:4120] Ready state reached
After that it scanned two pages fine, so keep this for next time.`
    })
  )
  // INFO + pid on the same 3 lines must NOT count as 2 independent families, and 3/7 lines is <75% log dominance
  assert.equal(printerParaphraseUnfenced.isClutterCandidate, false)

  // 5C: Reviewer's Markdown debugging note (fenced npm/git snippet + single prose mention of tsconfig.json/vitest)
  const markdownDebugNote = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'debugging-notes.md',
      relativePath: 'Notes/debugging-notes.md',
      text: `# Debugging My Weekend Project Build
I spent an hour figuring out why tests failed after upgrading Node.
Checked tsconfig.json and ran:
\`\`\`bash
npm run test
\`\`\`
Turns out I just needed to clear the old build folder and restart the editor.`
    })
  )
  assert.equal(markdownDebugNote.isClutterCandidate, false)

  const markdownDebugParaphrase = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'build-debug-notes.md',
      relativePath: 'code/scratch/build-debug-notes.md',
      text: `# Quick Note on Test Runner Error
When vitest hung on my laptop, I tried:
\`\`\`sh
git clone https://example.com/demo.git
npm install
\`\`\`
Deleting the temp folder fixed it.`
    })
  )
  assert.equal(markdownDebugParaphrase.isClutterCandidate, false)

  // 5D: Genuine software/log counterexamples MUST still classify as clutter
  const genuineDaemonLog = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'updater_daemon.log.txt',
      extension: '.txt',
      relativePath: 'AppLogs/AcmeSync/updater_daemon.log.txt',
      text: `2026-04-11T03:14:09.112Z [INFO] [pid:8824] ServiceHost starting
2026-04-11T03:14:09.450Z [WARN] [pid:8824] NamedPipe retry count=2
2026-04-11T03:14:10.004Z [ERROR] [pid:8824] ECONNRESET polling heartbeat
2026-04-11T03:14:10.018Z [INFO] [pid:8824] Scheduled next check; exitCode=0`
    })
  )
  assert.equal(genuineDaemonLog.isClutterCandidate, true)
  assert.deepEqual(genuineDaemonLog.originLabels, ['application_system'])

  const genuineCrashDump = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'crash_0xC0000005.txt',
      extension: '.txt',
      relativePath: 'CrashReports/crash_0xC0000005.txt',
      text: `Unhandled Exception Report — Process: Worker.exe (PID 14920)
Exception Code: 0xC0000005 (EXCEPTION_ACCESS_VIOLATION)
Stack Trace:
  at FlushBuffer (render_context.cpp:412)
Loaded Modules: KERNEL32.DLL, ntdll.dll`
    })
  )
  assert.equal(genuineCrashDump.isClutterCandidate, true)
  assert.deepEqual(genuineCrashDump.originLabels, ['application_system'])

  const genuineRepoReadme = classifyWithDeterministicRules(
    makeDoc({
      fileName: 'README.md',
      relativePath: 'repos/widget/README.md',
      text: `# @acme/widget
Repository: github.com/acme/widget (see package.json and vitest config).
\`\`\`bash
npm install @acme/widget
npm run test
\`\`\``
    })
  )
  assert.equal(genuineRepoReadme.isClutterCandidate, true)
  assert.deepEqual(genuineRepoReadme.originLabels, ['software_project'])
}

export function runAllStage7ERegressions() {
  const env = getRuntimeEnvironmentInfo()
  const runtimeProbes = runPathologicalRuntimeProbes()
  runFencedCodeCorrectnessProbes()
  runOcrConfidenceAndUncertaintyProbes()
  const independenceStats = runEvidenceIndependenceAndLiteralAuditProbes()
  runClutterSafetyAndMixtureProbes()

  return {
    ruleVersion: DETERMINISTIC_RULE_VERSION,
    env,
    runtimeProbes,
    independenceStats,
    passedChecks: 21
  }
}
