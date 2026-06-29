import { useCallback, useMemo, useState } from 'react'
import { useRevalidator } from 'react-router'
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  FolderInput,
  MoreVertical,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ShareDialog } from '@/components/ShareDialog'
import { SpaceSelect } from '@/components/SpaceSelect'
import { Spinner } from '@/components/states'
import { VisibilityMenu } from '@/components/visibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { timeAgo } from '@/lib/time'
import type { SiteSummary, SpaceSummary, Visibility } from '@/lib/types'
import { cn } from '@/lib/utils'

const visibilityLabel = (v: Visibility): string => v.charAt(0).toUpperCase() + v.slice(1)

// ─── Sortable table ──────────────────────────────────────────────────────────

type SortKey = 'name' | 'visibility' | 'created'
type Sort = { key: SortKey; dir: 'asc' | 'desc' }

const VIS_RANK: Record<Visibility, number> = { private: 0, members: 1, team: 2 }
const COMPARE: Record<SortKey, (a: SiteSummary, b: SiteSummary) => number> = {
  name: (a, b) => (a.title ?? a.siteSlug).localeCompare(b.title ?? b.siteSlug),
  visibility: (a, b) => VIS_RANK[a.visibility] - VIS_RANK[b.visibility],
  created: (a, b) => a.createdAt.localeCompare(b.createdAt), // ISO 8601 sorts lexicographically
}

export function SitesTable({ sites }: { sites: SiteSummary[] }) {
  const [sort, setSort] = useState<Sort>({ key: 'created', dir: 'desc' })

  const rows = useMemo(() => {
    const sorted = [...sites].sort(COMPARE[sort.key])
    return sort.dir === 'asc' ? sorted : sorted.reverse()
  }, [sites, sort])

  // Click a column: flip direction if already active, else select it (newest-first for dates,
  // A→Z otherwise).
  const toggle = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'created' ? 'desc' : 'asc' },
    )

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <SortHead label="Name" sortKey="name" sort={sort} onToggle={toggle} />
            <TableHead>URL</TableHead>
            <SortHead label="Visibility" sortKey="visibility" sort={sort} onToggle={toggle} />
            <SortHead label="Created" sortKey="created" sort={sort} onToggle={toggle} />
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <SiteRow key={s.id} site={s} />
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function SortHead({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string
  sortKey: SortKey
  sort: Sort
  onToggle: (key: SortKey) => void
}) {
  const active = sort.key === sortKey
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className="-mx-1 inline-flex items-center gap-1 rounded px-1 font-medium hover:text-foreground/70"
        aria-label={`Sort by ${label}`}
      >
        {label}
        <Icon className={cn('size-3.5', active ? 'opacity-80' : 'opacity-40')} />
      </button>
    </TableHead>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

type RowDialog = 'rename' | 'move' | 'share' | 'delete' | null

function SiteRow({ site }: { site: SiteSummary }) {
  const revalidator = useRevalidator()
  const [pendingVis, setPendingVis] = useState<Visibility | null>(null)
  const [dialog, setDialog] = useState<RowDialog>(null)
  const visibility = pendingVis ?? site.visibility
  const archived = site.status === 'archived'
  const refresh = () => revalidator.revalidate()
  const close = () => setDialog(null)

  async function changeVisibility(v: Visibility) {
    setPendingVis(v)
    try {
      await api.patch(`/api/sites/${site.spaceSlug}/${site.siteSlug}`, { visibility: v })
      toast.success('Visibility updated', { description: visibilityLabel(v) })
      setPendingVis(null) // drop the optimistic value; revalidated loader is source of truth
      refresh()
    } catch (err) {
      setPendingVis(null)
      toast.error('Could not update visibility', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(site.url)
      toast.success('Link copied', { description: site.url })
    } catch {
      toast.error("Couldn't copy to clipboard")
    }
  }

  return (
    <TableRow>
      <TableCell className="max-w-[15rem]">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{site.title ?? site.siteSlug}</span>
          {archived && <Badge variant="secondary">archived</Badge>}
        </div>
      </TableCell>
      <TableCell className="max-w-[22rem]">
        <a
          href={site.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          {site.url.replace(/^https?:\/\//, '')}
        </a>
      </TableCell>
      <TableCell>
        <VisibilityMenu trigger="chip" value={visibility} onChange={changeVisibility} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        <time dateTime={site.createdAt} title={new Date(site.createdAt).toLocaleString()}>
          {timeAgo(site.createdAt)}
        </time>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button asChild variant="outline" size="sm">
            <a href={site.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open
            </a>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => setDialog('rename')}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog('move')}>
                <FolderInput />
                Move
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog('share')}>
                <Share2 />
                Share…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyLink()}>
                <Copy />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Controlled dialogs driven by the kebab (a Dialog trigger can't live inside a menu item
            cleanly). Each renders only a portaled body — nothing inline in the cell. */}
        <RenameDialog
          site={site}
          open={dialog === 'rename'}
          onOpenChange={(o) => !o && close()}
          onDone={refresh}
        />
        <MoveDialog
          site={site}
          open={dialog === 'move'}
          onOpenChange={(o) => !o && close()}
          onDone={refresh}
        />
        <ShareDialog
          spaceSlug={site.spaceSlug}
          siteSlug={site.siteSlug}
          title={site.title}
          open={dialog === 'share'}
          onOpenChange={(o) => !o && close()}
        />
        <ConfirmDialog
          open={dialog === 'delete'}
          onOpenChange={(o) => !o && close()}
          title={`Delete ${site.spaceSlug}/${site.siteSlug}?`}
          description="This permanently removes the site and all its files."
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await api.delete(`/api/sites/${site.spaceSlug}/${site.siteSlug}`)
            toast.success('Site deleted')
            refresh()
          }}
        />
      </TableCell>
    </TableRow>
  )
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

