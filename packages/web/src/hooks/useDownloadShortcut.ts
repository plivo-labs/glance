import { useEffect } from 'react'
import { isDownloadShortcut } from '@/lib/download'

// ⌘⇧S / Ctrl+Shift+S opens the Download dialog. The page lives in a cross-origin iframe, so a key
// pressed with the page focused never reaches this window: the annotate client forwards it as
// glance:shortcut (only the frame we embed, from its own origin, is believed).
export function useDownloadShortcut(enabled: boolean, onOpen: () => void, frame: () => Window | null | undefined, origin: string): void {
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      if (!isDownloadShortcut(e)) return
      e.preventDefault()
      onOpen()
    }
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: string; name?: string } | null
      if (e.origin === origin && e.source === frame() && d?.type === 'glance:shortcut' && d.name === 'download') onOpen()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMessage)
    }
  }, [enabled, onOpen, frame, origin])
}
