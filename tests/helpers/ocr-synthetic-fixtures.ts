import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'

export interface RecordedSyntheticFixture {
  readonly filePath: string
  readonly fileName: string
  readonly byteSize: number
  readonly mtimeMs: number
  readonly sha256: string
}

export type SyntheticPdfPageSpec =
  | {
      readonly kind: 'scanned-image'
      readonly pageWidthPt?: number
      readonly pageHeightPt?: number
      readonly pixelWidth: number
      readonly pixelHeight: number
      readonly jpegBytes: Buffer
    }
  | {
      readonly kind: 'native-text'
      readonly pageWidthPt?: number
      readonly pageHeightPt?: number
      readonly lines: readonly string[]
    }
  | {
      readonly kind: 'native-header-plus-scanned-body'
      readonly pageWidthPt?: number
      readonly pageHeightPt?: number
      readonly headerLines: readonly string[]
      readonly bodyJpegBytes: Buffer
      readonly bodyPixelWidth: number
      readonly bodyPixelHeight: number
      readonly bodyRectPt?: {
        readonly x: number
        readonly y: number
        readonly width: number
        readonly height: number
      }
    }
  | {
      readonly kind: 'native-body-plus-small-logo'
      readonly pageWidthPt?: number
      readonly pageHeightPt?: number
      readonly bodyLines: readonly string[]
      readonly logoJpegBytes: Buffer
      readonly logoPixelWidth: number
      readonly logoPixelHeight: number
      readonly logoRectPt?: {
        readonly x: number
        readonly y: number
        readonly width: number
        readonly height: number
      }
    }
  | {
      readonly kind: 'blank-vector'
      readonly pageWidthPt?: number
      readonly pageHeightPt?: number
    }

export function renderTextCardPng({
  width,
  height,
  header,
  lines
}: {
  readonly width: number
  readonly height: number
  readonly header: string
  readonly lines: readonly string[]
}): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = '#000000'
  ctx.font = 'bold 42px sans-serif'
  ctx.fillText(header, 56, 94)

  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(56, 122)
  ctx.lineTo(width - 56, 122)
  ctx.stroke()

  ctx.font = '34px sans-serif'
  let y = 186
  for (const line of lines) {
    ctx.fillText(line, 56, y)
    y += 62
  }
  return canvas.toBuffer('image/png')
}

