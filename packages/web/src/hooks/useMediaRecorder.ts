import { useCallback, useEffect, useRef, useState } from 'react'
import { pickAudioMimeType } from '@/lib/recorder'

// State machine for a real in-browser recording: idle → recording ⇄ paused → stopped. The pure
// MIME/extension/title helpers live in lib/recorder.ts (unit-tested); this hook owns the stateful
// MediaRecorder + MediaStream and the pause-aware elapsed clock. getUserMedia rejection (mic denied)
// lands in `error` and leaves state at 'idle' so the caller can prompt a retry.
export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped'

export interface MediaRecorderHook {
  state: RecorderState
  /** Request the mic and begin recording. Rejects softly into `error`; never throws. */
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  /** Back to idle: drops the recorded blob + elapsed so the UI can record afresh. */
  reset: () => void
  /** Elapsed recording time in ms, not counting paused spans. Holds the final duration once stopped. */
  elapsedMs: number
  /** The recorded audio, available once state is 'stopped'. Its `type` is `mimeType`. */
  blob: Blob | null
  /** The MIME the recorder actually used (drives extForMime for the upload filename). */
  mimeType: string
  /** The live capture stream while recording/paused — for a waveform analyser. null when idle/stopped. */
  stream: MediaStream | null
  /** Human-readable capture error (mic denied / unsupported), else null. */
  error: string | null
}

export function useMediaRecorder(): MediaRecorderHook {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [mimeType, setMimeType] = useState('')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef('')
  // Elapsed clock: `baseRef` is the time banked from finished (unpaused) segments; while recording,
  // add now − `segmentStartRef`. Paused time is simply never accrued.
  const baseRef = useRef(0)
  const segmentStartRef = useRef(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTick = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
  }, [])

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => {
      t.stop()
    })
    streamRef.current = null
    setStream(null)
  }, [])

  const startTick = useCallback(() => {
    stopTick()
    segmentStartRef.current = Date.now()
    tickRef.current = setInterval(() => {
      setElapsedMs(baseRef.current + (Date.now() - segmentStartRef.current))
    }, 100)
  }, [stopTick])

  // Bank the running segment into baseRef and freeze the clock (pause/stop).
  const bankElapsed = useCallback(() => {
    baseRef.current += Date.now() - segmentStartRef.current
    setElapsedMs(baseRef.current)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone access was denied. Allow it in your browser and try again.')
      return
    }
    const mime = pickAudioMimeType()
    let recorder: MediaRecorder
    try {
      recorder = mime ? new MediaRecorder(media, { mimeType: mime }) : new MediaRecorder(media)
    } catch {
      media.getTracks().forEach((t) => {
        t.stop()
      })
      setError("This browser can't record audio.")
      return
    }

    streamRef.current = media
    recorderRef.current = recorder
    chunksRef.current = []
    mimeRef.current = recorder.mimeType || mime
    baseRef.current = 0

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      const type = mimeRef.current || 'audio/webm'
      setBlob(new Blob(chunksRef.current, { type }))
      setMimeType(type)
      setState('stopped')
      stopTracks()
    }

    setStream(media)
    setMimeType(mimeRef.current)
    setBlob(null)
    setElapsedMs(0)
    // A timeslice keeps chunks flushing periodically, so pause/resume can't strand a long segment.
    recorder.start(250)
    setState('recording')
    startTick()
  }, [startTick, stopTracks])

  const pause = useCallback(() => {
    if (recorderRef.current?.state !== 'recording') return
    recorderRef.current.pause()
    stopTick()
    bankElapsed()
    setState('paused')
  }, [stopTick, bankElapsed])

  const resume = useCallback(() => {
    if (recorderRef.current?.state !== 'paused') return
    recorderRef.current.resume()
    startTick()
    setState('recording')
  }, [startTick])

  const stop = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state === 'inactive') return
    stopTick()
    bankElapsed()
    rec.stop() // onstop finalizes the blob, flips to 'stopped', and stops the tracks
  }, [stopTick, bankElapsed])

  const reset = useCallback(() => {
    stopTick()
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null
      rec.stop()
    }
    stopTracks()
    recorderRef.current = null
    chunksRef.current = []
    baseRef.current = 0
    setBlob(null)
    setElapsedMs(0)
    setMimeType('')
    setError(null)
    setState('idle')
  }, [stopTick, stopTracks])

  // Release the mic + timer if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      stopTick()
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') {
        rec.onstop = null
        rec.stop()
      }
      streamRef.current?.getTracks().forEach((t) => {
        t.stop()
      })
    }
  }, [stopTick])

  return { state, start, pause, resume, stop, reset, elapsedMs, blob, mimeType, stream, error }
}
