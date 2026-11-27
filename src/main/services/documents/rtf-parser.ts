/**
 * Personal Vault — Stage 7B Bounded RTF State-Machine Parser
 *
 * Parses Rich Text Format (.rtf) documents using an explicit brace-group
 * state machine with bounded nesting depth and output size. Skips non-body
 * destinations (fonttbl, colortbl, stylesheet, pict, object, info, *\) rather
 * than stripping formatting with fragile regular expressions.
 */

const SKIP_DESTINATIONS = new Set<string>([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'objdata',
  'header',
  'footer',
  'headerl',
  'headerr',
  'headerf',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'fldinst',
  'datafield',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'xmlopen',
  'mmathPr',
  'listtable',
  'listoverridetable',
  'revtbl',
  'rsidtbl',
  'pgdsctbl',
  'generator'
])

// Windows-1252 C1 control range (0x80..0x9F) mapping to Unicode code points
const WIN1252_MAP: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178
}

interface RtfGroupState {
  uc: number
  skip: boolean
}

export interface RtfParseResult {
  readonly ok: true
  readonly text: string
  readonly truncated: boolean
  readonly truncationReason: string | null
}

export interface RtfParseError {
  readonly ok: false
  readonly reason: string
}

function decodeWin1252Byte(byteVal: number): string {
  const mapped = WIN1252_MAP[byteVal]
  if (mapped !== undefined) {
    return String.fromCharCode(mapped)
  }
  return String.fromCharCode(byteVal)
}

export function parseRtfBuffer(
  buffer: Buffer,
  limits: { maxGroupDepth: number; maxExtractedChars: number }
): RtfParseResult | RtfParseError {
  const raw = buffer.toString('latin1')
  const trimmedStart = raw.trimStart()
  if (!trimmedStart.startsWith('{\\rtf')) {
    return { ok: false, reason: 'Missing RTF header ({\\rtf)' }
  }

  const stack: RtfGroupState[] = []
  let current: RtfGroupState = { uc: 1, skip: false }
  let skipChars = 0
  let hexCount = 0
  let out = ''
  let truncated = false
  let truncationReason: string | null = null

  const appendChar = (ch: string): boolean => {
    if (current.skip) return true
    if (skipChars > 0) {
      skipChars--
      return true
    }
    if (out.length + ch.length > limits.maxExtractedChars) {
      truncated = true
      truncationReason = `Extracted text exceeded ${limits.maxExtractedChars} character limit`
      return false
    }
    out += ch
    return true
  }

  let i = 0
  const len = raw.length

  while (i < len) {
    if (hexCount > 0) {
      hexCount--
      i++
      continue
    }

    const ch = raw[i]

    if (ch === '{') {
      if (stack.length >= limits.maxGroupDepth) {
        return {
          ok: false,
          reason: `RTF group nesting exceeded maximum depth (${limits.maxGroupDepth})`
        }
      }
      stack.push({ ...current })
      i++
      continue
    }

    if (ch === '}') {
      const popped = stack.pop()
      if (!popped) {
        return { ok: false, reason: 'Unbalanced closing brace in RTF document' }
      }
      current = popped
      skipChars = 0
      i++
      continue
    }

    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }

    if (ch === '\\') {
      i++
      if (i >= len) break
      const next = raw[i]

      // Escaped literal characters and special symbols
      if (next === '\\' || next === '{' || next === '}') {
        if (!appendChar(next)) break
        i++
        continue
      }
      if (next === '*') {
        // Ignorable destination marker {\*\...}
        current.skip = true
        i++
        continue
      }
      if (next === '~') {
        if (!appendChar('\u00a0')) break
        i++
        continue
      }
      if (next === '-') {
        i++
        continue
      }
      if (next === '_') {
        if (!appendChar('-')) break
        i++
        continue
      }
      if (next === '\r' || next === '\n') {
        if (!appendChar('\n')) break
        i++
        continue
      }
      if (next === "'") {
        // Hex escape \'hh
        const hex = raw.slice(i + 1, i + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          const byteVal = Number.parseInt(hex, 16)
          if (!appendChar(decodeWin1252Byte(byteVal))) break
          i += 3
        } else {
          i++
        }
        continue
      }

      // Control word: [a-zA-Z]+ followed by optional signed integer parameter and optional single space delimiter
      const wordMatch = /^[a-zA-Z]+/.exec(raw.slice(i, i + 64))
      if (!wordMatch) {
        // Other single-char control symbol
        i++
        continue
      }

      const word = wordMatch[0]
      i += word.length

      let param: number | null = null
      const numMatch = /^-?\d+/.exec(raw.slice(i, i + 16))
      if (numMatch) {
        param = Number.parseInt(numMatch[0], 10)
        i += numMatch[0].length
      }

      // A single space immediately following a control word is a delimiter, not content
      if (i < len && raw[i] === ' ') {
        i++
      }

      if (SKIP_DESTINATIONS.has(word)) {
        current.skip = true
        continue
      }

      if (word === 'uc' && param !== null && param >= 0 && param <= 16) {
        current.uc = param
        continue
      }

      if (word === 'u' && param !== null) {
        const codePoint = param < 0 ? param + 65536 : param
        if (codePoint >= 0 && codePoint <= 0x10ffff) {
          if (!appendChar(String.fromCodePoint(codePoint))) break
        }
        skipChars = current.uc
        continue
      }

      if (word === 'bin' && param !== null && param > 0) {
        i += param
        continue
      }

      if (word === 'par' || word === 'line' || word === 'row') {
        if (!appendChar('\n')) break
      } else if (word === 'tab' || word === 'cell') {
        if (!appendChar('\t')) break
      } else if (word === 'emdash') {
        if (!appendChar('—')) break
      } else if (word === 'endash') {
        if (!appendChar('–')) break
      } else if (word === 'lquote') {
        if (!appendChar('‘')) break
      } else if (word === 'rquote') {
        if (!appendChar('’')) break
      } else if (word === 'ldblquote') {
        if (!appendChar('“')) break
      } else if (word === 'rdblquote') {
        if (!appendChar('”')) break
      } else if (word === 'bullet') {
        if (!appendChar('•')) break
      }
      continue
    }

    if (ch !== undefined && !appendChar(ch)) break
    i++
  }

  if (stack.length !== 0 && !truncated) {
    return { ok: false, reason: 'Unclosed brace group in RTF document' }
  }

  return {
    ok: true,
    text: out.replace(/\n{3,}/g, '\n\n').trim(),
    truncated,
    truncationReason
  }
}
