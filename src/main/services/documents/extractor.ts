/**
 * Personal Vault — Stage 7B Document Text Extraction Engine
 *
 * Pure buffer-level extraction for supported formats (.txt, .md, .markdown,
 * .csv, .tsv, .rtf, .pdf, .docx) with strict size/page/decompression/output
 * bounds and zero external network or script execution.
 */

import { TextDecoder } from 'node:util'
import { Unzip, UnzipInflate } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { parseRtfBuffer } from './rtf-parser'
import {
  classifyPdfPageForOcr,
  inspectPdfPageForOcr,
  type PdfPageLike
} from './ocr/pdf-page-policy'
import {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  type DocumentExtractionOptions,
  type DocumentExtractionOutcome
} from './types'

export {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  SUPPORTED_DOCUMENT_EXTENSIONS
}

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

function makeOutcome(
  partial: Omit<DocumentExtractionOutcome, 'recipeVersion' | 'extractedCharCount'> & {
    extractedCharCount?: number
  }
): DocumentExtractionOutcome {
  const text = partial.text
  return {
    recipeVersion: DOCUMENT_EXTRACTION_RECIPE_VERSION,
    extractedCharCount: partial.extractedCharCount ?? (text ? text.length : 0),
    ...partial
  }
}

function truncateText(
  rawText: string,
  maxChars: number
): { text: string; truncated: boolean; truncationReason: string | null } {
  if (rawText.length <= maxChars) {
    return { text: rawText, truncated: false, truncationReason: null }
  }
  return {
    text: rawText.slice(0, maxChars),
    truncated: true,
    truncationReason: `Extracted text exceeded ${maxChars} character limit`
  }
}

function decodeTextBuffer(buffer: Buffer):
  | {
      ok: true
      text: string
      encoding: string
    }
  | {
      ok: false
      reason: string
    } {
  if (buffer.length === 0) {
    return { ok: true, text: '', encoding: 'utf-8' }
  }

  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    const slice = buffer.subarray(3)
    if (slice.includes(0x00)) {
      return { ok: false, reason: 'Binary NUL bytes detected in UTF-8 text document' }
    }
    try {
      const dec = new TextDecoder('utf-8', { fatal: true })
      return { ok: true, text: dec.decode(slice), encoding: 'utf-8-bom' }
    } catch {
      return { ok: true, text: slice.toString('latin1'), encoding: 'latin1' }
    }
  }

  // UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const slice = buffer.subarray(2)
    const evenLen = slice.length - (slice.length % 2)
    const dec = new TextDecoder('utf-16le')
    return { ok: true, text: dec.decode(slice.subarray(0, evenLen)), encoding: 'utf-16le' }
  }

  // UTF-16 BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const slice = buffer.subarray(2)
    const evenLen = slice.length - (slice.length % 2)
    const swapped = Buffer.allocUnsafe(evenLen)
    for (let i = 0; i < evenLen; i += 2) {
      swapped[i] = slice[i + 1]!
      swapped[i + 1] = slice[i]!
    }
    const dec = new TextDecoder('utf-16le')
    return { ok: true, text: dec.decode(swapped), encoding: 'utf-16be' }
  }

  // Reject binary files disguised as plain text
  if (buffer.includes(0x00)) {
    return { ok: false, reason: 'Binary NUL bytes detected in text document' }
  }

  try {
    const dec = new TextDecoder('utf-8', { fatal: true })
    return { ok: true, text: dec.decode(buffer), encoding: 'utf-8' }
  } catch {
    // Windows-1252 / Latin-1 fallback for legacy text files
    const win1252 = new TextDecoder('windows-1252')
    return { ok: true, text: win1252.decode(buffer), encoding: 'windows-1252' }
  }
}

function parseDelimitedText(raw: string, delimiter: ',' | '\t'): string {
  const rows: string[] = []
  let rowCells: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cell += ch === '\r' || ch === '\n' ? ' ' : ch
      i++
      continue
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      rowCells.push(cell.trim())
      cell = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      rowCells.push(cell.trim())
      if (rowCells.some((c) => c.length > 0)) {
        rows.push(rowCells.join('\t'))
      }
      rowCells = []
      cell = ''
      if (ch === '\r' && raw[i + 1] === '\n') {
        i += 2
      } else {
        i++
      }
      continue
    }
    cell += ch
    i++
  }

  rowCells.push(cell.trim())
  if (rowCells.some((c) => c.length > 0)) {
    rows.push(rowCells.join('\t'))
  }

  return rows.join('\n')
}

