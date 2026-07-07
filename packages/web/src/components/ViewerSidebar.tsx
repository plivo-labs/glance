import { X } from 'lucide-react'
import { Link } from 'react-router'
import { clear, groupBySite, type RecentSite, removeEntry, useRecents } from '@/lib/recents'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

// An overlay Sheet (not a persistent panel) so it never fights the right-hand ReviewRail for
// width, in the viewer's already-tight full-bleed layout (ViewerTopBar + canvas [+ rail]).
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
  const sites = groupBySite(entries)

  const close = () => onOpenChange(false)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-80 gap-0 p-0 sm:max-w-xs">
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b py-3 pr-10 pl-4">
          <div>
            <SheetTitle className="text-sm">Recently opened</SheetTitle>
            <SheetDescription className="sr-only">Sites and files you've opened recently.</SheetDescription>
          </div>
          {userId && sites.length > 0 && (
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
          {sites.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground text-sm">Sites you open will show up here.</p>
          ) : (
            sites.map((s) => (
              <SiteGroup
                key={`${s.spaceSlug}/${s.siteSlug}`}
                site={s}
                current={s.spaceSlug === currentSpaceSlug && s.siteSlug === currentSiteSlug}
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

function fileHref(spaceSlug: string, siteSlug: string, filePath: string): string {
  return `/${spaceSlug}/${siteSlug}/${filePath.split('/').map(encodeURIComponent).join('/')}`
}

function SiteGroup({
  site,
  current,
  userId,
  onNavigate,
}: {
  site: RecentSite
  current: boolean
  userId: string | null
  onNavigate: () => void
}) {
  return (
    <div className="px-2 py-1">
      <div className={cn('group flex items-center gap-1 rounded-md px-2 py-1.5', current && 'bg-foreground/5')}>
        <Link
          to={`/${site.spaceSlug}/${site.siteSlug}`}
          onClick={onNavigate}
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            current ? 'font-medium text-foreground' : 'text-foreground/90 hover:text-foreground',
          )}
          title={`${site.spaceSlug}/${site.siteSlug}`}
        >
          {site.title ?? site.siteSlug}
        </Link>
        <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(site.at)}</span>
        {userId && (
          <button
            type="button"
            aria-label={`Remove ${site.title ?? site.siteSlug} from recents`}
            className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            onClick={() => removeEntry(userId, { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug })}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {site.files.length > 0 && (
        <ul className="ml-3 border-l pl-2">
          {site.files.map((f) => (
            <li key={f.filePath} className="group flex items-center gap-1 rounded-md px-2 py-1 hover:bg-foreground/5">
              <Link
                to={fileHref(site.spaceSlug, site.siteSlug, f.filePath)}
                onClick={onNavigate}
                className="min-w-0 flex-1 truncate text-muted-foreground text-xs hover:text-foreground"
                title={f.filePath}
              >
                {f.filePath}
              </Link>
              <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(f.at)}</span>
              {userId && (
                <button
                  type="button"
                  aria-label={`Remove ${f.filePath} from recents`}
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => removeEntry(userId, { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug, filePath: f.filePath })}
                >
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
