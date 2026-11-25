// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  interpretPhotoQuery,
  matchGpsToOfflinePlaces,
  resolveOfflinePlace
} from '../../src/main/services/search'
import type {
  CameraLabelRecord,
  PhotoMetadataFacetItem,
  SavedEventRecord,
  SavedPlaceRecord
} from '../../src/main/services/catalog/types'

const KNOWN_CAMERAS: PhotoMetadataFacetItem[] = [
  { normalizedValue: 'apple iphone 15 pro', displayLabel: 'Apple iPhone 15 Pro', count: 12 },
  { normalizedValue: 'canon eos r5', displayLabel: 'Canon EOS R5', count: 8 },
  { normalizedValue: 'sony ilce-7m4', displayLabel: 'Sony ILCE-7M4', count: 4 }
]

const NO_EVENTS: SavedEventRecord[] = []
const NO_PLACES: SavedPlaceRecord[] = []
const NO_CAMERA_LABELS: CameraLabelRecord[] = []

describe('Offline gazetteer & photo query parser', () => {
  it('interprets "Yellowstone in 2025" as resolved GPS place + 2025 date with no visual terms', () => {
    const res = interpretPhotoQuery({
      queryText: 'Yellowstone in 2025',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })

    expect(res.clarification).toBeNull()
    expect(res.interpretedFilters.place).toEqual({
      label: 'Yellowstone National Park',
      normalizedLabel: 'yellowstone national park',
      source: 'offline_gazetteer',
      savedPlaceId: null,
      gpsBounds: {
        minLat: 44.131,
        maxLat: 45.111,
        minLon: -111.156,
        maxLon: -109.825
      }
    })
    expect(res.interpretedFilters.date).toEqual({
      mode: 'year',
      label: '2025',
      captureDateFrom: '2025-01-01',
      captureDateTo: '2025-12-31'
    })
    expect(res.interpretedFilters.visualTerms).toBeNull()
  })

  it('interprets "Mountains in Yellowstone" with place filter extracted before remaining visual terms', () => {
    const res = interpretPhotoQuery({
      queryText: 'Mountains in Yellowstone',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })

    expect(res.clarification).toBeNull()
    expect(res.interpretedFilters.place?.label).toBe('Yellowstone National Park')
    expect(res.interpretedFilters.place?.gpsBounds).toBeTruthy()
    expect(res.interpretedFilters.visualTerms).toBe('Mountains')
  })

  it('interprets "June 6 of any year" as recurring month+day filter', () => {
    const res = interpretPhotoQuery({
      queryText: 'June 6 of any year',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })

    expect(res.clarification).toBeNull()
    expect(res.interpretedFilters.date).toEqual({
      mode: 'recurring_month_day',
      label: 'June 6 (any year)',
      captureMonth: 6,
      captureDay: 6
    })
    expect(res.interpretedFilters.visualTerms).toBeNull()
  })

  it('prompts the user when "My wedding week" is undefined, then resolves once saved', () => {
    const undefinedRes = interpretPhotoQuery({
      queryText: 'My wedding week',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })

    expect(undefinedRes.clarification).toEqual({
      kind: 'define_event',
      term: 'My wedding week',
      message:
        'No saved date range exists yet for "My wedding week". Enter start and end dates to save this event offline.',
      options: []
    })

    const savedEvents: SavedEventRecord[] = [
      {
        id: 1,
        name: 'My wedding week',
        normalizedName: 'my wedding week',
        dateFrom: '2024-09-10',
        dateTo: '2024-09-16',
        notes: null,
        createdAtMs: 1000,
        updatedAtMs: 1000
      }
    ]
    const savedRes = interpretPhotoQuery({
      queryText: 'sunset during My wedding week',
      savedEvents,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })

    expect(savedRes.clarification).toBeNull()
    expect(savedRes.interpretedFilters.date).toEqual({
      mode: 'saved_event',
      label: 'My wedding week (2024-09-10 to 2024-09-16)',
      captureDateFrom: '2024-09-10',
      captureDateTo: '2024-09-16',
      eventName: 'My wedding week'
    })
    expect(savedRes.interpretedFilters.visualTerms).toBe('sunset')
  })

  it('disambiguates ambiguous offline places like "Springfield" without external network calls', () => {
    const res = interpretPhotoQuery({
      queryText: 'Springfield in 2024',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })

    expect(res.clarification?.kind).toBe('disambiguate_place')
    expect(res.clarification?.options.map((o) => o.label)).toContain('Springfield, Illinois')
    expect(res.clarification?.options.map((o) => o.label)).toContain('Springfield, Missouri')
    expect(res.interpretedFilters.date?.captureDateFrom).toBe('2024-01-01')
  })

  it('asks the user to define unknown explicit places like "in Atlantis" while keeping visual prepositions intact', () => {
    const unknownPlace = interpretPhotoQuery({
      queryText: 'dinner in Atlantis',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })
    expect(unknownPlace.clarification?.kind).toBe('define_place')
    expect(unknownPlace.clarification?.term).toBe('Atlantis')

    const visualContext = interpretPhotoQuery({
      queryText: 'dog in snow',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })
    expect(visualContext.clarification).toBeNull()
    expect(visualContext.interpretedFilters.place).toBeNull()
    expect(visualContext.interpretedFilters.visualTerms).toBe('dog in snow')
  })

  it('supports explicit camera models and user camera labels without inferring ownership from make/model alone', () => {
    const inferredOwnership = interpretPhotoQuery({
      queryText: "Sarah's iPhone in Yosemite",
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })
    expect(inferredOwnership.interpretedFilters.camera).toBeNull()
    expect(inferredOwnership.interpretedFilters.place?.label).toBe('Yosemite National Park')

    const explicitModel = interpretPhotoQuery({
      queryText: 'Yellowstone on Canon EOS R5 in 2025',
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: NO_CAMERA_LABELS
    })
    expect(explicitModel.interpretedFilters.camera).toEqual({
      label: 'Canon EOS R5',
      cameraNormalized: 'canon eos r5',
      source: 'explicit_camera_model'
    })
    expect(explicitModel.interpretedFilters.place?.label).toBe('Yellowstone National Park')
    expect(explicitModel.interpretedFilters.date?.label).toBe('2025')
    expect(explicitModel.interpretedFilters.visualTerms).toBeNull()

    const userLabels: CameraLabelRecord[] = [
      {
        id: 1,
        cameraNormalized: 'apple iphone 15 pro',
        label: "Sarah's Phone",
        normalizedLabel: "sarah's phone",
        createdAtMs: 1000,
        updatedAtMs: 1000
      }
    ]
    const explicitUserLabel = interpretPhotoQuery({
      queryText: "sunset with Sarah's Phone in Yellowstone",
      savedEvents: NO_EVENTS,
      savedPlaces: NO_PLACES,
      knownCameras: KNOWN_CAMERAS,
      cameraLabels: userLabels
    })
    expect(explicitUserLabel.interpretedFilters.camera).toEqual({
      label: "Sarah's Phone (apple iphone 15 pro)",
      cameraNormalized: 'apple iphone 15 pro',
      source: 'user_camera_label'
    })
    expect(explicitUserLabel.interpretedFilters.place?.label).toBe('Yellowstone National Park')
    expect(explicitUserLabel.interpretedFilters.visualTerms).toBe('sunset')
  })

  it('matches Old Faithful coordinates to Yellowstone offline and prioritizes saved places', () => {
    const gpsMatches = matchGpsToOfflinePlaces(44.4605, -110.8281)
    expect(gpsMatches.map((m) => m.label)).toContain('Yellowstone National Park')

    const customPlace: SavedPlaceRecord = {
      id: 4,
      name: 'Grandma Cabin',
      normalizedName: 'grandma cabin',
      minLat: 38.9,
      maxLat: 39.2,
      minLon: -120.2,
      maxLon: -119.9,
      centerLat: 39.05,
      centerLon: -120.05,
      radiusKm: null,
      notes: 'Lake Tahoe',
      createdAtMs: 1000,
      updatedAtMs: 1000
    }
    const resolved = resolveOfflinePlace('Grandma Cabin', [customPlace])
    expect(resolved.status).toBe('resolved')
    if (resolved.status === 'resolved') {
      expect(resolved.match.savedPlaceId).toBe(4)
      expect(resolved.match.source).toBe('saved_place')
    }
  })
})