async function extractPdfFromBuffer(
  buffer: Buffer,
  limits: { maxPdfPages: number; maxExtractedChars: number }
): Promise<DocumentExtractionOutcome> {
  if (buffer.length === 0) {
    return makeOutcome({
      status: 'no_text_ocr_required',
      text: null,
      pageCount: 0,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Empty file (0 bytes)',
      detectedEncoding: null
    })
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0
  } as Parameters<typeof pdfjs.getDocument>[0])

  let pdfDoc: Awaited<typeof loadingTask.promise> | null = null
  try {
    pdfDoc = await loadingTask.promise
    const totalPages = pdfDoc.numPages
    const pagesToRead = Math.min(totalPages, limits.maxPdfPages)
    const pageTexts: string[] = []
    let totalChars = 0
    let ocrCandidatePages = 0
    let stoppedPageScanEarly = totalPages > limits.maxPdfPages
    let truncated = totalPages > limits.maxPdfPages
    let truncationReason: string | null = truncated
      ? `PDF page count (${totalPages}) exceeded limit of ${limits.maxPdfPages} pages`
      : null

    for (let pageNum = 1; pageNum <= pagesToRead; pageNum++) {
      const page = await pdfDoc.getPage(pageNum)
      let pageNeedsOcr: boolean | null = null
      try {
        const inspection = await inspectPdfPageForOcr(page as unknown as PdfPageLike)
        pageNeedsOcr = classifyPdfPageForOcr(inspection).needsOcr
      } catch {
        // Conservative fallback if operator list inspection fails on a malformed page
        pageNeedsOcr = true
      }
      if (pageNeedsOcr) {
        ocrCandidatePages += 1
      }

      const content = await page.getTextContent()
      const parts: string[] = []
      for (const item of content.items) {
        if ('str' in item && typeof item.str === 'string') {
          parts.push(item.str)
          if ('hasEOL' in item && item.hasEOL) {
            parts.push('\n')
          } else {
            parts.push(' ')
          }
        }
      }
      const pageBody = parts
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      if (pageBody.length > 0) {
        const block = `--- Page ${pageNum} ---\n${pageBody}`
        if (totalChars + block.length + 2 > limits.maxExtractedChars) {
          const remaining = Math.max(0, limits.maxExtractedChars - totalChars)
          if (remaining > 0) {
            pageTexts.push(block.slice(0, remaining))
          }
          truncated = true
          stoppedPageScanEarly = pageNum < totalPages
          truncationReason = `Extracted text exceeded ${limits.maxExtractedChars} character limit`
          break
        }
        pageTexts.push(block)
        totalChars += block.length + 2
      }
    }

    const ocrCandidatePageCount =
      ocrCandidatePages > 0 ? ocrCandidatePages : stoppedPageScanEarly ? null : 0

    const joined = pageTexts.join('\n\n').trim()
    if (joined.length === 0) {
      return makeOutcome({
        status: 'no_text_ocr_required',
        text: null,
        pageCount: totalPages,
        ocrCandidatePageCount: totalPages > 0 ? Math.max(1, ocrCandidatePages) : 0,
        truncated: false,
        truncationReason: null,
        statusDetail:
          totalPages > 0
            ? `No selectable text found across ${totalPages} ${totalPages === 1 ? 'page' : 'pages'} (OCR required in Stage 7C)`
            : 'PDF contains 0 pages',
        detectedEncoding: null
      })
    }

    return makeOutcome({
      status: truncated ? 'truncated' : 'extracted',
      text: joined,
      pageCount: totalPages,
      ocrCandidatePageCount,
      truncated,
      truncationReason,
      statusDetail: truncated ? truncationReason : null,
      detectedEncoding: 'pdf'
    })
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : ''
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errName === 'PasswordException' || /password/i.test(errMsg)) {
      return makeOutcome({
        status: 'password_protected',
        text: null,
        pageCount: null,
        truncated: false,
        truncationReason: null,
        statusDetail: 'PDF is password protected or encrypted',
        detectedEncoding: null
      })
    }
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: `Corrupt or unreadable PDF: ${errMsg}`,
      detectedEncoding: null
    })
  } finally {
    if (pdfDoc) {
      try {
        await (pdfDoc as unknown as { destroy?: () => Promise<void> }).destroy?.()
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

type OrderedXmlNode = Record<string, unknown>

const STANDARD_XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeStandardXmlCharacterReferences(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (full, ref: string) => {
    if (ref in STANDARD_XML_ENTITIES) {
      return STANDARD_XML_ENTITIES[ref]!
    }
    let codePoint: number
    if (ref.startsWith('#x')) {
      codePoint = Number.parseInt(ref.slice(2), 16)
    } else if (ref.startsWith('#')) {
      codePoint = Number.parseInt(ref.slice(1), 10)
    } else {
      return full
    }
    if (
      !Number.isInteger(codePoint) ||
      codePoint <= 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return full
    }
    return String.fromCodePoint(codePoint)
  })
}

function extractTextFromDocxOrderedNodes(nodes: unknown[]): string {
  const paragraphs: string[] = []

  const collectTextFromRunOrParagraph = (children: unknown[]): string => {
    let buf = ''
    for (const child of children) {
      if (!child || typeof child !== 'object') continue
      const node = child as OrderedXmlNode
      if ('#text' in node && typeof node['#text'] === 'string') {
        buf += decodeStandardXmlCharacterReferences(node['#text'])
        continue
      }
      if ('w:tab' in node) {
        buf += '\t'
        continue
      }
      if ('w:br' in node || 'w:cr' in node) {
        buf += '\n'
        continue
      }
      for (const [key, val] of Object.entries(node)) {
        if (key === ':@' || key === '#text') continue
        if (Array.isArray(val)) {
          buf += collectTextFromRunOrParagraph(val)
        }
      }
    }
    return buf
  }

  const walkBody = (children: unknown[]): void => {
    for (const child of children) {
      if (!child || typeof child !== 'object') continue
      const node = child as OrderedXmlNode
      if ('w:p' in node && Array.isArray(node['w:p'])) {
        const pText = collectTextFromRunOrParagraph(node['w:p']).trimEnd()
        if (pText.length > 0) {
          paragraphs.push(pText)
        }
      } else if ('w:tbl' in node && Array.isArray(node['w:tbl'])) {
        for (const trCandidate of node['w:tbl']) {
          if (!trCandidate || typeof trCandidate !== 'object') continue
          const trNode = trCandidate as OrderedXmlNode
          if ('w:tr' in trNode && Array.isArray(trNode['w:tr'])) {
            const cells: string[] = []
            for (const tcCandidate of trNode['w:tr']) {
              if (!tcCandidate || typeof tcCandidate !== 'object') continue
              const tcNode = tcCandidate as OrderedXmlNode
              if ('w:tc' in tcNode && Array.isArray(tcNode['w:tc'])) {
                const cellText = collectTextFromRunOrParagraph(tcNode['w:tc'])
                  .replace(/\s+/g, ' ')
                  .trim()
                cells.push(cellText)
              }
            }
            if (cells.some((c) => c.length > 0)) {
              paragraphs.push(cells.join('\t'))
            }
          }
        }
      } else {
        for (const [key, val] of Object.entries(node)) {
          if (key === ':@' || key === '#text') continue
          if (Array.isArray(val)) {
            walkBody(val)
          }
        }
      }
    }
  }

  walkBody(nodes)
  return paragraphs.join('\n\n').trim()
}

function extractDocxFromBuffer(
  buffer: Buffer,
  limits: {
    maxDecompressedZipBytes: number
    maxDocxXmlBytes: number
    maxZipEntries: number
    maxExtractedChars: number
  }
): DocumentExtractionOutcome {
  if (buffer.length === 0) {
    return makeOutcome({
      status: 'no_text_ocr_required',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Empty file (0 bytes)',
      detectedEncoding: null
    })
  }

  // Detect OLE2 encrypted Office container
  if (
    buffer.length >= OLE2_MAGIC.length &&
    buffer.subarray(0, OLE2_MAGIC.length).equals(OLE2_MAGIC)
  ) {
    return makeOutcome({
      status: 'password_protected',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'DOCX is encrypted or password protected (OLE2 container)',
      detectedEncoding: null
    })
  }

  // Must start with ZIP local file header PK\x03\x04 or empty archive PK\x05\x06
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    ((buffer[2] !== 0x03 || buffer[3] !== 0x04) && (buffer[2] !== 0x05 || buffer[3] !== 0x06))
  ) {
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Invalid DOCX archive header',
      detectedEncoding: null
    })
  }

  let totalDecompressed = 0
  let entryCount = 0
  const documentXmlChunks: Uint8Array[] = []
  let documentXmlBytes = 0
  let foundDocumentXml = false

  class ZipLimitExceededError extends Error {
    public constructor(message: string) {
      super(message)
      this.name = 'ZipLimitExceededError'
    }
  }

  try {
    const unzip = new Unzip((file) => {
      entryCount++
      if (entryCount > limits.maxZipEntries) {
        throw new ZipLimitExceededError(
          `DOCX archive entry count exceeded limit (${limits.maxZipEntries})`
        )
      }
      const isDocumentXml = file.name === 'word/document.xml'
      if (!isDocumentXml) {
        return
      }
      foundDocumentXml = true
      file.ondata = (err, chunk) => {
        if (err) {
          throw err
        }
        if (!chunk) return
        totalDecompressed += chunk.length
        documentXmlBytes += chunk.length
        if (totalDecompressed > limits.maxDecompressedZipBytes) {
          throw new ZipLimitExceededError(
            `DOCX decompressed size exceeded ${limits.maxDecompressedZipBytes} byte limit`
          )
        }
        if (documentXmlBytes > limits.maxDocxXmlBytes) {
          throw new ZipLimitExceededError(
            `word/document.xml exceeded ${limits.maxDocxXmlBytes} byte limit`
          )
        }
        documentXmlChunks.push(chunk)
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    const UNZIP_PUSH_CHUNK_BYTES = 32 * 1024
    const view = new Uint8Array(buffer)
    for (let offset = 0; offset < view.length; offset += UNZIP_PUSH_CHUNK_BYTES) {
      const end = Math.min(offset + UNZIP_PUSH_CHUNK_BYTES, view.length)
      unzip.push(view.subarray(offset, end), end === view.length)
    }
  } catch (err: unknown) {
    if (err instanceof ZipLimitExceededError) {
      return makeOutcome({
        status: 'truncated',
        text: null,
        pageCount: null,
        truncated: true,
        truncationReason: err.message,
        statusDetail: err.message,
        detectedEncoding: null
      })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: `Corrupt DOCX ZIP archive: ${msg}`,
      detectedEncoding: null
    })
  }

  if (!foundDocumentXml) {
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Missing word/document.xml inside DOCX archive',
      detectedEncoding: null
    })
  }

  const xmlBuffer = Buffer.concat(documentXmlChunks.map((c) => Buffer.from(c)))
  const xmlString = xmlBuffer.toString('utf8')

  // Reject DOCTYPE / ENTITY declarations explicitly to prevent DTD/XXE tricks
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xmlString)) {
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Disallowed XML DOCTYPE/ENTITY declaration in DOCX',
      detectedEncoding: null
    })
  }

  const validation = XMLValidator.validate(xmlString)
  if (validation !== true) {
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: `Malformed XML in DOCX: ${validation.err.msg}`,
      detectedEncoding: null
    })
  }

  let parsed: unknown
  try {
    const parser = new XMLParser({
      preserveOrder: true,
      processEntities: false,
      ignoreAttributes: true,
      trimValues: false,
      parseTagValue: false
    })
    parsed = parser.parse(xmlString)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: `Malformed XML in DOCX: ${msg}`,
      detectedEncoding: null
    })
  }

  // Basic structural check for unclosed tags: fast-xml-parser can be lenient unless validated
  if (!Array.isArray(parsed) || parsed.length === 0 || !xmlString.includes('</w:document>')) {
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Malformed or incomplete word/document.xml structure',
      detectedEncoding: null
    })
  }

  const rawText = extractTextFromDocxOrderedNodes(parsed)
  if (rawText.trim().length === 0) {
    return makeOutcome({
      status: 'no_text_ocr_required',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'DOCX contains no extractable text',
      detectedEncoding: 'utf-8'
    })
  }

  const { text, truncated, truncationReason } = truncateText(rawText, limits.maxExtractedChars)
  return makeOutcome({
    status: truncated ? 'truncated' : 'extracted',
    text,
    pageCount: null,
    truncated,
    truncationReason,
    statusDetail: truncated ? truncationReason : null,
    detectedEncoding: 'utf-8'
  })
}

