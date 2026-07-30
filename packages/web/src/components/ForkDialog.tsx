import { useCallback, useState } from 'react'
import { forkSlug, useForkSite } from '@/hooks/useForkSite'
import type { Visibility } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MountSensor } from '@/components/ui/mount-sensor'
import { Spinner } from '@/components/states'
import { VisibilityMenu } from '@/components/visibility'

type ForkSource = { spaceSlug: string; siteSlug: string; title: string | null; visibility: Visibility }

const forkName = (site: ForkSource) => `${site.title ?? site.siteSlug} (copy)`

// Fork used to be fire-and-forget: an empty POST body, a `-copy` slug the user never saw and the
// source's visibility inherited in silence. This dialog is the ask — a name and a tier — and it is
// the ONLY way either call site (viewer hamburger, dashboard kebab) reaches useForkSite.
//
// The URL slug is derived from the name rather than typed: one field to fill, and the destination
// path is shown under it so the derivation is never a surprise. The destination SPACE is
// deliberately not offered — a fork still lands in the caller's personal space.
export function ForkDialog({
  site,
  open,
  onOpenChange,
}: {
  site: ForkSource
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { fork, forking } = useForkSite(site)
  const [name, setName] = useState(() => forkName(site))
  const [visibility, setVisibility] = useState<Visibility>(site.visibility)
  const slug = forkSlug(name)
  const nameId = `fork-${site.spaceSlug}-${site.siteSlug}`

  // Reseed the form each time the dialog opens, on a plain sensor element rather than a ref on
  // DialogContent: Radix recomposes content refs on every render, which would snap the name field
  // back on every keystroke (cf. RenameDialog in SitesTable).
  const seed = useCallback(() => {
    setName(forkName(site))
    setVisibility(site.visibility)
  }, [site])

  async function confirm() {
    if (await fork({ title: name, visibility })) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !forking && onOpenChange(o)}>
      <DialogContent>
        <MountSensor onMount={seed} />
        <DialogHeader>
          <DialogTitle>Fork site</DialogTitle>
          <DialogDescription>
            Copies <span className="font-mono">{`${site.spaceSlug}/${site.siteSlug}`}</span> into your personal space.
            The copy is independent — its own files, no shares, no comments.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {/* Per-row id, like RenameDialog/MoveDialog: the dashboard mounts one of these per site. */}
          <Label htmlFor={nameId}>Name</Label>
          <Input id={nameId} value={name} disabled={forking} onChange={(e) => setName(e.target.value)} />
          <p className="text-muted-foreground text-xs">
            {slug ? (
              <>
                URL: <span className="font-mono">{slug}</span>
              </>
            ) : (
              // Nothing usable to derive — the API falls back to its own `<slug>-copy` dedupe.
              <>That name has no usable URL slug, so one is picked from the original.</>
            )}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Visibility</Label>
          <div>
            <VisibilityMenu value={visibility} onChange={setVisibility} disabled={forking} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={forking} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={forking} onClick={() => void confirm()}>
            {forking && <Spinner />}
            Fork
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
