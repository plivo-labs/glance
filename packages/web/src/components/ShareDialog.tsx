import { type ReactNode, useCallback, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Check, Plus, Search, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { newSpaceHref } from '@/lib/nav'
import { buildSharePayload } from '@/lib/shares'
import type { ShareRole, ShareSet, SpaceSummary, UserLite } from '@/lib/types'
import { UserAvatar } from '@/components/UserAvatar'
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
import { Input } from '@/components/ui/input'
import { MountSensor } from '@/components/ui/mount-sensor'
import { Spinner } from '@/components/states'
import { cn } from '@/lib/utils'

type Props = {
  spaceSlug: string
  siteSlug: string
  title?: string | null
  // Controlled mode: when `open` is provided the dialog renders no trigger and is driven by the
  // parent (e.g. a dropdown-menu item). Uncontrolled (default) keeps its own Share button.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // Uncontrolled trigger's label — tight table rows shorten it to "Share".
  triggerLabel?: string
}

// Shared with the space page's invite dialog — one Set-toggle for every picker selection.
export function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// Add a user (default viewer) or remove them; preserves the role of everyone else.
function toggleUser(map: Map<string, ShareRole>, id: string): Map<string, ShareRole> {
  const next = new Map(map)
  if (next.has(id)) next.delete(id)
  else next.set(id, 'viewer')
  return next
}

// Owner-only sharing: pick specific people and/or groups to grant access, on top of the
// site's visibility tier. Data loads on open via a ref-callback on the dialog content (Radix
// mounts it on every open — and a controlled/external open does NOT fire Radix onOpenChange,
// so the load can't live there); Save replaces the whole set via PUT.
export function ShareDialog({
  spaceSlug,
  siteSlug,
  title,
  open: openProp,
  onOpenChange,
  triggerLabel = 'Share with people & groups',
}: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const [internalOpen, setInternalOpen] = useState(false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : internalOpen
  const setOpen = (o: boolean) => (controlled ? onOpenChange?.(o) : setInternalOpen(o))
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [users, setUsers] = useState<UserLite[]>([])
  const [groups, setGroups] = useState<SpaceSummary[]>([])
  // Per-user grant: id → role. A user in the map is shared-with (default 'viewer'); absent = not
  // shared. Groups stay a plain Set — they're always view-only.
  const [selUsers, setSelUsers] = useState<Map<string, ShareRole>>(new Map())
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set())

  const loadOnMount = useCallback(
    () => {
      setBusy(true)
      Promise.all([
        api.get<UserLite[]>('/api/users'),
        api.get<SpaceSummary[]>('/api/spaces/mine'),
        api.get<ShareSet>(`/api/sites/${spaceSlug}/${siteSlug}/shares`),
      ])
        .then(([us, sp, shares]) => {
          setUsers(us)
          setGroups(sp.filter((s) => s.type === 'group'))
          // Prefer the role-aware `users` list; fall back to legacy userIds (all viewers) if absent.
          setSelUsers(
            new Map(shares.users?.map((u) => [u.id, u.role]) ?? shares.userIds.map((id) => [id, 'viewer' as ShareRole])),
          )
          setSelGroups(new Set(shares.groupIds))
        })
        .catch((err) =>
          toast.error('Could not load sharing', { description: err instanceof Error ? err.message : undefined }),
        )
        .finally(() => setBusy(false))
    },
    [spaceSlug, siteSlug],
  )

  async function save() {
    setSaving(true)
    try {
      await api.put(`/api/sites/${spaceSlug}/${siteSlug}/shares`, buildSharePayload(selUsers, selGroups))
      toast.success('Sharing updated')
      setOpen(false)
    } catch (err) {
      toast.error('Could not update sharing', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  const count = selUsers.size + selGroups.size

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Share2 />
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <MountSensor onMount={loadOnMount} />
        <DialogHeader>
          <DialogTitle className="truncate">Share {title ?? siteSlug}</DialogTitle>
          <DialogDescription>
            Grant specific people or other spaces access — on top of the site’s visibility setting.
          </DialogDescription>
        </DialogHeader>

        {busy ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="space-y-4">
            {groups.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Other spaces</p>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  {groups.map((g) => (
                    <PickerRow
                      key={g.id}
                      checked={selGroups.has(g.id)}
                      onToggle={() => setSelGroups((s) => toggle(s, g.id))}
                      label={g.name}
                      sub={`/${g.slug}`}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed p-3 text-center">
                <p className="text-sm text-muted-foreground">
                  You’re only in your personal space. Create a space to share a site with a whole team at once.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setOpen(false)
                    navigate(newSpaceHref(location))
                  }}
                >
                  <Plus />
                  New space
                </Button>
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">People</p>
              <PeoplePicker
                users={users}
                checked={(u) => selUsers.has(u.id)}
                onToggle={(u) => setSelUsers((s) => toggleUser(s, u.id))}
                trailing={(u) => (
                  <ShareRoleTrailing role={selUsers.get(u.id)} onChange={(r) => setSelUsers((s) => new Map(s).set(u.id, r))} />
                )}
              />
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <span className="self-center text-xs text-muted-foreground">
            {count === 0 ? 'Not shared with anyone' : `Shared with ${count}`}
          </span>
          <Button onClick={save} disabled={busy || saving}>
            {saving && <Spinner />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Searchable directory list of PickerRows — the shared core of the share and invite dialogs.
// Owns its query state, so it resets naturally with the dialog content that hosts it (Radix
// remounts content on every open). `trailing` renders per-row extras (e.g. the RolePicker).
export function PeoplePicker({
  users,
  checked,
  onToggle,
  trailing,
}: {
  users: UserLite[]
  checked: (u: UserLite) => boolean
  onToggle: (u: UserLite) => void
  trailing?: (u: UserLite) => ReactNode
}) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = needle
    ? users.filter((u) => u.email.toLowerCase().includes(needle) || (u.name ?? '').toLowerCase().includes(needle))
    : users
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" className="pl-8" />
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No people found.</p>
        ) : (
          shown.map((u) => (
            <div key={u.id} className="flex items-center gap-2">
              <PickerRow
                className="flex-1"
                checked={checked(u)}
                onToggle={() => onToggle(u)}
                label={u.name ?? u.email}
                sub={u.name ? u.email : undefined}
                user={u}
              />
              {trailing?.(u)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// Shared with the space page's invite dialog — one checkbox-row look across both pickers.
export function PickerRow({
  checked,
  onToggle,
  label,
  sub,
  className,
  user,
}: {
  checked: boolean
  onToggle: () => void
  label: string
  sub?: string
  className?: string
  // A person row shows their photo; the group rows that share this component pass nothing.
  user?: UserLite
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className={cn('flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted', className)}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
      {user && <UserAvatar userId={user.id} name={user.name} email={user.email} />}
      <span className="min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}

// `PeoplePicker`'s `trailing` slot for the share dialog: a RolePicker once the row is checked,
// nothing before. Hoisted to a real component so the render prop composes an existing one instead
// of declaring a component mid-render, which is what no-unstable-nested-components objects to.
function ShareRoleTrailing({ role, onChange }: { role: ShareRole | undefined; onChange: (r: ShareRole) => void }) {
  return role !== undefined ? <RolePicker role={role} onChange={onChange} /> : null
}

// Segmented Viewer|Editor toggle shown beside a selected person. Editor = may redeploy the site's
// content (never rename/move/delete). Groups get no such control — they stay view-only.
function RolePicker({ role, onChange }: { role: ShareRole; onChange: (r: ShareRole) => void }) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border text-xs">
      {(['viewer', 'editor'] as const).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          aria-pressed={role === r}
          className={cn(
            'px-2 py-1 capitalize transition-colors',
            role === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {r}
        </button>
      ))}
    </div>
  )
}
