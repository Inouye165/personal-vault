import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent
} from 'react'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  Info,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type {
  OpenInDefaultPlayerResponse,
  OriginalPhotoResult,
  PhotoItem,
  VideoContainerDto,
  VideoPlaybackResult
} from '../../../shared/validation/ipc-schemas'

export function formatMediaDuration(durationMs: number | null | undefined): string | null {
  if (
    durationMs === null ||
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return null
  }
  return formatSeconds(Math.round(durationMs / 1000))
}

export function formatSeconds(totalSecondsInput: number): string {
  if (!Number.isFinite(totalSecondsInput) || totalSecondsInput < 0) {
    return '0:00'
  }
  const totalSeconds = Math.floor(totalSecondsInput)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatContainerLabel(container: VideoContainerDto | null | undefined): string {
  switch (container) {
    case 'quicktime':
      return 'QuickTime (MOV)'
    case 'mp4':
      return 'MP4'
    case 'webm':
      return 'WebM'
    default:
      return 'Video'
  }
}

export function hasMismatchedVideoExtension(
  item: Pick<PhotoItem, 'mediaKind' | 'extension' | 'videoContainer'>
): boolean {
  if (item.mediaKind !== 'video' || !item.videoContainer) return false
  const ext = item.extension.toLowerCase()
  const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm'])
  return !videoExtensions.has(ext)
}

function buildUnsupportedVideoMessage(
  container: VideoContainerDto | null | undefined,
  videoCodec: string | null | undefined
): string {
  const codecLower = (videoCodec ?? '').toLowerCase()
  if (codecLower === 'hevc' || codecLower === 'hvc1' || codecLower === 'hev1') {
    return 'This video uses HEVC (H.265) encoding, which the packaged Windows player cannot decode in-app without platform HEVC codec support. You can open a read-only copy in your default Windows media player instead.'
  }
  return `The in-app player could not decode this ${formatContainerLabel(container)} video${videoCodec ? ` (${videoCodec})` : ''}. You can try opening it in your system default media player instead.`
}

const MIN_ZOOM_SCALE = 0.1
const MAX_ZOOM_SCALE = 8
const ZOOM_STEP_FACTOR = 1.25

function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale))
}

export interface MediaViewerModalProps {
  readonly open: boolean
  readonly items: readonly PhotoItem[]
  readonly getItemAtIndex: (index: number) => PhotoItem | undefined
  readonly totalCount: number
  readonly currentIndex: number | null
  readonly onNavigate: (nextIndex: number) => void
  readonly onClose: () => void
  readonly onOpenDetails: (item: PhotoItem) => void
  readonly ensureRangeLoaded?: (startIndex: number, endIndex: number) => void
  readonly restoreFocusTo?: () => HTMLElement | null
}

interface MediaViewerItemContentProps {
  readonly item: PhotoItem
  readonly currentIndex: number
  readonly totalCount: number
  readonly hasPrev: boolean
  readonly hasNext: boolean
  readonly onNavigatePrev: () => void
  readonly onNavigateNext: () => void
  readonly onClose: () => void
  readonly onOpenDetails: (item: PhotoItem) => void
}

