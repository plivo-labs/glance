import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { LiveWaveform } from '@/components/record/LiveWaveform'
import { VoiceButton } from '@/components/record/VoiceButton'
import { Spinner } from '@/components/states'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useMediaRecorder } from '@/hooks/useMediaRecorder'
import { formatTimestamp } from '@/lib/audio'
import { defaultRecordingTitle, extForMime, recordingSlug } from '@/lib/recorder'
import { defaultSpaceSlug } from '@/lib/spaces'
import type { SpaceSummary } from '@/lib/types'
import { uploadFiles, UploadError } from '@/lib/uploadWithProgress'

// Record → preview → save a voice note as its own single-file site, then jump into the AudioView.
// The recorder state machine lives in useMediaRecorder; the pure slug/title/ext helpers in
// lib/recorder. Deploys to the user's personal space (team-visible) — the same upload path the
// DeployCard uses, with the display title carried as the `title` form field.
export function RecordDialog({
  spaces,
  open,
  onOpenChange,
}: {
  spaces: SpaceSummary[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const rec = useMediaRecorder()
  const [title, setTitle] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // On a slug collision we bump a suffix so the retry lands on a fresh URL. Held in a ref because the
  // Save handler reads it synchronously; `conflict` drives the retry UI.
  const suffixRef = useRef(0)
  const [conflict, setConflict] = useState(false)

  const space = defaultSpaceSlug(spaces)

  // Preview URL for the recorded blob — revoked on blob change / unmount (also covers dialog close,
  // which resets the recorder and clears the blob).
  useEffect(() => {
    if (!rec.blob) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(rec.blob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [rec.blob])

  // Seed a default title the moment recording stops (only if the user hasn't typed one).
  useEffect(() => {
    if (rec.state === 'stopped') setTitle((t) => t || defaultRecordingTitle(new Date()))
  }, [rec.state])

  function close(next: boolean) {
    if (saving) return
    if (!next) {
      rec.reset()
      setTitle('')
      setConflict(false)
      suffixRef.current = 0
    }
    onOpenChange(next)
  }

  async function save() {
    if (!rec.blob) return
    if (!space) {
      toast.error('No space to save into.')
      return
    }
    const now = new Date()
    const effectiveTitle = title.trim() || defaultRecordingTitle(now)
    const base = recordingSlug(effectiveTitle, now)
    // Keep room for the `-N` suffix so a retry never blows the 40-char slug cap.
    const slug = suffixRef.current > 0 ? `${base.slice(0, 36)}-${suffixRef.current + 1}` : base
    const mime = rec.mimeType || 'audio/webm'
    const fileName = `recording.${extForMime(mime)}`

    setSaving(true)
    setConflict(false)
    try {
      const file = new File([rec.blob], fileName, { type: mime })
      const res = await uploadFiles(`/api/upload/${space}/${slug}`, [{ file, path: fileName }], {
        visibility: 'team',
        title: effectiveTitle,
      })
      toast.success('Recording saved', { description: res.url })
      onOpenChange(false)
      rec.reset()
      setTitle('')
      suffixRef.current = 0
      // Jump straight to the audio file's own URL — the site root would land in the iframe wrapper,
      // but the deep file path resolves to the AudioView (isAudioFile). res.url has no trailing slash.
      navigate(new URL(`${res.url}/${fileName}`).pathname)
    } catch (err) {
      if (err instanceof UploadError && err.status === 409) {
        suffixRef.current += 1 // next Save targets `${base}-N`
        setConflict(true)
      } else {
        toast.error('Could not save recording', {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const recording = rec.state === 'recording' || rec.state === 'paused'
  const stopped = rec.state === 'stopped'

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record a voice comment</DialogTitle>
          <DialogDescription>
            {stopped ? 'Give it a name and save.' : 'Tap the mic to start. You can pause and resume.'}
          </DialogDescription>
        </DialogHeader>

        {stopped ? (
          <div className="space-y-4">
            {previewUrl && (
              // biome-ignore lint/a11y/useMediaCaption: user's own recording, no track to caption
              <audio src={previewUrl} controls preload="metadata" className="w-full" />
            )}
            <div className="space-y-1.5">
              <Label htmlFor="recording-title">Title</Label>
              <Input
                id="recording-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value)
                  suffixRef.current = 0 // a new title means a new base slug — reset the retry suffix
                  setConflict(false)
                }}
                placeholder={defaultRecordingTitle(new Date())}
                disabled={saving}
                autoFocus
              />
              {conflict && (
                <p className="text-sm font-medium text-destructive">
                  That link is taken — rename it, or save again for a fresh URL.
                </p>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={rec.reset} disabled={saving} className="text-muted-foreground">
              <RotateCcw />
              Record again
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-5 py-4">
            <LiveWaveform stream={rec.stream} active={rec.state === 'recording'} />
            <p className="font-mono text-3xl tabular-nums">{formatTimestamp(rec.elapsedMs / 1000)}</p>
            <div className="flex items-center gap-4">
              {recording && (
                <Button
                  variant="outline"
                  size="icon"
                  className="size-11 rounded-full"
                  aria-label={rec.state === 'paused' ? 'Resume recording' : 'Pause recording'}
                  onClick={rec.state === 'paused' ? rec.resume : rec.pause}
                >
                  {rec.state === 'paused' ? <Play /> : <Pause />}
                </Button>
              )}
              <VoiceButton state={rec.state} onStart={() => void rec.start()} onStop={rec.stop} />
            </div>
            {rec.error && <p className="text-sm font-medium text-destructive">{rec.error}</p>}
          </div>
        )}

        {stopped && (
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !rec.blob}>
              {saving && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
