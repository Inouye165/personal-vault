import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'pv.appearance.theme'

/**
 * Reads the persisted appearance theme, defaulting to Light on first use
 * or when storage is unavailable or contains an unrecognized value.
 */
export function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light'
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return raw === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * Applies the active theme token attributes to the root HTML element.
 */
export function applyThemeToDocument(theme: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.colorScheme = theme
}

/**
 * Persists and synchronizes the renderer Light / Dark appearance preference.
 */
export function useTheme(): {
  readonly theme: ThemeMode
  readonly setTheme: (next: ThemeMode) => void
} {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const initial = readStoredTheme()
    applyThemeToDocument(initial)
    return initial
  })

  useEffect(() => {
    applyThemeToDocument(theme)
  }, [theme])

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next)
    applyThemeToDocument(next)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        // Ignore storage write failures in restricted environments
      }
    }
  }, [])

  return { theme, setTheme }
}
