import { Pause, Play } from 'lucide-react'
import { type RefObject, useEffect, useState } from 'react'
import { formatTimestamp } from '@/lib/audio'
import { cn } from '@/lib/utils'

// A seek bar over a caller-owned `<audio>` element: play/pause, a draggable progress slider, and a
// `current / duration` readout (formatTimestamp). Hand-written — no vendored deps. The element is
// owned by AudioPlayer (remounted via key={src}), so this component remounts with it and re-binds
// its listeners on every source change. Reading currentTime elsewhere (the composer timestamp
// button) still works because both drive the same element through the shared `audioRef`.
export function AudioScrubber({
  audioRef,
  className,
}: {
  audioRef: RefObject<HTMLAudioElement | null>
  className?: string
}) {
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  // Mirror the element's playback lifecycle into local state. Seed from the element up front in case
  // metadata already loaded (a fast/cached source) before this effect bound its listeners.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = () => setCurrent(el.currentTime)
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onPause)
    onMeta()
    setCurrent(el.currentTime)
    setPlaying(!el.paused)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onPause)
    }
  }, [audioRef])

  function toggle() {
    const el = audioRef.current
    if (!el) return
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current
    const next = Number(e.target.value)
    setCurrent(next) // reflect the drag immediately (timeupdate doesn't fire while paused)
    if (el) el.currentTime = next
  }

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm outline-none transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(current, duration || 0)}
        onChange={seek}
        aria-label="Seek"
        className="h-1 min-w-0 flex-1 cursor-pointer accent-primary"
      />
      <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
        {formatTimestamp(current)} / {formatTimestamp(duration)}
      </span>
    </div>
  )
}
