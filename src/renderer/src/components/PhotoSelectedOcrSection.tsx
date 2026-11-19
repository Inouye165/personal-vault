import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isSupportedOcrImageExtension,
  type DocumentOcrPreviewPayloadDto,
  type DocumentOcrStateItemDto,
  type OcrModelStatusDto
} from '../../../shared/validation/document-schemas'

export interface PhotoSelectedOcrSectionProps {
  readonly fileLocationId: number
  readonly extension: string
}

export function PhotoSelectedOcrSection({
  fileLocationId,
  extension
}: PhotoSelectedOcrSectionProps) {
  const supported = isSupportedOcrImageExtension(extension)
  const [trackedSelection, setTrackedSelection] = useState(() => ({
    fileLocationId,
    supported
  }))
  const [modelStatus, setModelStatus] = useState<OcrModelStatusDto | null>(null)
  const [ocrState, setOcrState] = useState<DocumentOcrStateItemDto | null>(null)
  const [ocrPreview, setOcrPreview] = useState<DocumentOcrPreviewPayloadDto | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const activeFileLocationIdRef = useRef(fileLocationId)
  const selectionEpochRef = useRef(0)
  const loadRequestSeqRef = useRef(0)
  const actionRequestSeqRef = useRef(0)

  if (
    trackedSelection.fileLocationId !== fileLocationId ||
    trackedSelection.supported !== supported
  ) {
    setTrackedSelection({ fileLocationId, supported })
    setOcrState(null)
    setOcrPreview(null)
    setError(null)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadForPhoto = useCallback(async (id: number, epoch: number) => {
    if (
      !mountedRef.current ||
      activeFileLocationIdRef.current !== id ||
      selectionEpochRef.current !== epoch
    ) {
      return
    }
    if (
      typeof window.api.getDocumentOcrState !== 'function' ||
      typeof window.api.getDocumentOcrPreview !== 'function'
    ) {
      return
    }
    const requestSeq = ++loadRequestSeqRef.current
    try {
      const [stateRes, previewRes] = await Promise.all([
        window.api.getDocumentOcrState({ fileLocationId: id }),
        window.api.getDocumentOcrPreview({ fileLocationId: id })
      ])
      if (
        !mountedRef.current ||
        activeFileLocationIdRef.current !== id ||
        selectionEpochRef.current !== epoch ||
        loadRequestSeqRef.current !== requestSeq
      ) {
        return
      }
      setError(null)
      setOcrState(stateRes.state)
      setOcrPreview(previewRes.preview)
    } catch (err) {
      if (
        !mountedRef.current ||
        activeFileLocationIdRef.current !== id ||
        selectionEpochRef.current !== epoch ||
        loadRequestSeqRef.current !== requestSeq
      ) {
        return
      }
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    activeFileLocationIdRef.current = fileLocationId
    const selectionEpoch = ++selectionEpochRef.current
    if (!supported) return
    let effectCancelled = false

    if (typeof window.api.getOcrModelStatus === 'function') {
      void window.api
        .getOcrModelStatus()
        .then((status) => {
          if (
            !effectCancelled &&
            mountedRef.current &&
            selectionEpochRef.current === selectionEpoch
          ) {
            setModelStatus(status)
          }
        })
        .catch(() => {})
    }
    if (typeof window.api.getDocumentOcrProgress === 'function') {
      void window.api
        .getDocumentOcrProgress()
        .then((progress) => {
          if (
            !effectCancelled &&
            mountedRef.current &&
            selectionEpochRef.current === selectionEpoch
          ) {
            setIsRunning(progress.status === 'running')
          }
        })
        .catch(() => {})
    }
    void Promise.resolve(fileLocationId).then((id) => {
      if (
        !effectCancelled &&
        mountedRef.current &&
        activeFileLocationIdRef.current === id &&
        selectionEpochRef.current === selectionEpoch
      ) {
        void loadForPhoto(id, selectionEpoch)
      }
    })

    const unsubModel =
      typeof window.api.onOcrModelStatus === 'function'
        ? window.api.onOcrModelStatus((status) => {
            if (!effectCancelled && mountedRef.current) setModelStatus(status)
          })
        : undefined
    const unsubOcr =
      typeof window.api.onDocumentOcrProgress === 'function'
        ? window.api.onDocumentOcrProgress((progress) => {
            if (effectCancelled || !mountedRef.current) return
            setIsRunning(progress.status === 'running')
            if (progress.status !== 'running') {
              void Promise.resolve(fileLocationId).then((id) => {
                if (
                  !effectCancelled &&
                  mountedRef.current &&
                  activeFileLocationIdRef.current === id &&
                  selectionEpochRef.current === selectionEpoch
                ) {
                  void loadForPhoto(id, selectionEpoch)
                }
              })
            }
          })
        : undefined

    return () => {
      effectCancelled = true
      unsubModel?.()
      unsubOcr?.()
    }
  }, [fileLocationId, loadForPhoto, supported])

  if (!supported || typeof window.api.ocrSelectedDocuments !== 'function') {
    return null
  }

  const isModelReady = modelStatus?.state === 'ready'

  const handleRunOcr = async () => {
    const targetId = fileLocationId
    const targetEpoch = selectionEpochRef.current
    const actionSeq = ++actionRequestSeqRef.current
    setError(null)
    setIsRunning(true)
    try {
      await window.api.ocrSelectedDocuments({
        fileLocationIds: [targetId],
        forceReocr: true
      })
      if (
        mountedRef.current &&
        activeFileLocationIdRef.current === targetId &&
        selectionEpochRef.current === targetEpoch &&
        actionRequestSeqRef.current === actionSeq
      ) {
        await loadForPhoto(targetId, targetEpoch)
      }
    } catch (err) {
      if (
        mountedRef.current &&
        activeFileLocationIdRef.current === targetId &&
        selectionEpochRef.current === targetEpoch &&
        actionRequestSeqRef.current === actionSeq
      ) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (mountedRef.current) {
        if (typeof window.api.getDocumentOcrProgress === 'function') {
          try {
            const progress = await window.api.getDocumentOcrProgress()
            if (mountedRef.current) {
              setIsRunning(progress.status === 'running')
            }
          } catch {
            if (mountedRef.current) {
              setIsRunning(false)
            }
          }
        } else {
          setIsRunning(false)
        }
      }
    }
  }

  return (
    <div className="details-section" data-testid="photo-ocr-section">
      <h4>Document Image OCR (Explicit Selection)</h4>
      <div className="photo-ocr-actions">
        <button
          type="button"
          className="btn-secondary btn-sm"
          data-testid="photo-ocr-selected-btn"
          disabled={!isModelReady || isRunning}
          onClick={() => void handleRunOcr()}
        >
          {isRunning ? 'Running OCR…' : 'Run OCR on This Image'}
        </button>
      </div>
      {!isModelReady && (
        <p className="documents-preview-empty">
          Offline English OCR model is not ready. Install or import it in the Documents tab.
        </p>
      )}
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      {ocrState && ocrState.ocrStatus !== 'not_processed' && (
        <dl className="details-list">
          <dt>OCR Status</dt>
          <dd data-testid="photo-ocr-status">{ocrState.ocrStatus}</dd>
          {ocrState.ocrModelId && (
            <>
              <dt>OCR Model</dt>
              <dd>
                {ocrState.ocrModelId} ({ocrState.ocrLanguage ?? 'eng'})
              </dd>
            </>
          )}
        </dl>
      )}
      {ocrPreview && ocrPreview.extractedText && ocrPreview.extractedText.length > 0 && (
        <>
          <h5>OCR text (machine-recognized)</h5>
          <pre className="documents-extracted-text" data-testid="photo-ocr-text-preview">
            {ocrPreview.extractedText}
          </pre>
        </>
      )}
      {ocrPreview &&
        (!ocrPreview.extractedText || ocrPreview.extractedText.length === 0) &&
        ocrPreview.ocrStatus !== 'not_processed' && (
          <p className="documents-preview-empty" data-testid="photo-ocr-empty-state">
            {ocrPreview.statusDetail ?? `No OCR text recognized (${ocrPreview.ocrStatus}).`}
          </p>
        )}
    </div>
  )
}
