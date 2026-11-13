import { type ReactNode, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { type DownloadOptions, loadDownloadOptions, saveDownloadOptions } from '@/lib/download'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/states'

// What the user is building the page FOR decides the download: a designed page keeps its look at
// the original width, a centered article reads better as an A4 "info" copy, and sometimes only the
// words are wanted. The choices are remembered per browser.
export function DownloadDialog({
  open,
  onOpenChange,
  onDownload,
  onPrint,
  shortcut,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Makes the file. Rejecting keeps the dialog open with the message in a toast.
  onDownload: (options: DownloadOptions) => Promise<void>
  // The old path: the browser's own print dialog.
  onPrint: () => void
  shortcut: string
}) {
  const [o, setO] = useState(loadDownloadOptions)
  const [busy, setBusy] = useState(false)
  const submitRef = useRef<HTMLButtonElement>(null)
  const set = <K extends keyof DownloadOptions>(key: K, value: DownloadOptions[K]) => setO((prev) => ({ ...prev, [key]: value }))
  const pdf = o.format === 'pdf'

  async function submit() {
    setBusy(true)
    try {
      saveDownloadOptions(o)
      await onDownload(o)
      onOpenChange(false)
    } catch (err) {
      toast.error('Could not download', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-lg"
        // Enter downloads straight away; the options are one Tab or click away.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          submitRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Download</DialogTitle>
          <DialogDescription>
            Pick what suits this page. Shortcut: <span className="font-mono">{shortcut}</span>
          </DialogDescription>
        </DialogHeader>

        <Group label="Format">
          <Choice name="format-pdf" checked={pdf} disabled={busy} onSelect={() => set('format', 'pdf')} title="PDF" hint="Pages to read, print or share" />
          <Choice name="format-text" checked={!pdf} disabled={busy} onSelect={() => set('format', 'text')} title="Plain text" hint=".txt with just the words" />
        </Group>

        {pdf && (
          <>
            <Group label="Size">
              <Choice name="size-info" checked={o.size === 'info'} disabled={busy} onSelect={() => set('size', 'info')} title="Info size" hint="Paper pages, content in a readable column" />
              <Choice name="size-full" checked={o.size === 'full'} disabled={busy} onSelect={() => set('size', 'full')} title="Original size" hint="Wide pages that look like the screen" />
            </Group>
            <Group label="Look">
              <Choice name="look-theme" checked={o.look === 'theme'} disabled={busy} onSelect={() => set('look', 'theme')} title="As designed" hint="Theme, colors and backgrounds, light or dark as you see it" />
              <Choice name="look-simple" checked={o.look === 'simple'} disabled={busy} onSelect={() => set('look', 'simple')} title="Simple" hint="Light and plain, like a basic print" />
            </Group>
            {o.size === 'info' && (
              <Group label="Paper">
                <Choice name="paper-a4" checked={o.paper === 'a4'} disabled={busy} onSelect={() => set('paper', 'a4')} title="A4" />
                <Choice name="paper-letter" checked={o.paper === 'letter'} disabled={busy} onSelect={() => set('paper', 'letter')} title="Letter" />
              </Group>
            )}
          </>
        )}

        <DialogFooter className="sm:items-center">
          {pdf && (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              disabled={busy}
              data-testid="download-dialog-print-btn"
              onClick={() => {
                onOpenChange(false)
                onPrint()
              }}
            >
              Use browser print
            </Button>
          )}
          <Button variant="outline" disabled={busy} data-testid="download-dialog-cancel-btn" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button ref={submitRef} disabled={busy} data-testid="download-dialog-submit-btn" onClick={() => void submit()}>
            {busy ? <Spinner /> : <Download />}
            {pdf ? 'Download PDF' : 'Download .txt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
        {children}
      </div>
    </div>
  )
}

function Choice({
  name,
  checked,
  disabled,
  onSelect,
  title,
  hint,
}: {
  name: string
  checked: boolean
  disabled: boolean
  onSelect: () => void
  title: string
  hint?: string
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        checked ? 'border-brand bg-brand/5' : 'border-input hover:bg-accent',
        disabled && 'cursor-default opacity-60',
      )}
    >
      {/* A real radio (one `name` per group), visually hidden: arrow keys and screen readers just work. */}
      <input
        type="radio"
        name={name.split('-')[0]}
        checked={checked}
        disabled={disabled}
        data-testid={`download-dialog-${name}-select`}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="font-medium">{title}</span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </label>
  )
}
