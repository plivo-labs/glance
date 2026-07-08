import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

// Decorative level meter for the recorder. When a live stream + Web Audio are available it drives
// the bars off an AnalyserNode's frequency data; otherwise it falls back to a gentle animated pulse.
// Purely cosmetic — every failure path degrades to the fallback and never throws.
const BARS = 28
const IDLE = Array.from({ length: BARS }, () => 0.06)

export function LiveWaveform({
  stream,
  active,
  className,
}: {
  stream: MediaStream | null
  active: boolean
  className?: string
}) {
  const [levels, setLevels] = useState<number[]>(IDLE)
  const rafRef = useRef(0)

  useEffect(() => {
    if (!active) {
      setLevels(IDLE)
      return
    }

    let ctx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let data: Uint8Array<ArrayBuffer> | null = null
    try {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (stream && AC) {
        ctx = new AC()
        const source = ctx.createMediaStreamSource(stream)
        analyser = ctx.createAnalyser()
        analyser.fftSize = BARS * 2
        source.connect(analyser)
        data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      }
    } catch {
      ctx = null
      analyser = null
      data = null
    }

    const tick = () => {
      if (analyser && data) {
        analyser.getByteFrequencyData(data)
        setLevels(Array.from(data.slice(0, BARS), (v) => Math.max(0.06, v / 255)))
      } else {
        const t = Date.now() / 180
        setLevels(Array.from({ length: BARS }, (_, i) => 0.2 + 0.35 * Math.abs(Math.sin(t + i * 0.45))))
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ctx?.close().catch(() => {})
    }
  }, [stream, active])

  return (
    <div
      aria-hidden
      className={cn('flex h-16 w-full items-center justify-center gap-1', className)}
    >
      {levels.map((level, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative bar list
          key={i}
          className="w-1.5 origin-center rounded-full bg-primary/70 transition-transform duration-75"
          style={{ height: '100%', transform: `scaleY(${Math.max(0.06, level).toFixed(3)})` }}
        />
      ))}
    </div>
  )
}
