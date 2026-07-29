import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  Link,
  Navigate,
  useLoaderData,
  useLocation,
  useNavigate,
  useRouteLoaderData,
  useSearchParams,
} from 'react-router'
import { ChevronDown, Download, Mic, Plus, Rocket, Star, Terminal, Upload, Users } from 'lucide-react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { DeployCard } from '@/components/DeployCard'
import { GettingStarted } from '@/components/GettingStarted'
import { RecordDialog } from '@/components/record/RecordDialog'
import {
  actionsColumn,
  CopyOpenActions,
  feedColumns,
  starColumn,
  nameColumn,
  OpenLinkButton,
  updatedColumn,
  urlColumn,
  visibilityBadgeColumn,
} from '@/components/siteColumns'
import { SitesTable } from '@/components/SitesTable'
import { SortableTable, type Column } from '@/components/SortableTable'
import { EmptyState, Spinner } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import {
  deriveFeedState,
  errorMessage,
  type DashboardTab,
  type FeedSlot,
  type TabContent,
  type TabId,
  feedRowPath,
  tabFromParam,
} from '@/lib/feedState'
import { skipSearchOnlyRevalidation } from '@/lib/nav'
import { notificationHref } from '@/lib/mentions'
import type { RootData } from '@/lib/notifications'
import { timeAgo } from '@/lib/time'
import type { CommentFeedItem, SiteSummary, SpaceSummary, TeamUpload } from '@/lib/types'

// Stream the feeds instead of blocking the route on them: the loader returns the five promises
// un-awaited, the component tracks one slot per feed (useFeedSlot), and deriveFeedState (pure,
// unit-tested in lib/feedState.test.ts) maps the slots to the tab model — so each tab paints as
// its OWN feed resolves instead of every tab waiting on the slowest call. A failed feed degrades
// only its own tab; any 401 → login redirect.
// Observe each promise's rejection at creation: the real handlers only attach in useFeedSlot's
// post-mount effect, so a fast failure (or a revalidation racing an unmount) would otherwise
// surface as an unhandled rejection. Same rule viewerLoader.ts applies to the comments prefetch.
function observed<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

export function loader() {
  return {
    sites: observed(api.get<SiteSummary[]>('/api/sites/mine')),
    starred: observed(api.get<SiteSummary[]>('/api/sites/starred')),
    shared: observed(api.get<SiteSummary[]>('/api/sites/shared')),
    spaces: observed(api.get<SpaceSummary[]>('/api/spaces/mine')),
    team: observed(api.get<TeamUpload[]>('/api/sites/team')),
    comments: observed(api.get<CommentFeedItem[]>('/api/comments/feed')),
  }
}

// The active tab (?tab=) and the create-space dialog (?new=space) live in the search params — a
// search-only navigation must not refire all five feed calls.
export const shouldRevalidate = skipSearchOnlyRevalidation

/** Copy-and-mutate helper for setSearchParams updaters (params come to us read-only). */
const withParams = (prev: URLSearchParams, mutate: (next: URLSearchParams) => void) => {
  const next = new URLSearchParams(prev)
  mutate(next)
  return next
}

// All ?tab= WRITE mechanics in one place: clearing a stale param (see FeedState.staleTab — an
// effect, not a render-time set, since it mutates the URL) and the guarded tab-switch path.
// The guard dedupes Radix's double-fire: Tabs calls onValueChange twice per click (click, then
// focus) because the controlled value only catches up after our async URL update, and the refire
// would be a same-URL navigation — which React Router treats as "revalidate every loader". It
// compares against the LIVE URL, not render state: the refire lands before the re-render, but
// history has already been updated synchronously.
function useSetTabParam(staleTab: boolean): (t: TabId) => void {
  const [, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (staleTab) {
      setSearchParams((prev) => withParams(prev, (next) => next.delete('tab')), { replace: true })
    }
  }, [staleTab, setSearchParams])
  return (t) => {
    if (t === tabFromParam(new URLSearchParams(window.location.search).get('tab'))) return
    setSearchParams(
      // 'sites' is the default — keep the landing URL clean instead of pinning ?tab=sites.
      (prev) => withParams(prev, (next) => (t === 'sites' ? next.delete('tab') : next.set('tab', t))),
      { replace: true },
    )
  }
}

// Sites shared with me — same table shell as Your sites, minus the owner-only actions.
const SHARED_COLUMNS = feedColumns<SiteSummary>((s) => <CopyOpenActions url={s.url} />)

