import { type ReactNode, useEffect, useState } from 'react'
import {
  Link,
  Navigate,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from 'react-router'
import { ChevronDown, Download, ExternalLink, Mic, Plus, Rocket, Terminal, Upload } from 'lucide-react'
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
import { api } from '@/lib/api'
import {
  deriveFeedState,
  errorMessage,
  type DashboardTab,
  type FeedSlot,
  type TabContent,
  type TabId,
} from '@/lib/feedState'
import type { SiteSummary, SpaceSummary, TeamUpload } from '@/lib/types'

// Stream the feeds instead of blocking the route on them: the loader returns the four promises
// un-awaited, the component tracks one slot per feed (useFeedSlot), and deriveFeedState (pure,
// unit-tested in lib/feedState.test.ts) maps the slots to the tab model — so each tab paints as
// its OWN feed resolves instead of every tab waiting on the slowest call. A failed feed degrades
// only its own tab; any 401 → login redirect.
export function loader() {
  return {
    sites: api.get<SiteSummary[]>('/api/sites/mine'),
    shared: api.get<SiteSummary[]>('/api/sites/shared'),
    spaces: api.get<SpaceSummary[]>('/api/spaces/mine'),
    team: api.get<TeamUpload[]>('/api/sites/team'),
  }
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
    shared: Promise<SiteSummary[]>
    spaces: Promise<SpaceSummary[]>
    team: Promise<TeamUpload[]>
  }
  const slots = {
    sites: useFeedSlot(loaded.sites),
    shared: useFeedSlot(loaded.shared),
    spaces: useFeedSlot(loaded.spaces),
    team: useFeedSlot(loaded.team),
  }
  const [searchParams] = useSearchParams()
  const location = useLocation()
  // Controlled tabs (Radix Tabs is otherwise uncontrolled): the user's pick is `requestedTab`;
  // deriveFeedState reconciles it against the tabs that exist and the two URL/feed-driven steers.
  const [requestedTab, setRequestedTab] = useState<TabId>('sites')
  const state = deriveFeedState(slots, {
    requestedTab,
    // #6 — a deep link ?new=space (from CommandPalette/ShareDialog, even while already on
    // /dashboard) must select the Spaces tab so NewSpaceDialog mounts + opens.
    wantsNewSpace: searchParams.get('new') === 'space',
  })
  // Reconcile during render, not in an effect (the repo's idiom). This CONSUMES the steering
  // signal: once requestedTab is 'spaces', the next derive returns steerTo: null — fire-once.
  // It also makes the #38 fallback sticky (active Shared tab emptied away → land on Your sites).
  const target = state.steerTo ?? state.activeTab
  if (requestedTab !== target) setRequestedTab(target)

  // Any feed 401'd — the session lapsed. Bounce to login, preserving where we were.
  if (state.unauthorized) {
    return (
      <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
    )
  }

  return (
    <div className="space-y-10">
      <ToolbarSection spaces={slots.spaces} />
      <AgentSetup />
      <Tabs value={state.activeTab} onValueChange={(t) => setRequestedTab(t as TabId)} className="gap-6">
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
    return (
      <EmptyState
        title="Couldn't load the deploy form"
        description={errorMessage(spaces.error, 'Something went wrong. Try refreshing.')}
      />
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
              <EmptyState
                icon={Rocket}
                title="No sites yet"
                description="Drop a folder above to ship your first."
              />
            ) : (
              <SitesTable sites={sites} />
            )
          }
        </TabPanel>
      )
    case 'shared':
      return (
        <TabPanel content={tab.content} what="shared sites">
          {(shared) => <SharedSitesTable sites={shared} />}
        </TabPanel>
      )
    case 'spaces':
      // The New-space row renders in every content state so ?new=space can open the dialog (#6)
      // even while the feed is still loading. Rows here are the GROUP spaces (helper-filtered).
      return (
        <div className="space-y-4">
          <div className="flex justify-end">
            <NewSpaceDialog />
          </div>
          <TabPanel content={tab.content} what="your spaces">
            {(groupSpaces) =>
              groupSpaces.length === 0 ? (
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
              )
            }
          </TabPanel>
        </div>
      )
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

// Onboarding banner under the hero: the one-liner installs the CLI *and* the agent skill, so a user
// can hand it to their coding agent (Claude, Codex, Cursor) and start shipping from the terminal.
// Pointed at THIS deployment's origin (mirrors GET /api/install), same as InstallDialog — no feed
// needed, so it renders immediately, independent of every feed slot.
function AgentSetup() {
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
