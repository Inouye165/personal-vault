/**
 * Personal Vault — Stage 7D Document Semantic Evaluation Spike:
 * Tokenizer-Aware Chunker & Expanded Synthetic Corpus
 *
 * Normalizes text (`\r\n?` -> `\n`, outer trim), splits strictly by model token
 * budget using `@huggingface/tokenizers` so token-dense tails are never dropped,
 * preserves exact UTF-16 character offsets into `normalizedText`, and returns
 * explicit coverage/truncation metadata.
 */

import { createHash } from 'node:crypto'

export const CHUNK_DEFAULTS = Object.freeze({
  maxContentTokensPerChunk: 510, // leaves room for [CLS] + [SEP] in 512-token window
  overlapTokens: 64,
  maxChunksPerDocument: 128,
  maxTextCharsForIndexing: 500_000
})

export function normalizeDocumentText(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\r\n?/g, '\n').trim()
}

export function computeNormalizedTextSha256(normalizedText) {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex')
}

function encodeContentTokenCount(tokenizer, text) {
  return tokenizer.encode(text, { add_special_tokens: false }).ids.length
}

/**
 * Splits normalized text into atomic whitespace/word spans with exact
 * `[start, end]` UTF-16 offsets into `boundedText`. If a single unspaced span
 * exceeds `maxContentTokensPerChunk`, binary-splits it by character bounds.
 */
function buildTokenBudgetedSpans(boundedText, tokenizer, maxContentTokensPerChunk) {
  const rawSpans = []
  const re = /\S+/g
  let match
  while ((match = re.exec(boundedText)) !== null) {
    rawSpans.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0]
    })
  }

  const spans = []
  for (const span of rawSpans) {
    const tokenCount = encodeContentTokenCount(tokenizer, span.text)
    if (tokenCount <= maxContentTokensPerChunk) {
      spans.push({ start: span.start, end: span.end, tokenCount })
      continue
    }

    // Binary-split oversized unspaced token runs so no tail is dropped
    let pos = span.start
    while (pos < span.end) {
      let lo = pos + 1
      let hi = span.end
      let bestEnd = pos + 1
      let bestTokens = encodeContentTokenCount(tokenizer, boundedText.slice(pos, bestEnd))
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const subTokens = encodeContentTokenCount(tokenizer, boundedText.slice(pos, mid))
        if (subTokens <= maxContentTokensPerChunk) {
          bestEnd = mid
          bestTokens = subTokens
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      spans.push({ start: pos, end: bestEnd, tokenCount: bestTokens })
      pos = bestEnd
    }
  }
  return spans
}

/**
 * Tokenizer-aware chunker with exact `normalizedText` offsets and explicit
 * coverage/truncation disclosure.
 */
