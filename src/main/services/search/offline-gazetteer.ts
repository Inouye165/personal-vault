import type { GpsBoundingBox, SavedPlaceRecord } from '../catalog/types'

export interface GazetteerPlaceEntry {
  readonly placeId: string
  readonly canonicalName: string
  readonly aliases: readonly string[]
  readonly regionHint: string
  readonly gpsBounds: GpsBoundingBox
  readonly ambiguousGroup?: string
}

/**
 * 100% offline gazetteer of built-in geographic bounding boxes and known ambiguous
 * place names. No network requests are ever made.
 */
export const OFFLINE_GAZETTEER_PLACES: readonly GazetteerPlaceEntry[] = [
  {
    placeId: 'yellowstone-np',
    canonicalName: 'Yellowstone National Park',
    aliases: ['yellowstone', 'yellowstone national park', 'yellowstone np'],
    regionHint: 'Wyoming / Montana / Idaho, USA',
    gpsBounds: { minLat: 44.131, maxLat: 45.111, minLon: -111.156, maxLon: -109.825 }
  },
  {
    placeId: 'yosemite-np',
    canonicalName: 'Yosemite National Park',
    aliases: ['yosemite', 'yosemite valley', 'yosemite national park', 'yosemite np'],
    regionHint: 'California, USA',
    gpsBounds: { minLat: 37.492, maxLat: 38.187, minLon: -119.886, maxLon: -119.198 }
  },
  {
    placeId: 'grand-canyon-np',
    canonicalName: 'Grand Canyon',
    aliases: ['grand canyon', 'grand canyon national park'],
    regionHint: 'Arizona, USA',
    gpsBounds: { minLat: 35.95, maxLat: 36.45, minLon: -112.75, maxLon: -111.7 }
  },
  {
    placeId: 'grand-teton-np',
    canonicalName: 'Grand Teton National Park',
    aliases: ['grand teton', 'grand teton national park', 'tetons'],
    regionHint: 'Wyoming, USA',
    gpsBounds: { minLat: 43.62, maxLat: 44.01, minLon: -111.05, maxLon: -110.42 }
  },
  {
    placeId: 'glacier-np',
    canonicalName: 'Glacier National Park',
    aliases: ['glacier national park', 'glacier np'],
    regionHint: 'Montana, USA',
    gpsBounds: { minLat: 48.23, maxLat: 49.0, minLon: -114.48, maxLon: -113.24 }
  },
  {
    placeId: 'zion-np',
    canonicalName: 'Zion National Park',
    aliases: ['zion', 'zion national park'],
    regionHint: 'Utah, USA',
    gpsBounds: { minLat: 37.14, maxLat: 37.51, minLon: -113.19, maxLon: -112.81 }
  },
  {
    placeId: 'bryce-canyon-np',
    canonicalName: 'Bryce Canyon',
    aliases: ['bryce canyon', 'bryce canyon national park'],
    regionHint: 'Utah, USA',
    gpsBounds: { minLat: 37.41, maxLat: 37.71, minLon: -112.31, maxLon: -112.09 }
  },
  {
    placeId: 'banff-np',
    canonicalName: 'Banff National Park',
    aliases: ['banff', 'banff national park'],
    regionHint: 'Alberta, Canada',
    gpsBounds: { minLat: 50.71, maxLat: 52.32, minLon: -117.16, maxLon: -115.17 }
  },
  {
    placeId: 'maui',
    canonicalName: 'Maui',
    aliases: ['maui'],
    regionHint: 'Hawaii, USA',
    gpsBounds: { minLat: 20.56, maxLat: 21.04, minLon: -156.71, maxLon: -155.97 }
  },
  {
    placeId: 'oahu',
    canonicalName: 'Oahu',
    aliases: ['oahu', 'honolulu'],
    regionHint: 'Hawaii, USA',
    gpsBounds: { minLat: 21.25, maxLat: 21.72, minLon: -158.29, maxLon: -157.64 }
  },
  {
    placeId: 'san-francisco',
    canonicalName: 'San Francisco',
    aliases: ['san francisco', 'sf'],
    regionHint: 'California, USA',
    gpsBounds: { minLat: 37.7, maxLat: 37.84, minLon: -122.52, maxLon: -122.35 }
  },
  {
    placeId: 'new-york-city',
    canonicalName: 'New York City',
    aliases: ['new york', 'new york city', 'nyc', 'manhattan'],
    regionHint: 'New York, USA',
    gpsBounds: { minLat: 40.49, maxLat: 40.92, minLon: -74.26, maxLon: -73.7 }
  },
  {
    placeId: 'seattle',
    canonicalName: 'Seattle',
    aliases: ['seattle'],
    regionHint: 'Washington, USA',
    gpsBounds: { minLat: 47.49, maxLat: 47.74, minLon: -122.44, maxLon: -122.23 }
  },
  {
    placeId: 'denver',
    canonicalName: 'Denver',
    aliases: ['denver'],
    regionHint: 'Colorado, USA',
    gpsBounds: { minLat: 39.61, maxLat: 39.92, minLon: -105.11, maxLon: -104.6 }
  },
  {
    placeId: 'chicago',
    canonicalName: 'Chicago',
    aliases: ['chicago'],
    regionHint: 'Illinois, USA',
    gpsBounds: { minLat: 41.64, maxLat: 42.03, minLon: -87.94, maxLon: -87.52 }
  },
  {
    placeId: 'los-angeles',
    canonicalName: 'Los Angeles',
    aliases: ['los angeles', 'la'],
    regionHint: 'California, USA',
    gpsBounds: { minLat: 33.7, maxLat: 34.34, minLon: -118.67, maxLon: -118.15 }
  },
  {
    placeId: 'austin',
    canonicalName: 'Austin',
    aliases: ['austin'],
    regionHint: 'Texas, USA',
    gpsBounds: { minLat: 30.1, maxLat: 30.52, minLon: -97.94, maxLon: -97.56 }
  },
  {
    placeId: 'boston',
    canonicalName: 'Boston',
    aliases: ['boston'],
    regionHint: 'Massachusetts, USA',
    gpsBounds: { minLat: 42.22, maxLat: 42.4, minLon: -71.19, maxLon: -70.92 }
  },
  {
    placeId: 'tokyo',
    canonicalName: 'Tokyo',
    aliases: ['tokyo'],
    regionHint: 'Japan',
    gpsBounds: { minLat: 35.52, maxLat: 35.9, minLon: 139.55, maxLon: 139.92 }
  },
  {
    placeId: 'london',
    canonicalName: 'London',
    aliases: ['london'],
    regionHint: 'United Kingdom',
    gpsBounds: { minLat: 51.28, maxLat: 51.69, minLon: -0.51, maxLon: 0.34 }
  },
  {
    placeId: 'kyoto',
    canonicalName: 'Kyoto',
    aliases: ['kyoto'],
    regionHint: 'Japan',
    gpsBounds: { minLat: 34.87, maxLat: 35.33, minLon: 135.55, maxLon: 135.88 }
  },
  {
    placeId: 'rome',
    canonicalName: 'Rome',
    aliases: ['rome', 'roma'],
    regionHint: 'Italy',
    gpsBounds: { minLat: 41.79, maxLat: 41.99, minLon: 12.36, maxLon: 12.62 }
  },
  // Intentionally ambiguous place names requiring offline disambiguation
  {
    placeId: 'springfield-il',
    canonicalName: 'Springfield, Illinois',
    aliases: ['springfield, il', 'springfield illinois'],
    ambiguousGroup: 'springfield',
    regionHint: 'Illinois, USA',
    gpsBounds: { minLat: 39.71, maxLat: 39.88, minLon: -89.76, maxLon: -89.56 }
  },
  {
    placeId: 'springfield-mo',
    canonicalName: 'Springfield, Missouri',
    aliases: ['springfield, mo', 'springfield missouri'],
    ambiguousGroup: 'springfield',
    regionHint: 'Missouri, USA',
    gpsBounds: { minLat: 37.11, maxLat: 37.29, minLon: -93.39, maxLon: -93.2 }
  },
  {
    placeId: 'springfield-or',
    canonicalName: 'Springfield, Oregon',
    aliases: ['springfield, or', 'springfield oregon'],
    ambiguousGroup: 'springfield',
    regionHint: 'Oregon, USA',
    gpsBounds: { minLat: 44.01, maxLat: 44.09, minLon: -123.04, maxLon: -122.91 }
  },
  {
    placeId: 'springfield-ma',
    canonicalName: 'Springfield, Massachusetts',
    aliases: ['springfield, ma', 'springfield massachusetts'],
    ambiguousGroup: 'springfield',
    regionHint: 'Massachusetts, USA',
    gpsBounds: { minLat: 42.06, maxLat: 42.16, minLon: -72.62, maxLon: -72.47 }
  },
  {
    placeId: 'portland-or',
    canonicalName: 'Portland, Oregon',
    aliases: ['portland, or', 'portland oregon'],
    ambiguousGroup: 'portland',
    regionHint: 'Oregon, USA',
    gpsBounds: { minLat: 45.43, maxLat: 45.65, minLon: -122.84, maxLon: -122.47 }
  },
  {
    placeId: 'portland-me',
    canonicalName: 'Portland, Maine',
    aliases: ['portland, me', 'portland maine'],
    ambiguousGroup: 'portland',
    regionHint: 'Maine, USA',
    gpsBounds: { minLat: 43.62, maxLat: 43.73, minLon: -70.35, maxLon: -70.18 }
  },
  {
    placeId: 'paris-fr',
    canonicalName: 'Paris, France',
    aliases: ['paris, france', 'paris france'],
    ambiguousGroup: 'paris',
    regionHint: 'France',
    gpsBounds: { minLat: 48.81, maxLat: 48.91, minLon: 2.22, maxLon: 2.47 }
  },
  {
    placeId: 'paris-tx',
    canonicalName: 'Paris, Texas',
    aliases: ['paris, tx', 'paris texas'],
    ambiguousGroup: 'paris',
    regionHint: 'Texas, USA',
    gpsBounds: { minLat: 33.62, maxLat: 33.71, minLon: -95.61, maxLon: -95.48 }
  },
  {
    placeId: 'jackson-wy',
    canonicalName: 'Jackson, Wyoming',
    aliases: ['jackson, wy', 'jackson hole', 'jackson wyoming'],
    ambiguousGroup: 'jackson',
    regionHint: 'Wyoming, USA',
    gpsBounds: { minLat: 43.44, maxLat: 43.52, minLon: -110.82, maxLon: -110.71 }
  },
  {
    placeId: 'jackson-ms',
    canonicalName: 'Jackson, Mississippi',
    aliases: ['jackson, ms', 'jackson mississippi'],
    ambiguousGroup: 'jackson',
    regionHint: 'Mississippi, USA',
    gpsBounds: { minLat: 32.22, maxLat: 32.42, minLon: -90.29, maxLon: -90.08 }
  }
]

