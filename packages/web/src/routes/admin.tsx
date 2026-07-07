import { useState } from 'react'
import {
  Activity,
  Archive,
  ArchiveRestore,
  Boxes,
  Eye,
  FileText,
  FolderOpen,
  HardDrive,
  MessageSquare,
  Terminal,
  Trash2,
  UserCheck,
  Users2,
} from 'lucide-react'
import {
  type LoaderFunctionArgs,
  redirect,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState, PageHeader, SectionHeader, Spinner } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VisibilityBadge } from '@/components/visibility'
import { api, ApiError } from '@/lib/api'
import type { SiteStatus, Visibility } from '@/lib/types'

// ── API row shapes (admin endpoints; see API contract) ──────────────────────
interface AdminSite {
  id: string
  spaceSlug: string
  siteSlug: string
  title: string | null
  visibility: Visibility
  status: SiteStatus
  ownerId: string
  createdAt: string
}

interface AdminSpace {
  id: string
  slug: string
  name: string
  type: 'personal' | 'group'
  memberCount: number
  createdAt: string
}

interface AdminUser {
  id: string
  email: string
  name: string | null
  role: 'member' | 'superadmin'
  createdAt: string
}

type AdminTab = 'overview' | 'sites' | 'spaces' | 'users'

interface SitesData {
  sites: AdminSite[]
  page: number
  pageSize: number
  total: number
}

// Usage-analytics payload from GET /api/admin/stats (see lib/stats.ts).
interface StatsData {
  totals: {
    users: number
    sites: number
    files: number
    storageBytes: number
    comments: number
    views: number
    cliInvocations: number
    uniqueViewers: number
  }
  activeViewers30d: number
  series: { date: string; signups: number; sites: number; views: number; comments: number; cli: number }[]
  topSites: { siteId: string | null; siteLabel: string | null; views: number }[]
  windowDays: number
}

type LoaderData =
  | { tab: 'overview'; data: StatsData }
  | { tab: 'sites'; data: SitesData }
  | { tab: 'spaces'; data: AdminSpace[] }
  | { tab: 'users'; data: AdminUser[] }

const TABS: AdminTab[] = ['overview', 'sites', 'spaces', 'users']

function asTab(value: string | null): AdminTab {
  return value === 'sites' || value === 'spaces' || value === 'users' ? value : 'overview'
}

// If the requested page overshoots the available pages — e.g. the last row of the last page was
// just deleted, stranding the admin on an empty "Page N of M" past the end (#36) — return the last
// VALID page to redirect to; otherwise null. Pure so it's unit-testable without the loader.
export function overflowPage(data: SitesData): number | null {
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))
  return data.page > totalPages ? totalPages : null
}

// ── Loader: tab-aware fetch driven by URL searchParams ──────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const tab = asTab(url.searchParams.get('tab'))
  try {
    if (tab === 'overview') {
      const data = await api.get<StatsData>('/api/admin/stats')
      return { tab, data } satisfies LoaderData
    }
    if (tab === 'spaces') {
      const data = await api.get<AdminSpace[]>('/api/admin/spaces')
      return { tab, data } satisfies LoaderData
    }
    if (tab === 'users') {
      const data = await api.get<AdminUser[]>('/api/admin/users')
      return { tab, data } satisfies LoaderData
    }
    const status = url.searchParams.get('status') ?? ''
    const visibility = url.searchParams.get('visibility') ?? ''
    const page = url.searchParams.get('page') ?? '1'
    const qs = new URLSearchParams()
    if (status) qs.set('status', status)
    if (visibility) qs.set('visibility', visibility)
    qs.set('page', page)
    const data = await api.get<SitesData>(`/api/admin/sites?${qs.toString()}`)
    // Clamp an out-of-range page (e.g. after deleting the last row of the last page) to the last
    // valid page so the admin never lands on an empty ghost page. Re-throwing the redirect through
    // the catch below is a no-op (a Response isn't an ApiError), and the redirected load lands
    // in-range so it can't loop.
    const overflow = overflowPage(data)
    if (overflow !== null) {
      qs.set('page', String(overflow))
      qs.set('tab', 'sites')
      throw redirect(`/admin?${qs.toString()}`)
    }
    return { tab, data } satisfies LoaderData
  } catch (err) {
    // 401 → login; 403 (non-superadmin) bubbles to the route ErrorBoundary.
    if (err instanceof ApiError && err.status === 401) throw redirect('/login')
    throw err
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString()
}

// Run a mutation, toast the outcome, then revalidate the loader. The ConfirmDialog
// trigger re-throws so its own spinner/error toast still works for destructive flows.
function useMutation() {
  const revalidator = useRevalidator()
  return async (label: string, fn: () => Promise<unknown>) => {
    await fn()
    toast.success(label)
    revalidator.revalidate()
  }
}

// Non-destructive action (no ConfirmDialog), so it owns its own in-flight state to
// disable + spinner while the PATCH runs and to guard against double-submits.
function RestoreButton({ siteId }: { siteId: string }) {
  const mutate = useMutation()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        mutate('Site restored', () => api.patch(`/api/admin/sites/${siteId}/restore`))
          .catch((err) => toast.error(err instanceof Error ? err.message : 'Restore failed'))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? <Spinner className="size-3.5" /> : <ArchiveRestore className="size-3.5" />}
      Restore
    </Button>
  )
}