function MediaViewerItemContent({
  item,
  currentIndex,
  totalCount,
  hasPrev,
  hasNext,
  onNavigatePrev,
  onNavigateNext,
  onClose,
  onOpenDetails
}: MediaViewerItemContentProps): ReactElement {
  const isVideo = item.mediaKind === 'video'
  const stageRef = useRef<HTMLDivElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const dragRef = useRef<{
    active: boolean
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  const hasOriginalPhotoApi = Boolean(window.api?.getOriginalPhoto)
  const hasVideoPlaybackApi = Boolean(window.api?.prepareVideoPlayback)

  // Photo state (initialized cleanly per keyed item)
  const [photoLoading, setPhotoLoading] = useState(!isVideo && hasOriginalPhotoApi)
  const [photoResult, setPhotoResult] = useState<OriginalPhotoResult | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(
    !isVideo && !hasOriginalPhotoApi ? 'Original photograph viewer API is unavailable.' : null
  )
  const [zoomMode, setZoomMode] = useState<'fit' | 'zoom'>('fit')
  const [zoomScale, setZoomScale] = useState<number>(1)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0
  })

  // Video state (initialized cleanly per keyed item)
  const [videoLoading, setVideoLoading] = useState(isVideo && hasVideoPlaybackApi)
  const [videoResult, setVideoResult] = useState<VideoPlaybackResult | null>(null)
  const [videoError, setVideoError] = useState<string | null>(
    isVideo && !hasVideoPlaybackApi ? 'Video playback API is unavailable.' : null
  )
  const [runtimeVideoFailure, setRuntimeVideoFailure] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTimeSec, setCurrentTimeSec] = useState(0)
  const [durationSec, setDurationSec] = useState(
    item.videoDurationMs !== null && item.videoDurationMs !== undefined
      ? item.videoDurationMs / 1000
      : 0
  )
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [defaultPlayerBusy, setDefaultPlayerBusy] = useState(false)
  const [defaultPlayerFeedback, setDefaultPlayerFeedback] =
    useState<OpenInDefaultPlayerResponse | null>(null)

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange)
    }
  }, [])

  // Track stage size for responsive Fit scale calculation
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const rect = el.getBoundingClientRect()
      setStageSize({ width: rect.width, height: rect.height })
    }
    update()
    const obs = new ResizeObserver(update)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Fetch original photograph or prepare video playback token cleanly
  useEffect(() => {
    let cancelled = false
    let issuedToken: string | null = null

    if (isVideo) {
      if (window.api?.prepareVideoPlayback) {
        void window.api
          .prepareVideoPlayback({ locationId: item.id })
          .then((res) => {
            if (cancelled) {
              if (res.status === 'ready') {
                void window.api?.revokeVideoPlaybackToken?.({ token: res.token })
              }
              return
            }
            setVideoLoading(false)
            setVideoResult(res)
            if (res.status === 'ready') {
              issuedToken = res.token
              if (res.durationMs !== null) {
                setDurationSec(res.durationMs / 1000)
              }
            } else {
              setVideoError(res.reason)
            }
          })
          .catch((err: unknown) => {
            if (cancelled) return
            setVideoLoading(false)
            setVideoError(err instanceof Error ? err.message : 'Failed to prepare video playback')
          })
      }
    } else if (window.api?.getOriginalPhoto) {
      void window.api
        .getOriginalPhoto({ locationId: item.id })
        .then((res) => {
          if (cancelled) return
          setPhotoLoading(false)
          setPhotoResult(res)
          if (res.status !== 'ready') {
            setPhotoError(res.reason)
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setPhotoLoading(false)
          setPhotoError(err instanceof Error ? err.message : 'Failed to load full photograph')
        })
    }

    return () => {
      cancelled = true
      if (issuedToken) {
        void window.api?.revokeVideoPlaybackToken?.({ token: issuedToken })
      }
    }
  }, [item.id, isVideo])

  const readyPhoto = photoResult?.status === 'ready' ? photoResult : null
  const fitRatio =
    readyPhoto && stageSize.width > 0 && stageSize.height > 0
      ? Math.min(stageSize.width / readyPhoto.width, stageSize.height / readyPhoto.height, 1)
      : 1

  const setFitView = useCallback(() => {
    setZoomMode('fit')
    setZoomScale(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const setActualSizeView = useCallback(() => {
    setZoomMode('zoom')
    setZoomScale(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const handleZoomIn = useCallback(() => {
    setZoomMode('zoom')
    setZoomScale((prev) => {
      const base = zoomMode === 'fit' ? fitRatio : prev
      return clampZoom(base * ZOOM_STEP_FACTOR)
    })
  }, [zoomMode, fitRatio])

  const handleZoomOut = useCallback(() => {
    setZoomMode('zoom')
    setZoomScale((prev) => {
      const base = zoomMode === 'fit' ? fitRatio : prev
      return clampZoom(base / ZOOM_STEP_FACTOR)
    })
  }, [zoomMode, fitRatio])

  const handleStageWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (isVideo || !readyPhoto) return
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const base = zoomMode === 'fit' ? fitRatio : zoomScale
      setZoomMode('zoom')
      setZoomScale(clampZoom(base * factor))
    },
    [isVideo, readyPhoto, zoomMode, fitRatio, zoomScale]
  )

  const handleStageDoubleClick = useCallback(() => {
    if (isVideo || !readyPhoto) return
    if (zoomMode === 'fit') {
      setActualSizeView()
    } else {
      setFitView()
    }
  }, [isVideo, readyPhoto, zoomMode, setActualSizeView, setFitView])

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (isVideo || zoomMode !== 'zoom' || e.button !== 0) return
      e.preventDefault()
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        originX: pan.x,
        originY: pan.y
      }
      setIsDragging(true)
    },
    [isVideo, zoomMode, pan.x, pan.y]
  )

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag?.active) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      const maxX = readyPhoto ? Math.max(240, readyPhoto.width * zoomScale) : 600
      const maxY = readyPhoto ? Math.max(240, readyPhoto.height * zoomScale) : 600
      setPan({
        x: Math.max(-maxX, Math.min(maxX, drag.originX + dx)),
        y: Math.max(-maxY, Math.min(maxY, drag.originY + dy))
      })
    },
    [readyPhoto, zoomScale]
  )

  const handleMouseEnd = useCallback(() => {
    if (!dragRef.current?.active) return
    dragRef.current = null
    setIsDragging(false)
  }, [])

  const togglePlayPause = useCallback(() => {
    const videoEl = videoRef.current
    if (!videoEl) return
    if (videoEl.paused) {
      const playPromise = videoEl.play?.()
      if (playPromise && typeof playPromise.catch === 'function') {
        void playPromise.catch((err: unknown) => {
          setRuntimeVideoFailure(
            err instanceof Error ? err.message : 'Unable to start video playback inside the app.'
          )
        })
      }
    } else {
      videoEl.pause?.()
    }
  }, [])

  const toggleMute = useCallback(() => {
    const videoEl = videoRef.current
    const nextMuted = !isMuted
    if (videoEl) {
      videoEl.muted = nextMuted
    }
    setIsMuted(nextMuted)
  }, [isMuted])

  const handleVolumeChange = useCallback((nextVol: number) => {
    const clamped = Math.max(0, Math.min(1, nextVol))
    const videoEl = videoRef.current
    if (videoEl) {
      videoEl.volume = clamped
      videoEl.muted = clamped === 0
    }
    setVolume(clamped)
    setIsMuted(clamped === 0)
  }, [])

  const handleSeek = useCallback((nextTimeSec: number) => {
    const videoEl = videoRef.current
    if (videoEl && Number.isFinite(nextTimeSec)) {
      videoEl.currentTime = nextTimeSec
    }
    setCurrentTimeSec(nextTimeSec)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const container = videoContainerRef.current
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {})
      return
    }
    if (container && typeof container.requestFullscreen === 'function') {
      void container.requestFullscreen().catch(() => {})
    }
  }, [])

  const handleOpenInDefaultPlayer = useCallback(async () => {
    if (!window.api?.openMediaInDefaultPlayer) return
    setDefaultPlayerBusy(true)
    setDefaultPlayerFeedback(null)
    try {
      const res = await window.api.openMediaInDefaultPlayer({ locationId: item.id })
      setDefaultPlayerFeedback(res)
    } catch (err: unknown) {
      setDefaultPlayerFeedback({
        ok: false,
        usedTemporaryCopy: false,
        launchedFileName: null,
        error: err instanceof Error ? err.message : 'Failed to open in default player'
      })
    } finally {
      setDefaultPlayerBusy(false)
    }
  }, [item.id])

  // Keyboard shortcuts inside modal
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const activeEl = document.activeElement
      const isSliderOrInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement

      if (e.key === 'ArrowLeft' && !isSliderOrInput) {
        e.preventDefault()
        onNavigatePrev()
        return
      }
      if (e.key === 'ArrowRight' && !isSliderOrInput) {
        e.preventDefault()
        onNavigateNext()
        return
      }

      if (isVideo) {
        if (
          (e.key === 'k' ||
            e.key === 'K' ||
            (e.key === ' ' &&
              !(activeEl instanceof HTMLButtonElement) &&
              !isSliderOrInput &&
              !(activeEl instanceof HTMLAnchorElement))) &&
          videoResult?.status === 'ready' &&
          !runtimeVideoFailure
        ) {
          e.preventDefault()
          togglePlayPause()
        } else if (e.key === 'm' || e.key === 'M') {
          if (!isSliderOrInput) {
            e.preventDefault()
            toggleMute()
          }
        } else if (e.key === 'f' || e.key === 'F') {
          if (!isSliderOrInput) {
            e.preventDefault()
            toggleFullscreen()
          }
        }
      } else if (readyPhoto && !isSliderOrInput) {
        if (e.key === '+' || e.key === '=') {
          e.preventDefault()
          handleZoomIn()
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          handleZoomOut()
        } else if (e.key === '0') {
          e.preventDefault()
          setFitView()
        } else if (e.key === '1') {
          e.preventDefault()
          setActualSizeView()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    isVideo,
    onNavigatePrev,
    onNavigateNext,
    videoResult,
    runtimeVideoFailure,
    togglePlayPause,
    toggleMute,
    toggleFullscreen,
    readyPhoto,
    handleZoomIn,
    handleZoomOut,
    setFitView,
    setActualSizeView
  ])

  const mismatchNotice = hasMismatchedVideoExtension(item)
    ? `Identified from file contents as ${formatContainerLabel(item.videoContainer)} video (${item.extension} extension kept untouched).`
    : null

  const readyVideo = videoResult?.status === 'ready' ? videoResult : null
  const failedVideo = videoResult && videoResult.status !== 'ready' ? videoResult : null
  const effectiveDurationSec =
    durationSec > 0
      ? durationSec
      : readyVideo?.durationMs !== null && readyVideo?.durationMs !== undefined
        ? readyVideo.durationMs / 1000
        : item.videoDurationMs !== null && item.videoDurationMs !== undefined
          ? item.videoDurationMs / 1000
          : 0

  const canOpenDefaultOnFailure = Boolean(
    runtimeVideoFailure || (failedVideo && failedVideo.canOpenInDefaultPlayer)
  )

  return (
    <>
      <div className="original-photo-header media-viewer-header">
        <div className="original-photo-title">
          <strong title={item.fileName}>{item.fileName}</strong>
          {totalCount > 0 && (
            <span className="media-viewer-counter" data-testid="media-viewer-counter">
              {currentIndex + 1} of {totalCount}
            </span>
          )}
          {!isVideo && readyPhoto && (
            <span className="original-photo-dims" data-testid="photos-original-dims">
              {readyPhoto.width} × {readyPhoto.height}
            </span>
          )}
          {isVideo && (
            <span className="original-photo-dims" data-testid="media-viewer-video-dims">
              {formatContainerLabel(readyVideo?.container ?? item.videoContainer)}
              {(readyVideo?.widthPx ?? item.videoWidthPx) &&
              (readyVideo?.heightPx ?? item.videoHeightPx)
                ? ` · ${readyVideo?.widthPx ?? item.videoWidthPx} × ${readyVideo?.heightPx ?? item.videoHeightPx}`
                : ''}
              {(readyVideo?.videoCodec ?? item.videoCodec)
                ? ` · ${String(readyVideo?.videoCodec ?? item.videoCodec).toUpperCase()}`
                : ''}
            </span>
          )}
        </div>

        <div className="media-viewer-toolbar">
          {!isVideo && (
            <div
              className="media-viewer-zoom-controls"
              role="group"
              aria-label="Photo zoom controls"
            >
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="media-viewer-zoom-out"
                aria-label="Zoom out"
                title="Zoom out (-)"
                disabled={!readyPhoto}
                onClick={handleZoomOut}
              >
                <ZoomOut size={14} aria-hidden="true" />
              </button>
              <span className="media-viewer-zoom-readout" data-testid="media-viewer-zoom-level">
                {zoomMode === 'fit' ? 'Fit' : `${Math.round(zoomScale * 100)}%`}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="media-viewer-zoom-in"
                aria-label="Zoom in"
                title="Zoom in (+)"
                disabled={!readyPhoto}
                onClick={handleZoomIn}
              >
                <ZoomIn size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`btn btn-sm ${zoomMode === 'fit' ? 'btn-primary' : 'btn-secondary'}`}
                data-testid="media-viewer-fit-btn"
                aria-pressed={zoomMode === 'fit'}
                disabled={!readyPhoto}
                onClick={setFitView}
              >
                Fit
              </button>
              <button
                type="button"
                className={`btn btn-sm ${
                  zoomMode === 'zoom' && Math.abs(zoomScale - 1) < 0.001
                    ? 'btn-primary'
                    : 'btn-secondary'
                }`}
                data-testid="media-viewer-100-btn"
                aria-pressed={zoomMode === 'zoom' && Math.abs(zoomScale - 1) < 0.001}
                disabled={!readyPhoto}
                onClick={setActualSizeView}
              >
                100%
              </button>
            </div>
          )}

          <div className="media-viewer-nav-controls">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="media-viewer-prev-btn"
              aria-label="Previous item"
              disabled={!hasPrev}
              onClick={onNavigatePrev}
            >
              <ChevronLeft size={15} aria-hidden="true" />
              <span>Previous</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="media-viewer-next-btn"
              aria-label="Next item"
              disabled={!hasNext}
              onClick={onNavigateNext}
            >
              <span>Next</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="media-viewer-details-btn"
            onClick={() => onOpenDetails(item)}
          >
            <Info size={14} aria-hidden="true" />
            <span>Details</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="photos-original-close-btn"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
            <span>Close</span>
          </button>
        </div>
      </div>

      {!isVideo && readyPhoto?.sourceKind === 'cached_preview' && (
        <div
          className="media-viewer-banner media-viewer-banner-warning"
          data-testid="media-viewer-cached-notice"
          role="status"
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {readyPhoto.notice ??
              'Showing a cached preview only. The original file is currently unavailable and no verified vault copy was found.'}
          </span>
        </div>
      )}

      {readyPhoto?.sourceKind === 'vault_copy' && (
        <div
          className="media-viewer-banner media-viewer-banner-info"
          data-testid="media-viewer-source-notice"
          role="status"
        >
          <Info size={16} aria-hidden="true" />
          <span>{readyPhoto.notice ?? 'Showing your verified vault copy.'}</span>
        </div>
      )}

      {isVideo && readyVideo?.sourceKind === 'vault_copy' && (
        <div
          className="media-viewer-banner media-viewer-banner-info"
          data-testid="media-viewer-source-notice"
          role="status"
        >
          <Info size={16} aria-hidden="true" />
          <span>{readyVideo.notice ?? 'Playing your verified vault copy.'}</span>
        </div>
      )}

      {mismatchNotice && (
        <div className="media-viewer-banner media-viewer-banner-info" role="status">
          <Film size={16} aria-hidden="true" />
          <span>{mismatchNotice}</span>
        </div>
      )}

      <div className="original-photo-body media-viewer-body">
        {!isVideo && (
          <div
            ref={stageRef}
            className={`media-viewer-stage ${
              zoomMode === 'zoom' ? (isDragging ? 'is-dragging' : 'is-pannable') : 'is-fit'
            }`}
            data-testid="media-viewer-stage"
            onWheel={handleStageWheel}
            onDoubleClick={handleStageDoubleClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseEnd}
            onMouseLeave={handleMouseEnd}
          >
            {photoLoading && (
              <p className="original-photo-status" role="status">
                Loading full-resolution photograph…
              </p>
            )}
            {!photoLoading && photoError && (
              <p
                className="original-photo-error error-text"
                data-testid="photos-original-error"
                role="alert"
              >
                {photoError}
              </p>
            )}
            {!photoLoading && readyPhoto && (
              <img
                src={readyPhoto.dataUrl}
                alt={item.fileName}
                draggable={false}
                data-testid="photos-original-img"
                data-zoom-mode={
                  zoomMode === 'fit' ? 'fit' : Math.abs(zoomScale - 1) < 0.001 ? 'actual' : 'custom'
                }
                data-zoom-scale={zoomMode === 'fit' ? fitRatio.toFixed(2) : zoomScale.toFixed(2)}
                className={`original-photo-img media-viewer-img ${
                  zoomMode === 'fit' ? 'media-viewer-img-fit' : 'media-viewer-img-zoom'
                }`}
                style={
                  zoomMode === 'fit'
                    ? undefined
                    : {
                        width: `${readyPhoto.width}px`,
                        height: `${readyPhoto.height}px`,
                        maxWidth: 'none',
                        maxHeight: 'none',
                        transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoomScale})`,
                        transformOrigin: 'center center'
                      }
                }
              />
            )}
          </div>
        )}

        {isVideo && (
          <div
            ref={videoContainerRef}
            className="video-player-container"
            data-testid="video-player-container"
          >
            {videoLoading && (
              <p className="original-photo-status" role="status">
                Preparing video playback…
              </p>
            )}

            {!videoLoading && (videoError || runtimeVideoFailure) && (
              <div className="video-fallback-card" data-testid="video-fallback-panel" role="alert">
                <AlertTriangle size={28} aria-hidden="true" />
                <div className="video-fallback-content">
                  <strong>
                    {failedVideo?.status === 'missing'
                      ? 'Video file unavailable'
                      : failedVideo?.status === 'corrupt'
                        ? 'Unreadable video file'
                        : 'Cannot play this video inside the app'}
                  </strong>
                  <p data-testid="photos-original-error">{runtimeVideoFailure ?? videoError}</p>
                  {canOpenDefaultOnFailure && (
                    <div className="video-fallback-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        data-testid="video-open-default-player-btn"
                        disabled={defaultPlayerBusy}
                        onClick={() => void handleOpenInDefaultPlayer()}
                      >
                        <ExternalLink size={14} aria-hidden="true" />
                        <span>
                          {defaultPlayerBusy ? 'Opening default player…' : 'Open in default player'}
                        </span>
                      </button>
                    </div>
                  )}
                  {defaultPlayerFeedback && (
                    <p
                      className={defaultPlayerFeedback.ok ? 'sub-text' : 'error-text'}
                      data-testid="video-default-player-feedback"
                      role="status"
                    >
                      {defaultPlayerFeedback.ok
                        ? (defaultPlayerFeedback.message ??
                          `Opened ${defaultPlayerFeedback.launchedFileName ?? item.fileName} in your default media player.`)
                        : (defaultPlayerFeedback.error ?? 'Could not launch default player.')}
                    </p>
                  )}
                </div>
              </div>
            )}

            {!videoLoading && readyVideo && !runtimeVideoFailure && (
              <>
                <div className="video-element-wrapper">
                  <video
                    ref={videoRef}
                    className="video-player-element"
                    data-testid="media-viewer-video"
                    src={readyVideo.streamUrl}
                    playsInline
                    preload="metadata"
                    onClick={togglePlayPause}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                    onTimeUpdate={(e) => {
                      setCurrentTimeSec(e.currentTarget.currentTime || 0)
                    }}
                    onDurationChange={(e) => {
                      const dur = e.currentTarget.duration
                      if (Number.isFinite(dur) && dur > 0) {
                        setDurationSec(dur)
                      }
                    }}
                    onVolumeChange={(e) => {
                      setVolume(e.currentTarget.volume)
                      setIsMuted(e.currentTarget.muted)
                    }}
                    onLoadedMetadata={(e) => {
                      const el = e.currentTarget
                      if (Number.isFinite(el.duration) && el.duration > 0) {
                        setDurationSec(el.duration)
                      }
                      if (
                        readyVideo.hasVideoTrack &&
                        el.readyState >= 2 &&
                        el.videoWidth === 0 &&
                        el.videoHeight === 0
                      ) {
                        setRuntimeVideoFailure(
                          buildUnsupportedVideoMessage(readyVideo.container, readyVideo.videoCodec)
                        )
                      }
                    }}
                    onLoadedData={(e) => {
                      const el = e.currentTarget
                      if (readyVideo.hasVideoTrack && el.videoWidth === 0 && el.videoHeight === 0) {
                        setRuntimeVideoFailure(
                          buildUnsupportedVideoMessage(readyVideo.container, readyVideo.videoCodec)
                        )
                      }
                    }}
                    onCanPlay={(e) => {
                      const el = e.currentTarget
                      if (readyVideo.hasVideoTrack && el.videoWidth === 0 && el.videoHeight === 0) {
                        setRuntimeVideoFailure(
                          buildUnsupportedVideoMessage(readyVideo.container, readyVideo.videoCodec)
                        )
                      }
                    }}
                    onError={() => {
                      setRuntimeVideoFailure(
                        buildUnsupportedVideoMessage(readyVideo.container, readyVideo.videoCodec)
                      )
                    }}
                  />
                </div>

                <div className="video-controls-bar" data-testid="video-controls-bar">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    data-testid="video-play-pause-btn"
                    aria-label={isPlaying ? 'Pause video' : 'Play video'}
                    onClick={togglePlayPause}
                  >
                    {isPlaying ? (
                      <Pause size={15} aria-hidden="true" />
                    ) : (
                      <Play size={15} aria-hidden="true" />
                    )}
                    <span>{isPlaying ? 'Pause' : 'Play'}</span>
                  </button>

                  <input
                    type="range"
                    className="video-seek-slider"
                    data-testid="video-seek-slider"
                    aria-label="Seek video"
                    min={0}
                    max={effectiveDurationSec > 0 ? effectiveDurationSec : 0}
                    step={0.1}
                    value={Math.min(
                      currentTimeSec,
                      effectiveDurationSec > 0 ? effectiveDurationSec : 0
                    )}
                    disabled={effectiveDurationSec <= 0}
                    onChange={(e) => handleSeek(Number(e.target.value))}
                  />

                  <span className="video-time-readout" data-testid="video-time-readout">
                    {formatSeconds(currentTimeSec)} / {formatSeconds(effectiveDurationSec)}
                  </span>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    data-testid="video-mute-btn"
                    aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                    onClick={toggleMute}
                  >
                    {isMuted || volume === 0 ? (
                      <VolumeX size={15} aria-hidden="true" />
                    ) : (
                      <Volume2 size={15} aria-hidden="true" />
                    )}
                  </button>

                  <input
                    type="range"
                    className="video-volume-slider"
                    data-testid="video-volume-slider"
                    aria-label="Volume"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => handleVolumeChange(Number(e.target.value))}
                  />

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    data-testid="video-fullscreen-btn"
                    aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                    onClick={toggleFullscreen}
                  >
                    {isFullscreen ? (
                      <Minimize2 size={15} aria-hidden="true" />
                    ) : (
                      <Maximize2 size={15} aria-hidden="true" />
                    )}
                  </button>

                  {readyVideo.canOpenInDefaultPlayer && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      data-testid="video-open-default-player-btn"
                      disabled={defaultPlayerBusy}
                      onClick={() => void handleOpenInDefaultPlayer()}
                    >
                      <ExternalLink size={14} aria-hidden="true" />
                      <span>Open in default player</span>
                    </button>
                  )}
                </div>

                {defaultPlayerFeedback && (
                  <div
                    className={`media-viewer-banner ${
                      defaultPlayerFeedback.ok
                        ? 'media-viewer-banner-info'
                        : 'media-viewer-banner-warning'
                    }`}
                    data-testid="video-default-player-feedback"
                    role="status"
                  >
                    <span>
                      {defaultPlayerFeedback.ok
                        ? (defaultPlayerFeedback.message ??
                          `Opened ${defaultPlayerFeedback.launchedFileName ?? item.fileName} in your default media player.`)
                        : (defaultPlayerFeedback.error ?? 'Could not launch default player.')}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}

export function MediaViewerModal({
  open,
  items,
  getItemAtIndex,
  totalCount,
  currentIndex,
  onNavigate,
  onClose,
  onOpenDetails,
  ensureRangeLoaded,
  restoreFocusTo
}: MediaViewerModalProps): ReactElement | null {
  const modalRef = useRef<HTMLDivElement>(null)
  const currentItem =
    open && currentIndex !== null
      ? (getItemAtIndex(currentIndex) ?? items[currentIndex] ?? null)
      : null

  const handleTrapClose = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {})
      return
    }
    onClose()
  }, [onClose])

  useFocusTrap({
    isOpen: open,
    isModal: open,
    isActive: open,
    containerRef: modalRef,
    onClose: handleTrapClose,
    restoreFocusTo
  })

  // Prefetch adjacent range when navigating across virtualized pages
  useEffect(() => {
    if (!open || currentIndex === null || totalCount <= 0) return
    ensureRangeLoaded?.(Math.max(0, currentIndex - 1), Math.min(totalCount, currentIndex + 2))
  }, [open, currentIndex, totalCount, ensureRangeLoaded])

  const hasPrev = open && currentIndex !== null && currentIndex > 0
  const hasNext = open && currentIndex !== null && currentIndex + 1 < totalCount

  const handleNavigatePrev = useCallback(() => {
    if (!hasPrev || currentIndex === null) return
    onNavigate(currentIndex - 1)
  }, [hasPrev, currentIndex, onNavigate])

  const handleNavigateNext = useCallback(() => {
    if (!hasNext || currentIndex === null) return
    onNavigate(currentIndex + 1)
  }, [hasNext, currentIndex, onNavigate])

  if (!open || !currentItem || currentIndex === null) {
    return null
  }

  return (
    <div
      className="original-photo-backdrop media-viewer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={modalRef}
        className="original-photo-modal media-viewer-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${currentItem.mediaKind === 'video' ? 'Video player' : 'Photo viewer'}: ${currentItem.fileName}`}
        data-testid="photos-original-modal"
        tabIndex={-1}
      >
        <MediaViewerItemContent
          key={currentItem.id}
          item={currentItem}
          currentIndex={currentIndex}
          totalCount={totalCount}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onNavigatePrev={handleNavigatePrev}
          onNavigateNext={handleNavigateNext}
          onClose={onClose}
          onOpenDetails={onOpenDetails}
        />
      </div>
    </div>
  )
}