export function chunkDocumentTextTokenizerAware(text, tokenizer, options = {}) {
  const maxContentTokensPerChunk =
    options.maxContentTokensPerChunk ?? CHUNK_DEFAULTS.maxContentTokensPerChunk
  const overlapTokens = Math.min(
    options.overlapTokens ?? CHUNK_DEFAULTS.overlapTokens,
    Math.max(0, maxContentTokensPerChunk - 1)
  )
  const maxChunksPerDocument = options.maxChunksPerDocument ?? CHUNK_DEFAULTS.maxChunksPerDocument
  const maxTextCharsForIndexing =
    options.maxTextCharsForIndexing ?? CHUNK_DEFAULTS.maxTextCharsForIndexing

  const normalized = normalizeDocumentText(text)
  const normalizedTextSha256 = computeNormalizedTextSha256(normalized)
  const normalizedCharCount = normalized.length

  if (normalizedCharCount === 0) {
    return {
      chunks: [],
      normalizedTextSha256,
      normalizedCharCount: 0,
      indexedCharCount: 0,
      coverageRatio: 1,
      truncated: false,
      truncationReason: null,
      totalTokenCount: 0,
      indexedTokenCount: 0,
      maxChunksPerDocument,
      maxTextCharsForIndexing,
      maxContentTokensPerChunk,
      overlapTokens
    }
  }

  const charTruncated = normalizedCharCount > maxTextCharsForIndexing
  const boundedText = charTruncated ? normalized.slice(0, maxTextCharsForIndexing) : normalized
  const spans = buildTokenBudgetedSpans(boundedText, tokenizer, maxContentTokensPerChunk)
  const totalTokenCount = spans.reduce((acc, s) => acc + s.tokenCount, 0)

  const chunks = []
  let spanIdx = 0
  let chunkIndex = 0
  let chunkTruncated = false

  while (spanIdx < spans.length) {
    if (chunkIndex >= maxChunksPerDocument) {
      chunkTruncated = true
      break
    }

    const startSpanIdx = spanIdx
    let endSpanIdx = startSpanIdx
    let runningTokens = 0

    while (endSpanIdx < spans.length) {
      const nextTokens = runningTokens + spans[endSpanIdx].tokenCount
      if (nextTokens > maxContentTokensPerChunk && endSpanIdx > startSpanIdx) {
        break
      }
      runningTokens = nextTokens
      endSpanIdx += 1
    }

    // Verify exact combined chunk encoding does not exceed maxContentTokensPerChunk
    let charOffsetStart = spans[startSpanIdx].start
    let charOffsetEnd = spans[endSpanIdx - 1].end
    let chunkText = boundedText.slice(charOffsetStart, charOffsetEnd)
    let actualTokens = encodeContentTokenCount(tokenizer, chunkText)
    while (actualTokens > maxContentTokensPerChunk && endSpanIdx - startSpanIdx > 1) {
      endSpanIdx -= 1
      charOffsetEnd = spans[endSpanIdx - 1].end
      chunkText = boundedText.slice(charOffsetStart, charOffsetEnd)
      actualTokens = encodeContentTokenCount(tokenizer, chunkText)
    }

    chunks.push({
      chunkIndex,
      charOffsetStart,
      charOffsetEnd,
      contentTokenCount: actualTokens,
      text: chunkText
    })
    chunkIndex += 1

    if (endSpanIdx >= spans.length) break

    // Step back by overlapTokens, always advancing at least 1 span
    let backTokens = 0
    let nextStartSpanIdx = endSpanIdx
    while (nextStartSpanIdx > startSpanIdx + 1) {
      const prevSpanTokens = spans[nextStartSpanIdx - 1].tokenCount
      if (backTokens + prevSpanTokens > overlapTokens) break
      backTokens += prevSpanTokens
      nextStartSpanIdx -= 1
    }
    spanIdx = Math.max(startSpanIdx + 1, nextStartSpanIdx)
  }

  const lastChunk = chunks[chunks.length - 1]
  const indexedCharCount = lastChunk ? lastChunk.charOffsetEnd : 0
  const indexedTokenCount = chunks.reduce((acc, c) => acc + c.contentTokenCount, 0)
  const truncated = charTruncated || chunkTruncated
  const truncationReason =
    charTruncated && chunkTruncated
      ? 'both'
      : charTruncated
        ? 'max_chars_exceeded'
        : chunkTruncated
          ? 'max_chunks_reached'
          : null

  return {
    chunks,
    normalizedTextSha256,
    normalizedCharCount,
    indexedCharCount,
    coverageRatio:
      normalizedCharCount > 0 ? Number((indexedCharCount / normalizedCharCount).toFixed(4)) : 1,
    truncated,
    truncationReason,
    totalTokenCount,
    indexedTokenCount,
    maxChunksPerDocument,
    maxTextCharsForIndexing,
    maxContentTokensPerChunk,
    overlapTokens
  }
}

function buildTokenDenseLedgerTailText() {
  const lines = []
  for (let i = 1; i <= 220; i += 1) {
    lines.push(
      `TXN-${10000 + i} | 2025-0${(i % 9) + 1}-14 | ACCT-9941-${i} | VENDOR-${i * 7} | $${(12.34 + i).toFixed(2)} | CLEARED`
    )
  }
  lines.push(
    'TXN-88412 | 2025-10-28 | ACCT-9941-WIRE | CASCADE ROOFING LLC | $14,250.00 | FINAL ROOF REPLACEMENT WIRE TRANSFER'
  )
  return lines.join('\n')
}

