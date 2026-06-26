import { useState } from 'react'
import { Check, Search, Share2 } from 'lucide-react'
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

type Props = { spaceSlug: string; siteSlug: string; title?: string | null }

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// Owner-only sharing: pick specific people and/or groups to grant access, on top of the
// site's visibility tier. Data loads on open (event-driven — no effect); Save replaces the
// whole set via PUT.
export function ShareDialog({ spaceSlug, siteSlug, title }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [users, setUsers] = useState<UserLite[]>([])
  const [groups, setGroups] = useState<SpaceSummary[]>([])
  const [selUsers, setSelUsers] = useState<Set<string>>(new Set())
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')

  async function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) return
    setBusy(true)
    try {
      const [us, sp, shares] = await Promise.all([
        api.get<UserLite[]>('/api/users'),
        api.get<SpaceSummary[]>('/api/spaces/mine'),
        api.get<ShareSet>(`/api/sites/${spaceSlug}/${siteSlug}/shares`),
      ])
      setUsers(us)
      setGroups(sp.filter((s) => s.type === 'group'))
      setSelUsers(new Set(shares.userIds))
      setSelGroups(new Set(shares.groupIds))
    } catch (err) {
      toast.error('Could not load sharing', { description: err instanceof Error ? err.message : undefined })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2 />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">Share {title ?? siteSlug}</DialogTitle>
          <DialogDescription>
            Grant specific people or groups access — on top of the site’s visibility setting.
          </DialogDescription>
        </DialogHeader>

        {busy ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="space-y-4">
            {groups.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Groups</p>
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
