import { type RefObject, useEffect } from 'react'
import {
  AudioPlayerButton,
  AudioPlayerDuration,
  AudioPlayerProgress,
  AudioPlayerProvider,
  AudioPlayerTime,
  useAudioPlayer,
} from '@/components/ui/audio-player'
import { cn } from '@/lib/utils'

// The app-facing audio player: the vendored ElevenLabs player is a set of composable primitives
// (Provider + button/progress/time/duration), so we arrange them once here into a single bar and
// feed it one `src`. Used by the full-screen AudioView and the record-dialog preview; the voice
// comment card keeps the compact hand-written scrubber (its own smaller footprint).
//
// `audioRef` (optional) is bridged to the player's internal <audio> so a caller can read the live
// playback position on demand — the review composer's "insert timestamp" button does exactly that.

function PlayerBar({ src, audioRef }: { src: string; audioRef?: RefObject<HTMLAudioElement | null> }) {
  const player = useAudioPlayer()

  // Load the single track on mount (the Provider is remounted per-src by the key below, so this
  // runs once for each source and never needs to diff).
  useEffect(() => {
    player.setActiveItem({ id: src, src })
  }, [src, player])

  // Point the caller's ref at the player's own <audio> element so `currentTime` reads stay live.
  useEffect(() => {
    if (audioRef) audioRef.current = player.ref.current
  }, [audioRef, player.ref])

  // MediaRecorder webm/opus blobs report duration=Infinity until the browser is forced to scan to
  // the end — which leaves the scrubber with no max and the readout blank. Nudge currentTime past
  // the end once on metadata load; the browser resolves the real duration, then we snap back to 0.
  // No-op for finite-duration sources (mp3/wav), so it's safe to always attach.
  useEffect(() => {
    const el = player.ref.current
    if (!el) return
    let nudged = false
    const resolveDuration = () => {
      if (el.duration !== Number.POSITIVE_INFINITY || nudged) return
      nudged = true
      const onSeeked = () => {
        el.currentTime = 0
        el.removeEventListener('seeked', onSeeked)
      }
      el.addEventListener('seeked', onSeeked)
      el.currentTime = 1e7 // large but finite: the browser clamps to the real end and reports duration
    }
    el.addEventListener('loadedmetadata', resolveDuration)
    if (el.readyState >= 1) resolveDuration()
    return () => el.removeEventListener('loadedmetadata', resolveDuration)
  }, [player.ref])

  return (
    <div className="flex w-full items-center gap-3">
      <AudioPlayerButton
        size="icon"
        className="size-10 shrink-0 rounded-full bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
      />
      <AudioPlayerProgress className="flex-1" />
      <div className="flex shrink-0 items-center gap-1 font-mono text-muted-foreground text-xs tabular-nums">
        <AudioPlayerTime />
        <span>/</span>
        <AudioPlayerDuration />
      </div>
    </div>
  )
}

export function RichAudioPlayer({
  src,
  audioRef,
  className,
}: {
  src: string
  audioRef?: RefObject<HTMLAudioElement | null>
  className?: string
}) {
  // key={src} remounts the whole Provider (audio element included) on a source change — the same
  // reliable-reload contract the hand-written player used; callers must NOT also key it.
  return (
    <div key={src} className={cn('w-full', className)}>
      <AudioPlayerProvider>
        <PlayerBar src={src} audioRef={audioRef} />
      </AudioPlayerProvider>
    </div>
  )
}
