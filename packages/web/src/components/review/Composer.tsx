import { Clock } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Shared text composer for a new thread or a flat reply. Controlled locally; submits trimmed,
// non-empty bodies and clears on success.
export function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
  className,
  timestampButton,
}: {
  placeholder: string
  submitLabel: string
  onSubmit: (body: string) => void | Promise<void>
  onCancel?: () => void
  autoFocus?: boolean
  className?: string
  // Audio view only: inserts a `[m:ss] ` prefix for the player's current position. `getPrefix`
  // is called at click time (not render time) so it always reflects the latest playback position.
  timestampButton?: { label: string; getPrefix: () => string }
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = body.trim()

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
          <Button type="button" size="sm" disabled={!trimmed || busy} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
