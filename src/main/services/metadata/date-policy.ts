/**
 * Personal Vault — Stage 6C Capture Date Precedence, Calendar Validation & Timezone Policy
 *
 * Precedence & Conflict Policy:
 * 1. Prefer EXIF `DateTimeOriginal` (+ `SubSecTimeOriginal`, `OffsetTimeOriginal`).
 * 2. Fall back to EXIF `DateTimeDigitized` (+ `SubSecTimeDigitized`, `OffsetTimeDigitized`)
 *    ONLY when `DateTimeOriginal` is absent.
 * 3. Never silently mask a malformed/impossible `DateTimeOriginal` with `DateTimeDigitized`.
 *    When `DateTimeOriginal` is present and invalid, capture date stays null (`Unknown`) and
 *    raw evidence + parse error are preserved.
 * 4. When both `DateTimeOriginal` and `DateTimeDigitized` are present and disagree, `DateTimeOriginal`
 *    wins and `captureDateConflict` records the discrepancy.
 * 5. Never use IFD0 `DateTime` (`ModifyDate`), filesystem `birthtime`/`mtime`, or filename patterns
 *    to infer capture dates.
 * 6. Timestamps without an explicit timezone offset remain `local_wall_clock_unknown_tz` with
 *    `captureUtcEpochMs = null`. Calendar date filtering uses the recorded capture wall-clock
 *    `YYYY-MM-DD` date without host-timezone or UTC conversion.
 */

import { METADATA_LIMITS, type CaptureDateResolution, type CaptureDateSourceTag } from './types'

export interface RawExifDateInputs {
  readonly dateTimeOriginalRaw?: string | null
  readonly offsetTimeOriginalRaw?: string | null
  readonly subSecTimeOriginalRaw?: string | null
  readonly dateTimeDigitizedRaw?: string | null
  readonly offsetTimeDigitizedRaw?: string | null
  readonly subSecTimeDigitizedRaw?: string | null
}

interface ParsedWallClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly inlineSubseconds: string | null
  readonly inlineOffsetRaw: string | null
}