export function normalizePlaceTerm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isPointInBoundingBox(lat: number, lon: number, bounds: GpsBoundingBox): boolean {
  if (lat < bounds.minLat || lat > bounds.maxLat) return false
  if (bounds.minLon <= bounds.maxLon) {
    return lon >= bounds.minLon && lon <= bounds.maxLon
  }
  return lon >= bounds.minLon || lon <= bounds.maxLon
}

export interface OfflinePlaceMatch {
  readonly placeId: string
  readonly label: string
  readonly source: 'saved_place' | 'offline_gazetteer'
  readonly regionHint: string
  readonly gpsBounds: GpsBoundingBox | null
  readonly savedPlaceId: number | null
}

export type OfflinePlaceResolution =
  | { readonly status: 'resolved'; readonly match: OfflinePlaceMatch }
  | {
      readonly status: 'ambiguous'
      readonly term: string
      readonly options: readonly OfflinePlaceMatch[]
    }
  | { readonly status: 'not_found'; readonly term: string }

function toSavedPlaceMatch(place: SavedPlaceRecord): OfflinePlaceMatch {
  return {
    placeId: `saved:${place.id}`,
    label: place.name,
    source: 'saved_place',
    regionHint: place.notes?.trim() ? place.notes.trim() : 'User-saved place',
    gpsBounds: {
      minLat: place.minLat,
      maxLat: place.maxLat,
      minLon: place.minLon,
      maxLon: place.maxLon
    },
    savedPlaceId: place.id
  }
}

