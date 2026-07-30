import { ChevronRight, Command, GitFork, History, Menu, MessageSquare, Share2, Sparkles, Star } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useStar } from '@/hooks/useStar'
import type { ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ForkDialog } from '@/components/ForkDialog'
import { ShareDialog } from '@/components/ShareDialog'
import { SummarySheet } from '@/components/SummarySheet'
import { BrandMark } from '@/components/states'

// The persistent top chrome for the viewer: brand (→ dashboard) + a breadcrumb, then one action
// row — Star, Comments, hamburger. Replaces the old floating PreviewToolbar dock.
//
// C2b: "review mode" is gone — Comments is a plain TOGGLE for the rail panel, always present (an
// open-count badge rides along), and there is no separate Done button; the rail's own ✕ closes it
// too. Commenting is unconditional elsewhere (viewer.tsx) — the rail is just a
// panel you open and close, not a gate on any of that.
//
// The row is the same three controls at EVERY breakpoint: only Star and Comments earn a permanent
// slot; Recently opened / Search / Fork / TL;DR / Share live in the hamburger menu. Those menu
// items are driven from shared state (ForkDialog, SummarySheet, ShareDialog) held here, so the
// menu item and the sheet/dialog it opens are one action.
export function ViewerTopBar({
  site,
  sitePath,
  railOpen,
  commentCount,
  onToggleRail,
  onToggleSidebar,
  onSearch,
}: {
  site: ViewerSite
  sitePath: string
  railOpen: boolean
  commentCount: number
  onToggleRail: () => void
  onToggleSidebar: () => void
  onSearch: () => void
}) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  // Star has a permanent slot in the row, so it is the one action with no menu-item twin.
  const { starred, toggle: toggleStar } = useStar(site)
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:gap-3">
      <Link to="/dashboard" className="flex shrink-0 items-center gap-2 font-mono font-semibold text-sm tracking-tight">
        <BrandMark />
        glance
      </Link>

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
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          title={starred ? 'Remove star' : 'Star this page'}
          aria-label={starred ? 'Remove star' : 'Star this page'}
          aria-pressed={starred}
          onClick={() => void toggleStar()}
        >
          <Star className={starred ? 'fill-primary text-primary' : 'opacity-40'} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onToggleRail}
          aria-pressed={railOpen}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Menu">
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
            {/* Fork is deliberately NOT gated on site.isOwner (unlike Share): anyone who can read a
                site can fork it, so a plain viewer gets this too. */}
            <DropdownMenuItem onSelect={() => setForkOpen(true)}>
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
      {/* All three render through a portal, so they can live inside the header without affecting
          layout. Controlled (no inline trigger) — their menu items drive this state. */}
      <ForkDialog site={site} open={forkOpen} onOpenChange={setForkOpen} />
      <SummarySheet
        spaceSlug={site.spaceSlug}
        siteSlug={site.siteSlug}
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
      />
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
