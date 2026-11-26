import type {
  CameraLabelRecord,
  PhotoMetadataFacetItem,
  SavedEventRecord,
  SavedPlaceRecord
} from '../catalog/types'
import type {
  InterpretedCameraFilter,
  InterpretedDateFilter,
  InterpretedPlaceFilter,
  InterpretedSearchFilters,
  SearchClarificationPrompt
} from '../../../shared/validation/ipc-schemas'
import {
  listAllKnownGazetteerAliases,
  normalizePlaceTerm,
  resolveOfflinePlace
} from './offline-gazetteer'

export interface InterpretPhotoQueryInput {
  readonly queryText: string
  readonly savedEvents: readonly SavedEventRecord[]
  readonly savedPlaces: readonly SavedPlaceRecord[]
  readonly knownCameras: readonly PhotoMetadataFacetItem[]
  readonly cameraLabels: readonly CameraLabelRecord[]
}

export interface InterpretPhotoQueryResult {
  readonly interpretedFilters: InterpretedSearchFilters
  readonly clarification: SearchClarificationPrompt | null
}

const MONTH_MAP: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const NON_PLACE_VISUAL_CONTEXTS = new Set([
  'snow',
  'ice',
  'frost',
  'grass',
  'leaves',
  'foliage',
  'bloom',
  'blossom',
  'blossoms',
  'water',
  'ocean',
  'sea',
  'lake',
  'pool',
  'puddle',
  'waves',
  'surf',
  'rain',
  'fog',
  'mist',
  'hail',
  'wind',
  'storm',
  'clouds',
  'sky',
  'light',
  'lighting',
  'dark',
  'darkness',
  'daylight',
  'sun',
  'sunlight',
  'sunshine',
  'moonlight',
  'shade',
  'shadow',
  'shadows',
  'silhouette',
  'silhouettes',
  'winter',
  'summer',
  'spring',
  'autumn',
  'fall',
  'night',
  'morning',
  'afternoon',
  'evening',
  'sunset',
  'sunrise',
  'dusk',
  'dawn',
  'noon',
  'midnight',
  'flight',
  'motion',
  'action',
  'focus',
  'midair',
  'air',
  'background',
  'foreground',
  'distance',
  'frame',
  'mirror',
  'reflection',
  'reflections',
  'glass',
  'window',
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'pink',
  'purple',
  'black',
  'white',
  'gray',
  'grey',
  'color',
  'black and white',
  'restaurant',
  'restaurants',
  'cafe',
  'store',
  'shop',
  'mountains',
  'mountain',
  'hills',
  'valley',
  'canyon',
  'desert',
  'beach',
  'sand',
  'mud',
  'dirt',
  'dust',
  'woods',
  'trees',
  'forest',
  'park',
  'playground',
  'garden',
  'yard',
  'backyard',
  'city',
  'town',
  'street',
  'road',
  'alley',
  'kitchen',
  'living room',
  'bedroom',
  'bathroom',
  'classroom',
  'office',
  'home',
  'school',
  'work',
  'car',
  'truck',
  'boat',
  'train',
  'plane',
  'bed',
  'chair',
  'couch',
  'sofa',
  'waterfront',
  'nature',
  'wild',
  'indoors',
  'outdoors',
  'uniform',
  'uniforms',
  'costume',
  'costumes',
  'suit',
  'suits',
  'dress',
  'dresses',
  'hat',
  'hats',
  'glasses',
  'sunglasses',
  'front',
  'back',
  'line',
  'row',
  'group',
  'crowd',
  'pair',
  'sleep',
  'love',
  'peace'
])

const PLACE_DETERMINER_PREFIX_RE =
  /^(?:the|a|an|my|our|your|his|her|their|this|that|these|those|some|any|deep|fresh|heavy|thick|bright|dark|cold|warm|tall|short|wet|dry|clear|murky|crystal|green|golden|white|black|blue|red|open|broad|high|low|swimming|wading|autumn|winter|summer|spring|morning|evening)\s+/i