function SharedSitesTable({ sites }: { sites: SiteSummary[] }) {
  return (
    <SortableTable
      rows={sites}
      columns={SHARED_COLUMNS}
      getRowKey={(s) => s.id}
      initialSort={{ key: 'created', dir: 'desc' }}
    />
  )
}

// One slot per feed. Stale-while-revalidate on purpose: a revalidation hands us a NEW promise,
// and we keep showing the settled slot until the new one settles — resetting to pending here
// would flash every tab back to a skeleton on refetch. The cleanup flag drops out-of-order
// settlements from a superseded promise.
const PENDING = { status: 'pending' } as const

function useFeedSlot<T>(promise: Promise<T>): FeedSlot<T> {
  const [slot, setSlot] = useState<FeedSlot<T>>(PENDING)
  useEffect(() => {
    let superseded = false
    promise.then(
      (data) => {
        if (!superseded) setSlot({ status: 'resolved', data })
      },
      (error: unknown) => {
        if (!superseded) setSlot({ status: 'rejected', error })
      },
    )
    return () => {
      superseded = true
    }
  }, [promise])
  return slot
}

export function Component() {
  const loaded = useLoaderData() as {
    sites: Promise<SiteSummary[]>
    starred: Promise<SiteSummary[]>
    shared: Promise<SiteSummary[]>
    spaces: Promise<SpaceSummary[]>
    team: Promise<TeamUpload[]>
    comments: Promise<CommentFeedItem[]>
  }
  const sites = useFeedSlot(loaded.sites)
  const starred = useFeedSlot(loaded.starred)
  const shared = useFeedSlot(loaded.shared)
  const spaces = useFeedSlot(loaded.spaces)
  const team = useFeedSlot(loaded.team)
  const comments = useFeedSlot(loaded.comments)
  const [searchParams] = useSearchParams()
  const location = useLocation()
  // The active tab lives in the URL (?tab=) so a refresh or a shared link lands on the same tab.
  // deriveFeedState reconciles it against the tabs that actually exist; the URL is NOT rewritten
  // on fallback, so a ?tab=shared deep link activates once the Shared tab pops in (#38: an active
  // Shared tab emptied away falls back to Your sites the same way). Memoized so `tabs` and every
  // `rows` array keep their identity across unrelated re-renders (SortableTable's sort memo).
  const state = useMemo(
    () =>
      deriveFeedState(
        { sites, starred, shared, spaces, team, comments },
        { requestedTab: tabFromParam(searchParams.get('tab')) },
      ),
    [sites, starred, shared, spaces, team, comments, searchParams],
  )
  const setTab = useSetTabParam(state.staleTab)

  // Any feed 401'd — the session lapsed. Bounce to login, preserving where we were.
  if (state.unauthorized) {
    return (
      <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
    )
  }

  return (
    <div className="space-y-10">
      <ToolbarSection spaces={spaces} />
      <AgentSetup />
      {/* Mounted at the route level (not inside a tab), so ?new=space opens it from anywhere. */}
      <NewSpaceDialog />
      <Tabs value={state.activeTab} onValueChange={(t) => setTab(t as TabId)} className="gap-6">
        <TabsList variant="line">
          {state.tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
              {tab.count !== null && <TabCount n={tab.count} />}
            </TabsTrigger>
          ))}
        </TabsList>
        {state.tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id}>
            <TabBody tab={tab} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

// The deploy card needs only `spaces`, so it renders off that slot alone — the primary action
// paints as soon as spaces resolves and a slow or failing feed can't block or break it.
function ToolbarSection({ spaces }: { spaces: FeedSlot<SpaceSummary[]> }) {
  if (spaces.status === 'pending') return <ToolbarSkeleton />
  if (spaces.status === 'rejected') {
    // Keep the New menu alive on a failed feed — with the Spaces tab now conditional, it's the
    // page's only create-space affordance. The deploy pickers degrade inside their own dialogs.
    return (
      <div className="space-y-2">
        <DashboardToolbar spaces={[]} />
        <p className="text-destructive text-sm" role="alert">
          Couldn't load your spaces — {errorMessage(spaces.error, 'something went wrong. Try refreshing.')}
        </p>
      </div>
    )
  }
  return <DashboardToolbar spaces={spaces.data} />
}