export function renderSmallLogoPng(width = 180, height = 72): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#1e3a8a'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(36, height / 2, 18, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(68, 22, 88, 10)
  ctx.fillRect(68, 40, 60, 10)
  return canvas.toBuffer('image/png')
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function buildSyntheticPdfBuffer(pageSpecs: readonly SyntheticPdfPageSpec[]): Buffer {
  const objects: Array<{ id: number; bodyBuffer: Buffer }> = []
  const addObject = (bodyBuffer: Buffer): number => {
    const id = objects.length + 1
    objects.push({ id, bodyBuffer })
    return id
  }

  const fontObjId = addObject(
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')
  )

  const pageObjIds: number[] = []
  const pagesPlaceholderIdx = objects.length
  const pagesObjId = addObject(Buffer.alloc(0))

  const makeImageXObject = (w: number, h: number, jpegBytes: Buffer): number => {
    const header = Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
      'ascii'
    )
    const footer = Buffer.from('\nendstream', 'ascii')
    return addObject(Buffer.concat([header, jpegBytes, footer]))
  }

  const makeStreamObject = (asciiStream: string): number => {
    const body = Buffer.from(asciiStream, 'ascii')
    return addObject(
      Buffer.concat([
        Buffer.from(`<< /Length ${body.length} >>\nstream\n`, 'ascii'),
        body,
        Buffer.from('endstream', 'ascii')
      ])
    )
  }

  for (const spec of pageSpecs) {
    const pageW = spec.pageWidthPt ?? 612
    const pageH = spec.pageHeightPt ?? 792

    if (spec.kind === 'scanned-image') {
      const imgId = makeImageXObject(spec.pixelWidth, spec.pixelHeight, spec.jpegBytes)
      const contentId = makeStreamObject(`q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`)
      pageObjIds.push(
        addObject(
          Buffer.from(
            `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`,
            'ascii'
          )
        )
      )
    } else if (spec.kind === 'native-text') {
      let s = 'BT\n/F1 14 Tf\n54 720 Td\n'
      spec.lines.forEach((line, idx) => {
        if (idx > 0) s += '0 -22 Td\n'
        s += `(${escapePdfString(line)}) Tj\n`
      })
      s += 'ET\n'
      const contentId = makeStreamObject(s)
      pageObjIds.push(
        addObject(
          Buffer.from(
            `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentId} 0 R >>`,
            'ascii'
          )
        )
      )
    } else if (spec.kind === 'native-header-plus-scanned-body') {
      const imgId = makeImageXObject(spec.bodyPixelWidth, spec.bodyPixelHeight, spec.bodyJpegBytes)
      const rect = spec.bodyRectPt ?? { x: 36, y: 48, width: 540, height: 580 }
      let s = 'BT\n/F1 13 Tf\n36 748 Td\n'
      spec.headerLines.forEach((line, idx) => {
        if (idx > 0) s += '0 -18 Td\n'
        s += `(${escapePdfString(line)}) Tj\n`
      })
      s += 'ET\n'
      s += `q\n${rect.width} 0 0 ${rect.height} ${rect.x} ${rect.y} cm\n/Im0 Do\nQ\n`
      const contentId = makeStreamObject(s)
      pageObjIds.push(
        addObject(
          Buffer.from(
            `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontObjId} 0 R >> /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`,
            'ascii'
          )
        )
      )
    } else if (spec.kind === 'native-body-plus-small-logo') {
      const imgId = makeImageXObject(spec.logoPixelWidth, spec.logoPixelHeight, spec.logoJpegBytes)
      // Default 90x36 pt corner logo = 3,240 pt^2 on 612x792 = 0.67% of page area
      const rect = spec.logoRectPt ?? { x: 480, y: 730, width: 90, height: 36 }
      let s = `q\n${rect.width} 0 0 ${rect.height} ${rect.x} ${rect.y} cm\n/Im0 Do\nQ\n`
      s += 'BT\n/F1 13 Tf\n48 680 Td\n'
      spec.bodyLines.forEach((line, idx) => {
        if (idx > 0) s += '0 -20 Td\n'
        s += `(${escapePdfString(line)}) Tj\n`
      })
      s += 'ET\n'
      const contentId = makeStreamObject(s)
      pageObjIds.push(
        addObject(
          Buffer.from(
            `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontObjId} 0 R >> /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`,
            'ascii'
          )
        )
      )
    } else {
      const contentId = makeStreamObject(`1 1 1 rg\n0 0 ${pageW} ${pageH} re\nf\n`)
      pageObjIds.push(
        addObject(
          Buffer.from(
            `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << >> /Contents ${contentId} 0 R >>`,
            'ascii'
          )
        )
      )
    }
  }

  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ')
  objects[pagesPlaceholderIdx]!.bodyBuffer = Buffer.from(
    `<< /Type /Pages /Kids [${kids}] /Count ${pageObjIds.length} >>`,
    'ascii'
  )
  const catalogObjId = addObject(
    Buffer.from(`<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`, 'ascii')
  )

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'binary')]
  let offset = chunks[0]!.length
  const xrefOffsets = [0]

  for (const obj of objects) {
    xrefOffsets.push(offset)
    const prefix = Buffer.from(`${obj.id} 0 obj\n`, 'ascii')
    const suffix = Buffer.from('\nendobj\n', 'ascii')
    chunks.push(prefix, obj.bodyBuffer, suffix)
    offset += prefix.length + obj.bodyBuffer.length + suffix.length
  }

  const xrefStart = offset
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(xrefOffsets[i]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'ascii'))

  return Buffer.concat(chunks)
}

