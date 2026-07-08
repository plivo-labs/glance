import { Check, ChevronRight, Command, History, MessageSquare } from 'lucide-react'
import { Link } from 'react-router'
import type { ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { ShareDialog } from '@/components/ShareDialog'
import type { ReviewMode } from '@/components/review/ReviewRail'

// Canvas width for the preview iframe: full-bleed, a wide column, or a narrow reading measure
// (the wrapper letterboxes the rest).
export type CanvasWidth = 'full' | 'wide' | 'reading'

const WIDTHS = [
  { value: 'full', label: 'Full', title: 'Full width' },
  { value: 'wide', label: 'Wide', title: 'Wide column' },
  { value: 'reading', label: 'Read', title: 'Reading width' },
] as const satisfies readonly { value: CanvasWidth; label: string; title: string }[]

const MODES = [
  { value: 'read', label: 'Read', title: 'Browse the page' },
  { value: 'annotate', label: 'Annotate', title: 'Click an element to comment' },
] as const satisfies readonly { value: ReviewMode; label: string; title: string }[]

// The persistent top chrome for the viewer: brand (→ dashboard) + a breadcrumb, then the actions.
// Outside review: Comments (with an open count) + Share. In review: Read·Annotate, width, Share, Done.
// Replaces the old floating PreviewToolbar dock.
export function ViewerTopBar({
  site,
  sitePath,
  review,
  mode,
  onMode,
  width,
  onWidth,
  commentCount,
  onReview,
  onExit,
  onToggleSidebar,
  onSearch,
}: {
  site: ViewerSite
  sitePath: string
  review: boolean
  mode: ReviewMode
  onMode: (mode: ReviewMode) => void
  width: CanvasWidth
  onWidth: (width: CanvasWidth) => void
  commentCount: number
  onReview: () => void
  onExit: () => void
  onToggleSidebar: () => void
  onSearch: () => void
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3">
      <Link to="/dashboard" className="flex shrink-0 items-center gap-2 font-mono font-semibold text-sm tracking-tight">
        <span className="size-2.5 rounded-[3px] bg-primary shadow-[0_0_12px_1px_var(--primary)]" />
        glance
      </Link>

      <Button size="sm" variant="ghost" className="shrink-0 px-2" title="Recently opened" aria-label="Recently opened" onClick={onToggleSidebar}>
        <History className="size-3.5" />
      </Button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
        <ChevronRight className="size-3.5 shrink-0 opacity-40" />
        <span className="shrink-0">{site.spaceSlug}</span>
        <span className="opacity-40">/</span>
        <span className={cn('truncate', !sitePath && 'text-foreground')}>{site.title ?? site.siteSlug}</span>
        {sitePath && (
          <>
            <span className="opacity-40">/</span>
            <span className="truncate text-foreground">{sitePath}</span>
          </>
        )}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={onSearch}
          title="Search sites or run a command"
        >
          <Command className="size-3.5" />
          <span className="hidden lg:inline">Search</span>
          <kbd className="hidden rounded border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground lg:inline">
            ⌘K
          </kbd>
        </Button>
        <Segmented value={width} options={WIDTHS} onChange={onWidth} />
        {review ? (
          <>
            <Segmented value={mode} options={MODES} onChange={onMode} />
            {site.isOwner && <ShareDialog spaceSlug={site.spaceSlug} siteSlug={site.siteSlug} title={site.title} compact />}
            <Button size="sm" variant="secondary" onClick={onExit}>
              <Check className="size-3.5" />
              Done
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={onReview}
              className={cn('gap-1.5', commentCount > 0 && 'text-primary')}
              title={commentCount > 0 ? `${commentCount} open comment${commentCount === 1 ? '' : 's'}` : 'Comments'}
            >
              <MessageSquare className="size-3.5" />
              Comments
              {commentCount > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-semibold text-[10px] text-primary-foreground leading-none tabular-nums">
                  {commentCount > 9 ? '9+' : commentCount}
                </span>
              )}
            </Button>
            {site.isOwner && <ShareDialog spaceSlug={site.spaceSlug} siteSlug={site.siteSlug} title={site.title} compact />}
          </>
        )}
      </div>
    </header>
  )
}