// Per-tab body: loading skeleton / contained error / rows — each tab degrades alone.
function TabBody({ tab }: { tab: DashboardTab }) {
  switch (tab.id) {
    case 'sites':
      return (
        <TabPanel content={tab.content} what="your sites">
          {(sites) =>
            sites.length === 0 ? (
              <div className="mx-auto max-w-2xl py-10">
                <div className="mb-6 flex flex-col items-center gap-3 text-center">
                  <div className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Rocket className="size-5" />
                  </div>
                  <div className="font-medium">No sites yet</div>
                </div>
                <GettingStarted />
              </div>
            ) : (
              <SitesTable sites={sites} />
            )
          }
        </TabPanel>
      )
    case 'starred':
      return (
        <TabPanel content={tab.content} what="starred pages">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState
                icon={Star}
                title="Nothing starred yet"
                description="Star any team, group or shared page to pin it here."
              />
            ) : (
              <SharedSitesTable sites={rows} />
            )
          }
        </TabPanel>
      )
    // Shared and Spaces exist only resolved-with-rows (feedState), so they render rows directly —
    // no loading/error states to handle. New space lives in the top New menu.
    case 'shared':
      return <SharedSitesTable sites={tab.rows} />
    case 'spaces':
      return <SpacesTable spaces={tab.rows} />
    case 'team':
      return (
        <TabPanel content={tab.content} what="team activity">
          {(team) =>
            team.length === 0 ? (
              <EmptyState
                icon={Rocket}
                title="Nothing shipped yet"
                description="Team-visible sites show up here as people deploy them."
              />
            ) : (
              <TeamActivityTable team={team} />
            )
          }
        </TabPanel>
      )
    case 'comments':
      return (
        <TabPanel content={tab.content} what="comments">
          {(comments) =>
            comments.length === 0 ? (
              <EmptyState
                title="No comments yet"
                description="Mentions of you and comments you write will land here."
              />
            ) : (
              <CommentsFeed comments={comments} />
            )
          }
        </TabPanel>
      )
  }
}

function TabPanel<T>({
  content,
  what,
  children,
}: {
  content: TabContent<T>
  what: string
  children: (rows: T) => ReactNode
}) {
  if (content.kind === 'loading') return <TabPanelSkeleton />
  if (content.kind === 'error') {
    return <EmptyState title={`Couldn't load ${what}`} description={content.message} />
  }
  return children(content.rows)
}

// First paint, before the feeds resolve — one placeholder per streamed section.
function ToolbarSkeleton() {
  // Mirror DashboardToolbar's slim row (heading + subtitle on the left, New button on the right)
  // so the fallback doesn't reflow when the real toolbar streams in.
  return (
    <div className="flex items-end justify-between gap-4" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-9 w-24 rounded-md" />
    </div>
  )
}