function RenameDialog({
  site,
  open,
  onOpenChange,
  onDone,
}: {
  site: SiteSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [title, setTitle] = useState(site.title ?? '')
  const [saving, setSaving] = useState(false)

  // Reset the field each time the dialog opens (Radix mounts content on open) — no effect.
  const seed = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) setTitle(site.title ?? '')
    },
    [site.title],
  )

  async function save() {
    setSaving(true)
    try {
      await api.patch(`/api/sites/${site.spaceSlug}/${site.siteSlug}`, { title })
      toast.success('Renamed')
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error('Could not rename', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent ref={seed}>
        <DialogHeader>
          <DialogTitle>Rename site</DialogTitle>
          <DialogDescription className="font-mono">{site.url}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`rename-${site.id}`}>Title</Label>
          <Input
            id={`rename-${site.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={site.siteSlug}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void save()
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Spinner />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Move a site into another space the caller belongs to. Spaces load on open (via a content
// ref-callback — no effect); the current space is excluded. Moving keeps the site's
// files/comments/shares — only its URL changes — so a revalidate picks up the new URL.
function MoveDialog({
  site,
  open,
  onOpenChange,
  onDone,
}: {
  site: SiteSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [target, setTarget] = useState('')

  const loadOnMount = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      setTarget('')
      setBusy(true)
      api
        .get<SpaceSummary[]>('/api/spaces/mine')
        .then((sp) => setSpaces(sp.filter((s) => s.slug !== site.spaceSlug)))
        .catch((err) =>
          toast.error('Could not load spaces', { description: err instanceof Error ? err.message : undefined }),
        )
        .finally(() => setBusy(false))
    },
    [site.spaceSlug],
  )

  async function save() {
    if (!target) return
    setSaving(true)
    try {
      const { url } = await api.post<{ url: string }>(
        `/api/sites/${site.spaceSlug}/${site.siteSlug}/move`,
        { space: target },
      )
      toast.success('Site moved', { description: url })
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error('Could not move site', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent ref={loadOnMount}>
        <DialogHeader>
          <DialogTitle>Move site</DialogTitle>
          <DialogDescription className="font-mono">{site.url}</DialogDescription>
        </DialogHeader>
        {busy ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        ) : spaces.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            You’re only in one space. Create another space to move sites into it.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor={`move-${site.id}`}>Destination space</Label>
            <SpaceSelect id={`move-${site.id}`} value={target} onChange={setTarget} spaces={spaces} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || saving || !target}>
            {saving && <Spinner />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
