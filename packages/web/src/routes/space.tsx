import { useCallback, useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData, useNavigate, useRevalidator } from 'react-router'
import { ExternalLink, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PeoplePicker, ShareDialog, toggle } from '@/components/ShareDialog'
import { CopyOpenActions, feedColumns } from '@/components/siteColumns'
import { SortableTable } from '@/components/SortableTable'
import { EmptyState, PageHeader, SectionHeader, Spinner } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { MountSensor } from '@/components/ui/mount-sensor'
import { Separator } from '@/components/ui/separator'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import type { SiteSummary, SpaceDetail, UserLite } from '@/lib/types'

// GET /api/spaces/:slug/sites returns the shared feed-row shape plus per-row ownership.
interface SpaceSite extends SiteSummary {
  isOwner: boolean
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    const [space, sites] = await Promise.all([
      api.get<SpaceDetail>(`/api/spaces/${params.space}`),
      api.get<SpaceSite[]>(`/api/spaces/${params.space}/sites`),
    ])
    return { space, sites }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

// Invite members via a modal with the company directory (same picker rows as ShareDialog) instead
// of a free-text email form. Multi-select, then one POST per pick — the API invites by email and
// is idempotent for existing members. Directory loads on open via MountSensor (Radix mounts the
// content each open). On any success the route revalidates so the member count stays honest.
function InviteMembersDialog({ slug }: { slug: string }) {
  const revalidator = useRevalidator()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [users, setUsers] = useState<UserLite[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set()) // emails — the API's invite key

  const loadOnMount = useCallback(() => {
    setBusy(true)
    setSelected(new Set())
    api
      .get<UserLite[]>('/api/users')
      .then(setUsers)
      .catch((err) =>
        toast.error('Could not load people', { description: err instanceof Error ? err.message : undefined }),
      )
      .finally(() => setBusy(false))
  }, [])

  async function invite() {
    setSaving(true)
    try {
      const picks = [...selected]
      const results = await Promise.allSettled(
        picks.map((email) => api.post(`/api/spaces/${slug}/members`, { email })),
      )
      const rejects = results.flatMap((r, i) =>
        r.status === 'rejected' ? [{ email: picks[i], reason: r.reason }] : [],
      )
      if (rejects.length === 0) {
        toast.success(picks.length === 1 ? 'Member invited' : `${picks.length} members invited`)
        setOpen(false)
      } else {
        // Keep ONLY the failed picks selected so the open dialog shows exactly what needs
        // retrying, and name them — a bare count doesn't say which invite went wrong.
        setSelected(new Set(rejects.map((r) => r.email)))
        const { reason } = rejects[0]
        toast.error(`${rejects.length} of ${picks.length} invites failed`, {
          description: `${rejects.map((r) => r.email).join(', ')}${reason instanceof Error ? ` — ${reason.message}` : ''}`,
        })
      }
      if (rejects.length < picks.length) revalidator.revalidate()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <UserPlus />
          Invite members
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <MountSensor onMount={loadOnMount} />
        <DialogHeader>
          <DialogTitle>Invite members</DialogTitle>
          <DialogDescription>Pick teammates to grant them access to this space.</DialogDescription>
        </DialogHeader>

        {busy ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        ) : (
          <PeoplePicker
            users={users}
            checked={(u) => selected.has(u.email)}
            onToggle={(u) => setSelected((s) => toggle(s, u.email))}
          />
        )}

        <DialogFooter className="sm:justify-between">
          <span className="self-center text-xs text-muted-foreground">
            {selected.size === 0 ? 'No one selected' : `${selected.size} selected`}
          </span>
          <Button onClick={invite} disabled={busy || saving || selected.size === 0}>
            {saving && <Spinner />}
            Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Same table shell as the dashboard feeds; owners get a Share action on their own rows.
const SPACE_SITE_COLUMNS = feedColumns<SpaceSite>((s) => (
  <CopyOpenActions url={s.url}>
    {s.isOwner && (
      <ShareDialog spaceSlug={s.spaceSlug} siteSlug={s.siteSlug} title={s.title} triggerLabel="Share" />
    )}
  </CopyOpenActions>
))

function DangerZone({ space }: { space: SpaceDetail }) {
  const navigate = useNavigate()
  return (
    <div className="space-y-3">
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">Danger zone</p>
          <p className="text-sm text-muted-foreground">
            Deleting this space removes it for all members. This cannot be undone.
          </p>
        </div>
        <ConfirmDialog
          title="Delete this space?"
          description={`This permanently deletes "${space.name}" and removes access for all members.`}
          confirmLabel="Delete space"
          destructive
          onConfirm={async () => {
            // Throw on failure so ConfirmDialog surfaces the toast (e.g. 403 forbidden).
            await api.delete(`/api/spaces/${space.slug}`)
            toast.success('Space deleted')
            navigate('/dashboard')
          }}
        >
          <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive">
            <Trash2 />
            Delete space
          </Button>
        </ConfirmDialog>
      </div>
    </div>
  )
}

export function Component() {
  const { space, sites } = useLoaderData() as { space: SpaceDetail; sites: SpaceSite[] }
  const isGroup = space.type === 'group'

  return (
    <div className="space-y-8">
      <PageHeader
        title={space.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={isGroup ? 'default' : 'secondary'} className="capitalize">
              {space.type}
            </Badge>
            <span>
              {space.memberCount} member{space.memberCount === 1 ? '' : 's'}
            </span>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span className="font-mono">/{space.slug}</span>
          </span>
        }
      >
        {/* Invite is owner-only server-side — don't offer a button that can only 403. */}
        {isGroup && space.isOwner && <InviteMembersDialog slug={space.slug} />}
      </PageHeader>

      <section className="space-y-4">
        <SectionHeader index={1} title="Sites" />
        {sites.length === 0 ? (
          <EmptyState
            icon={ExternalLink}
            title="No sites yet"
            description="No sites you can access here yet."
          />
        ) : (
          <SortableTable
            rows={sites}
            columns={SPACE_SITE_COLUMNS}
            getRowKey={(s) => s.id}
            initialSort={{ key: 'created', dir: 'desc' }}
          />
        )}
      </section>

      {isGroup && <DangerZone space={space} />}
    </div>
  )
}
