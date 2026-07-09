import { Suspense, useMemo, useState } from 'react'
import {
  Await,
  Link,
  Navigate,
  type ShouldRevalidateFunctionArgs,
  useAsyncError,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  useRouteLoaderData,
  useSearchParams,
} from 'react-router'
import { Bell, ChevronDown, Download, ExternalLink, Mic, Plus, Rocket, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { DeployCard } from '@/components/DeployCard'
import { RecordDialog } from '@/components/record/RecordDialog'
import {
  actionsColumn,
  createdColumn,
  nameColumn,
  OpenLinkButton,
  urlColumn,
  visibilityBadgeColumn,
} from '@/components/siteColumns'
import { SitesTable } from '@/components/SitesTable'
import { SortableTable, type Column } from '@/components/SortableTable'
import { EmptyState, Spinner } from '@/components/states'
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
  DialogTrigger,
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
import { useOpenNotification } from '@/components/NotificationsBell'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { notifPoll } from '@/lib/notifPoll'
import type { NotificationList, RootData } from '@/lib/notifications'
import { timeAgo } from '@/lib/time'
import type { SiteSummary, SpaceSummary, TeamUpload } from '@/lib/types'

// Stream the feeds instead of blocking the route on them: the shell paints at root-loader time,
// the deploy card streams on `spaces` alone, and the tabs stream once their feeds resolve —
// rather than the whole page staying blank until the slowest call returns. Promises are consumed
// via <Await>; a failed feed degrades only its own section (FeedError), and a 401 → login.
export function loader() {
  return {
    sites: api.get<SiteSummary[]>('/api/sites/mine'),
    shared: api.get<SiteSummary[]>('/api/sites/shared'),
    spaces: api.get<SpaceSummary[]>('/api/spaces/mine'),
    team: api.get<TeamUpload[]>('/api/sites/team'),
  }
}

// The 60s notification poll revalidates the ROOT loader (notifications); this route's 4 feeds are
// heavy and don't change on that cadence, so skip them for a poll-flagged revalidation. Every other
// trigger (navigation, a mutation's revalidate()) refreshes normally.
export function shouldRevalidate(arg: ShouldRevalidateFunctionArgs): boolean {
  if (notifPoll.consume()) return false
  return arg.defaultShouldRevalidate
}

// Sites shared with me — same table shell as Your sites, minus the owner-only actions.
const SHARED_COLUMNS: Column<SiteSummary>[] = [
  nameColumn(),
  urlColumn(),
  visibilityBadgeColumn(),
  createdColumn(),
  actionsColumn((s) => (
    <div className="flex items-center justify-end gap-1">
      <CopyButton text={s.url} label="" variant="outline" />
      <OpenLinkButton url={s.url} />
    </div>
  )),
]

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

export function Component() {
  const { sites, shared, spaces, team } = useLoaderData() as {
    sites: Promise<SiteSummary[]>
    shared: Promise<SiteSummary[]>
    spaces: Promise<SpaceSummary[]>
    team: Promise<TeamUpload[]>
  }
  // The tabs need every count (and the conditional Shared tab) up front, so they share one Await on
  // all four feeds. The deploy card only needs `spaces`, so it streams on its own — the primary
  // action paints as soon as spaces resolves and a slow or failing feed can't block or break it.
  // Each <Await> sees a STABLE promise across re-renders (a fresh Promise.all would re-suspend);
  // revalidation yields new promises but React keeps the resolved UI through the RR transition, so
  // refetch won't flash the skeletons — only the first paint does.
  const tabsData = useMemo(() => Promise.all([sites, shared, spaces, team]), [sites, shared, spaces, team])

  return (
    <div className="space-y-10">
      <NotificationsInbox />
      <Suspense fallback={<ToolbarSkeleton />}>
        <Await resolve={spaces} errorElement={<FeedError what="the deploy form" />}>
          {(spaces) => <DashboardToolbar spaces={spaces} />}
        </Await>
      </Suspense>
      <Suspense fallback={<TabsSkeleton />}>
        <Await resolve={tabsData} errorElement={<FeedError what="your sites" />}>
          {([sites, shared, spaces, team]) => (
            <DashboardTabs sites={sites} shared={shared} spaces={spaces} team={team} />
          )}
        </Await>
      </Suspense>
    </div>
  )
}

// Homepage "Notifications" inbox. The notifications live on the ROOT loader (deferred), which this
// route's own loader can't see — so read them via useRouteLoaderData('root'). Hidden entirely when
// there's nothing to show, so a caught-up dashboard stays clean.
function NotificationsInbox() {
  const root = useRouteLoaderData('root') as RootData | undefined
  if (!root) return null
  return (
    <Suspense fallback={null}>
      <Await resolve={root.notifications} errorElement={null}>
        {(data: NotificationList) => <NotificationsInboxCard data={data} />}
      </Await>
    </Suspense>
  )
}

function NotificationsInboxCard({ data }: { data: NotificationList }) {
  const open = useOpenNotification()
  if (data.items.length === 0) return null
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Bell className="size-4 text-muted-foreground" />
        <h2 className="font-medium text-sm">Notifications</h2>
        {data.unreadCount > 0 && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono font-semibold text-[11px] text-primary">
            {data.unreadCount} new
          </span>
        )}
      </div>
      <ul className="divide-y">
        {data.items.slice(0, 5).map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => open(n)}
              className={cn(
                'flex w-full items-start gap-2 px-4 py-2.5 text-left text-sm hover:bg-accent/50',
                !n.read && 'bg-primary/5',
              )}
            >
              <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-primary')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="font-medium">{n.actorName ?? 'Someone'}</span> mentioned you
                  {n.siteLabel ? ` in ${n.siteLabel}` : ''}
                </span>
                {n.snippet && <span className="block truncate text-muted-foreground text-xs">{n.snippet}</span>}
                <span className="block text-muted-foreground text-xs">{timeAgo(n.createdAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function DashboardTabs({
  sites,
  shared,
  spaces,
  team,
}: {
  sites: SiteSummary[]
  shared: SiteSummary[]
  spaces: SpaceSummary[]
  team: TeamUpload[]
}) {
  const groupSpaces = spaces.filter((s) => s.type === 'group')
  const [searchParams] = useSearchParams()
  // Controlled tabs (Radix Tabs is otherwise uncontrolled) so we can steer the active tab in two
  // cases the URL/feeds dictate. Reconcile during render, not in an effect (the repo's idiom):
  const [tab, setTab] = useState('sites')
  // #6 — a deep link ?new=space (from CommandPalette/ShareDialog, even while already on /dashboard)
  // must select the Spaces tab so NewSpaceDialog mounts + opens.
  if (searchParams.get('new') === 'space' && tab !== 'spaces') setTab('spaces')
  // #38 — the Shared tab exists only while something is shared; if that feed empties during a
  // revalidation while it's active, fall back to Your sites so the panel never blanks.
  if (tab === 'shared' && shared.length === 0) setTab('sites')

  return (
    <div className="space-y-10">
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="sites">
            Your sites
            <TabCount n={sites.length} />
          </TabsTrigger>
          {shared.length > 0 && (
            <TabsTrigger value="shared">
              Shared with me
              <TabCount n={shared.length} />
            </TabsTrigger>
          )}
          <TabsTrigger value="spaces">
            Your spaces
            <TabCount n={groupSpaces.length} />
          </TabsTrigger>
          <TabsTrigger value="team">Team activity</TabsTrigger>
        </TabsList>

        <TabsContent value="sites">
          {sites.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="No sites yet"
              description="Drop a folder above to ship your first."
            />
          ) : (
            <SitesTable sites={sites} />
          )}
        </TabsContent>

        {shared.length > 0 && (
          <TabsContent value="shared">
            <SharedSitesTable sites={shared} />
          </TabsContent>
        )}

        <TabsContent value="spaces" className="space-y-4">
          <div className="flex justify-end">
            <NewSpaceDialog />
          </div>
          {groupSpaces.length === 0 ? (
            <EmptyState
              title="No group spaces"
              description="Create a space to collaborate with teammates."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {groupSpaces.map((s) => (
                <SpaceCard key={s.id} space={s} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="team">
          {team.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="Nothing shipped yet"
              description="Team-visible sites show up here as people deploy them."
            />
          ) : (
            <TeamActivityTable team={team} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
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

function TabsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="flex gap-4">
        {['a', 'b', 'c', 'd'].map((k) => (
          <Skeleton key={k} className="h-7 w-28" />
        ))}
      </div>
      <div className="space-y-2">
        {['a', 'b', 'c', 'd', 'e'].map((k) => (
          <Skeleton key={k} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}

// A feed rejected. 401 = the session lapsed → bounce to login, preserving where we were. Anything
// else renders a contained inline error so one failed feed degrades only its own section instead
// of taking down the whole route.
function FeedError({ what }: { what: string }) {
  const error = useAsyncError()
  const location = useLocation()
  if (error instanceof ApiError && error.status === 401) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }
  return (
    <EmptyState
      title={`Couldn't load ${what}`}
      description={error instanceof Error ? error.message : 'Something went wrong. Try refreshing.'}
    />
  )
}

function TabCount({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{n}</span>
  )
}

// ─── Team activity ───────────────────────────────────────────────────────────

// Same table shell, with who-shipped + when columns. Defaults to newest-first (a feed).
const who = (u: TeamUpload) => u.uploaderName ?? u.uploaderEmail

const TEAM_COLUMNS: Column<TeamUpload>[] = [
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
  createdColumn('when', 'When'),
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

// One primary button opens a menu: Record audio (RecordDialog) · Upload files (UploadDialog wrapping
// the bare DeployCard) · Install the CLI (the one-liner). onSelect closes the menu, then opens the
// controlled dialog rendered as a sibling — no nesting, so focus returns cleanly on close.
function NewMenu({ spaces }: { spaces: SpaceSummary[] }) {
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

function SpaceCard({ space }: { space: SpaceSummary }) {
  return (
    <Card className="gap-0 py-0 transition-colors hover:border-primary/40">
      <Link to={`/${space.slug}`} className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate font-medium">{space.name}</p>
          <p className="font-mono text-sm text-muted-foreground">/{space.slug}</p>
        </div>
        <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </Card>
  )
}

function NewSpaceDialog() {
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const [searchParams, setSearchParams] = useSearchParams()
  const [internalOpen, setInternalOpen] = useState(false)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  // Open LIVE from the URL: CommandPalette/ShareDialog navigate to ?new=space while already on
  // /dashboard, so a mount-time initializer (which never re-runs) would silently no-op (#6).
  // Reading the param each render catches every arrival.
  const open = internalOpen || searchParams.get('new') === 'space'
  const setOpen = (o: boolean) => {
    setInternalOpen(o)
    // Clear the param on close so the still-present URL doesn't immediately reopen the dialog.
    if (!o && searchParams.get('new') === 'space') {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('new')
          return next
        },
        { replace: true },
      )
    }
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
      setOpen(false)
      revalidator.revalidate()
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
    <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus />
          New space
        </Button>
      </DialogTrigger>
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