function toGazetteerMatch(entry: GazetteerPlaceEntry): OfflinePlaceMatch {
  return {
    placeId: entry.placeId,
    label: entry.canonicalName,
    source: 'offline_gazetteer',
    regionHint: entry.regionHint,
    gpsBounds: entry.gpsBounds,
    savedPlaceId: null
  }
}

export function resolveOfflinePlace(
  rawTerm: string,
  savedPlaces: readonly SavedPlaceRecord[]
): OfflinePlaceResolution {
  const normalized = normalizePlaceTerm(rawTerm)
  if (!normalized) {
    return { status: 'not_found', term: rawTerm }
  }

  // 1. User-saved places always take precedence so user definitions resolve immediately
  for (const place of savedPlaces) {
    if (normalizePlaceTerm(place.name) === normalized) {
      return { status: 'resolved', match: toSavedPlaceMatch(place) }
    }
  }

  // 2. Exact match on unique built-in entry (or explicit "Springfield, Illinois")
  const exactEntry = OFFLINE_GAZETTEER_PLACES.find(
    (entry) =>
      normalizePlaceTerm(entry.canonicalName) === normalized ||
      entry.aliases.some((alias) => normalizePlaceTerm(alias) === normalized)
  )
  if (exactEntry) {
    return { status: 'resolved', match: toGazetteerMatch(exactEntry) }
  }

  // 3. Ambiguous bare group (e.g., "Springfield", "Portland", "Paris", "Jackson")
  const ambiguousMatches = OFFLINE_GAZETTEER_PLACES.filter(
    (entry) => entry.ambiguousGroup === normalized
  )
  if (ambiguousMatches.length > 1) {
    return {
      status: 'ambiguous',
      term: rawTerm.trim(),
      options: ambiguousMatches.map(toGazetteerMatch)
    }
  }

  return { status: 'not_found', term: rawTerm.trim() }
}