export async function writeRecordedFixture(
  filePath: string,
  bytes: Buffer
): Promise<RecordedSyntheticFixture> {
  await writeFile(filePath, bytes)
  const st = await stat(filePath)
  return {
    filePath,
    fileName: filePath.split(/[\\/]/).pop() ?? filePath,
    byteSize: st.size,
    mtimeMs: st.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

export async function createOcrFoundationTestFixtures(targetDir: string): Promise<{
  receiptPng: RecordedSyntheticFixture
  receiptTiff: RecordedSyntheticFixture
  scannedPdf: RecordedSyntheticFixture
  blankPng: RecordedSyntheticFixture
  blankScanPdf: RecordedSyntheticFixture
  headerPlusScannedBodyPdf: RecordedSyntheticFixture
  nativeBodyPlusSmallLogoPdf: RecordedSyntheticFixture
  mixedPolicyPdf: RecordedSyntheticFixture
}> {
  await mkdir(targetDir, { recursive: true })

  const receiptPngBytes = renderTextCardPng({
    width: 1100,
    height: 620,
    header: 'PERSONAL VAULT MARKET',
    lines: [
      'RECEIPT NO 48291',
      'DATE 2026-11-15',
      'ITEM ARCHIVAL BINDER 22.00',
      'SALES TAX 2.50',
      'TOTAL PAID 24.50'
    ]
  })
  const receiptTiffBytes = await sharp(receiptPngBytes).tiff({ compression: 'lzw' }).toBuffer()

  const scan1Jpeg = await sharp(
    renderTextCardPng({
      width: 1200,
      height: 1550,
      header: 'SCANNED STATEMENT PAGE ONE',
      lines: ['ACCOUNT REF 77410', 'BALANCE FORWARD 510.00']
    })
  )
    .jpeg({ quality: 92 })
    .toBuffer()

  const scan2Jpeg = await sharp(
    renderTextCardPng({
      width: 1200,
      height: 1550,
      header: 'SCANNED STATEMENT PAGE TWO',
      lines: ['CLOSING BALANCE 645.00', 'STATEMENT CODE ALPHA99']
    })
  )
    .jpeg({ quality: 92 })
    .toBuffer()

  const scannedPdfBytes = buildSyntheticPdfBuffer([
    { kind: 'scanned-image', pixelWidth: 1200, pixelHeight: 1550, jpegBytes: scan1Jpeg },
    { kind: 'scanned-image', pixelWidth: 1200, pixelHeight: 1550, jpegBytes: scan2Jpeg }
  ])

  const blankPngBytes = await sharp({
    create: { width: 900, height: 1100, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .png()
    .toBuffer()
  const blankJpegBytes = await sharp(blankPngBytes).jpeg({ quality: 95 }).toBuffer()
  const blankScanPdfBytes = buildSyntheticPdfBuffer([
    { kind: 'scanned-image', pixelWidth: 900, pixelHeight: 1100, jpegBytes: blankJpegBytes }
  ])

  const scannedBodyJpeg = await sharp(
    renderTextCardPng({
      width: 1150,
      height: 1250,
      header: 'SCANNED BODY CLAUSE 4410',
      lines: ['HANDWRITTEN RECEIPT ATTACHED', 'COUNTERSIGNED CODE ZETA88']
    })
  )
    .jpeg({ quality: 92 })
    .toBuffer()

  const headerPlusScannedBodyPdfBytes = buildSyntheticPdfBuffer([
    {
      kind: 'native-header-plus-scanned-body',
      headerLines: [
        'PERSONAL VAULT ARCHIVE HEADER — DOCUMENT ID PV-9081 — PAGE 1 OF 1',
        'Generated digital cover stamp over scanned body content'
      ],
      bodyJpegBytes: scannedBodyJpeg,
      bodyPixelWidth: 1150,
      bodyPixelHeight: 1250,
      bodyRectPt: { x: 36, y: 48, width: 540, height: 580 }
    }
  ])

  const smallLogoJpeg = await sharp(renderSmallLogoPng(180, 72)).jpeg({ quality: 92 }).toBuffer()
  const nativeBodyPlusSmallLogoPdfBytes = buildSyntheticPdfBuffer([
    {
      kind: 'native-body-plus-small-logo',
      bodyLines: [
        'DIGITAL INVOICE SUMMARY 33019',
        'This page has full selectable digital body text and a small corner logo.',
        'Amount Due: 128.00 USD — Reference: LOGO-SAFE-PAGE'
      ],
      logoJpegBytes: smallLogoJpeg,
      logoPixelWidth: 180,
      logoPixelHeight: 72,
      logoRectPt: { x: 480, y: 730, width: 90, height: 36 }
    }
  ])

  const mixedPolicyPdfBytes = buildSyntheticPdfBuffer([
    {
      kind: 'native-body-plus-small-logo',
      bodyLines: [
        'DIGITAL COVER PAGE 1001',
        'This digital cover page includes a small corner logo and full native text.',
        'Policy Reference PV-MIXED-LOGO-SAFE'
      ],
      logoJpegBytes: smallLogoJpeg,
      logoPixelWidth: 180,
      logoPixelHeight: 72,
      logoRectPt: { x: 480, y: 730, width: 90, height: 36 }
    },
    {
      kind: 'native-header-plus-scanned-body',
      headerLines: [
        'SELECTABLE RUNNING HEADER — ANNEX PAGE 2 — DO NOT SKIP BODY OCR',
        'Archive Batch Stamp 2026-11-15'
      ],
      bodyJpegBytes: scannedBodyJpeg,
      bodyPixelWidth: 1150,
      bodyPixelHeight: 1250,
      bodyRectPt: { x: 36, y: 48, width: 540, height: 580 }
    },
    {
      kind: 'blank-vector'
    }
  ])

  return {
    receiptPng: await writeRecordedFixture(
      join(targetDir, 'synthetic_receipt.png'),
      receiptPngBytes
    ),
    receiptTiff: await writeRecordedFixture(
      join(targetDir, 'synthetic_receipt.tiff'),
      receiptTiffBytes
    ),
    scannedPdf: await writeRecordedFixture(join(targetDir, 'scanned_only.pdf'), scannedPdfBytes),
    blankPng: await writeRecordedFixture(join(targetDir, 'blank_page.png'), blankPngBytes),
    blankScanPdf: await writeRecordedFixture(join(targetDir, 'blank_scan.pdf'), blankScanPdfBytes),
    headerPlusScannedBodyPdf: await writeRecordedFixture(
      join(targetDir, 'header_plus_scanned_body.pdf'),
      headerPlusScannedBodyPdfBytes
    ),
    nativeBodyPlusSmallLogoPdf: await writeRecordedFixture(
      join(targetDir, 'native_body_plus_small_logo.pdf'),
      nativeBodyPlusSmallLogoPdfBytes
    ),
    mixedPolicyPdf: await writeRecordedFixture(
      join(targetDir, 'mixed_policy_document.pdf'),
      mixedPolicyPdfBytes
    )
  }
}
