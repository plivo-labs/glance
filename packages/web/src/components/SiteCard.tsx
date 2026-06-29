import { useState } from 'react'
import { useRevalidator } from 'react-router'
import { ExternalLink, FolderInput, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import type { SiteSummary, SpaceSummary, Visibility } from '@/lib/types'

const visibilityLabel = (v: Visibility): string => v.charAt(0).toUpperCase() + v.slice(1)

export function SiteCard({ site }: { site: SiteSummary }) {
  const revalidator = useRevalidator()
  const [pendingVis, setPendingVis] = useState<Visibility | null>(null)
  const visibility = pendingVis ?? site.visibility
  const archived = site.status === 'archived'
  const refresh = () => revalidator.revalidate()

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

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{site.title ?? site.siteSlug}</span>
            {archived && <Badge variant="secondary">archived</Badge>}
          </div>
          <a
            href={site.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {site.url}
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <VisibilityMenu value={visibility} onChange={changeVisibility} />
          <RenameDialog site={site} onDone={refresh} />
          <MoveDialog site={site} onDone={refresh} />
          <ShareDialog spaceSlug={site.spaceSlug} siteSlug={site.siteSlug} title={site.title} />
          <CopyButton text={site.url} label="" variant="outline" />
          <Button asChild variant="outline" size="sm">
            <a href={site.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open
            </a>
          </Button>
          <ConfirmDialog
            title={`Delete ${site.spaceSlug}/${site.siteSlug}?`}
            description="This permanently removes the site and all its files."
            confirmLabel="Delete"
            destructive
            onConfirm={async () => {
              await api.delete(`/api/sites/${site.spaceSlug}/${site.siteSlug}`)
              toast.success('Site deleted')
              refresh()
            }}
          >
            <Button variant="ghost" size="icon" aria-label="Delete site">
              <Trash2 className="text-destructive" />
            </Button>
          </ConfirmDialog>
        </div>
      </div>
    </Card>
  )
}

function RenameDialog({ site, onDone }: { site: SiteSummary; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(site.title ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await api.patch(`/api/sites/${site.spaceSlug}/${site.siteSlug}`, { title })
      toast.success('Renamed')
      setOpen(false)
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
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (saving) return
        setOpen(o)
        if (o) setTitle(site.title ?? '')
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil />
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent>
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
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={save} disabled={saving}>
            {saving && <Spinner />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Move a site into another space the caller belongs to. Spaces load on open (event-driven, no
// effect); the current space is excluded. Moving keeps the site's files/comments/shares — only
// its URL changes — so a revalidate picks up the new URL.
function MoveDialog({ site, onDone }: { site: SiteSummary; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [target, setTarget] = useState('')

  async function onOpenChange(next: boolean) {
    if (saving) return
    setOpen(next)
    if (!next) return
    setTarget('')
    setBusy(true)
    try {
      const sp = await api.get<SpaceSummary[]>('/api/spaces/mine')
      setSpaces(sp.filter((s) => s.slug !== site.spaceSlug))
    } catch (err) {
      toast.error('Could not load spaces', { description: err instanceof Error ? err.message : undefined })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (!target) return
    setSaving(true)
    try {
      const { url } = await api.post<{ url: string }>(`/api/sites/${site.spaceSlug}/${site.siteSlug}/move`, {
        space: target,
      })
      toast.success('Site moved', { description: url })
      setOpen(false)
      onDone()
    } catch (err) {
      toast.error('Could not move site', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FolderInput />
          Move
        </Button>
      </DialogTrigger>
      <DialogContent>
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
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={save} disabled={busy || saving || !target}>
            {saving && <Spinner />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
