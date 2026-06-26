import { useSyncExternalStore } from 'react'

// Manual theme: no next-themes. The no-flash class is set by an inline script in
// index.html before paint; this module just reads/flips it. useTheme subscribes via
// useSyncExternalStore (a React hook, NOT useEffect) so components like the Toaster
// re-render on toggle without violating the project's no-useEffect rule.

export type Theme = 'light' | 'dark'
const KEY = 'glance-theme'

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function setTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark')
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* private mode / storage disabled — ignore */
  }
  window.dispatchEvent(new Event('glance:theme'))
}

export function toggleTheme(): void {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark')
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('glance:theme', cb)
  return () => window.removeEventListener('glance:theme', cb)
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => 'dark')
}
