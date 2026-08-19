import { ChevronRight, Command, GitFork, History, Menu, MessageSquare, Printer, Share2, Sparkles, Star } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { useStar } from '@/hooks/useStar'
import { api } from '@/lib/api'
import type { ViewerSite, Visibility } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ForkDialog } from '@/components/ForkDialog'
import { ShareDialog } from '@/components/ShareDialog'
import { SummarySheet } from '@/components/SummarySheet'
import { ThemeMenu, patchTheme } from '@/components/theme-select'
import { VISIBILITY_META, VisibilityBadge, VisibilityMenu } from '@/components/visibility'
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
  onPrint,
}: {
  site: ViewerSite
  sitePath: string
  railOpen: boolean
  commentCount: number
  onToggleRail: () => void
  onToggleSidebar: () => void
  onSearch: () => void
  // Posts glance:print into the content iframe (HTML sites only — absent hides the item). The
  // frame prints itself; the browser's print dialog is where the user picks "Save as PDF".
  onPrint?: () => void
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

      {/* Right after the name, so "what site is this — private / members / team" is answered
          without opening a dialog. The owner gets the live picker; everyone else a read-only chip. */}
      {site.isOwner ? <ViewerVisibility site={site} /> : <VisibilityBadge value={site.visibility} className="shrink-0" />}

      {/* Design theme: the owner gets a live switcher (hidden on phones — visibility wins the
          space); a re-skin needs a reload since the theme is injected server-side at serve time. */}
      {site.isOwner && (
        <span className="hidden shrink-0 sm:inline-flex">
          <ViewerTheme site={site} />
        </span>
      )}

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
            {onPrint && (
              <DropdownMenuItem onSelect={onPrint}>
                <Printer />
                Print / Save as PDF
              </DropdownMenuItem>
            )}
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

// Owner-only tier picker, same chip as the dashboard table. It holds its own value rather than
// revalidating: the viewer's loader also re-fires the comments prefetch, and a visibility PATCH is
// no reason to pay for that — the tier is the only thing that changed.
function ViewerVisibility({ site }: { site: ViewerSite }) {
  const [visibility, setVisibility] = useState(site.visibility)

  async function change(v: Visibility) {
    const prev = visibility
    setVisibility(v)
    try {
      await api.patch(`/api/sites/${site.spaceSlug}/${site.siteSlug}`, { visibility: v })
      toast.success('Visibility updated', { description: VISIBILITY_META[v].label })
    } catch (err) {
      setVisibility(prev)
      toast.error('Could not update visibility', { description: err instanceof Error ? err.message : undefined })
    }
  }

  return (
    <span className="shrink-0">
      <VisibilityMenu trigger="chip" value={visibility} onChange={change} />
    </span>
  )
}

// Owner-only theme switcher. The theme is injected into the served HTML by the content worker, so
// after a successful PATCH the page reloads — the iframe's annotate response is no-store and the
// themed etag never matches across a switch, so the reload always shows the new skin. (No local
// state: the reload repaints everything, and on failure the chip should keep showing the truth.)
function ViewerTheme({ site }: { site: ViewerSite }) {
  return (
    <ThemeMenu
      trigger="chip"
      value={site.theme}
      onChange={(t) =>
        void patchTheme(site.spaceSlug, site.siteSlug, t).then((ok) => {
          if (ok) window.location.reload()
        })
      }
    />
  )
}