export function listAllKnownGazetteerAliases(): readonly string[] {
  const seen = new Set<string>()
  for (const entry of OFFLINE_GAZETTEER_PLACES) {
    seen.add(normalizePlaceTerm(entry.canonicalName))
    for (const alias of entry.aliases) {
      seen.add(normalizePlaceTerm(alias))
    }
    if (entry.ambiguousGroup) {
      seen.add(entry.ambiguousGroup)
    }
  }
  return Array.from(seen).sort((a, b) => b.length - a.length)
}

export function matchGpsToOfflinePlaces(
  lat: number,
  lon: number,
  savedPlaces: readonly SavedPlaceRecord[] = []
): readonly OfflinePlaceMatch[] {
  const matches: OfflinePlaceMatch[] = []
  for (const place of savedPlaces) {
    if (
      place.minLat !== null &&
      place.maxLat !== null &&
      place.minLon !== null &&
      place.maxLon !== null
    ) {
      const bounds: GpsBoundingBox = {
        minLat: place.minLat,
        maxLat: place.maxLat,
        minLon: place.minLon,
        maxLon: place.maxLon
      }
      if (isPointInBoundingBox(lat, lon, bounds)) {
        matches.push(toSavedPlaceMatch(place))
      }
    }
  }

  for (const entry of OFFLINE_GAZETTEER_PLACES) {
    if (isPointInBoundingBox(lat, lon, entry.gpsBounds)) {
      matches.push(toGazetteerMatch(entry))
    }
  }
  return matches
}
