/**
 * Personal Vault — Stage 7E Planning & Evaluation: Conservative Deterministic Classifier Prototype
 *
 * Prototype Version: `doc_classify_rules_v1_rev4_eval`
 *
 * Principles & review-finding guarantees enforced:
 * 1. Never classifies from filename/path when no readable extracted/OCR text exists (`unknown`).
 * 2. Full-stream CommonMark fence state tracking (` ``` ` and `~~~`, length-matched, info-string rules)
 *    across the entire available text BEFORE head/tail range selection (`[0, 64_000)` + `[-16_000]`),
 *    preserving active fence state across the omitted middle without resetting `tail` to prose.
 * 3. Line-oriented heading parsing and horizontal-whitespace (`[ \t]`) phrase patterns with zero
 *    multiline-spanning `^\s*`, `[\w\s]*`, or `[\s\S]{...}` backtracking constructs.
 * 4. Strict evidence independence: pairwise-disjoint signal families verified so no single phrase
 *    or line occurrence can establish >= 2 families for any purpose or origin label; zero
 *    corpus-specific literals.
 * 5. Enforced OCR confidence caps (`< 80` -> at most `'medium'`; `< 60` -> at most `'low'`;
 *    missing OCR confidence -> `'ocr_confidence_missing'` + at most `'medium'`), non-overwriting
 *    `uncertaintyReasons[]` across all return paths, and strict blocking of `isClutterCandidate`
 *    whenever any input/origin uncertainty is present.
 */

export const DETERMINISTIC_RULE_VERSION = 'doc_classify_rules_v1_rev4_eval'
export const MAX_INSPECTED_HEAD_CHARS = 64_000
export const MAX_INSPECTED_TAIL_CHARS = 16_000
export const MIN_SUBSTANTIVE_PROSE_CHARS = 80
const MAX_HEADING_LINE_CHARS = 120

export const DISQUALIFYING_CLUTTER_UNCERTAINTIES = new Set([
  'no_extracted_text',
  'insufficient_text_length',
  'truncated_input',
  'upstream_truncated_input',
  'unclosed_code_fence',
  'ocr_low_confidence',
  'ocr_confidence_missing',
  'overlapping_origin_signals'
])

/**
 * Checks whether a single physical line (without `\n`) is a CommonMark opening or closing code fence.
 * Uses linear character-code scanning (no backtracking regexes, no artificial 256-char truncation).
 */
function parseFenceDelimiterLine(rawText, lineStart, lineEnd, activeFence) {
  const lineLen = lineEnd - lineStart
  if (lineLen < 3) {
    return null
  }

  // CommonMark allows 0..3 leading spaces before fence markers
  let pos = lineStart
  let leadingSpaces = 0
  while (pos < lineEnd && rawText.charCodeAt(pos) === 32 && leadingSpaces < 4) {
    pos += 1
    leadingSpaces += 1
  }
  if (leadingSpaces > 3 || pos >= lineEnd) {
    return null
  }

  const firstCode = rawText.charCodeAt(pos)
  if (firstCode !== 96 /* ` */ && firstCode !== 126 /* ~ */) {
    return null
  }
  const markerChar = firstCode === 96 ? '`' : '~'

  let runEnd = pos
  while (runEnd < lineEnd && rawText.charCodeAt(runEnd) === firstCode) {
    runEnd += 1
  }
  const markerLen = runEnd - pos
  if (markerLen < 3) {
    return null
  }

  if (activeFence === null) {
    // Backtick fence info strings cannot contain backticks per CommonMark
    if (markerChar === '`') {
      const btIdx = rawText.indexOf('`', runEnd)
      if (btIdx !== -1 && btIdx < lineEnd) {
        return null
      }
    }
    let infoStart = runEnd
    while (infoStart < lineEnd) {
      const ch = rawText.charCodeAt(infoStart)
      if (ch !== 32 && ch !== 9) break
      infoStart += 1
    }
    let lang = null
    if (infoStart < lineEnd) {
      const langSlice = rawText.slice(infoStart, Math.min(lineEnd, infoStart + 33))
      const langMatch = /^[A-Za-z0-9_+-]{1,32}/.exec(langSlice)
      if (langMatch) {
        lang = langMatch[0].toLowerCase()
      }
    }
    return { kind: 'open', markerChar, markerLen, lang }
  }

  // Closing fence must match markerChar, have >= opening markerLen, and carry only optional spaces/tabs
  if (markerChar === activeFence.markerChar && markerLen >= activeFence.markerLen) {
    for (let i = runEnd; i < lineEnd; i += 1) {
      const ch = rawText.charCodeAt(i)
      if (ch !== 32 && ch !== 9) {
        return null
      }
    }
    return { kind: 'close' }
  }

  return null
}

/**
 * Scans the full normalized text line-by-line to track exact fenced-code state across
 * `[0, headEnd)`, the omitted middle `[headEnd, tailStart)`, and `[tailStart, totalChars)`.
 * Never resets `tail` to prose when a fence opened in `head` or in the omitted middle.
 */
