import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'

function renderTextCanvas({ width, height, lines, header }) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = '#000000'
  ctx.font = 'bold 42px sans-serif'
  ctx.fillText(header, 60, 96)

  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(60, 124)
  ctx.lineTo(width - 60, 124)
  ctx.stroke()

  ctx.font = '34px sans-serif'
  let y = 190
  for (const line of lines) {
    ctx.fillText(line, 60, y)
    y += 64
  }
  return canvas
}

/**
 * Builds a deterministic PDF 1.4 buffer containing:
 * - image-only pages (embedded /DCTDecode JPEG XObjects, zero BT/ET text ops),
 * - native-text pages (Helvetica BT/ET stream, zero image XObjects), or
 * - blank vector spacer pages (white rectangle fill, zero text and zero images).
 */
function buildSyntheticPdf(pageSpecs) {
  const objects = []
  const addObject = (bodyBuffer) => {
    const id = objects.length + 1
    objects.push({ id, bodyBuffer })
    return id
  }

  const fontObjId = addObject(
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')
  )

  const pageObjIds = []
  const pagesPlaceholderIndex = objects.length
  const pagesObjId = addObject(Buffer.alloc(0))

  for (const spec of pageSpecs) {
    const pageW = spec.pageWidthPt ?? 612
    const pageH = spec.pageHeightPt ?? 792

    if (spec.kind === 'scanned-image') {
      const imgHeader = Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${spec.pixelWidth} /Height ${spec.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${spec.jpegBytes.length} >>\nstream\n`,
        'ascii'
      )
      const imgFooter = Buffer.from('\nendstream', 'ascii')
      const imgObjId = addObject(Buffer.concat([imgHeader, spec.jpegBytes, imgFooter]))

      const contentStream = Buffer.from(`q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`, 'ascii')
      const contentObjId = addObject(
        Buffer.concat([
          Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, 'ascii'),
          contentStream,
          Buffer.from('endstream', 'ascii')
        ])
      )

      const pageDict = Buffer.from(
        `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
        'ascii'
      )
      pageObjIds.push(addObject(pageDict))
    } else if (spec.kind === 'native-text') {
      const escapedLines = spec.lines.map((line) =>
        line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      )
      let streamStr = 'BT\n/F1 18 Tf\n54 720 Td\n'
      escapedLines.forEach((line, idx) => {
        if (idx > 0) streamStr += '0 -28 Td\n'
        streamStr += `(${line}) Tj\n`
      })
      streamStr += 'ET\n'

      const contentStream = Buffer.from(streamStr, 'ascii')
      const contentObjId = addObject(
        Buffer.concat([
          Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, 'ascii'),
          contentStream,
          Buffer.from('endstream', 'ascii')
        ])
      )

      const pageDict = Buffer.from(
        `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
        'ascii'
      )
      pageObjIds.push(addObject(pageDict))
    } else if (spec.kind === 'blank-vector') {
      const contentStream = Buffer.from(`1 1 1 rg\n0 0 ${pageW} ${pageH} re\nf\n`, 'ascii')
      const contentObjId = addObject(
        Buffer.concat([
          Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, 'ascii'),
          contentStream,
          Buffer.from('endstream', 'ascii')
        ])
      )
      const pageDict = Buffer.from(
        `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << >> /Contents ${contentObjId} 0 R >>`,
        'ascii'
      )
      pageObjIds.push(addObject(pageDict))
    } else {
      throw new Error(`Unsupported synthetic PDF page spec kind: ${spec.kind}`)
    }
  }

  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ')
  objects[pagesPlaceholderIndex].bodyBuffer = Buffer.from(
    `<< /Type /Pages /Kids [${kids}] /Count ${pageObjIds.length} >>`,
    'ascii'
  )

  const catalogObjId = addObject(
    Buffer.from(`<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`, 'ascii')
  )

  const chunks = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'binary')]
  let offset = chunks[0].length
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

async function recordFixture(filePath, bytes) {
  await writeFile(filePath, bytes)
  const st = await stat(filePath)
  return {
    filePath,
    fileName: path.basename(filePath),
    byteSize: st.size,
    mtimeMs: st.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

export async function createSyntheticOcrFixtures(targetDir) {
  await mkdir(targetDir, { recursive: true })

  // 1. Synthetic receipt PNG + TIFF
  const receiptCanvas = renderTextCanvas({
    width: 1100,
    height: 620,
    header: 'PERSONAL VAULT MARKET',
    lines: [
      'RECEIPT NO 48291',
      'DATE 2026-11-14',
      'ITEM ARCHIVAL BINDER 22.00',
      'SALES TAX 2.50',
      'TOTAL PAID 24.50'
    ]
  })
  const receiptPngBytes = receiptCanvas.toBuffer('image/png')
  const receiptTiffBytes = await sharp(receiptPngBytes).tiff({ compression: 'lzw' }).toBuffer()

  // 2. Scanned image-only 2-page PDF (zero PDF text operators)
  const scanPage1 = renderTextCanvas({
    width: 1200,
    height: 1550,
    header: 'SCANNED STATEMENT PAGE ONE',
    lines: ['ACCOUNT REF 77410', 'BALANCE FORWARD 510.00', 'NO DIGITAL TEXT STREAM']
  })
  const scanPage2 = renderTextCanvas({
    width: 1200,
    height: 1550,
    header: 'SCANNED STATEMENT PAGE TWO',
    lines: ['CLOSING BALANCE 645.00', 'STATEMENT CODE ALPHA99']
  })
  const scanJpeg1 = await sharp(scanPage1.toBuffer('image/png')).jpeg({ quality: 92 }).toBuffer()
  const scanJpeg2 = await sharp(scanPage2.toBuffer('image/png')).jpeg({ quality: 92 }).toBuffer()

  const scannedPdfBytes = buildSyntheticPdf([
    {
      kind: 'scanned-image',
      pixelWidth: 1200,
      pixelHeight: 1550,
      jpegBytes: scanJpeg1
    },
    {
      kind: 'scanned-image',
      pixelWidth: 1200,
      pixelHeight: 1550,
      jpegBytes: scanJpeg2
    }
  ])

  // 3. Blank image & blank image-only PDF (honest ocr_no_text verification)
  const blankPngBytes = await sharp({
    create: {
      width: 900,
      height: 1100,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .png()
    .toBuffer()
  const blankJpegBytes = await sharp(blankPngBytes).jpeg({ quality: 95 }).toBuffer()
  const blankScanPdfBytes = buildSyntheticPdf([
    {
      kind: 'scanned-image',
      pixelWidth: 900,
      pixelHeight: 1100,
      jpegBytes: blankJpegBytes
    }
  ])

  // 4. Mixed 3-page PDF:
  //    Page 1 = native selectable text ("NATIVE POLICY SECTION 1001")
  //    Page 2 = image-only scan ("SCANNED ADDENDUM 2002")
  //    Page 3 = blank vector spacer (neither native text nor raster images)
  const mixedScanCanvas = renderTextCanvas({
    width: 1200,
    height: 1550,
    header: 'SCANNED ADDENDUM 2002',
    lines: ['SIGNED RECEIPT ACKNOWLEDGED', 'ARCHIVE STAMP 88310']
  })
  const mixedScanJpeg = await sharp(mixedScanCanvas.toBuffer('image/png'))
    .jpeg({ quality: 92 })
    .toBuffer()

  const mixedPdfBytes = buildSyntheticPdf([
    {
      kind: 'native-text',
      lines: [
        'NATIVE POLICY SECTION 1001',
        'This first page contains native selectable PDF text.',
        'Policy Reference PV-2026-MIXED'
      ]
    },
    {
      kind: 'scanned-image',
      pixelWidth: 1200,
      pixelHeight: 1550,
      jpegBytes: mixedScanJpeg
    },
    {
      kind: 'blank-vector'
    }
  ])

  return {
    receiptPng: await recordFixture(path.join(targetDir, 'synthetic_receipt.png'), receiptPngBytes),
    receiptTiff: await recordFixture(
      path.join(targetDir, 'synthetic_receipt.tiff'),
      receiptTiffBytes
    ),
    scannedPdf: await recordFixture(path.join(targetDir, 'scanned_only.pdf'), scannedPdfBytes),
    blankPng: await recordFixture(path.join(targetDir, 'blank_page.png'), blankPngBytes),
    blankScanPdf: await recordFixture(path.join(targetDir, 'blank_scan.pdf'), blankScanPdfBytes),
    mixedPdf: await recordFixture(path.join(targetDir, 'mixed_document.pdf'), mixedPdfBytes)
  }
}
