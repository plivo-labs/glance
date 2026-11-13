import { RotateCcw } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { MountSensor } from '@/components/ui/mount-sensor'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { timeAgo } from '@/lib/time'
import { type SiteVersion, formatBytes, siteVersions, versionAuthor } from '@/lib/versions'

type Props = {
  spaceSlug: string
  siteSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  // After a successful restore. The default reloads: the content iframe and viewer metadata are
  // stale, and a reload is how the theme switcher refreshes them too.
  onRestored?: () => void
}

type State = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; versions: SiteVersion[] }

export function HistorySheet({ spaceSlug, siteSlug, open, onOpenChange, onRestored }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    siteVersions
      .list(spaceSlug, siteSlug)
      .then((versions) => setState({ kind: 'ready', versions }))
      .catch((error: unknown) => {
        setState({ kind: 'failed' })
        toast.error('Could not load history', { description: error instanceof Error ? error.message : undefined })
      })
  }, [spaceSlug, siteSlug])

  // ConfirmDialog toasts and stays open when this throws, so only the success path is handled here.
  async function restore(v: SiteVersion) {
    await siteVersions.restore(spaceSlug, siteSlug, v.id)
    toast.success(`Restored version ${v.version}`)
    if (onRestored) onRestored()
    else window.location.reload()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <MountSensor onMount={load} />
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <RotateCcw className="size-4 text-brand-text" />
            History
          </SheetTitle>
          <SheetDescription>Earlier versions of this site. Restoring keeps what is live now as a new version.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {state.kind === 'loading' && (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {state.kind === 'failed' && (
            <div className="space-y-3 py-10 text-center">
              <p className="text-muted-foreground text-sm">Could not load history.</p>
              <Button variant="outline" size="sm" onClick={load} data-testid="history-sheet-retry-btn">
                Try again
              </Button>
            </div>
          )}
          {state.kind === 'ready' && state.versions.length === 0 && (
            <p className="py-10 text-center text-muted-foreground text-sm">
              No earlier versions yet. One is kept each time this site is replaced.
            </p>
          )}
          {state.kind === 'ready' && state.versions.length > 0 && (
            <ul className="space-y-2">
              {state.versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">Version {v.version}</div>
                    <div className="truncate text-muted-foreground text-xs">
                      Replaced {timeAgo(v.createdAt)} by {versionAuthor(v)}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {v.fileCount} {v.fileCount === 1 ? 'file' : 'files'} · {formatBytes(v.totalSize)}
                    </div>
                  </div>
                  <ConfirmDialog
                    title={`Restore version ${v.version}?`}
                    description="The site will serve this version again. What is live now is kept as a new version, so you can undo this."
                    confirmLabel="Restore"
                    onConfirm={() => restore(v)}
                  >
                    <Button variant="outline" size="sm" data-testid="history-version-restore-btn">
                      Restore
                    </Button>
                  </ConfirmDialog>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