// ── Overview (usage analytics) tab ──────────────────────────────────────────
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 || value === Math.floor(value) ? 0 : 1)} ${units[i]}`
}

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Eye; label: string; value: string; sub?: string }) {
  return (
    <Card className="gap-0 py-4">
      <CardHeader className="px-4 pb-1">
        <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
}

// Dependency-free inline SVG sparkline. Scales a series to the viewBox; flat/empty series render
// as a baseline. Purely decorative, so it's aria-hidden — the numbers carry the real information.
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const width = 240
  const height = 40
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`)
  const line = points.join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
      role="presentation"
    >
      <polygon points={area} className="fill-primary/10" />
      <polyline points={line} fill="none" className="stroke-primary" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

function TrendCard({
  icon: Icon,
  label,
  total,
  values,
}: {
  icon: typeof Eye
  label: string
  total: number
  values: number[]
}) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4 pb-0">
        <CardTitle className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Icon className="size-3.5" />
            {label}
          </span>
          <span className="tabular-nums">{formatCount(total)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <Sparkline values={values} className="h-10 w-full" />
      </CardContent>
    </Card>
  )
}

function StatsPanel({ data }: { data: StatsData }) {
  const { totals, series, topSites, activeViewers30d, windowDays } = data
  const sum = (key: 'signups' | 'views' | 'cli' | 'comments') => series.reduce((acc, d) => acc + d[key], 0)

  return (
    <div className="space-y-6">
      {/* Headline totals (all-time). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard icon={Users2} label="Users" value={formatCount(totals.users)} />
        <StatCard icon={FolderOpen} label="Sites" value={formatCount(totals.sites)} />
        <StatCard
          icon={FileText}
          label="Files hosted"
          value={formatCount(totals.files)}
          sub={formatBytes(totals.storageBytes)}
        />
        <StatCard icon={HardDrive} label="Storage" value={formatBytes(totals.storageBytes)} />
        <StatCard
          icon={Eye}
          label="Page views"
          value={formatCount(totals.views)}
          sub={`${formatCount(totals.uniqueViewers)} unique viewers`}
        />
        <StatCard
          icon={UserCheck}
          label="Active viewers"
          value={formatCount(activeViewers30d)}
          sub={`last ${windowDays} days`}
        />
        <StatCard icon={MessageSquare} label="Comments" value={formatCount(totals.comments)} />
        <StatCard icon={Terminal} label="CLI invocations" value={formatCount(totals.cliInvocations)} />
      </div>

      {/* 30-day trends. */}
      <div>
        <SectionHeader title={`Last ${windowDays} days`}>
          <span className="text-sm text-muted-foreground">Daily activity</span>
        </SectionHeader>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TrendCard icon={Eye} label="Views" total={sum('views')} values={series.map((d) => d.views)} />
          <TrendCard icon={Users2} label="Signups" total={sum('signups')} values={series.map((d) => d.signups)} />
          <TrendCard
            icon={MessageSquare}
            label="Comments"
            total={sum('comments')}
            values={series.map((d) => d.comments)}
          />
          <TrendCard icon={Terminal} label="CLI" total={sum('cli')} values={series.map((d) => d.cli)} />
        </div>
      </div>

      {/* Most-viewed sites in the window. */}
      <div>
        <SectionHeader title="Top sites">
          <span className="text-sm text-muted-foreground">Most viewed in the last {windowDays} days</span>
        </SectionHeader>
        {topSites.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={Activity}
              title="No views yet"
              description="Page views will appear here once sites get traffic."
            />
          </div>
        ) : (
          <div className="mt-3 rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topSites.map((s) => (
                  <TableRow key={s.siteId ?? s.siteLabel ?? 'unknown'}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      /{s.siteLabel ?? 'deleted site'}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatCount(s.views)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

const STATUS_OPTIONS = ['active', 'archived'] as const
const VISIBILITY_OPTIONS: Visibility[] = ['private', 'members', 'team']

// "all" is the sentinel for the unfiltered option (Radix Select can't hold an empty value).
const ALL = 'all'

// ── Sites tab ───────────────────────────────────────────────────────────────
function SitesPanel({ data }: { data: SitesData }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const mutate = useMutation()

  const status = searchParams.get('status') ?? ALL
  const visibility = searchParams.get('visibility') ?? ALL
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))

  function setFilter(key: 'status' | 'visibility', value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value === ALL) next.delete(key)
      else next.set(key, value)
      next.set('page', '1') // filtering resets pagination
      return next
    })
  }

  function setPage(page: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('page', String(page))
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(v) => setFilter('status', v)}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={visibility} onValueChange={(v) => setFilter('visibility', v)}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder="Visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All visibility</SelectItem>
            {VISIBILITY_OPTIONS.map((v) => (
              <SelectItem key={v} value={v} className="capitalize">
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {data.sites.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No sites match"
          description="Try clearing the status or visibility filters."
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sites.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="font-medium">{s.title ?? s.siteSlug}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      /{s.spaceSlug}/{s.siteSlug}
                    </div>
                  </TableCell>
                  <TableCell>
                    <VisibilityBadge value={s.visibility} />
                  </TableCell>
                  <TableCell>
                    {s.status === 'active' ? (
                      <Badge className="border-transparent bg-success/15 text-success">active</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-muted-foreground">
                        archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(s.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {s.status === 'active' ? (
                        <ConfirmDialog
                          title="Archive this site?"
                          description={`/${s.spaceSlug}/${s.siteSlug} will be hidden from listings but can be restored.`}
                          confirmLabel="Archive"
                          onConfirm={() =>
                            mutate('Site archived', () =>
                              api.patch(`/api/admin/sites/${s.id}/archive`),
                            )
                          }
                        >
                          <Button variant="outline" size="sm">
                            <Archive className="size-3.5" />
                            Archive
                          </Button>
                        </ConfirmDialog>
                      ) : (
                        <RestoreButton siteId={s.id} />
                      )}
                      <ConfirmDialog
                        title="Delete this site?"
                        description={`Hard delete /${s.spaceSlug}/${s.siteSlug} and all its files. This cannot be undone.`}
                        confirmLabel="Delete"
                        destructive
                        onConfirm={() =>
                          mutate('Site deleted', () => api.delete(`/api/admin/sites/${s.id}`))
                        }
                      >
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                          <Trash2 className="size-3.5" />
                          Delete
                        </Button>
                      </ConfirmDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Page {data.page} of {totalPages} · {data.total} site{data.total === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={data.page <= 1}
            onClick={() => setPage(data.page - 1)}
          >
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={data.page >= totalPages}
            onClick={() => setPage(data.page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Spaces tab ──────────────────────────────────────────────────────────────
function SpacesPanel({ spaces }: { spaces: AdminSpace[] }) {
  const mutate = useMutation()

  if (spaces.length === 0) {
    return <EmptyState icon={Boxes} title="No spaces yet" description="Group spaces will appear here once created." />
  }

  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Members</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {spaces.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">/{s.slug}</TableCell>
              <TableCell>
                <Badge variant={s.type === 'group' ? 'secondary' : 'outline'} className="capitalize">
                  {s.type}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{s.memberCount}</TableCell>
              <TableCell className="text-muted-foreground">{formatDate(s.createdAt)}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-2">
                  {s.type === 'group' ? (
                    <ConfirmDialog
                      title="Delete this space?"
                      description={`Delete the "${s.name}" space (/${s.slug}). This cannot be undone.`}
                      confirmLabel="Delete"
                      destructive
                      onConfirm={() =>
                        mutate('Space deleted', () => api.delete(`/api/spaces/${s.slug}`))
                      }
                    >
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                        <Trash2 className="size-3.5" />
                        Delete
                      </Button>
                    </ConfirmDialog>
                  ) : (
                    <span className="text-xs text-muted-foreground">Personal</span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Users tab ───────────────────────────────────────────────────────────────
function UsersPanel({ users }: { users: AdminUser[] }) {
  if (users.length === 0) {
    return <EmptyState icon={Users2} title="No users yet" description="Registered users will appear here." />
  }

  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joined</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <div className="font-medium">{u.name ?? u.email}</div>
                <div className="font-mono text-xs text-muted-foreground">{u.email}</div>
              </TableCell>
              <TableCell>
                {u.role === 'superadmin' ? (
                  <Badge>superadmin</Badge>
                ) : (
                  <Badge variant="secondary" className="text-muted-foreground">
                    member
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(u.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Route component ─────────────────────────────────────────────────────────
export function Component() {
  const loaderData = useLoaderData() as LoaderData
  const [, setSearchParams] = useSearchParams()
  const tab = loaderData.tab

  const description =
    loaderData.tab === 'overview'
      ? 'Usage at a glance'
      : loaderData.tab === 'sites'
        ? `${loaderData.data.total} site${loaderData.data.total === 1 ? '' : 's'}`
        : loaderData.tab === 'spaces'
          ? `${loaderData.data.length} space${loaderData.data.length === 1 ? '' : 's'}`
          : `${loaderData.data.length} user${loaderData.data.length === 1 ? '' : 's'}`

  function onTabChange(next: string) {
    // Switching tabs starts fresh — drop site-only filters/pagination.
    setSearchParams(asTab(next) === 'sites' ? { tab: 'sites' } : { tab: asTab(next) })
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Admin" description={description} />

      <Tabs value={tab} onValueChange={onTabChange} className="space-y-6">
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="capitalize">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>

        {loaderData.tab === 'overview' && <StatsPanel data={loaderData.data} />}
        {loaderData.tab === 'sites' && <SitesPanel data={loaderData.data} />}
        {loaderData.tab === 'spaces' && <SpacesPanel spaces={loaderData.data} />}
        {loaderData.tab === 'users' && <UsersPanel users={loaderData.data} />}
      </Tabs>
    </div>
  )
}