/**
 * Expanded synthetic corpus (feasibility check + near-topic distractors + noisy OCR +
 * long/token-dense tail + dual native/OCR tracks on the same document).
 */
export const SYNTHETIC_DOCUMENTS = [
  {
    id: 'doc-lease-pdf',
    fileLocationId: 101,
    fileName: 'oakwood-apartments-lease-2025.pdf',
    extension: '.pdf',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      'RESIDENTIAL RENTAL AGREEMENT — OAKWOOD APARTMENTS LLC',
      'Premises: Unit 4B, 742 Oakwood Avenue, Portland, OR 97205.',
      'Term: Twelve (12) months commencing March 1, 2025 and ending February 28, 2026.',
      'Monthly Consideration: Tenant agrees to pay $2,400.00 per calendar month due on the first day of each month via ACH transfer.',
      'Refundable Damage & Cleaning Deposit: Upon execution, Tenant shall remit $3,000.00 held in an escrow account, refundable within 31 days after surrender of keys less documented repairs beyond normal wear and tear.',
      'Pet Addendum: One indoor cat permitted with no additional monthly pet fee.'
    ].join('\n\n')
  },
  {
    id: 'doc-auto-insurance-distractor-pdf',
    fileLocationId: 102,
    fileName: 'auto-policy-2022-expired.pdf',
    extension: '.pdf',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      'AUTOMOBILE INSURANCE POLICY DECLARATIONS (EXPIRED 2022)',
      'Monthly Premium: $148.00 billed automatically. Collision deductible: $1,000.00. Comprehensive deductible: $500.00.',
      'Covers 2018 Honda Civic Sedan; rental car reimbursement up to $30/day during collision repair.'
    ].join('\n\n')
  },
  {
    id: 'doc-dishwasher-ocr-pdf',
    fileLocationId: 103,
    fileName: 'scan_kitchen_appliance_2024.pdf',
    extension: '.pdf',
    textSourceKind: 'ocr',
    recipeVersion: 'doc_ocr_v1',
    ocrModelId: 'tesseract-fast-eng',
    // Noisy OCR with 0/O, 1/l, and broken line wraps
    text: [
      'APPL1ANCE PURCHASE & SERVlCE C0VERAGE',
      'BRAND: B0SCH   M0DEL: SHPM65Z55N/0l   SER1AL: FD0309004l2',
      '24-M0 L1MlTED C0VERAGE — PARTS & LAB0R F0R DRAIN PUMP, M0T0R, AND C0NTR0L B0ARD.',
      'RETA1LER: PAC1F1C H0ME APPL1ANCES   T0TAL PA1D: $899.00',
      '1F DRA1NAGE FAULT E24 0CCURS ON D1SHWASHER, 1NSPECT SUMP F1LTER AND CALL AUTH0R1ZED TECHN1C1AN.'
    ].join('\n\n')
  },
  {
    id: 'doc-fridge-distractor-docx',
    fileLocationId: 104,
    fileName: 'refrigerator-ice-maker-care.docx',
    extension: '.docx',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      'French-Door Refrigerator — Ice Maker & Water Filter Guide',
      'Replace the internal carbon water filter cartridge every 6 months. If ice cubes taste stale, flush 3 gallons through the dispenser.'
    ].join('\n\n')
  },
  {
    id: 'doc-router-manual-docx',
    fileLocationId: 105,
    fileName: 'ax3000-mesh-gateway-guide.docx',
    extension: '.docx',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      'AX3000 Dual-Band Wireless Gateway — Quick Reference',
      'Section 1: Initial Setup. Connect the WAN Ethernet port to your fiber ONT modem and power on the unit.',
      'Section 2: LED Indicators. Solid white indicates active internet link; blinking amber indicates DHCP negotiation failure.',
      'Section 3: Restoring Factory Defaults. If the wireless network password is forgotten or firmware configuration becomes unresponsive, insert a paperclip into the recessed pinhole button on the rear panel and hold for 10 seconds until all status LEDs flash.'
    ].join('\n\n')
  },
  {
    id: 'doc-medical-eob-ocr-png',
    fileLocationId: 106,
    fileName: 'eob_clinic_visit_oct.png',
    extension: '.png',
    textSourceKind: 'ocr',
    recipeVersion: 'doc_ocr_v1',
    ocrModelId: 'tesseract-fast-eng',
    text: [
      'EXPLANAT10N 0F BENEF1TS — N0T A B1LL',
      'PR0V1DER: CASCADE FAM1LY PRACT1CE   SERV1CE DATE: l0/l4/2025',
      'PR0CEDURE: 0UTPAT1ENT D1AGN0ST1C LAB PANEL (CPT 80053)',
      'B1LLED AM0UNT: $3l0.00   PLAN D1SC0UNT: $l85.00   PLAN PA1D: $80.00',
      'PAT1ENT RESP0NS1B1L1TY (C0-PAY): $45.00',
      'RETA1N TH1S STATEMENT F0R HSA / FSA HEALTHCARE RE1MBURSEMENT REC0RDS.'
    ].join('\n\n')
  },
  {
    id: 'doc-long-solar-spec-md',
    fileLocationId: 107,
    fileName: 'home-battery-backup-notes.md',
    extension: '.md',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      '# Off-Grid & Whole-Home Battery Backup Planning Notes\n\n' +
        'These personal notes summarize roof irradiance estimates, inverter sizing, and seasonal load shedding for our residence. ' +
        'Average daily consumption in winter is 18 kWh when heat pump auxiliary strips are disabled, rising to 29 kWh during January cold snaps. ' +
        'Panel azimuth is 182 degrees true south with a 28 degree roof pitch and minimal afternoon shading from the neighbor pine tree.\n\n' +
        'We compared 10 kWh and 15 kWh lithium iron phosphate (LFP) wall-mounted modules for cycle life, cold-weather self-heating, and UL 9540A thermal runaway certification. ' +
        'LFP chemistry was chosen over NMC primarily for indoor garage mounting safety and 6,000-cycle warranty retention above 80% state of health.',
      '## Critical Loads Subpanel & Manual Interlock\n\n' +
        'During utility grid outages, the 200A main service panel isolates via an automatic transfer switch (ATS) in under 20 milliseconds so the refrigerator, well pump, and home office NAS remain online without rebooting.\n\n' +
        'Emergency shutdown procedure: flip the exterior red DC isolator handle to OFF before opening the AC breaker enclosure.'
    ].join('\n\n')
  },
  {
    id: 'doc-solar-tax-distractor-md',
    fileLocationId: 108,
    fileName: 'solar-incentive-article-clip.md',
    extension: '.md',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      '# Residential Clean Energy Tax Credit Overview',
      'Homeowners installing rooftop solar panels may claim a 30% federal tax credit on Form 5695; battery storage systems over 3 kWh also qualify.'
    ].join('\n\n')
  },
  {
    id: 'doc-token-dense-ledger-txt',
    fileLocationId: 109,
    fileName: 'annual-checking-ledger-2025.txt',
    extension: '.txt',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: buildTokenDenseLedgerTailText()
  },
  {
    id: 'doc-sourdough-recipe-txt',
    fileLocationId: 110,
    fileName: 'weekend-country-loaf.txt',
    extension: '.txt',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      'Country Sourdough Bread Formula',
      'Mix 450g bread flour, 50g whole wheat, 375g warm water, and 100g active levain starter.',
      'Bulk ferment 4 hours with four sets of coil folds at 30-minute intervals. Bake in preheated Dutch oven at 475F covered for 20 minutes, then uncovered 22 minutes.'
    ].join('\n\n')
  },
  {
    id: 'doc-software-clutter-json-txt',
    fileLocationId: 111,
    fileName: 'build-dependencies-manifest.txt',
    extension: '.txt',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: [
      '{"name":"demo-app","lockfileVersion":3,"packages":{"node_modules/chalk":{"version":"5.3.0","integrity":"sha512-d9xg..."}}}',
      'webpack 5.91.0 compiled with 0 errors and 2 warnings in 1420 ms.'
    ].join('\n\n')
  },
  // Dual native + OCR tracks on the SAME fileLocationId (112)
  {
    id: 'doc-hybrid-court-notice-pdf:native',
    fileLocationId: 112,
    fileName: 'county-property-assessment-hybrid.pdf',
    extension: '.pdf',
    textSourceKind: 'native',
    recipeVersion: 'doc_extract_v1',
    text: 'MULTNOMAH COUNTY — ELECTRONIC COVER SHEET — PARCEL R249108'
  },
  {
    id: 'doc-hybrid-court-notice-pdf:ocr',
    fileLocationId: 112,
    fileName: 'county-property-assessment-hybrid.pdf',
    extension: '.pdf',
    textSourceKind: 'ocr',
    recipeVersion: 'doc_ocr_v1',
    ocrModelId: 'tesseract-fast-eng',
    text: [
      'MULTNOMAH COUNTY TAX ASSESSMENT OFFICE — ANNUAL NOTICE',
      'PARCEL ID: R249108   TAX YEAR: 2025-2026',
      'ASSESSED REAL MARKET VALUE: $482,000   ANNUAL PROPERTY TAX DUE: $5,412.80',
      'APPEAL DEADLINE: PETITION MUST BE POSTMARKED ON OR BEFORE DECEMBER 31, 2025.'
    ].join('\n\n')
  }
]

