// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import {
  DOCUMENT_EXTRACTION_LIMITS,
  DOCUMENT_EXTRACTION_RECIPE_VERSION,
  extractDocumentFromBuffer
} from '../../src/main/services/documents/extractor'

/**
 * Builds a minimal valid single-page PDF with optional text using raw PDF objects.
 */
function buildMinimalPdf(textContent: string | null): Buffer {
  const streamBody =
    textContent !== null
      ? `BT\n/F1 12 Tf\n72 720 Td\n(${textContent.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) Tj\nET\n`
      : ''

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamBody, 'latin1')} >>\nstream\n${streamBody}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += obj
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function buildMinimalEncryptedPdf(): Buffer {
  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n',
    '3 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF> /U <00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF> /P -4 >>\nendobj\n'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += obj
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function buildMinimalDocx(documentXml: string): Buffer {
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
    ),
    'word/document.xml': strToU8(documentXml)
  })
  return Buffer.from(zipped)
}

describe('Document Text Extractor (Stage 7B)', () => {
  it('extracts UTF-8, UTF-8 BOM, UTF-16 LE/BE, and Windows-1252 plain text and markdown', async () => {
    const utf8Res = await extractDocumentFromBuffer(
      Buffer.from('Hello\nWorld — café', 'utf8'),
      '.txt'
    )
    expect(utf8Res.status).toBe('extracted')
    expect(utf8Res.recipeVersion).toBe(DOCUMENT_EXTRACTION_RECIPE_VERSION)
    expect(utf8Res.text).toBe('Hello\nWorld — café')
    expect(utf8Res.detectedEncoding).toBe('utf-8')

    const utf8Bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Title\n\nBody', 'utf8')
    ])
    const mdRes = await extractDocumentFromBuffer(utf8Bom, '.md')
    expect(mdRes.status).toBe('extracted')
    expect(mdRes.text).toBe('# Title\n\nBody')

    const utf16LeBody = Buffer.from('Meeting notes\nAction item', 'utf16le')
    const utf16Le = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16LeBody])
    const u16Res = await extractDocumentFromBuffer(utf16Le, '.markdown')
    expect(u16Res.status).toBe('extracted')
    expect(u16Res.text).toBe('Meeting notes\nAction item')
    expect(u16Res.detectedEncoding).toBe('utf-16le')

    // Windows-1252 / Latin-1 fallback when invalid UTF-8 bytes exist
    const latinBuf = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x97, 0x20, 0x4f, 0x4b])
    const latinRes = await extractDocumentFromBuffer(latinBuf, '.txt')
    expect(latinRes.status).toBe('extracted')
    expect(latinRes.text).toContain('Café')
  })

  it('extracts CSV and TSV preserving tabular structure', async () => {
    const csv = 'Name,Amount,Note\n"Widget, Pro",42.50,"Line 1\nLine 2"\nBolt,3.00,Plain\n'
    const csvRes = await extractDocumentFromBuffer(Buffer.from(csv, 'utf8'), '.csv')
    expect(csvRes.status).toBe('extracted')
    expect(csvRes.text).toContain('Name\tAmount\tNote')
    expect(csvRes.text).toContain('Widget, Pro\t42.50\tLine 1 Line 2')

    const tsv = 'ColA\tColB\n1\t2\n'
    const tsvRes = await extractDocumentFromBuffer(Buffer.from(tsv, 'utf8'), '.tsv')
    expect(tsvRes.status).toBe('extracted')
    expect(tsvRes.text).toContain('ColA\tColB')
    expect(tsvRes.text).toContain('1\t2')
  })

  it('parses RTF using a bounded state machine and skips non-body destinations', async () => {
    const rtf =
      '{\\rtf1\\ansi\\ansicpg1252\\deff0' +
      '{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}' +
      '{\\colortbl;\\red0\\green0\\blue0;}' +
      '{\\*\\generator PersonalVaultTest;}' +
      '{\\pict\\pngblip 89504e470d0a1a0a}' +
      '{\\object\\objemb{\\*\\objdata 01050000}}' +
      "Hello \\b bold\\b0\\tab world!\\par Next \\u8212? line caf\\'e9.\\par}"
    const res = await extractDocumentFromBuffer(Buffer.from(rtf, 'ascii'), '.rtf')
    expect(res.status).toBe('extracted')
    expect(res.text).toContain('Hello bold\tworld!')
    expect(res.text).toContain('Next — line café.')
    expect(res.text).not.toContain('Arial')
    expect(res.text).not.toContain('PersonalVaultTest')
    expect(res.text).not.toContain('89504e47')
    expect(res.text).not.toContain('01050000')
  })

  it('rejects malformed RTF and enforces group nesting bounds', async () => {
    const malformed = await extractDocumentFromBuffer(
      Buffer.from('Not an RTF file', 'utf8'),
      '.rtf'
    )
    expect(malformed.status).toBe('corrupt_or_failed')

    const deep = '{'.repeat(200) + 'hello' + '}'.repeat(200)
    const deepRes = await extractDocumentFromBuffer(
      Buffer.from('{\\rtf1' + deep + '}', 'utf8'),
      '.rtf'
    )
    expect(deepRes.status).toBe('corrupt_or_failed')
  })

  it('extracts text-bearing PDFs with page references, and distinguishes scanned, encrypted, and corrupt PDFs', async () => {
    const textPdf = buildMinimalPdf('Quarterly Tax Summary 2025')
    const textRes = await extractDocumentFromBuffer(textPdf, '.pdf')
    expect(textRes.status).toBe('extracted')
    expect(textRes.pageCount).toBe(1)
    expect(textRes.text).toContain('--- Page 1 ---')
    expect(textRes.text).toContain('Quarterly Tax Summary 2025')

    const scannedPdf = buildMinimalPdf(null)
    const scannedRes = await extractDocumentFromBuffer(scannedPdf, '.pdf')
    expect(scannedRes.status).toBe('no_text_ocr_required')
    expect(scannedRes.pageCount).toBe(1)
    expect(scannedRes.statusDetail).toMatch(/OCR/i)

    const encryptedPdf = buildMinimalEncryptedPdf()
    const encRes = await extractDocumentFromBuffer(encryptedPdf, '.pdf')
    expect(encRes.status).toBe('password_protected')

    const corruptPdf = await extractDocumentFromBuffer(
      Buffer.from('%PDF-1.4\ngarbage', 'utf8'),
      '.pdf'
    )
    expect(corruptPdf.status).toBe('corrupt_or_failed')
  })

  it('extracts valid DOCX paragraphs and tables, rejects XXE/external entities, and enforces zip limits', async () => {
    const docxXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
      '<w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>'
    const docxBuf = buildMinimalDocx(docxXml)
    const res = await extractDocumentFromBuffer(docxBuf, '.docx')
    expect(res.status).toBe('extracted')
    expect(res.text).toContain('First paragraph')
    expect(res.text).toContain('Cell A\tCell B')

    // Encrypted OLE2 container disguised as .docx
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])
    const oleRes = await extractDocumentFromBuffer(ole2, '.docx')
    expect(oleRes.status).toBe('password_protected')

    // Malformed XML inside DOCX
    const badXmlDocx = buildMinimalDocx('<w:document><w:body><unclosed></w:document>')
    const badRes = await extractDocumentFromBuffer(badXmlDocx, '.docx')
    expect(badRes.status).toBe('corrupt_or_failed')

    // External entity / DTD injection must NOT resolve external files or entities
    const xxeDocx = buildMinimalDocx(
      '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY secret SYSTEM "file:///C:/Windows/win.ini">]>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&secret;SafeText</w:t></w:r></w:p></w:body></w:document>'
    )
    const xxeRes = await extractDocumentFromBuffer(xxeDocx, '.docx')
    expect(xxeRes.status === 'extracted' || xxeRes.status === 'corrupt_or_failed').toBe(true)
    if (xxeRes.text) {
      expect(xxeRes.text).not.toContain('[fonts]')
    }
  })

  it('enforces zip decompression byte limits on DOCX archives', async () => {
    // Create highly compressible payload exceeding custom maxDecompressedZipBytes
    const bigText = 'A'.repeat(200_000)
    const bigDocx = buildMinimalDocx(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${bigText}</w:t></w:r></w:p></w:body></w:document>`
    )
    const limitedRes = await extractDocumentFromBuffer(bigDocx, '.docx', {
      maxDecompressedZipBytes: 50_000
    })
    expect(limitedRes.status).toBe('truncated')
    expect(limitedRes.truncated).toBe(true)
    expect(limitedRes.truncationReason).toMatch(/decompressed|limit|size/i)
  })

  it('handles empty files, unsupported extensions, binary disguised text, and explicit output truncation', async () => {
    const emptyRes = await extractDocumentFromBuffer(Buffer.alloc(0), '.txt')
    expect(emptyRes.status).toBe('no_text_ocr_required')
    expect(emptyRes.statusDetail).toMatch(/empty/i)

    const unsupportedRes = await extractDocumentFromBuffer(Buffer.from('data'), '.doc')
    expect(unsupportedRes.status).toBe('unsupported')

    const binaryTxt = await extractDocumentFromBuffer(Buffer.from([0x00, 0x01, 0x02, 0x03]), '.txt')
    expect(binaryTxt.status).toBe('corrupt_or_failed')

    const longText = 'word '.repeat(200)
    const truncRes = await extractDocumentFromBuffer(Buffer.from(longText, 'utf8'), '.txt', {
      maxExtractedChars: 100
    })
    expect(truncRes.status).toBe('truncated')
    expect(truncRes.truncated).toBe(true)
    expect(truncRes.text?.length).toBeLessThanOrEqual(100)
    expect(DOCUMENT_EXTRACTION_LIMITS.MAX_INPUT_BYTES).toBe(32 * 1024 * 1024)
  })

  it('preserves DOCX numeric text, leading zeros, and standard XML character references without external entities', async () => {
    const docxXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
      '<w:p><w:r><w:t>12345</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>007</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>A &amp; B &lt;tag&gt; &quot;q&quot; &apos;s&apos; &#8212; &#x2713;</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    const docxBuf = buildMinimalDocx(docxXml)
    const res = await extractDocumentFromBuffer(docxBuf, '.docx')
    expect(res.status).toBe('extracted')
    expect(res.text).toContain('12345')
    expect(res.text).toContain('007')
    expect(res.text).toContain('A & B <tag> "q" \'s\' — ✓')
  })

  it('stops DOCX decompression promptly on highly compressible XML and untrusted ZIP size declarations', async () => {
    // 2 MiB of highly compressible XML (< 10 KiB compressed)
    const repeated =
      '<w:p><w:r><w:t>AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</w:t></w:r></w:p>'.repeat(25_000)
    const bombXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${repeated}</w:body></w:document>`
    const bombBuf = Buffer.from(buildMinimalDocx(bombXml))

    // Spoof uncompressedSize in local file header (offset 22, 4 bytes LE) to a tiny 10 bytes
    const spoofedSmallBuf = Buffer.from(bombBuf)
    spoofedSmallBuf.writeUInt32LE(10, 22)

    const t0 = performance.now()
    const bombRes = await extractDocumentFromBuffer(spoofedSmallBuf, '.docx', {
      maxDocxXmlBytes: 8_192,
      maxDecompressedZipBytes: 16_384
    })
    const elapsedMs = performance.now() - t0
    expect(bombRes.status).toBe('truncated')
    expect(bombRes.truncated).toBe(true)
    expect(bombRes.truncationReason).toMatch(/exceeded|limit/i)
    expect(elapsedMs).toBeLessThan(500)

    // Untrusted huge uncompressedSize declaration on a tiny valid DOCX must not crash or OOM
    const tinyXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Tiny</w:t></w:r></w:p></w:body></w:document>'
    const spoofedHugeBuf = Buffer.from(buildMinimalDocx(tinyXml))
    const docEntryOffset = spoofedHugeBuf.indexOf('word/document.xml')
    if (docEntryOffset > 22) {
      // Local file header starts 30 bytes before filename
      spoofedHugeBuf.writeUInt32LE(0x7fffffff, docEntryOffset - 30 + 22)
    }
    const hugeHeaderRes = await extractDocumentFromBuffer(spoofedHugeBuf, '.docx')
    expect(hugeHeaderRes.status === 'extracted' || hugeHeaderRes.status === 'truncated').toBe(true)
  })
})
