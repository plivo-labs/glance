import { Music } from 'lucide-react'
import type { RefObject } from 'react'

// First-class audio player for the letterbox canvas — replaces the sandboxed iframe for audio
// files (there's no HTML document to frame). `audioRef` is forwarded so the viewer can read
// `currentTime` on demand (the comment composer's timestamp button) with a plain ref read
// inside an event handler — no state, no effect.
export function AudioView({
  src,
  fileName,
  audioRef,
}: {
  src: string
  fileName: string
  audioRef: RefObject<HTMLAudioElement | null>
}) {
  return (
    <div className="flex size-full items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
        <div className="flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Music className="size-7" />
        </div>
        <p className="w-full truncate text-center font-medium text-sm" title={fileName}>
          {fileName}
        </p>
        {/* `key={src}` forces a remount (not just an attribute update) when the file path changes —
            a bare src swap on a live <audio> doesn't reliably reload in every browser. */}
        {/* biome-ignore lint/a11y/useMediaCaption: audio-only source, no track to caption */}
        <audio key={src} ref={audioRef} controls preload="metadata" className="w-full">
          <source src={src} />
        </audio>
      </div>
    </div>
  )
}