export const SYNTHETIC_EVAL_QUERIES = [
  {
    id: 'q-rent',
    query: 'monthly apartment rent and security deposit',
    expectedFileLocationId: 101,
    expectedSourceKind: 'native',
    description: 'Native lease vs near-topic auto insurance monthly premium distractor'
  },
  {
    id: 'q-dishwasher',
    query: 'broken dishwasher warranty repair service',
    expectedFileLocationId: 103,
    expectedSourceKind: 'ocr',
    description: 'Noisy OCR (0/O, 1/l) appliance coverage vs refrigerator manual distractor'
  },
  {
    id: 'q-wifi-reset',
    query: 'how to reset Wi-Fi router to factory settings',
    expectedFileLocationId: 105,
    expectedSourceKind: 'native',
    description: 'Native DOCX manual paraphrase'
  },
  {
    id: 'q-medical-copay',
    query: 'tax deductible medical co-pay for HSA reimbursement',
    expectedFileLocationId: 106,
    expectedSourceKind: 'ocr',
    description: 'Noisy OCR PNG EOB ("C0-PAY: $45.00", "RE1MBURSEMENT")'
  },
  {
    id: 'q-grid-outage',
    query: 'automatic transfer switch during utility power outage',
    expectedFileLocationId: 107,
    expectedSourceKind: 'native',
    description: 'Multi-chunk Markdown vs solar tax credit distractor'
  },
  {
    id: 'q-ledger-tail',
    query: 'wire transfer to Cascade Roofing for roof replacement',
    expectedFileLocationId: 109,
    expectedSourceKind: 'native',
    description: 'Token-dense >2000-token ledger tail preservation'
  },
  {
    id: 'q-property-tax',
    query: 'deadline to appeal annual county property tax bill',
    expectedFileLocationId: 112,
    expectedSourceKind: 'ocr',
    description:
      'Dual-track (native cover + OCR body) attribution to OCR track on fileLocationId 112'
  },
  {
    id: 'q-bread',
    query: 'sourdough bread baking temperature and dutch oven time',
    expectedFileLocationId: 110,
    expectedSourceKind: 'native',
    description: 'Native TXT recipe retrieval'
  }
]
