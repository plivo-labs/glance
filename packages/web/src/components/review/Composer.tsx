import { Clock, Mic, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMediaRecorder } from '@/hooks/useMediaRecorder'
import { formatTimestamp } from '@/lib/audio'
import { cn } from '@/lib/utils'

// Shared composer for a new thread or a flat reply. Text and voice are alternative submit paths:
// typing submits trimmed non-empty bodies via onSubmit (clears on success); the mic records a clip
// that submits via onSubmitVoice. Controlled locally.
export function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  onSubmitVoice,
  onCancel,
  autoFocus,
  className,
  timestampButton,
}: {
  placeholder: string
  submitLabel: string
  onSubmit: (body: string) => void | Promise<void>
  // When set, the composer shows a mic that records a clip and submits it here (voice comment).
  onSubmitVoice?: (blob: Blob) => void | Promise<void>
  onCancel?: () => void
  autoFocus?: boolean
  className?: string
  // Audio view only: inserts a `[m:ss] ` prefix for the player's current position. `getPrefix`
  // is called at click time (not render time) so it always reflects the latest playback position.
  timestampButton?: { label: string; getPrefix: () => string }
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const rec = useMediaRecorder()
  const trimmed = body.trim()
  // While recording/paused (or holding a finished clip) the voice strip takes over the composer —
  // text and voice are one-or-the-other for a single submit.
  const recording = rec.state === 'recording' || rec.state === 'paused'
  const recorded = rec.state === 'stopped'

  async function submit() {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed)
      setBody('')
    } finally {
      setBusy(false)
    }
  }

  async function sendVoice() {
    if (!rec.blob || busy) return
    setBusy(true)
    try {
      await onSubmitVoice?.(rec.blob)
      rec.reset()
    } finally {
      setBusy(false)
    }
  }

  if (recording || recorded) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center gap-3 rounded-md border border-input bg-muted/40 px-3 py-2">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              rec.state === 'recording' ? 'animate-pulse bg-destructive' : 'bg-muted-foreground',
            )}
          />
          <span className="font-mono text-sm tabular-nums">{formatTimestamp(rec.elapsedMs / 1000)}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {recording ? (
              <Button type="button" size="sm" variant="destructive" onClick={rec.stop}>
                <Square className="size-3.5 fill-current" />
                Stop
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={sendVoice} disabled={busy}>
                {submitLabel}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={rec.reset}
              disabled={busy}
              aria-label="Discard recording"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
        {rec.error && <p className="font-medium text-destructive text-sm">{rec.error}</p>}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: composer is opened by an explicit user action.
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div className={cn('flex items-center gap-2', timestampButton ? 'justify-between' : 'justify-end')}>
        {timestampButton && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setBody((b) => timestampButton.getPrefix() + b)}
          >
            <Clock className="size-3.5" />
            {timestampButton.label}
          </Button>
        )}
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {onSubmitVoice && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void rec.start()}
              aria-label="Record a voice comment"
            >
              <Mic className="size-3.5" />
            </Button>
          )}
          <Button type="button" size="sm" disabled={!trimmed || busy} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
      {rec.error && <p className="font-medium text-destructive text-sm">{rec.error}</p>}
    </div>
  )
}
