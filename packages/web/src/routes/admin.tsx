import { useState } from 'react'
import { Archive, ArchiveRestore, Boxes, FolderOpen, Trash2, Users2 } from 'lucide-react'
import {
  type LoaderFunctionArgs,
  redirect,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState, PageHeader, Spinner } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

type AdminTab = 'sites' | 'spaces' | 'users'

interface SitesData {
  sites: AdminSite[]
  page: number
  pageSize: number
  total: number
}

type LoaderData =
  | { tab: 'sites'; data: SitesData }
  | { tab: 'spaces'; data: AdminSpace[] }
  | { tab: 'users'; data: AdminUser[] }

const TABS: AdminTab[] = ['sites', 'spaces', 'users']

function asTab(value: string | null): AdminTab {
  return value === 'spaces' || value === 'users' ? value : 'sites'
}

// ── Loader: tab-aware fetch driven by URL searchParams ──────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const tab = asTab(url.searchParams.get('tab'))
  try {
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

const STATUS_OPTIONS = ['active', 'archived'] as const
const VISIBILITY_OPTIONS: Visibility[] = ['private', 'group', 'team', 'public']

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
    loaderData.tab === 'sites'
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

        {loaderData.tab === 'sites' && <SitesPanel data={loaderData.data} />}
        {loaderData.tab === 'spaces' && <SpacesPanel spaces={loaderData.data} />}
        {loaderData.tab === 'users' && <UsersPanel users={loaderData.data} />}
      </Tabs>
    </div>
  )
}