export function scanTextWithFenceContext(rawText, doc = {}) {
  const normalized = rawText.replace(/\r\n?/g, '\n').trim()
  const totalNormalizedChars = normalized.length
  const upstreamTruncated = Boolean(doc.nativeTruncated || doc.ocrTruncated)
  const maxCombined = MAX_INSPECTED_HEAD_CHARS + MAX_INSPECTED_TAIL_CHARS

  const truncatedForInspection = totalNormalizedChars > maxCombined
  const headStart = 0
  const headEnd = truncatedForInspection ? MAX_INSPECTED_HEAD_CHARS : totalNormalizedChars
  const tailStart = truncatedForInspection
    ? totalNormalizedChars - MAX_INSPECTED_TAIL_CHARS
    : totalNormalizedChars
  const tailEnd = totalNormalizedChars

  const inspectedHeadChars = headEnd - headStart
  const inspectedTailChars = tailEnd - tailStart
  const omittedChars = truncatedForInspection ? tailStart - headEnd : 0

  const proseLines = []
  const fencedLines = []
  const fenceLanguages = new Set()
  let fenceCount = 0
  let fencedLineCount = 0
  let activeFence = null
  let tailEnteredInsideFence = false
  let recordedTailEntry = !truncatedForInspection

  let lineStart = 0
  while (lineStart <= totalNormalizedChars) {
    const nlIdx = normalized.indexOf('\n', lineStart)
    const lineEnd = nlIdx === -1 ? totalNormalizedChars : nlIdx

    const overlapsHead = lineStart < headEnd && lineEnd > headStart
    const overlapsTail = truncatedForInspection && lineStart < tailEnd && lineEnd > tailStart

    if (!recordedTailEntry && truncatedForInspection && lineEnd > tailStart) {
      tailEnteredInsideFence = activeFence !== null
      recordedTailEntry = true
    }

    const delim = parseFenceDelimiterLine(normalized, lineStart, lineEnd, activeFence)
    if (delim !== null) {
      if (delim.kind === 'open') {
        const countedInInspected = overlapsHead || overlapsTail
        activeFence = {
          markerChar: delim.markerChar,
          markerLen: delim.markerLen,
          lang: delim.lang,
          countedInInspected
        }
        if (countedInInspected) {
          fenceCount += 1
          if (delim.lang) fenceLanguages.add(delim.lang)
        }
      } else if (delim.kind === 'close') {
        if (activeFence && !activeFence.countedInInspected && (overlapsHead || overlapsTail)) {
          activeFence.countedInInspected = true
          fenceCount += 1
          if (activeFence.lang) fenceLanguages.add(activeFence.lang)
        }
        activeFence = null
      }
    } else {
      if (overlapsHead) {
        const seg = normalized.slice(Math.max(lineStart, headStart), Math.min(lineEnd, headEnd))
        if (activeFence !== null) {
          fencedLines.push(seg)
          fencedLineCount += 1
        } else {
          proseLines.push(seg)
        }
      }
      if (overlapsTail) {
        const seg = normalized.slice(Math.max(lineStart, tailStart), Math.min(lineEnd, tailEnd))
        if (activeFence !== null) {
          if (!activeFence.countedInInspected) {
            activeFence.countedInInspected = true
            fenceCount += 1
            if (activeFence.lang) fenceLanguages.add(activeFence.lang)
          }
          fencedLines.push(seg)
          fencedLineCount += 1
        } else {
          proseLines.push(seg)
        }
      }
    }

    if (nlIdx === -1) {
      break
    }
    lineStart = nlIdx + 1
  }

  const headText = normalized.slice(headStart, headEnd)
  const tailText = truncatedForInspection ? normalized.slice(tailStart, tailEnd) : ''
  const inspectedText = tailText ? `${headText}\n${tailText}` : headText

  return {
    totalNormalizedChars,
    inspectedText,
    proseText: proseLines.join('\n'),
    proseLines,
    fencedText: fencedLines.join('\n'),
    fencedLines,
    fenceCount,
    fencedLineCount,
    fenceLanguages: [...fenceLanguages],
    tailEnteredInsideFence,
    unclosedFenceAtEof: activeFence !== null,
    inspectedHeadChars,
    inspectedTailChars,
    omittedChars,
    headRange: { startChar: headStart, endChar: headEnd },
    omittedRange: truncatedForInspection ? { startChar: headEnd, endChar: tailStart } : null,
    tailRange: truncatedForInspection ? { startChar: tailStart, endChar: tailEnd } : null,
    truncatedForInspection,
    upstreamTruncated
  }
}

/**
 * Normalizes a candidate standalone heading line in O(1) bounded space (`<= 120` chars).
 * Returns `null` for long body lines or empty lines.
 */
function normalizeHeadingLine(line) {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_HEADING_LINE_CHARS) {
    return null
  }
  // Reject list items (`- `, `* `, `1. `) so list items are not mistaken for section headings
  if (/^(?:[-*•]|\d+[.)])[ \t]/.test(trimmed)) {
    return null
  }
  const hasHashPrefix = /^#{1,6}[ \t]+/.test(trimmed)
  // Without `#`, reject ordinary prose sentences ending in `.` or key-value lines with mid-line `:`
  if (!hasHashPrefix) {
    if (trimmed.endsWith('.')) {
      return null
    }
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx !== -1 && colonIdx < trimmed.length - 1) {
      return null
    }
  }
  const withoutHashes = trimmed.replace(/^#{1,6}[ \t]+/, '').replace(/:[ \t]*$/, '')
  const collapsed = withoutHashes
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase()
  return collapsed.length > 0 ? { normalizedHeading: collapsed, hasHashPrefix } : null
}

function evaluateOcrConfidenceState(doc) {
  if (doc.textSourceKind !== 'ocr') {
    return {
      isOcrTrack: false,
      isOcrConfidenceMissing: false,
      isOcrBelow80: false,
      isOcrBelow60: false
    }
  }
  const conf = doc.ocrMeanConfidence
  if (conf === null || conf === undefined || typeof conf !== 'number' || !Number.isFinite(conf)) {
    return {
      isOcrTrack: true,
      isOcrConfidenceMissing: true,
      isOcrBelow80: false,
      isOcrBelow60: false
    }
  }
  return {
    isOcrTrack: true,
    isOcrConfidenceMissing: false,
    isOcrBelow80: conf < 80,
    isOcrBelow60: conf < 60
  }
}

function applyOcrConfidenceCap(baseBand, ocrState) {
  let band = baseBand
  if (ocrState.isOcrBelow60) {
    return 'low'
  }
  if ((ocrState.isOcrBelow80 || ocrState.isOcrConfidenceMissing) && band === 'high') {
    band = 'medium'
  }
  return band
}

function countDistinctMatches(text, patterns) {
  let count = 0
  for (const re of patterns) {
    if (re.test(text)) count += 1
  }
  return count
}

