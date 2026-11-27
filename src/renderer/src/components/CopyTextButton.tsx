import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

export interface CopyTextButtonProps {
  readonly text: string | null | undefined
  readonly testId?: string
  readonly className?: string
  readonly ariaLabel?: string
}

/**
 * Renders a guarded "Copy text" action only when non-empty text and
 * `navigator.clipboard.writeText` are both available.
 */
export function CopyTextButton({
  text,
  testId = 'copy-extracted-text-btn',
  className = 'btn btn-secondary btn-xs copy-text-btn',
  ariaLabel = 'Copy extracted text'
}: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false)
  const [prevText, setPrevText] = useState(text)
  if (prevText !== text) {
    setPrevText(text)
    if (copied) setCopied(false)
  }

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])

  const hasClipboardSupport =
    typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'

  if (!text || text.trim().length === 0 || !hasClipboardSupport) {
    return null
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Ignore clipboard write rejections
    }
  }

  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation()
        void handleCopy()
      }}
    >
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span>{copied ? 'Copied' : 'Copy text'}</span>
    </button>
  )
}