// A pending tab's panel — the tab list itself always paints immediately.
function TabPanelSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {['a', 'b', 'c', 'd', 'e'].map((k) => (
        <Skeleton key={k} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  )
}

function TabCount({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{n}</span>
  )
}

// ─── Team activity ───────────────────────────────────────────────────────────

// Same table shell, with who-shipped + updated columns. Orders by last content activity (updatedAt)
// so a re-deployed site resurfaces to the top and the feed stays live.
const who = (u: TeamUpload) => u.uploaderName ?? u.uploaderEmail

const TEAM_COLUMNS: Column<TeamUpload>[] = [
  starColumn(),
  nameColumn(),
  urlColumn(),
  visibilityBadgeColumn(),
  {
    key: 'who',
    label: 'Shipped by',
    compare: (a, b) => who(a).localeCompare(who(b)),
    cellClassName: 'max-w-[12rem]',
    render: (u) => <span className="block truncate text-sm">{who(u)}</span>,
  },
  updatedColumn('when', 'Updated'),
  actionsColumn((u) => <OpenLinkButton url={u.url} />),
]

function TeamActivityTable({ team }: { team: TeamUpload[] }) {
  return (
    <SortableTable
      rows={team}
      columns={TEAM_COLUMNS}
      getRowKey={(u) => u.id}
      initialSort={{ key: 'when', dir: 'desc' }}
    />
  )
}

// ─── Comments ────────────────────────────────────────────────────────────────

function CommentsFeed({ comments }: { comments: CommentFeedItem[] }) {
  return (
    <ul className="divide-y rounded-xl border">
      {comments.map((item) => {
        const path = feedRowPath(item)
        const href = notificationHref({
          siteLabel: `${item.spaceSlug}/${item.siteSlug}`,
          filePath: item.filePath,
          threadId: item.threadId,
        })
        const v = (
          {
            mention: { author: item.actorName ?? 'Someone', verb: ' mentioned you' },
            owned: { author: item.actorName ?? 'Someone', verb: ' commented' },
            authored: { author: 'You', verb: '' },
          } as const
        )[item.kind]
        const editedSuffix = item.kind !== 'mention' && !!item.editedAt
        return (
          <li key={`${item.kind}:${item.id}`}>
            <Link
              to={href}
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent"
            >
              <span className="mt-0.5 w-16 shrink-0 rounded bg-muted px-1.5 py-0.5 text-center font-mono text-[10px] text-muted-foreground">
                {item.kind}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  <span className="font-medium">{v.author}</span>
                  {v.verb}
                  {item.snippet != null && (
                    <>
                      {' — "'}
                      {item.snippet}
                      {'"'}
                    </>
                  )}
                </p>
                <p className="truncate text-muted-foreground text-xs">
                  <span className="font-mono">
                    {item.spaceSlug}/{item.siteSlug}
                  </span>
                  {path && (
                    <>
                      {' · '}
                      <span className="font-mono">{path}</span>
                    </>
                  )}
                  {' · '}
                  {timeAgo(item.createdAt)}
                  {editedSuffix && ' · edited'}
                </p>
              </div>
              {item.threadStatus === 'open' ? (
                <Badge variant="success">open</Badge>
              ) : (
                <Badge variant="secondary" className="text-muted-foreground">
                  resolved
                </Badge>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

// ─── Top toolbar: the “New” menu ─────────────────────────────────────────────

// A slim header row instead of the old record-first mic hero: a plain-language heading and a
// single "New" menu. Creating is one click (record / upload); the sites list leads the page.
function DashboardToolbar({ spaces }: { spaces: SpaceSummary[] }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="font-semibold text-xl tracking-tight">Your work</h1>
        <p className="text-muted-foreground text-sm">Record a note or drop a folder — everyone gets a URL.</p>
      </div>
      <NewMenu spaces={spaces} />
    </div>
  )
}

// Onboarding banner under the hero: the one-liner installs the CLI *and* the agent skill, so a user
// can hand it to their coding agent (Claude, Codex, Cursor) and start shipping from the terminal.
// Pointed at THIS deployment's origin (mirrors GET /api/install), same as InstallDialog — no feed
// needed, so it renders immediately, independent of every feed slot. Hidden once the user's CLI
// has made an authenticated call (me.hasUsedCli) — the install one-liner stays reachable via
// NewMenu and the header HelpButton.
function AgentSetup() {
  const root = useRouteLoaderData('root') as RootData | undefined
  if (root?.user?.hasUsedCli) return null
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const installCmd = `curl -fsSL ${origin}/api/install | sh`
  return (
    <Card className="gap-4 border-primary/20 bg-primary/[0.03] p-5">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-primary" />
          <h2 className="font-medium">Give this to your agent</h2>
        </div>
        <p className="text-muted-foreground text-sm">
          Paste it into Claude, Codex, or Cursor — it installs the CLI and the glance skill, so your
          agent can ship sites and read review comments straight from your terminal.
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-md border bg-background/60 p-2">
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{installCmd}</code>
        <CopyButton text={installCmd} label="Copy" copiedMessage="Install command copied" />
      </div>
    </Card>
  )
}

// One primary button opens a menu: Record audio (RecordDialog) · Upload files (UploadDialog wrapping
// the bare DeployCard) · Create space (?new=space → the route-level NewSpaceDialog) · Install the
// CLI (the one-liner). onSelect closes the menu, then opens the controlled dialog rendered as a
// sibling — no nesting, so focus returns cleanly on close.
function NewMenu({ spaces }: { spaces: SpaceSummary[] }) {
  const [, setSearchParams] = useSearchParams()
  const [recordOpen, setRecordOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus />
            New
            <ChevronDown className="text-primary-foreground/80" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => setRecordOpen(true)}>
            <Mic />
            <div className="flex flex-col">
              <span>Record audio</span>
              <span className="text-muted-foreground text-xs">Voice note or comment</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setUploadOpen(true)}>
            <Upload />
            <div className="flex flex-col">
              <span>Upload files</span>
              <span className="text-muted-foreground text-xs">Drop a folder, get a URL</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              setSearchParams((prev) => withParams(prev, (next) => next.set('new', 'space')), {
                replace: true,
              })
            }
          >
            <Users />
            <div className="flex flex-col">
              <span>Create space</span>
              <span className="text-muted-foreground text-xs">Share sites with a group</span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setInstallOpen(true)}>
            <Download />
            Install the CLI
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RecordDialog spaces={spaces} open={recordOpen} onOpenChange={setRecordOpen} />
      <UploadDialog spaces={spaces} open={uploadOpen} onOpenChange={setUploadOpen} />
      <InstallDialog open={installOpen} onOpenChange={setInstallOpen} />
    </>
  )
}

// The CLI is also the agent skill; the one-liner is pre-pointed at THIS deployment's origin
// (mirrors GET /api/install), so what a user copies installs from the instance they're on.
function InstallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const installCmd = `curl -fsSL ${origin}/api/install | sh`
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install the glance CLI</DialogTitle>
          <DialogDescription>Deploy from your terminal — and use it as an agent skill.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
          <code className="min-w-0 flex-1 truncate font-mono text-sm">{installCmd}</code>
          <CopyButton text={installCmd} label="Copy" copiedMessage="Install command copied" />
        </div>
        <p className="text-muted-foreground text-xs">Installs to ~/.local/bin/glance.</p>
      </DialogContent>
    </Dialog>
  )
}

function UploadDialog({
  spaces,
  open,
  onOpenChange,
}: {
  spaces: SpaceSummary[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Upload files</DialogTitle>
          <DialogDescription>Pick a destination, then drop your files.</DialogDescription>
        </DialogHeader>
        <DeployCard spaces={spaces} />
      </DialogContent>
    </Dialog>
  )
}

// ─── Your spaces ─────────────────────────────────────────────────────────────

// Same table shell as the site feeds — one system across every collection on the dashboard.
const SPACE_COLUMNS: Column<SpaceSummary>[] = [
  {
    key: 'name',
    label: 'Name',
    headClassName: 'max-w-[15rem]',
    cellClassName: 'max-w-[15rem]',
    compare: (a, b) => a.name.localeCompare(b.name),
    render: (s) => (
      <Link to={`/${s.slug}`} className="block truncate font-medium hover:underline">
        {s.name}
      </Link>
    ),
  },
  {
    key: 'path',
    label: 'Path',
    compare: (a, b) => a.slug.localeCompare(b.slug),
    render: (s) => <span className="font-mono text-sm text-muted-foreground">/{s.slug}</span>,
  },
  actionsColumn((s) => (
    <Button asChild variant="outline" size="sm">
      <Link to={`/${s.slug}`}>Open</Link>
    </Button>
  )),
]

function SpacesTable({ spaces }: { spaces: SpaceSummary[] }) {
  return (
    <SortableTable
      rows={spaces}
      columns={SPACE_COLUMNS}
      getRowKey={(s) => s.id}
      initialSort={{ key: 'name', dir: 'asc' }}
    />
  )
}

function NewSpaceDialog() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  // Driven ENTIRELY by the URL: NewMenu, CommandPalette and ShareDialog all set ?new=space (even
  // while already on /dashboard — reading the param each render catches every arrival, #6).
  // Closing — the only transition this dialog owns — clears the param (so the URL doesn't
  // immediately reopen it) and resets the fields (so a reopen doesn't show a stale draft).
  const open = searchParams.get('new') === 'space'
  const close = () => {
    setSlug('')
    setName('')
    setSearchParams((prev) => withParams(prev, (next) => next.delete('new')), { replace: true })
  }

  async function create() {
    if (!slug.trim() || !name.trim()) {
      toast.error('Slug and name are required.')
      return
    }
    setSaving(true)
    try {
      const created = await api.post<{ slug: string }>('/api/spaces', { slug, name })
      toast.success('Space created', { description: `/${created.slug}` })
      close()
      // No revalidate: we navigate away, and returning to /dashboard re-runs the loader anyway.
      navigate(`/${created.slug}`)
    } catch (err) {
      toast.error('Could not create space', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a space</DialogTitle>
          <DialogDescription>Spaces let you share sites with a group of teammates.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="space-slug">Slug</Label>
            <Input
              id="space-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="platform-docs"
              className="font-mono"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-name">Name</Label>
            <Input
              id="space-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Platform Docs"
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={create} disabled={saving}>
            {saving && <Spinner />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
