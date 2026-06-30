import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router'
import { Check, Plus, Search, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { ShareSet, SpaceSummary, UserLite } from '@/lib/types'
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
import { Spinner } from '@/components/states'
import { cn } from '@/lib/utils'

type Props = {
  spaceSlug: string
  siteSlug: string
  title?: string | null
  compact?: boolean
  // Controlled mode: when `open` is provided the dialog renders no trigger and is driven by the
  // parent (e.g. a dropdown-menu item). Uncontrolled (default) keeps its own Share button.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// Owner-only sharing: pick specific people and/or groups to grant access, on top of the
// site's visibility tier. Data loads on open via a ref-callback on the dialog content (Radix
// mounts it on every open — and a controlled/external open does NOT fire Radix onOpenChange,
// so the load can't live there); Save replaces the whole set via PUT.
export function ShareDialog({ spaceSlug, siteSlug, title, compact, open: openProp, onOpenChange }: Props) {
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : internalOpen
  const setOpen = (o: boolean) => (controlled ? onOpenChange?.(o) : setInternalOpen(o))
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [users, setUsers] = useState<UserLite[]>([])
  const [groups, setGroups] = useState<SpaceSummary[]>([])
  const [selUsers, setSelUsers] = useState<Set<string>>(new Set())
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')

  // The ref lives on a plain sensor <div> below (NOT on DialogContent): Radix recomposes the
  // content ref on every render, so a ref-callback there fires on every render (detach+reattach)
  // and a fetch + setState would loop forever. A plain element's ref is uncomposed, so this stable
  // callback fires once per open. (cf. CommandPalette's onPaletteMount.)
  const loadOnMount = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      setBusy(true)
      Promise.all([
        api.get<UserLite[]>('/api/users'),
        api.get<SpaceSummary[]>('/api/spaces/mine'),
        api.get<ShareSet>(`/api/sites/${spaceSlug}/${siteSlug}/shares`),
      ])
        .then(([us, sp, shares]) => {
          setUsers(us)
          setGroups(sp.filter((s) => s.type === 'group'))
          setSelUsers(new Set(shares.userIds))
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
      await api.put(`/api/sites/${spaceSlug}/${siteSlug}/shares`, {
        userIds: [...selUsers],
        groupIds: [...selGroups],
      })
      toast.success('Sharing updated')
      setOpen(false)
    } catch (err) {
      toast.error('Could not update sharing', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  const needle = q.trim().toLowerCase()
  const shownUsers = needle
    ? users.filter((u) => u.email.toLowerCase().includes(needle) || (u.name ?? '').toLowerCase().includes(needle))
    : users
  const count = selUsers.size + selGroups.size

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          {compact ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              title="Share with people & groups"
              aria-label="Share with people & groups"
            >
              <Share2 />
            </Button>
          ) : (
            <Button variant="outline" size="sm">
              <Share2 />
              Share with people &amp; groups
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <div ref={loadOnMount} hidden aria-hidden="true" />
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
                    <Row
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
                    navigate('/dashboard?new=space')
                  }}
                >
                  <Plus />
                  New space
                </Button>
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">People</p>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search people…"
                  className="pl-8"
                />
              </div>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {shownUsers.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">No people found.</p>
                ) : (
                  shownUsers.map((u) => (
                    <Row
                      key={u.id}
                      checked={selUsers.has(u.id)}
                      onToggle={() => setSelUsers((s) => toggle(s, u.id))}
                      label={u.name ?? u.email}
                      sub={u.name ? u.email : undefined}
                    />
                  ))
                )}
              </div>
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

function Row({
  checked,
  onToggle,
  label,
  sub,
}: {
  checked: boolean
  onToggle: () => void
  label: string
  sub?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted"
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}