const ARTICLE_OR_POSSESSIVE_PREFIX_RE = /^(?:the|a|an|my|our|your|his|her|their|this|that)\s+/i

const CONVERSATIONAL_PREFIX_RE =
  /^(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)*(?:show\s+me|find\s+me|get\s+me|give\s+me|bring\s+up|pull\s+up|search\s+for|look\s+for|find)\b\s*/i

const PHOTO_WRAPPER_PREFIX_RE =
  /^(?:(?:all|any|only)\s+)?(?:(?:the|my|our|these|those)\s+)?(?:photos?|pictures?|pics?|images?|snapshots?|shots?)(?:\s+(?:of|from|taken(?:\s+(?:of|from))?)\b|\s+(?=(?:in|at|on|during|from|near|with)\b))\s*/i

function stripConversationalLeadIn(text: string): string {
  let current = text.replace(/\s+/g, ' ').trim()
  let prev = ''
  while (current !== prev) {
    prev = current
    if (CONVERSATIONAL_PREFIX_RE.test(current)) {
      const next = current.replace(CONVERSATIONAL_PREFIX_RE, '').trim()
      if (next.length > 0) {
        current = next
        continue
      }
    }
    if (PHOTO_WRAPPER_PREFIX_RE.test(current)) {
      const next = current.replace(PHOTO_WRAPPER_PREFIX_RE, '').trim()
      if (next.length > 0) {
        current = next
      }
    }
  }
  return current
}

function isTitleCaseProperName(rawCandidate: string): boolean {
  const words = rawCandidate.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  return words.every((w, idx) => {
    const lower = w.toLowerCase()
    if (idx > 0 && (lower === 'of' || lower === 'the' || lower === 'and' || lower === 'de')) {
      return true
    }
    return /^[A-Z]/.test(w)
  })
}

