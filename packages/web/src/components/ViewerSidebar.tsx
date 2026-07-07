import { X } from 'lucide-react'
import { Link } from 'react-router'
import { clear, entryLabel, type RecentEntry, removeEntry, useRecents } from '@/lib/recents'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

// An overlay Sheet (not a persistent panel) so it never fights the right-hand ReviewRail for
// width, in the viewer's already-tight full-bleed layout (ViewerTopBar + canvas [+ rail]).
//
// Flat, most-recent-first list — one row per visited page (most Glance sites are single-page, so
// a site→files tree was mostly noise; see `entryLabel` for the row-label rules).
export function ViewerSidebar({
  open,
  onOpenChange,
  userId,
  currentSpaceSlug,
  currentSiteSlug,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string | null
  currentSpaceSlug: string
  currentSiteSlug: string
}) {
  const entries = useRecents(userId)

  const close = () => onOpenChange(false)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-80 gap-0 p-0 sm:max-w-xs">
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b py-3 pr-10 pl-4">
          <div>
            <SheetTitle className="text-sm">Recently opened</SheetTitle>
            <SheetDescription className="sr-only">Pages you've opened recently.</SheetDescription>
          </div>
          {userId && entries.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-muted-foreground text-xs hover:text-foreground"
              onClick={() => clear(userId)}
            >
              Clear all
            </Button>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-2">
          {entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground text-sm">Pages you open will show up here.</p>
          ) : (
            entries.map((e) => (
              <Row
                key={`${e.spaceSlug}/${e.siteSlug}/${e.filePath}`}
                entry={e}
                // Root-row highlight only: an exact per-row match would need the current in-iframe
                // filePath threaded down here too, which the flatten kept out of scope.
                current={e.spaceSlug === currentSpaceSlug && e.siteSlug === currentSiteSlug && e.filePath === ''}
                userId={userId}
                onNavigate={close}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function entryHref(spaceSlug: string, siteSlug: string, filePath: string): string {
  return filePath ? `/${spaceSlug}/${siteSlug}/${filePath.split('/').map(encodeURIComponent).join('/')}` : `/${spaceSlug}/${siteSlug}`
}

function Row({
  entry,
  current,
  userId,
  onNavigate,
}: {
  entry: RecentEntry
  current: boolean
  userId: string | null
  onNavigate: () => void
}) {
  const { primary, secondary } = entryLabel(entry)
  return (
    <div className="px-2 py-1">
      <div className={cn('group flex items-center gap-1 rounded-md px-2 py-1.5', current && 'bg-foreground/5')}>
        <Link
          to={entryHref(entry.spaceSlug, entry.siteSlug, entry.filePath)}
          onClick={onNavigate}
          className="min-w-0 flex-1 truncate text-sm"
          title={`${entry.spaceSlug}/${entry.siteSlug}${entry.filePath ? `/${entry.filePath}` : ''}`}
        >
          <span className={cn(current ? 'font-medium text-foreground' : 'text-foreground/90 group-hover:text-foreground')}>
            {primary}
          </span>
          {secondary && <span className="ml-1.5 truncate text-muted-foreground text-xs">{secondary}</span>}
        </Link>
        <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(entry.at)}</span>
        {userId && (
          <button
            type="button"
            aria-label={`Remove ${primary} from recents`}
            className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            onClick={() => removeEntry(userId, { spaceSlug: entry.spaceSlug, siteSlug: entry.siteSlug, filePath: entry.filePath })}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