const SUMMARY_TOTAL_LINE_RE =
  /\b(?:sub[ \t]*t[o0]tal|t[o0]tal(?:[ \t]+(?:paid|due|amount))?|balance[ \t]+due|amount[ \t]+(?:paid|due)|co-?pay(?:[ \t]+paid)?)(?:[ \t]*:[ \t]*\$?|[ \t]+\$?|\$)\d{1,3}(?:,\d{3})*\.\d{2}\b/i

const ITEMIZED_PRICE_LINE_RE = /(?:\$[ \t]*\d{1,3}(?:,\d{3})*\.\d{2}|\b\d{1,4}\.\d{2}[ \t]*$)/

const PAYMENT_OR_TAX_LINE_RE =
  /\b(?:v[i1]sa|mastercard|amex|discover|cashier'?s[ \t]+check|payment[ \t]+method|sales[ \t]+tax|state[ \t]+tax|auth[ \t]*#|appr[ \t]+\d+)\b/i

export function classifyWithDeterministicRules(doc) {
  const ocrState = evaluateOcrConfidenceState(doc)
  const upstreamTruncated = Boolean(doc.nativeTruncated || doc.ocrTruncated)

  if (doc.text === null || doc.text === undefined || doc.text.trim().length === 0) {
    const uncertaintyReasons = ['no_extracted_text']
    if (upstreamTruncated) uncertaintyReasons.push('upstream_truncated_input')
    if (ocrState.isOcrBelow80) uncertaintyReasons.push('ocr_low_confidence')
    if (ocrState.isOcrConfidenceMissing) uncertaintyReasons.push('ocr_confidence_missing')

    return {
      ruleVersion: DETERMINISTIC_RULE_VERSION,
      purposeLabels: [],
      purposeStatus: 'unknown',
      originLabels: [],
      originStatus: 'unknown',
      confidenceBand: 'low',
      uncertaintyReason: uncertaintyReasons[0],
      uncertaintyReasons,
      totalNormalizedChars: 0,
      inspectedHeadChars: 0,
      inspectedTailChars: 0,
      omittedChars: 0,
      headRange: { startChar: 0, endChar: 0 },
      omittedRange: null,
      tailRange: null,
      tailEnteredInsideFence: false,
      unclosedFenceAtEof: false,
      fenceCount: 0,
      fencedLineCount: 0,
      fenceLanguages: [],
      isClutterCandidate: false,
      hasPersonalVeto: false,
      evidence: []
    }
  }

  const scanned = scanTextWithFenceContext(doc.text, doc)
  const {
    totalNormalizedChars,
    inspectedText,
    proseText,
    proseLines,
    fencedText,
    fenceCount,
    fencedLineCount,
    fenceLanguages,
    tailEnteredInsideFence,
    unclosedFenceAtEof,
    inspectedHeadChars,
    inspectedTailChars,
    omittedChars,
    headRange,
    omittedRange,
    tailRange,
    truncatedForInspection
  } = scanned

  const nonEmptyInspectedLines = inspectedText.split('\n').filter((l) => l.trim().length > 0)
  if (inspectedText.length < MIN_SUBSTANTIVE_PROSE_CHARS && nonEmptyInspectedLines.length < 4) {
    const uncertaintyReasons = ['insufficient_text_length']
    if (truncatedForInspection) uncertaintyReasons.push('truncated_input')
    if (upstreamTruncated) uncertaintyReasons.push('upstream_truncated_input')
    if (unclosedFenceAtEof) uncertaintyReasons.push('unclosed_code_fence')
    if (ocrState.isOcrBelow80) uncertaintyReasons.push('ocr_low_confidence')
    if (ocrState.isOcrConfidenceMissing) uncertaintyReasons.push('ocr_confidence_missing')

    return {
      ruleVersion: DETERMINISTIC_RULE_VERSION,
      purposeLabels: [],
      purposeStatus: 'unknown',
      originLabels: [],
      originStatus: 'unknown',
      confidenceBand: 'low',
      uncertaintyReason: uncertaintyReasons[0],
      uncertaintyReasons,
      totalNormalizedChars,
      inspectedHeadChars,
      inspectedTailChars,
      omittedChars,
      headRange,
      omittedRange,
      tailRange,
      tailEnteredInsideFence,
      unclosedFenceAtEof,
      fenceCount,
      fencedLineCount,
      fenceLanguages,
      isClutterCandidate: false,
      hasPersonalVeto: false,
      evidence: []
    }
  }

  const nonEmptyProseLines = []
  const headingInfos = []
  const nonHeadingProseLines = []

  for (const rawLine of proseLines) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) continue
    nonEmptyProseLines.push(trimmed)
    const heading = normalizeHeadingLine(trimmed)
    if (heading !== null) {
      headingInfos.push(heading)
    } else {
      nonHeadingProseLines.push(trimmed)
    }
  }

  const evidence = []
  const purposeScores = new Map()

  function addEvidence(axis, targetLabel, family, ruleId, weight, summary) {
    evidence.push({ axis, targetLabel, family, ruleId, weight, summary })
  }

  // ─── Purpose 1: `receipts` (4 pairwise-disjoint line/phrase families) ──────
  const receiptFamilies = new Set()
  let summaryLineCount = 0
  let itemizedPriceLineCount = 0
  let hasPaymentOrTax = false

  for (const line of nonEmptyProseLines) {
    const isSummary = SUMMARY_TOTAL_LINE_RE.test(line)
    const isTaxOrPay = PAYMENT_OR_TAX_LINE_RE.test(line)
    if (isSummary) {
      summaryLineCount += 1
    }
    if (isTaxOrPay) {
      hasPaymentOrTax = true
    }
    // Strictly exclude summary & tax lines so R1/R3 lines cannot double-count as R2 itemized lines
    if (!isSummary && !isTaxOrPay && ITEMIZED_PRICE_LINE_RE.test(line)) {
      itemizedPriceLineCount += 1
    }
  }

  if (summaryLineCount >= 1) {
    receiptFamilies.add('total_summary_line')
    addEvidence(
      'purpose',
      'receipts',
      'total_summary_line',
      'receipt.total_line',
      2,
      `Matched ${summaryLineCount} monetary total/subtotal/balance summary line(s)`
    )
  }

  if (itemizedPriceLineCount >= 3) {
    receiptFamilies.add('itemized_prices')
    addEvidence(
      'purpose',
      'receipts',
      'itemized_prices',
      'receipt.itemized_price_lines',
      2,
      `Matched ${itemizedPriceLineCount} distinct non-summary itemized monetary lines`
    )
  }

  if (hasPaymentOrTax) {
    receiptFamilies.add('payment_or_tax')
    addEvidence(
      'purpose',
      'receipts',
      'payment_or_tax',
      'receipt.payment_tender_or_tax',
      1.5,
      'Matched payment method, card authorization, or tax line'
    )
  }

  const hasReceiptHeader =
    /(?:\b(?:receipt|transaction)[ \t]*#|\btrn[ \t]*#:|\b(?:payment[ \t]+receipt|invoice|patient[ \t]+statement|billing[ \t]+statement)\b)/i.test(
      proseText
    )
  if (hasReceiptHeader) {
    receiptFamilies.add('receipt_identifier')
    addEvidence(
      'purpose',
      'receipts',
      'receipt_identifier',
      'receipt.header_or_id',
      1.5,
      'Matched receipt, invoice, statement, or transaction identifier'
    )
  }

  if (receiptFamilies.size >= 2 && (summaryLineCount >= 1 || itemizedPriceLineCount >= 3)) {
    purposeScores.set('receipts', receiptFamilies.size >= 3 ? 'high' : 'medium')
  }

  // ─── Purpose 2: `recipes` (3 pairwise-disjoint culinary families) ──────────
  const recipeFamilies = new Set()
  const hasRecipeHeading = headingInfos.some(
    ({ normalizedHeading: h }) => h === 'ingredients' || h.endsWith(' ingredients')
  )
  if (hasRecipeHeading) {
    recipeFamilies.add('ingredients_section')
    addEvidence(
      'purpose',
      'recipes',
      'ingredients_section',
      'recipe.ingredients_heading',
      2,
      'Matched standalone Ingredients section heading'
    )
  }

  const culinaryMeasureCount = countDistinctMatches(proseText, [
    /\b\d+(?:\/\d+)?[ \t]*(?:tbsp|tablespoons?|tsp|teaspoons?)\b/i,
    /\b\d+(?:\/\d+)?[ \t]*cups?\b/i,
    /\b\d+[ \t]*(?:grams?|oz|ounces|lb|pounds)[ \t]+[a-z]/i,
    /\b(?:pinch|cloves?|sprigs?|handful)[ \t]+(?:of[ \t]+)?[a-z]/i
  ])
  if (culinaryMeasureCount >= 2) {
    recipeFamilies.add('culinary_measurements')
    addEvidence(
      'purpose',
      'recipes',
      'culinary_measurements',
      'recipe.culinary_units',
      2,
      `Matched ${culinaryMeasureCount} culinary measurement patterns`
    )
  }

  const cookingProcessCount = countDistinctMatches(proseText, [
    /\bpreheat[ \t]+(?:the[ \t]+)?oven\b/i,
    /\b\d{3}[ \t]*°[ \t]*[FC]\b/,
    /\b(?:simmer|saut[eé]|whisk|knead|marinate|bake[ \t]+for|roast[ \t]+until|boil|ladle|fold[ \t]+in)\b/i,
    /\b(?:prep[ \t]+time|bake[ \t]+time|cook[ \t]+time|servings[ \t]*:)\b/i
  ])
  if (cookingProcessCount >= 2) {
    recipeFamilies.add('cooking_actions_and_temps')
    addEvidence(
      'purpose',
      'recipes',
      'cooking_actions_and_temps',
      'recipe.cooking_verbs_or_temps',
      2,
      `Matched ${cookingProcessCount} cooking process, oven temperature, or timing signals`
    )
  }

  if (recipeFamilies.size >= 2) {
    purposeScores.set('recipes', recipeFamilies.size >= 3 ? 'high' : 'medium')
  }

  // ─── Purpose 3: `legal` (4 pairwise-disjoint legal families) ───────────────
  const legalFamilies = new Set()
  const formalClauseCount = countDistinctMatches(proseText, [
    /\bWHEREAS\b/,
    /\bIN[ \t]+WITNESS[ \t]+WHEREOF\b/i,
    /\bgoverning[ \t]+law\b|\bgoverned[ \t]+by[ \t]+the[ \t]+laws[ \t]+of\b/i,
    /\bseverability\b|\bfull[ \t]+force[ \t]+and[ \t]+effect\b/i,
    /\bindemnif(?:y|ication)\b|\bhold[ \t]+harmless\b/i,
    /\blimitation[ \t]+of[ \t]+liability\b|\bconsequential[ \t]+damages\b/i
  ])
  if (formalClauseCount >= 1) {
    legalFamilies.add('formal_clauses')
    addEvidence(
      'purpose',
      'legal',
      'formal_clauses',
      'legal.formal_clauses',
      2,
      `Matched ${formalClauseCount} formal legal clause markers`
    )
  }

  const legalRoleOrInstrument =
    /\b(?:lease[ \t]+agreement|sublease[ \t]+addendum|consulting[ \t]+agreement|confidentiality[ \t]+agreement|end-user[ \t]+license[ \t]+agreement|power[ \t]+of[ \t]+attorney|landlord|tenant|lessor|lessee|sublessor|sublessee|licensor|licensee)\b/i.test(
      proseText
    )
  if (legalRoleOrInstrument) {
    legalFamilies.add('legal_instrument_or_parties')
    addEvidence(
      'purpose',
      'legal',
      'legal_instrument_or_parties',
      'legal.instrument_or_party_roles',
      2,
      'Matched contract/agreement instrument title or formal party roles'
    )
  }

  const ossLicenseHeaderOrId =
    /\b(?:MIT[ \t]+License|Apache[ \t]+License,[ \t]+Version[ \t]+2\.0|GNU[ \t]+GENERAL[ \t]+PUBLIC[ \t]+LICENSE)\b/i.test(
      proseText
    ) || /\bSPDX-License-Identifier[ \t]*:/i.test(proseText)
  if (ossLicenseHeaderOrId) {
    legalFamilies.add('oss_license_identifier_or_title')
    addEvidence(
      'purpose',
      'legal',
      'oss_license_identifier_or_title',
      'legal.oss_license_header',
      2,
      'Matched open-source license title or SPDX license identifier'
    )
  }

  const ossOperativeGrantOrDisclaimer =
    /\b(?:Permission[ \t]+is[ \t]+hereby[ \t]+granted,[ \t]+free[ \t]+of[ \t]+charge|WITHOUT[ \t]+WARRANTY[ \t]+OF[ \t]+ANY[ \t]+KIND|you[ \t]+may[ \t]+not[ \t]+use[ \t]+this[ \t]+file[ \t]+except[ \t]+in[ \t]+compliance[ \t]+with[ \t]+the[ \t]+License)\b/i.test(
      proseText
    )
  if (ossOperativeGrantOrDisclaimer) {
    legalFamilies.add('software_license_grant')
    addEvidence(
      'purpose',
      'legal',
      'software_license_grant',
      'legal.oss_license_grant_clause',
      2.5,
      'Matched operative open-source license grant or warranty disclaimer clause'
    )
  }

  const executionSignatureMarkers =
    /\bSigned[ \t]*:[ \t]*[A-Z][a-z]+|\bSignature[ \t]*:|\bNotary[ \t]+Public\b|\/s\/[ \t]*[A-Z]?/i.test(
      proseText
    )
  if (executionSignatureMarkers) {
    legalFamilies.add('execution_or_signatures')
    addEvidence(
      'purpose',
      'legal',
      'execution_or_signatures',
      'legal.signature_block',
      1.5,
      'Matched signature or execution attestation marker'
    )
  }

  if (legalFamilies.size >= 2) {
    purposeScores.set('legal', legalFamilies.size >= 3 ? 'high' : 'medium')
  }

  // ─── Purpose 4: `lists` (4 pairwise-disjoint list families) ────────────────
  const listFamilies = new Set()
  let checkboxLines = 0
  let bulletOrNumberedLines = 0
  for (const line of nonEmptyProseLines) {
    if (/^[-*][ \t]*\[[ xX]\][ \t]+\S/.test(line)) {
      checkboxLines += 1
    } else if (/^(?:[-*•]|\d+[.)])[ \t]+\S/.test(line)) {
      bulletOrNumberedLines += 1
    }
  }

  const csvDelimitedLines =
    (doc.extension === '.csv' || doc.extension === '.tsv') && nonEmptyInspectedLines.length >= 4
      ? nonEmptyInspectedLines.filter(
          (l) => l.split(doc.extension === '.tsv' ? '\t' : ',').length >= 3
        ).length
      : 0

  if (checkboxLines >= 4) {
    listFamilies.add('markdown_checkboxes')
    addEvidence(
      'purpose',
      'lists',
      'markdown_checkboxes',
      'list.checkbox_items',
      2.5,
      `Matched ${checkboxLines} Markdown task checkbox items`
    )
  }

  if (csvDelimitedLines >= 4 && csvDelimitedLines / nonEmptyInspectedLines.length >= 0.8) {
    listFamilies.add('tabular_inventory_rows')
    addEvidence(
      'purpose',
      'lists',
      'tabular_inventory_rows',
      'list.csv_tsv_table',
      2.5,
      `Matched ${csvDelimitedLines} structured tabular inventory rows`
    )
  }

  const lowerFileNameBounded = doc.fileName.slice(0, 200).toLowerCase()
  const hasListInFileName =
    /\b(?:checklist|backlog|grocery|groceries|errands|inventory|todo|to-do)\b/.test(
      lowerFileNameBounded
    ) || /\b(?:shopping|packing)[ _-]+list\b/.test(lowerFileNameBounded)
  const hasListInHeading = headingInfos.some(
    ({ normalizedHeading: h }) =>
      /\b(?:checklist|backlog|grocery|groceries|errands|inventory|todo|to-do)\b/.test(h) ||
      /\b(?:shopping|packing) list\b/.test(h)
  )
  if (hasListInFileName || hasListInHeading) {
    listFamilies.add('list_heading_or_title')
    addEvidence(
      'purpose',
      'lists',
      'list_heading_or_title',
      'list.heading_context',
      1.5,
      'Matched checklist/backlog/grocery/inventory heading or filename'
    )
  }

  const listDensityRatio =
    nonEmptyProseLines.length > 0 ? bulletOrNumberedLines / nonEmptyProseLines.length : 0
  if (
    bulletOrNumberedLines >= 3 &&
    listDensityRatio >= 0.6 &&
    !purposeScores.has('recipes') &&
    !/\bStep[ \t]+1\b/i.test(proseText)
  ) {
    listFamilies.add('high_list_line_density')
    addEvidence(
      'purpose',
      'lists',
      'high_list_line_density',
      'list.line_density',
      1.5,
      `Non-checkbox list line ratio ${(listDensityRatio * 100).toFixed(0)}% (${bulletOrNumberedLines}/${nonEmptyProseLines.length})`
    )
  }

  if (listFamilies.size >= 2 || csvDelimitedLines >= 5 || checkboxLines >= 5) {
    purposeScores.set('lists', checkboxLines >= 4 || csvDelimitedLines >= 5 ? 'high' : 'medium')
  }

  // ─── Purpose 5: `instructions` (3 pairwise-disjoint procedural families) ───
  const instructionFamilies = new Set()
  let hasStepOne = false
  let hasStepTwo = false
  let hasNumbered1 = false
  let hasNumbered2 = false
  for (const line of nonEmptyProseLines) {
    if (/^Step[ \t]+1[ \t]*:/i.test(line)) hasStepOne = true
    if (/^Step[ \t]+2[ \t]*:/i.test(line)) hasStepTwo = true
    // Exclude all-caps legal contract article clauses (`1. GRANT OF LICENSE:`, `2. GOVERNING LAW:`)
    const isAllCapsContractClause = /^\d+\.[ \t]+[A-Z][A-Z0-9 \t&/-]{3,}:/.test(line)
    if (!isAllCapsContractClause) {
      if (/^1\.[ \t]+[A-Z]/.test(line)) hasNumbered1 = true
      if (/^2\.[ \t]+[A-Z]/.test(line)) hasNumbered2 = true
    }
  }
  const hasExplicitSteps = (hasStepOne && hasStepTwo) || (hasNumbered1 && hasNumbered2)
  if (hasExplicitSteps) {
    instructionFamilies.add('numbered_steps')
    addEvidence(
      'purpose',
      'instructions',
      'numbered_steps',
      'instructions.ordered_steps',
      2,
      'Matched ordered procedural steps (Step 1: or sequential 1./2.)'
    )
  }

  const hasProceduralHeading = headingInfos.some(({ normalizedHeading: h }) => {
    if (
      h === 'instructions' ||
      h === 'directions' ||
      h === 'procedure' ||
      h === 'prerequisites' ||
      h === 'installation' ||
      h === 'setup' ||
      h === 'step-by-step setup' ||
      h === 'configuration' ||
      h === 'usage' ||
      h === 'troubleshooting' ||
      h.startsWith('safety warnings') ||
      h.startsWith('how to ') ||
      h.startsWith('steps ')
    ) {
      return true
    }
    return /\b(?:instructions|directions|guide|manual|procedure|steps)$/.test(h)
  })
  if (hasProceduralHeading) {
    instructionFamilies.add('procedural_heading')
    addEvidence(
      'purpose',
      'instructions',
      'procedural_heading',
      'instructions.procedural_section',
      2,
      'Matched standalone procedural heading'
    )
  }

  // Evaluate imperative verbs ONLY on non-heading prose lines so a heading cannot trigger both I2 and I3
  const nonHeadingProseBody = nonHeadingProseLines.join('\n')
  const imperativeVerbCount = countDistinctMatches(nonHeadingProseBody, [
    /\b(?:unplug|reconnect|plug[ \t]+in|rinse|press|turn[ \t]+the|remove[ \t]+the)\b/i,
    /\b(?:install|configure|launch[ \t]+the|copy|run|execute|verify)\b/i,
    /\b(?:preheat|combine|simmer|roast|season)\b/i
  ])
  if (imperativeVerbCount >= 1 && (hasExplicitSteps || fenceCount >= 1)) {
    instructionFamilies.add('imperative_actions')
    addEvidence(
      'purpose',
      'instructions',
      'imperative_actions',
      'instructions.imperative_verbs',
      1.5,
      'Matched imperative procedural verbs in body steps'
    )
  }

  // Pure single-recipe cards without explicit `Step 1:` or procedural guide/instructions headings stay `recipes`
  const hasExplicitGuideOrStepHeader =
    hasStepOne ||
    headingInfos.some(({ normalizedHeading: h }) =>
      /\b(?:instructions|guide|manual|procedure|setup)\b/.test(h)
    )
  const isPureSingleRecipeOnly = purposeScores.has('recipes') && !hasExplicitGuideOrStepHeader
  if (instructionFamilies.size >= 2 && !isPureSingleRecipeOnly) {
    purposeScores.set('instructions', instructionFamilies.size >= 3 ? 'high' : 'medium')
  }

  // ─── Origin / Context Signals (Pairwise-Disjoint Families) ─────────────────
  // Personal Family P1: Personal finance/tax, medical/clinical/veterinary, culinary, or consumer receipts
  const personalFamilies = new Set()
  if (
    purposeScores.has('recipes') ||
    purposeScores.has('receipts') ||
    /\b(?:patient|clinic|hospital|dental|dentist|veterinary|surgery|surgical|discharge|prescription|medication|vaccine|cpa|tax[ \t]+return|joint[ \t]+return|1099|w-2|ssn\/ein)\b/i.test(
      proseText
    )
  ) {
    personalFamilies.add('personal_finance_medical_or_culinary')
    addEvidence(
      'origin',
      'personal',
      'personal_finance_medical_or_culinary',
      'origin.personal.finance_health_culinary',
      2.5,
      'Matched personal receipt, culinary, medical/veterinary, or personal tax domain'
    )
  }

  // Personal Family P2: Family/kinship, neighbors/guests, or personal life reflections/journals
  if (
    /\b(?:family|relatives|mom|dad|mother|father|uncle|aunt|grandmother|grandfather|spouse|guests|neighbors?|eulogy|diary|journal|personal[ \t]+reflection)\b/i.test(
      `${lowerFileNameBounded}\n${proseText}`
    )
  ) {
    personalFamilies.add('personal_family_or_social_narrative')
    addEvidence(
      'origin',
      'personal',
      'personal_family_or_social_narrative',
      'origin.personal.family_or_journal',
      2.5,
      'Matched family/kinship, neighbor/guest, or personal journal/reflection markers'
    )
  }

  // Personal Family P3: Household residence, rooms, home property/appliances, or personal errands
  // (Zero shared tokens with P1 or P2 — e.g., `living room` exists ONLY here in P3)
  if (
    /\b(?:residential|apartment|sublease|master[ \t]+lease|tenant|landlord|living[ \t]+room|bedroom|kitchen|garage|backyards?|appliance|wi-?fi|grocery|groceries|home[ \t]+insurance|independent[ \t]+contractor)\b/i.test(
      `${lowerFileNameBounded}\n${proseText}`
    )
  ) {
    personalFamilies.add('personal_residence_or_household')
    addEvidence(
      'origin',
      'personal',
      'personal_residence_or_household',
      'origin.personal.residence_household',
      2,
      'Matched residential lease/home room, household appliance/Wi-Fi, or personal errand markers'
    )
  }

  // Software Project Families (S1 inspects ONLY fenced code; S2 requires >= 2 markers or SPDX; S4 cannot substitute for content)
  const softwareFamilies = new Set()
  const softwareContentFamilies = new Set()
  if (
    fenceCount >= 1 &&
    (fencedLineCount >= 2 ||
      fenceLanguages.some((lang) =>
        ['ts', 'tsx', 'js', 'bash', 'sh', 'json', 'yaml', 'python', 'rust', 'go'].includes(lang)
      )) &&
    /\b(?:npm[ \t]+(?:install|run|test)|pnpm|yarn|git[ \t]+clone|docker[ \t]+compose|cargo[ \t]+build|pytest|export[ \t]+(?:const|interface|function|class)|import[ \t]+\{)\b/.test(
      fencedText
    )
  ) {
    softwareFamilies.add('code_and_dev_toolchain_blocks')
    softwareContentFamilies.add('code_and_dev_toolchain_blocks')
    addEvidence(
      'origin',
      'software_project',
      'code_and_dev_toolchain_blocks',
      'origin.software.fenced_toolchain',
      2.5,
      `Matched ${fenceCount} fenced code block(s) containing developer CLI/module syntax`
    )
  }

  const repoMarkerCount = countDistinctMatches(proseText, [
    /\b(?:github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+|gitlab\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+)\b/i,
    /\b(?:package\.json|Cargo\.toml|pyproject\.toml|tsconfig\.json)\b/,
    /\b(?:eslint|vitest|tsc[ \t]+--noEmit)\b/i,
    /\bpull[ \t]+requests?\b/i
  ])
  const hasSpdxHeader = /\bSPDX-License-Identifier[ \t]*:/i.test(proseText)
  if (repoMarkerCount >= 2 || hasSpdxHeader) {
    softwareFamilies.add('repo_governance_or_package_metadata')
    softwareContentFamilies.add('repo_governance_or_package_metadata')
    addEvidence(
      'origin',
      'software_project',
      'repo_governance_or_package_metadata',
      'origin.software.repo_metadata',
      2.5,
      'Matched repository governance, SPDX identifier, or multiple package/tooling markers'
    )
  }

  const hasMitGrantPhrase =
    /\bPermission[ \t]+is[ \t]+hereby[ \t]+granted,[ \t]+free[ \t]+of[ \t]+charge\b/i.test(
      proseText
    ) && /\bthe[ \t]+"Software"/i.test(proseText)
  const hasApacheGrantPhrase =
    /\bLicensed[ \t]+under[ \t]+the[ \t]+Apache[ \t]+License,[ \t]+Version[ \t]+2\.0\b/i.test(
      proseText
    )
  if (hasMitGrantPhrase || hasApacheGrantPhrase) {
    softwareFamilies.add('oss_software_license_body')
    softwareContentFamilies.add('oss_software_license_body')
    addEvidence(
      'origin',
      'software_project',
      'oss_software_license_body',
      'origin.software.oss_license_body',
      2.5,
      'Matched standard open-source software distribution license grant body'
    )
  }

  const lowerBase = doc.fileName.toLowerCase()
  if (
    [
      'readme.md',
      'architecture.md',
      'third_party_notices.md',
      'license.txt',
      'license.md'
    ].includes(lowerBase) ||
    /(?:^|\/)(?:repos|code)\//i.test(doc.relativePath)
  ) {
    // Weak corroborator ONLY when paired with verified software content; cannot substitute for a 2nd content family for clutter
    if (softwareContentFamilies.size >= 1) {
      softwareFamilies.add('canonical_repo_artifact_or_layout')
      addEvidence(
        'origin',
        'software_project',
        'canonical_repo_artifact_or_layout',
        'origin.software.corroborated_artifact',
        1.5,
        'Canonical repository filename/path corroborated by software content'
      )
    }
  }

  // Application / System Families (non-fenced whole-document evidence; ISO log lines excluded from A2 telemetry)
  const systemFamilies = new Set()
  const systemContentFamilies = new Set()
  const ISO_LOG_LINE_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?[ \t]+\[(?:INFO|WARN|ERROR|DEBUG|FATAL)\]/i

  let isoLogLineCount = 0
  const nonIsoProseLines = []
  for (const line of nonEmptyProseLines) {
    if (ISO_LOG_LINE_RE.test(line)) {
      isoLogLineCount += 1
    } else {
      nonIsoProseLines.push(line)
    }
  }
  const hasWholeDocLogDominance =
    fenceCount === 0 &&
    isoLogLineCount >= 4 &&
    nonEmptyProseLines.length > 0 &&
    isoLogLineCount / nonEmptyProseLines.length >= 0.75
  if (isoLogLineCount >= 3 && fenceCount === 0) {
    systemFamilies.add('structured_timestamp_log_lines')
    systemContentFamilies.add('structured_timestamp_log_lines')
    addEvidence(
      'origin',
      'application_system',
      'structured_timestamp_log_lines',
      'origin.system.iso_log_stream',
      hasWholeDocLogDominance ? 3.5 : 2,
      `Matched ${isoLogLineCount} non-fenced structured ISO daemon/service log lines`
    )
  }

  const nonIsoProseText = nonIsoProseLines.join('\n')
  const crashDumpSectionCount = countDistinctMatches(nonIsoProseText, [
    /\b(?:Exception[ \t]+Code:[ \t]*0x[0-9A-Fa-f]+|EXCEPTION_ACCESS_VIOLATION|Unhandled[ \t]+Exception[ \t]+Report)\b/,
    /\bStack[ \t]+Trace:/,
    /\bLoaded[ \t]+Modules:/
  ])
  const hasPidTelemetryOutsideLogs = /\b(?:pid:\d+|tid:\d+|exitCode=\d+)\b/.test(nonIsoProseText)
  const hasWholeDocCrashDump = fenceCount === 0 && crashDumpSectionCount >= 2
  if (fenceCount === 0 && (hasWholeDocCrashDump || hasPidTelemetryOutsideLogs)) {
    systemFamilies.add('process_telemetry_or_crash_stack')
    systemContentFamilies.add('process_telemetry_or_crash_stack')
    addEvidence(
      'origin',
      'application_system',
      'process_telemetry_or_crash_stack',
      'origin.system.crash_or_pid_telemetry',
      hasWholeDocCrashDump ? 3.5 : 2,
      'Matched non-fenced PID/TID telemetry or native crash dump structure'
    )
  }

  const hasEulaHeader = /\b(?:END-USER[ \t]+LICENSE[ \t]+AGREEMENT|EULA)\b/i.test(proseText)
  const hasInstallerOrDriverContext =
    /\b(?:Setup[ \t]+Wizard|Setup[ \t]+Installer[ \t]+Component|Device[ \t]+Driver[ \t]+Software|\.exe\b)\b/i.test(
      proseText
    )
  if (fenceCount === 0 && hasEulaHeader && hasInstallerOrDriverContext) {
    systemFamilies.add('bundled_installer_eula')
    systemContentFamilies.add('bundled_installer_eula')
    addEvidence(
      'origin',
      'application_system',
      'bundled_installer_eula',
      'origin.system.installer_driver_eula',
      2.5,
      'Matched bundled driver/installer EULA text'
    )
  }

  if (
    /(?:^|\/)(?:AppLogs|CrashReports|CrashDumps|ProgramBackup|Program Files|AppData|Logs)\//i.test(
      doc.relativePath
    ) &&
    systemContentFamilies.size >= 1
  ) {
    systemFamilies.add('corroborated_system_log_or_installer_path')
    addEvidence(
      'origin',
      'application_system',
      'corroborated_system_log_or_installer_path',
      'origin.system.corroborated_path',
      1.5,
      'System/installer path corroborated by machine-generated log/crash/EULA content'
    )
  }

  const originLabels = []
  if (personalFamilies.size >= 1 && systemFamilies.size < 2 && softwareFamilies.size < 2) {
    originLabels.push('personal')
  } else if (personalFamilies.size >= 2) {
    originLabels.push('personal')
  }

  if (softwareFamilies.size >= 2 || softwareContentFamilies.size >= 2) {
    originLabels.push('software_project')
  }
  if (systemFamilies.size >= 2 || hasWholeDocLogDominance || hasWholeDocCrashDump) {
    originLabels.push('application_system')
  }

  const purposeLabels = [...purposeScores.keys()]
  // `'other'` = "Other / No structured match" (covers both off-taxonomy readable prose/logs and conservative abstention)
  const purposeStatus = purposeLabels.length > 0 ? 'classified' : 'other'
  const originStatus = originLabels.length > 0 ? 'classified' : 'unknown'

  const hasPersonalVeto =
    originLabels.includes('personal') ||
    personalFamilies.size >= 1 ||
    purposeScores.has('recipes') ||
    purposeScores.has('receipts')

  const uncertaintyReasons = []
  if (truncatedForInspection) {
    uncertaintyReasons.push('truncated_input')
  }
  if (upstreamTruncated) {
    uncertaintyReasons.push('upstream_truncated_input')
  }
  if (unclosedFenceAtEof) {
    uncertaintyReasons.push('unclosed_code_fence')
  }
  if (ocrState.isOcrBelow80) {
    uncertaintyReasons.push('ocr_low_confidence')
  }
  if (ocrState.isOcrConfidenceMissing) {
    uncertaintyReasons.push('ocr_confidence_missing')
  }
  if (
    originLabels.length > 1 ||
    (personalFamilies.size >= 1 && (softwareFamilies.size >= 2 || systemFamilies.size >= 2))
  ) {
    uncertaintyReasons.push('overlapping_origin_signals')
  }

  const hadSingleWeakAbstention =
    (!purposeScores.has('receipts') && receiptFamilies.size === 1) ||
    (!purposeScores.has('recipes') && recipeFamilies.size === 1) ||
    (!purposeScores.has('legal') && legalFamilies.size === 1) ||
    (!purposeScores.has('lists') && listFamilies.size === 1) ||
    (!purposeScores.has('instructions') && instructionFamilies.size === 1) ||
    (!originLabels.includes('personal') && personalFamilies.size === 1) ||
    (!originLabels.includes('software_project') && softwareFamilies.size === 1) ||
    (!originLabels.includes('application_system') && systemFamilies.size === 1)
  if (hadSingleWeakAbstention) {
    uncertaintyReasons.push('single_weak_signal_abstained')
  }

  let baseConfidenceBand = 'medium'
  if (
    [...purposeScores.values()].includes('high') ||
    softwareContentFamilies.size >= 2 ||
    systemContentFamilies.size >= 2 ||
    hasWholeDocLogDominance ||
    hasWholeDocCrashDump ||
    personalFamilies.size >= 2
  ) {
    baseConfidenceBand = 'high'
  } else if (purposeLabels.length === 0 && originLabels.length === 0) {
    baseConfidenceBand = 'low'
  }

  const confidenceBand = applyOcrConfidenceCap(baseConfidenceBand, ocrState)

  const isHighConfidenceSoftwareOrSystem =
    (originLabels.includes('software_project') && softwareContentFamilies.size >= 2) ||
    (originLabels.includes('application_system') &&
      (systemContentFamilies.size >= 2 || hasWholeDocLogDominance || hasWholeDocCrashDump))

  const hasDisqualifyingUncertainty = uncertaintyReasons.some((r) =>
    DISQUALIFYING_CLUTTER_UNCERTAINTIES.has(r)
  )

  const isClutterCandidate =
    confidenceBand === 'high' &&
    isHighConfidenceSoftwareOrSystem &&
    !hasPersonalVeto &&
    !originLabels.includes('personal') &&
    !hasDisqualifyingUncertainty

  const uncertaintyReason = uncertaintyReasons[0] ?? null

  return {
    ruleVersion: DETERMINISTIC_RULE_VERSION,
    purposeLabels,
    purposeStatus,
    originLabels,
    originStatus,
    confidenceBand,
    uncertaintyReason,
    uncertaintyReasons,
    totalNormalizedChars,
    inspectedHeadChars,
    inspectedTailChars,
    omittedChars,
    headRange,
    omittedRange,
    tailRange,
    tailEnteredInsideFence,
    unclosedFenceAtEof,
    fenceCount,
    fencedLineCount,
    fenceLanguages,
    isClutterCandidate,
    hasPersonalVeto,
    evidence
  }
}