function isLikelyVisualContextCandidate(
  rawCandidate: string,
  normalizedCandidate: string
): boolean {
  if (NON_PLACE_VISUAL_CONTEXTS.has(normalizedCandidate)) {
    return true
  }

  let stripped = normalizedCandidate
  let prev = ''
  while (stripped !== prev) {
    prev = stripped
    stripped = stripped.replace(PLACE_DETERMINER_PREFIX_RE, '').trim()
  }

  if (stripped && NON_PLACE_VISUAL_CONTEXTS.has(stripped)) {
    const rawTrimmed = rawCandidate.trim()
    const isCapitalizedProperMultiWord =
      rawTrimmed !== rawTrimmed.toLowerCase() &&
      stripped !== normalizedCandidate &&
      !ARTICLE_OR_POSSESSIVE_PREFIX_RE.test(rawTrimmed) &&
      isTitleCaseProperName(rawTrimmed)
    if (!isCapitalizedProperMultiWord) {
      return true
    }
  }

  return false
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function daysInCalendarMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return isLeap ? 29 : 28
  }
  return DAYS_IN_MONTH[month - 1] ?? 30
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanupRemainingText(text: string): string {
  let cleaned = text.replace(/\s+/g, ' ').trim()
  // Strip leading/trailing prepositions or punctuation left behind after filter extraction
  let prev = ''
  while (cleaned !== prev) {
    prev = cleaned
    cleaned = cleaned
      .replace(/^(in|at|on|from|during|near|around|with|for|and|&|,|-)\b\s*/i, '')
      .replace(/\s*\b(in|at|on|from|during|near|around|with|for|and|&|,|-)$/i, '')
      .replace(/^[,.\-–—:;?!]+|[,.\-–—:;?!]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return cleaned
}

function removeMatchedSpan(text: string, matched: string): string {
  const re = new RegExp(`(?:^|\\s)${escapeRegex(matched)}(?=\\s|$)`, 'i')
  return text.replace(re, ' ')
}

function extractDateFilter(
  text: string,
  savedEvents: readonly SavedEventRecord[]
): {
  remainingText: string
  date: InterpretedDateFilter | null
  clarification: SearchClarificationPrompt | null
} {
  // 1. Saved events (longest first, case-insensitive)
  const sortedEvents = [...savedEvents].sort((a, b) => b.name.length - a.name.length)
  for (const ev of sortedEvents) {
    const pattern = new RegExp(`(?:^|\\b)${escapeRegex(ev.name)}(?:\\b|$)`, 'i')
    if (pattern.test(text)) {
      const stripped = text.replace(pattern, ' ')
      return {
        remainingText: stripped,
        date: {
          mode: 'saved_event',
          label: `${ev.name} (${ev.dateFrom} to ${ev.dateTo})`,
          captureDateFrom: ev.dateFrom,
          captureDateTo: ev.dateTo,
          eventName: ev.name
        },
        clarification: null
      }
    }
  }

  // 2. Recurring month + day ("June 6 of any year", "6 June any year", "every June 6")
  const monthAlternation = Object.keys(MONTH_MAP)
    .sort((a, b) => b.length - a.length)
    .join('|')

  const recurringMDY = new RegExp(
    `\\b(?:on\\s+)?(${monthAlternation})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:any|every|each)\\s+year\\b`,
    'i'
  )
  const recurringDMY = new RegExp(
    `\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlternation})\\s+(?:of\\s+)?(?:any|every|each)\\s+year\\b`,
    'i'
  )
  const everyYearMDY = new RegExp(
    `\\b(?:every|each)\\s+(${monthAlternation})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
    'i'
  )

  for (const [re, monthIdx, dayIdx] of [
    [recurringMDY, 1, 2],
    [recurringDMY, 2, 1],
    [everyYearMDY, 1, 2]
  ] as const) {
    const m = re.exec(text)
    if (m) {
      const rawMonth = m[monthIdx]
      const rawDay = m[dayIdx]
      const month = rawMonth ? MONTH_MAP[rawMonth.toLowerCase()] : undefined
      const day = rawDay ? Number(rawDay) : NaN
      if (month && day >= 1 && day <= (DAYS_IN_MONTH[month - 1] ?? 31)) {
        return {
          remainingText: text.replace(m[0], ' '),
          date: {
            mode: 'recurring_month_day',
            label: `${MONTH_NAMES[month - 1] ?? 'Month'} ${day} (any year)`,
            captureMonth: month,
            captureDay: day
          },
          clarification: null
        }
      }
    }
  }

  // 3. Exact ISO date or YYYY-MM-DD..YYYY-MM-DD range
  const rangeIsoMatch = /\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|-|–)\s*(\d{4}-\d{2}-\d{2})\b/i.exec(
    text
  )
  if (rangeIsoMatch && rangeIsoMatch[1] && rangeIsoMatch[2]) {
    const from = rangeIsoMatch[1]
    const to = rangeIsoMatch[2]
    const [captureDateFrom, captureDateTo] = from <= to ? [from, to] : [to, from]
    return {
      remainingText: text.replace(rangeIsoMatch[0], ' '),
      date: {
        mode: 'range',
        label: `${captureDateFrom} to ${captureDateTo}`,
        captureDateFrom,
        captureDateTo
      },
      clarification: null
    }
  }

  const singleIsoMatch = /\b(?:on|in|from)?\s*(\d{4}-\d{2}-\d{2})\b/i.exec(text)
  if (singleIsoMatch && singleIsoMatch[1]) {
    const iso = singleIsoMatch[1]
    return {
      remainingText: text.replace(singleIsoMatch[0], ' '),
      date: {
        mode: 'range',
        label: iso,
        captureDateFrom: iso,
        captureDateTo: iso
      },
      clarification: null
    }
  }

  // 4. Exact "June 6, 2025"
  const mdyYearRe = new RegExp(
    `\\b(?:on\\s+)?(${monthAlternation})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,|\\s)+((?:19|20)\\d{2})\\b`,
    'i'
  )
  const mdyYearMatch = mdyYearRe.exec(text)
  if (mdyYearMatch && mdyYearMatch[1] && mdyYearMatch[2] && mdyYearMatch[3]) {
    const month = MONTH_MAP[mdyYearMatch[1].toLowerCase()]
    const day = Number(mdyYearMatch[2])
    const year = Number(mdyYearMatch[3])
    if (month && day >= 1 && day <= daysInCalendarMonth(year, month)) {
      const iso = `${year}-${pad2(month)}-${pad2(day)}`
      return {
        remainingText: text.replace(mdyYearMatch[0], ' '),
        date: {
          mode: 'range',
          label: `${MONTH_NAMES[month - 1] ?? 'Month'} ${day}, ${year}`,
          captureDateFrom: iso,
          captureDateTo: iso
        },
        clarification: null
      }
    }
  }

  // 5. Month + Year ("June 2025")
  const monthYearRe = new RegExp(
    `\\b(?:in|during|from)?\\s*(${monthAlternation})\\s+((?:19|20)\\d{2})\\b`,
    'i'
  )
  const monthYearMatch = monthYearRe.exec(text)
  if (monthYearMatch && monthYearMatch[1] && monthYearMatch[2]) {
    const month = MONTH_MAP[monthYearMatch[1].toLowerCase()]
    const year = Number(monthYearMatch[2])
    if (month) {
      const from = `${year}-${pad2(month)}-01`
      const to = `${year}-${pad2(month)}-${pad2(daysInCalendarMonth(year, month))}`
      return {
        remainingText: text.replace(monthYearMatch[0], ' '),
        date: {
          mode: 'range',
          label: `${MONTH_NAMES[month - 1] ?? 'Month'} ${year}`,
          captureDateFrom: from,
          captureDateTo: to
        },
        clarification: null
      }
    }
  }

  // 6. Year range ("from 2023 to 2025")
  const yearRangeMatch =
    /\b(?:from\s+)?((?:19|20)\d{2})\s*(?:to|through|-|–)\s*((?:19|20)\d{2})\b/i.exec(text)
  if (yearRangeMatch && yearRangeMatch[1] && yearRangeMatch[2]) {
    const y1 = Number(yearRangeMatch[1])
    const y2 = Number(yearRangeMatch[2])
    const [fromYear, toYear] = y1 <= y2 ? [y1, y2] : [y2, y1]
    return {
      remainingText: text.replace(yearRangeMatch[0], ' '),
      date: {
        mode: 'range',
        label: `${fromYear}–${toYear}`,
        captureDateFrom: `${fromYear}-01-01`,
        captureDateTo: `${toYear}-12-31`
      },
      clarification: null
    }
  }

  // 7. Standalone year ("in 2025" or "2025")
  const yearMatch = /\b(?:in|during|from)?\s*((?:19|20)\d{2})\b/i.exec(text)
  if (yearMatch && yearMatch[1]) {
    const year = yearMatch[1]
    return {
      remainingText: text.replace(yearMatch[0], ' '),
      date: {
        mode: 'year',
        label: year,
        captureDateFrom: `${year}-01-01`,
        captureDateTo: `${year}-12-31`
      },
      clarification: null
    }
  }

  // 8. Undefined personal event phrase (e.g. "My wedding week", "our Hawaii trip", "my graduation")
  // Do NOT treat arbitrary possessive noun phrases like "My dog" or "My red car" as events.
  const trimmed = text.trim()
  const containsPersonalEventPhrase =
    /\b(?:my|our)\s+(?:[\w'-]+\s+){0,3}(?:wedding|week|trip|vacation|honeymoon|anniversary|birthday|graduation|reunion|holiday|party|ceremony|conference|tour|retreat|cruise|festival|getaway|outing|celebration)(?:\s+(?:week|weekend|trip|day|eve|party|ceremony))?\b/i.exec(
      trimmed
    )
  if (containsPersonalEventPhrase) {
    const eventTerm = containsPersonalEventPhrase[0].trim()
    return {
      remainingText: trimmed,
      date: null,
      clarification: {
        kind: 'define_event',
        term: eventTerm,
        message: `No saved date range exists yet for "${eventTerm}". Enter start and end dates to save this event offline.`,
        options: []
      }
    }
  }

  return { remainingText: text, date: null, clarification: null }
}

function extractCameraFilter(
  text: string,
  knownCameras: readonly PhotoMetadataFacetItem[],
  cameraLabels: readonly CameraLabelRecord[]
): { remainingText: string; camera: InterpretedCameraFilter | null } {
  // Never infer camera ownership from embedded make/model alone (only explicit user camera labels or explicit camera model mentions).
  const sortedLabels = [...cameraLabels].sort((a, b) => b.label.length - a.label.length)
  for (const labelRecord of sortedLabels) {
    const re = new RegExp(`(?:^|\\b)${escapeRegex(labelRecord.label)}(?:\\b|$)`, 'i')
    if (re.test(text)) {
      const withClauseRe = new RegExp(
        `(?:\\b(?:shot|taken)\\s+(?:on|with)\\s+|\\b(?:on|with)\\s+)?${escapeRegex(labelRecord.label)}`,
        'i'
      )
      return {
        remainingText: text.replace(withClauseRe, ' '),
        camera: {
          label: `${labelRecord.label} (${labelRecord.cameraNormalized})`,
          cameraNormalized: labelRecord.cameraNormalized,
          source: 'user_camera_label'
        }
      }
    }
  }

  const sortedCameras = [...knownCameras].sort(
    (a, b) => b.displayLabel.length - a.displayLabel.length
  )
  for (const cam of sortedCameras) {
    const candidates = [cam.displayLabel, cam.normalizedValue]
    for (const candidate of candidates) {
      if (candidate.trim().length < 3) continue
      const re = new RegExp(`(?:^|\\b)${escapeRegex(candidate)}(?:\\b|$)`, 'i')
      if (re.test(text)) {
        const withClauseRe = new RegExp(
          `(?:\\b(?:shot|taken)\\s+(?:on|with)\\s+|\\b(?:on|with)\\s+)?${escapeRegex(candidate)}`,
          'i'
        )
        return {
          remainingText: text.replace(withClauseRe, ' '),
          camera: {
            label: cam.displayLabel,
            cameraNormalized: cam.normalizedValue,
            source: 'explicit_camera_model'
          }
        }
      }
    }
  }

  return { remainingText: text, camera: null }
}

function extractPlaceFilter(
  text: string,
  savedPlaces: readonly SavedPlaceRecord[]
): {
  remainingText: string
  place: InterpretedPlaceFilter | null
  clarification: SearchClarificationPrompt | null
} {
  // 1. Check user-saved place names + built-in offline gazetteer aliases longest-first
  const candidateTerms = new Set<string>(listAllKnownGazetteerAliases())
  for (const saved of savedPlaces) {
    candidateTerms.add(normalizePlaceTerm(saved.name))
  }
  const sortedTerms = Array.from(candidateTerms).sort((a, b) => b.length - a.length)

  for (const term of sortedTerms) {
    // Require a location preposition for 2-letter codes like "sf" or "la" so phrases like "a la carte" stay visual
    const re =
      term.length < 3
        ? new RegExp(`\\b(?:in|at|near|around|from)\\s+${escapeRegex(term)}(?:\\b|$)`, 'i')
        : new RegExp(`(?:^|\\b)${escapeRegex(term)}(?:\\b|$)`, 'i')
    if (re.test(text)) {
      const resolved = resolveOfflinePlace(term, savedPlaces)
      const prepRe = new RegExp(`(?:\\b(?:in|at|near|around|from)\\s+)?${escapeRegex(term)}`, 'i')
      const remainingText = text.replace(prepRe, ' ')
      if (resolved.status === 'resolved') {
        return {
          remainingText,
          place: {
            label: resolved.match.label,
            normalizedLabel: normalizePlaceTerm(resolved.match.label),
            source: resolved.match.source,
            savedPlaceId: resolved.match.savedPlaceId,
            gpsBounds: resolved.match.gpsBounds
          },
          clarification: null
        }
      }
      if (resolved.status === 'ambiguous') {
        return {
          remainingText,
          place: null,
          clarification: {
            kind: 'disambiguate_place',
            term: resolved.term,
            message: `Multiple offline places match "${resolved.term}". Choose the intended location:`,
            options: resolved.options.map((o) => ({
              placeId: o.placeId,
              label: o.label,
              regionHint: o.regionHint,
              gpsBounds: o.gpsBounds!,
              savedPlaceId: o.savedPlaceId
            }))
          }
        }
      }
    }
  }

  // 2. Explicit "in <unknown place>" phrasing when not a visual/environmental word or determiner+visual phrase
  const explicitPrepositionMatch = /\b(?:in|at|near)\s+([A-Za-z][A-Za-z\s,'-]{1,48})$/i.exec(
    text.trim()
  )
  if (explicitPrepositionMatch && explicitPrepositionMatch[1]) {
    const rawCandidate = explicitPrepositionMatch[1].trim()
    const normalizedCandidate = normalizePlaceTerm(rawCandidate)
    if (normalizedCandidate && !isLikelyVisualContextCandidate(rawCandidate, normalizedCandidate)) {
      const resolution = resolveOfflinePlace(rawCandidate, savedPlaces)
      if (resolution.status === 'not_found') {
        const remainingText = removeMatchedSpan(text, explicitPrepositionMatch[0])
        return {
          remainingText,
          place: null,
          clarification: {
            kind: 'define_place',
            term: rawCandidate,
            message: `Could not resolve "${rawCandidate}" in the offline place gazetteer. Define a saved place or GPS bounding box to filter by location.`,
            options: []
          }
        }
      }
    }
  }

  return { remainingText: text, place: null, clarification: null }
}

/**
 * Deterministic, 100% offline query interpreter separating structured place,
 * date/recurring/event, and explicit camera filters from remaining visual search terms.
 */
export function interpretPhotoQuery(input: InterpretPhotoQueryInput): InterpretPhotoQueryResult {
  const normalizedQuery = stripConversationalLeadIn(input.queryText)
  if (!normalizedQuery) {
    return {
      interpretedFilters: {
        place: null,
        date: null,
        camera: null,
        visualTerms: null
      },
      clarification: null
    }
  }

  const dateResult = extractDateFilter(normalizedQuery, input.savedEvents)
  if (dateResult.clarification) {
    return {
      interpretedFilters: {
        place: null,
        date: null,
        camera: null,
        visualTerms: null
      },
      clarification: dateResult.clarification
    }
  }

  const cameraResult = extractCameraFilter(
    dateResult.remainingText,
    input.knownCameras,
    input.cameraLabels
  )

  const placeResult = extractPlaceFilter(cameraResult.remainingText, input.savedPlaces)
  if (placeResult.clarification) {
    return {
      interpretedFilters: {
        place: null,
        date: dateResult.date,
        camera: cameraResult.camera,
        visualTerms: cleanupRemainingText(placeResult.remainingText) || null
      },
      clarification: placeResult.clarification
    }
  }

  const remainingVisual = cleanupRemainingText(placeResult.remainingText)
  return {
    interpretedFilters: {
      place: placeResult.place,
      date: dateResult.date,
      camera: cameraResult.camera,
      visualTerms: remainingVisual.length > 0 ? remainingVisual : null
    },
    clarification: null
  }
}