export async function extractDocumentFromBuffer(
  buffer: Buffer,
  extension: string,
  options?: DocumentExtractionOptions
): Promise<DocumentExtractionOutcome> {
  const ext = normalizeExtension(extension)
  const limits = {
    maxInputBytes: options?.maxInputBytes ?? DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES,
    maxPdfPages: options?.maxPdfPages ?? DOCUMENT_EXTRACTION_LIMITS.MAX_PDF_PAGES,
    maxDecompressedZipBytes:
      options?.maxDecompressedZipBytes ?? DOCUMENT_EXTRACTION_LIMITS.MAX_DECOMPRESSED_ZIP_BYTES,
    maxDocxXmlBytes: options?.maxDocxXmlBytes ?? DOCUMENT_EXTRACTION_LIMITS.MAX_DOCX_XML_BYTES,
    maxZipEntries: options?.maxZipEntries ?? DOCUMENT_EXTRACTION_LIMITS.MAX_ZIP_ENTRIES,
    maxRtfGroupDepth: options?.maxRtfGroupDepth ?? DOCUMENT_EXTRACTION_LIMITS.MAX_RTF_GROUP_DEPTH,
    maxExtractedChars: options?.maxExtractedChars ?? DOCUMENT_EXTRACTION_LIMITS.MAX_EXTRACTED_CHARS
  }

  if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(ext)) {
    return makeOutcome({
      status: 'unsupported',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: `Format ${ext || '(no extension)'} is not supported for text extraction in Stage 7B`,
      detectedEncoding: null
    })
  }

  if (buffer.length > limits.maxInputBytes) {
    return makeOutcome({
      status: 'truncated',
      text: null,
      pageCount: null,
      truncated: true,
      truncationReason: `Input file size (${buffer.length} bytes) exceeded ${limits.maxInputBytes} byte limit`,
      statusDetail: `Input file size (${buffer.length} bytes) exceeded ${limits.maxInputBytes} byte limit`,
      detectedEncoding: null
    })
  }

  if (ext === '.pdf') {
    return extractPdfFromBuffer(buffer, limits)
  }

  if (ext === '.docx') {
    return extractDocxFromBuffer(buffer, limits)
  }

  if (buffer.length === 0) {
    return makeOutcome({
      status: 'no_text_ocr_required',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Empty file (0 bytes)',
      detectedEncoding: null
    })
  }

  if (ext === '.rtf') {
    const rtfRes = parseRtfBuffer(buffer, {
      maxGroupDepth: limits.maxRtfGroupDepth,
      maxExtractedChars: limits.maxExtractedChars
    })
    if (!rtfRes.ok) {
      return makeOutcome({
        status: 'corrupt_or_failed',
        text: null,
        pageCount: null,
        truncated: false,
        truncationReason: null,
        statusDetail: rtfRes.reason,
        detectedEncoding: null
      })
    }
    if (rtfRes.text.trim().length === 0) {
      return makeOutcome({
        status: 'no_text_ocr_required',
        text: null,
        pageCount: null,
        truncated: false,
        truncationReason: null,
        statusDetail: 'RTF document contains no extractable text',
        detectedEncoding: 'rtf'
      })
    }
    return makeOutcome({
      status: rtfRes.truncated ? 'truncated' : 'extracted',
      text: rtfRes.text,
      pageCount: null,
      truncated: rtfRes.truncated,
      truncationReason: rtfRes.truncationReason,
      statusDetail: rtfRes.truncated ? rtfRes.truncationReason : null,
      detectedEncoding: 'rtf'
    })
  }

  // .txt, .md, .markdown, .csv, .tsv
  const decoded = decodeTextBuffer(buffer)
  if (!decoded.ok) {
    return makeOutcome({
      status: 'corrupt_or_failed',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: decoded.reason,
      detectedEncoding: null
    })
  }

  const normalizedText =
    ext === '.csv'
      ? parseDelimitedText(decoded.text, ',')
      : ext === '.tsv'
        ? parseDelimitedText(decoded.text, '\t')
        : decoded.text.replace(/\r\n/g, '\n')

  if (normalizedText.trim().length === 0) {
    return makeOutcome({
      status: 'no_text_ocr_required',
      text: null,
      pageCount: null,
      truncated: false,
      truncationReason: null,
      statusDetail: 'Document contains no non-whitespace text',
      detectedEncoding: decoded.encoding
    })
  }

  const { text, truncated, truncationReason } = truncateText(
    normalizedText,
    limits.maxExtractedChars
  )
  return makeOutcome({
    status: truncated ? 'truncated' : 'extracted',
    text,
    pageCount: null,
    truncated,
    truncationReason,
    statusDetail: truncated ? truncationReason : null,
    detectedEncoding: decoded.encoding
  })
}
