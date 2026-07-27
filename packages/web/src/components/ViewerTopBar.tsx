import { Check, ChevronRight, Command, GitFork, History, Menu, MessageSquare, Share2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useForkSite } from '@/hooks/useForkSite'
import type { ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ShareDialog } from '@/components/ShareDialog'
import { SummarySheet } from '@/components/SummarySheet'
import { Spinner } from '@/components/states'

// The persistent top chrome for the viewer: brand (→ dashboard) + a breadcrumb, then one action
// row that stays put across modes — Fork, TL;DR, Comments (with an open count, outside review),
// Share, and Done while reviewing. The Read·Annotate toggle lives in the ReviewRail header, next
// to the comments it drives. Replaces the old floating PreviewToolbar dock.
//
// Below `md` the row doesn't fit (7 controls overlapped the breadcrumb on a phone), so everything
// except Comments and Done collapses into a hamburger menu. Fork/TL;DR/Share are driven from shared
// state rather than duplicated components, so the desktop button and the menu item are one action.
export function ViewerTopBar({
  site,
  sitePath,
  review,
  commentCount,
  onReview,
  onExit,
  onToggleSidebar,
  onSearch,
}: {
  site: ViewerSite
  sitePath: string
  review: boolean
  commentCount: number
  onReview: () => void
  onExit: () => void
  onToggleSidebar: () => void
  onSearch: () => void
}) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const { fork, forking } = useForkSite(site)
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:gap-3">
      <Link to="/dashboard" className="flex shrink-0 items-center gap-2 font-mono font-semibold text-sm tracking-tight">
        <span className="size-2.5 rounded-[3px] bg-primary shadow-[0_0_12px_1px_var(--primary)]" />
        glance
      </Link>

      <Button
        size="sm"
        variant="ghost"
        className="hidden shrink-0 px-2 md:inline-flex"
        title="Recently opened"
        aria-label="Recently opened"
        onClick={onToggleSidebar}
      >
        <History className="size-3.5" />
      </Button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
        <ChevronRight className="size-3.5 shrink-0 opacity-40" />
        {/* The space slug is the first thing to go on a phone — the file being viewed matters more. */}
        <span className="hidden shrink-0 md:inline">{site.spaceSlug}</span>
        <span className="hidden opacity-40 md:inline">/</span>
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
          className="hidden gap-2 text-muted-foreground md:inline-flex"
          onClick={onSearch}
          title="Search sites or run a command"
        >
          <Command className="size-3.5" />
          <span className="hidden lg:inline">Search</span>
          <kbd className="hidden rounded border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground lg:inline">
            ⌘K
          </kbd>
        </Button>
        {/* Fork is deliberately NOT gated on site.isOwner (unlike Share): anyone who can read a
            site can fork it, so a plain viewer gets this too. */}
        <Button
          size="sm"
          variant="ghost"
          className="hidden gap-1.5 md:inline-flex"
          disabled={forking}
          onClick={() => void fork()}
          title="Copy this site into your own space"
        >
          {forking ? <Spinner className="size-3.5" /> : <GitFork className="size-3.5" />}
          Fork
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="hidden gap-1.5 md:inline-flex"
          title="AI summary"
          onClick={() => setSummaryOpen(true)}
        >
          <Sparkles className="size-3.5" />
          TL;DR
        </Button>
        {!review && (
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
        )}
        {site.isOwner && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden size-8 rounded-full md:inline-flex"
            title="Share with people & groups"
            aria-label="Share with people & groups"
            onClick={() => setShareOpen(true)}
          >
            <Share2 />
          </Button>
        )}
        {review && (
          <Button size="sm" variant="secondary" onClick={onExit}>
            <Check className="size-3.5" />
            Done
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 md:hidden" aria-label="Menu">
              <Menu />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onToggleSidebar}>
              <History />
              Recently opened
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSearch}>
              <Command />
              Search
            </DropdownMenuItem>
            <DropdownMenuItem disabled={forking} onSelect={() => void fork()}>
              <GitFork />
              Fork
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSummaryOpen(true)}>
              <Sparkles />
              TL;DR
            </DropdownMenuItem>
            {site.isOwner && (
              <DropdownMenuItem onSelect={() => setShareOpen(true)}>
                <Share2 />
                Share…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Both render through a portal, so they can live inside the header without affecting layout.
          Controlled (no inline trigger) — the desktop button and the menu item drive the same state. */}
      <SummarySheet spaceSlug={site.spaceSlug} siteSlug={site.siteSlug} open={summaryOpen} onOpenChange={setSummaryOpen} />
      {site.isOwner && (
        <ShareDialog
          spaceSlug={site.spaceSlug}
          siteSlug={site.siteSlug}
          title={site.title}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </header>
  )
}
