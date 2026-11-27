import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

function isElementVisibleAndFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
    return false
  }
  if (el.closest('[inert], [hidden], [aria-hidden="true"]') !== null) {
    return false
  }

  let curr: HTMLElement | null = el
  while (curr) {
    const style = window.getComputedStyle(curr)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false
    }
    curr = curr.parentElement
  }

  // In real browsers with layout, verify the element has rendered boxes.
  if (document.documentElement.getBoundingClientRect().width > 0) {
    return el.getClientRects().length > 0
  }

  return true
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isElementVisibleAndFocusable
  )
}

export interface UseFocusTrapOptions {
  readonly isOpen: boolean
  readonly isModal: boolean
  readonly isActive?: boolean
  readonly containerRef: RefObject<HTMLElement | null>
  readonly onClose: () => void
  readonly restoreFocusTo?: () => HTMLElement | null
}

/**
 * Manages Escape dismissal, focus restoration, and optional modal Tab trapping
 * for drawers and side panels.
 */
export function useFocusTrap({
  isOpen,
  isModal,
  isActive = true,
  containerRef,
  onClose,
  restoreFocusTo
}: UseFocusTrapOptions): void {
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  const wasModalRef = useRef(false)

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      wasOpenRef.current = true
    }

    if (isOpen && isActive && isModal && !wasModalRef.current) {
      wasModalRef.current = true
      if (containerRef.current && !containerRef.current.contains(document.activeElement)) {
        const focusables = getFocusableElements(containerRef.current)
        if (focusables.length > 0) {
          focusables[0]?.focus()
        } else {
          containerRef.current.focus()
        }
      }
    } else if (!isModal || !isActive) {
      wasModalRef.current = false
    }

    if (!isOpen && wasOpenRef.current) {
      wasOpenRef.current = false
      wasModalRef.current = false
      const target = restoreFocusTo?.() ?? previousFocusRef.current
      if (target && target.isConnected) {
        target.focus()
      }
      previousFocusRef.current = null
    }
  }, [isOpen, isModal, isActive, containerRef, restoreFocusTo])

  useEffect(() => {
    if (!isOpen || !isActive) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (!isModal || event.key !== 'Tab' || !containerRef.current) {
        return
      }

      const focusables = getFocusableElements(containerRef.current)
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement

      if (event.shiftKey) {
        if (active === first || !containerRef.current.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !containerRef.current.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isModal, isActive, containerRef, onClose])
}