function boundRawEvidence(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  // Strip NUL terminators while keeping visible raw text for diagnostics
  const withoutNul = raw.replace(/\0+/g, '')
  if (withoutNul.trim().length === 0) return null
  return withoutNul.length > METADATA_LIMITS.MAX_TEXT_LENGTH
    ? withoutNul.slice(0, METADATA_LIMITS.MAX_TEXT_LENGTH)
    : withoutNul
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInGregorianMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31
    case 4:
    case 6:
    case 9:
    case 11:
      return 30
    case 2:
      return isLeapYear(year) ? 29 : 28
    default:
      return 0
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

function isUnsetOffsetPlaceholder(offsetRaw: string | null): boolean {
  if (offsetRaw === null) return true
  const trimmed = offsetRaw.trim()
  if (trimmed.length === 0) return true
  // Common camera firmware blank placeholders for unset OffsetTime* tags: "   :  ", ":  ", "+  :  ", "-  :  "
  return /^[+-]?\s*:\s*$/.test(trimmed)
}

export function parseTimezoneOffset(
  offsetRaw: string
):
  | { readonly ok: true; readonly minutes: number; readonly normalizedText: string }
  | { readonly ok: false; readonly error: string } {
  const trimmed = offsetRaw.trim()
  if (trimmed === 'Z' || trimmed === 'z') {
    return { ok: true, minutes: 0, normalizedText: '+00:00' }
  }
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(trimmed)
  if (!match) {
    return { ok: false, error: `Invalid timezone offset format "${trimmed}"` }
  }
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const mins = Number(match[3])
  if (hours > 14 || mins > 59) {
    return { ok: false, error: `Out-of-range timezone offset "${trimmed}"` }
  }
  const totalMinutes = sign * (hours * 60 + mins)
  if (totalMinutes < -840 || totalMinutes > 840) {
    return { ok: false, error: `Timezone offset "${trimmed}" exceeds [-14:00, +14:00]` }
  }
  const normalizedSign = totalMinutes === 0 && sign === -1 ? '+' : match[1]!
  return {
    ok: true,
    minutes: totalMinutes === 0 ? 0 : totalMinutes,
    normalizedText: `${normalizedSign}${pad2(hours)}:${pad2(mins)}`
  }
}

function parseExifDateText(
  rawText: string
):
  | { readonly ok: true; readonly parsed: ParsedWallClock }
  | { readonly ok: false; readonly error: string } {
  const trimmed = rawText.trim()
  // Unset EXIF date placeholder: "0000:00:00 00:00:00" or "    :  :     :  :  "
  if (/^0{4}[:-]0{2}[:-]0{2}/.test(trimmed) || /^[:\s-]+$/.test(trimmed)) {
    return { ok: false, error: `Unset or zero EXIF date "${trimmed}"` }
  }

  const match =
    /^(\d{4})[:-](\d{2})[:-](\d{2})[T\s](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-][^\s]+)?$/i.exec(
      trimmed
    )
  if (!match) {
    return { ok: false, error: `Malformed EXIF timestamp "${trimmed}"` }
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const inlineSubseconds = match[7] ?? null
  const inlineOffsetRaw = match[8] ?? null

  if (year < 1826 || year > 9999) {
    return { ok: false, error: `Implausible calendar year ${year} in "${trimmed}"` }
  }
  if (month < 1 || month > 12) {
    return { ok: false, error: `Invalid calendar month ${month} in "${trimmed}"` }
  }
  const maxDay = daysInGregorianMonth(year, month)
  if (day < 1 || day > maxDay) {
    return { ok: false, error: `Invalid calendar date ${pad4(year)}-${pad2(month)}-${pad2(day)}` }
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return { ok: false, error: `Invalid time-of-day in "${trimmed}"` }
  }

  return {
    ok: true,
    parsed: {
      year,
      month,
      day,
      hour,
      minute,
      second,
      inlineSubseconds,
      inlineOffsetRaw
    }
  }
}

function sanitizeSubseconds(
  subSecTagRaw: string | null,
  inlineSubseconds: string | null
):
  | { readonly ok: true; readonly subseconds: string | null }
  | { readonly ok: false; readonly error: string } {
  const candidate = subSecTagRaw !== null ? subSecTagRaw.trim() : inlineSubseconds
  if (!candidate || candidate.length === 0) {
    return { ok: true, subseconds: null }
  }
  if (!/^\d{1,9}$/.test(candidate)) {
    return { ok: false, error: `Malformed subsecond value "${candidate}"` }
  }
  if (
    subSecTagRaw !== null &&
    inlineSubseconds !== null &&
    subSecTagRaw.trim() !== inlineSubseconds
  ) {
    return {
      ok: false,
      error: `Contradictory subsecond values "${inlineSubseconds}" vs "${subSecTagRaw.trim()}"`
    }
  }
  return { ok: true, subseconds: candidate }
}

function evaluateCandidateTag(params: {
  sourceTag: CaptureDateSourceTag
  rawDate: string
  rawOffset: string | null
  rawSubSec: string | null
}): CaptureDateResolution {
  const dateParsed = parseExifDateText(params.rawDate)
  if (!dateParsed.ok) {
    return {
      captureDateSourceTag: params.sourceTag,
      rawCaptureDateText: params.rawDate,
      captureSubseconds: null,
      captureOffsetMinutes: null,
      captureOffsetText: null,
      captureTimezoneStatus: 'unknown',
      captureCalendarDate: null,
      captureLocalIso: null,
      captureUtcEpochMs: null,
      captureDateParseError: dateParsed.error,
      captureDateConflict: null
    }
  }

  const { year, month, day, hour, minute, second, inlineSubseconds, inlineOffsetRaw } =
    dateParsed.parsed

  const subRes = sanitizeSubseconds(params.rawSubSec, inlineSubseconds)
  if (!subRes.ok) {
    return {
      captureDateSourceTag: params.sourceTag,
      rawCaptureDateText: params.rawDate,
      captureSubseconds: null,
      captureOffsetMinutes: null,
      captureOffsetText: null,
      captureTimezoneStatus: 'unknown',
      captureCalendarDate: null,
      captureLocalIso: null,
      captureUtcEpochMs: null,
      captureDateParseError: subRes.error,
      captureDateConflict: null
    }
  }

  const hasTagOffset = !isUnsetOffsetPlaceholder(params.rawOffset)
  const hasInlineOffset = !isUnsetOffsetPlaceholder(inlineOffsetRaw)

  let resolvedOffsetMinutes: number | null = null
  let resolvedOffsetText: string | null = null

  if (hasTagOffset || hasInlineOffset) {
    const tagParsed = hasTagOffset ? parseTimezoneOffset(params.rawOffset!) : null
    const inlineParsed = hasInlineOffset ? parseTimezoneOffset(inlineOffsetRaw!) : null

    if (tagParsed && !tagParsed.ok) {
      return {
        captureDateSourceTag: params.sourceTag,
        rawCaptureDateText: params.rawDate,
        captureSubseconds: null,
        captureOffsetMinutes: null,
        captureOffsetText: null,
        captureTimezoneStatus: 'invalid_offset',
        captureCalendarDate: null,
        captureLocalIso: null,
        captureUtcEpochMs: null,
        captureDateParseError: tagParsed.error,
        captureDateConflict: null
      }
    }
    if (inlineParsed && !inlineParsed.ok) {
      return {
        captureDateSourceTag: params.sourceTag,
        rawCaptureDateText: params.rawDate,
        captureSubseconds: null,
        captureOffsetMinutes: null,
        captureOffsetText: null,
        captureTimezoneStatus: 'invalid_offset',
        captureCalendarDate: null,
        captureLocalIso: null,
        captureUtcEpochMs: null,
        captureDateParseError: inlineParsed.error,
        captureDateConflict: null
      }
    }
    if (tagParsed?.ok && inlineParsed?.ok && tagParsed.minutes !== inlineParsed.minutes) {
      return {
        captureDateSourceTag: params.sourceTag,
        rawCaptureDateText: params.rawDate,
        captureSubseconds: null,
        captureOffsetMinutes: null,
        captureOffsetText: null,
        captureTimezoneStatus: 'invalid_offset',
        captureCalendarDate: null,
        captureLocalIso: null,
        captureUtcEpochMs: null,
        captureDateParseError: `Contradictory timezone offsets "${inlineParsed.normalizedText}" vs "${tagParsed.normalizedText}"`,
        captureDateConflict: null
      }
    }

    const chosen = tagParsed?.ok ? tagParsed : inlineParsed?.ok ? inlineParsed : null
    if (chosen) {
      resolvedOffsetMinutes = chosen.minutes
      resolvedOffsetText = chosen.normalizedText
    }
  }

  const calendarDate = `${pad4(year)}-${pad2(month)}-${pad2(day)}`
  const baseLocalIso = `${calendarDate}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
  const localIso = subRes.subseconds ? `${baseLocalIso}.${subRes.subseconds}` : baseLocalIso

  let utcEpochMs: number | null = null
  if (resolvedOffsetMinutes !== null) {
    // Compute millisecond fraction strictly from digits (first 3 digits padded to ms)
    const msFraction = subRes.subseconds ? Number(subRes.subseconds.slice(0, 3).padEnd(3, '0')) : 0
    // Use Date.UTC purely on integer components so host timezone NEVER participates
    const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, msFraction)
    utcEpochMs = wallClockAsUtcMs - resolvedOffsetMinutes * 60_000
  }

  return {
    captureDateSourceTag: params.sourceTag,
    rawCaptureDateText: params.rawDate,
    captureSubseconds: subRes.subseconds,
    captureOffsetMinutes: resolvedOffsetMinutes,
    captureOffsetText: resolvedOffsetText,
    captureTimezoneStatus:
      resolvedOffsetMinutes !== null ? 'offset_present' : 'local_wall_clock_unknown_tz',
    captureCalendarDate: calendarDate,
    captureLocalIso: localIso,
    captureUtcEpochMs: utcEpochMs,
    captureDateParseError: null,
    captureDateConflict: null
  }
}

export function resolveCaptureDate(inputs: RawExifDateInputs): CaptureDateResolution {
  const origRaw = boundRawEvidence(inputs.dateTimeOriginalRaw)
  const origOffset = boundRawEvidence(inputs.offsetTimeOriginalRaw)
  const origSubSec = boundRawEvidence(inputs.subSecTimeOriginalRaw)

  const digiRaw = boundRawEvidence(inputs.dateTimeDigitizedRaw)
  const digiOffset = boundRawEvidence(inputs.offsetTimeDigitizedRaw)
  const digiSubSec = boundRawEvidence(inputs.subSecTimeDigitizedRaw)

  if (origRaw !== null) {
    const primary = evaluateCandidateTag({
      sourceTag: 'DateTimeOriginal',
      rawDate: origRaw,
      rawOffset: origOffset,
      rawSubSec: origSubSec
    })

    if (digiRaw !== null) {
      const secondary = evaluateCandidateTag({
        sourceTag: 'DateTimeDigitized',
        rawDate: digiRaw,
        rawOffset: digiOffset,
        rawSubSec: digiSubSec
      })

      let conflict: string | null = null
      if (primary.captureDateParseError && secondary.captureCalendarDate !== null) {
        conflict = `DateTimeOriginal ("${origRaw}") is invalid while DateTimeDigitized ("${digiRaw}") is present; keeping capture date Unknown rather than masking invalid primary tag`
      } else if (
        primary.captureLocalIso !== null &&
        secondary.captureLocalIso !== null &&
        primary.captureLocalIso.slice(0, 19) !== secondary.captureLocalIso.slice(0, 19)
      ) {
        conflict = `DateTimeOriginal ("${origRaw}") differs from DateTimeDigitized ("${digiRaw}"); using DateTimeOriginal`
      } else if (
        primary.captureDateParseError === null &&
        secondary.captureDateParseError !== null
      ) {
        conflict = `DateTimeDigitized ("${digiRaw}") is malformed; using valid DateTimeOriginal`
      }

      if (conflict) {
        return {
          ...primary,
          captureDateConflict: conflict
        }
      }
    }

    return primary
  }

  if (digiRaw !== null) {
    return evaluateCandidateTag({
      sourceTag: 'DateTimeDigitized',
      rawDate: digiRaw,
      rawOffset: digiOffset,
      rawSubSec: digiSubSec
    })
  }

  return {
    captureDateSourceTag: null,
    rawCaptureDateText: null,
    captureSubseconds: null,
    captureOffsetMinutes: null,
    captureOffsetText: null,
    captureTimezoneStatus: 'unknown',
    captureCalendarDate: null,
    captureLocalIso: null,
    captureUtcEpochMs: null,
    captureDateParseError: null,
    captureDateConflict: null
  }
}
