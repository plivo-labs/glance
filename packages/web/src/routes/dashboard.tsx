import { useRef, useState } from 'react'
import {
  Link,
  type LoaderFunctionArgs,
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from 'react-router'
import {
  ExternalLink,
  FolderUp,
  Pencil,
  Plus,
  Rocket,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ShareDialog } from '@/components/ShareDialog'
import { EmptyState, PageHeader, SectionHeader, Spinner } from '@/components/states'
import { VisibilityBadge, VisibilityMenu } from '@/components/visibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import type { SiteSummary, SlugExists, SpaceSummary, TeamUpload, Visibility } from '@/lib/types'
import { type DroppedFile, filesFromDataTransfer, filesFromInput } from '@/lib/walkFiles'
import { uploadFiles } from '@/lib/uploadWithProgress'
import { cn } from '@/lib/utils'

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const [sites, shared, spaces, team] = await Promise.all([
      api.get<SiteSummary[]>('/api/sites/mine'),
      api.get<SiteSummary[]>('/api/sites/shared'),
      api.get<SpaceSummary[]>('/api/spaces/mine'),
      api.get<TeamUpload[]>('/api/sites/team'),
    ])
    return { sites, shared, spaces, team }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

function SharedSiteRow({ site }: { site: SiteSummary }) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{site.title ?? site.siteSlug}</span>
            <VisibilityBadge value={site.visibility} />
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
          <CopyButton text={site.url} label="" variant="outline" />
          <Button asChild variant="outline" size="sm">
            <a href={site.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open
            </a>
          </Button>
        </div>
      </div>
    </Card>
  )
}

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; pct: number; count: number }
  | { phase: 'done'; url: string }
  | { phase: 'error'; message: string }

export function Component() {
  const { sites, shared, spaces, team } = useLoaderData() as {
    sites: SiteSummary[]
    shared: SiteSummary[]
    spaces: SpaceSummary[]
    team: TeamUpload[]
  }
  const groupSpaces = spaces.filter((s) => s.type === 'group')

  return (
    <div className="space-y-10">
      <PageHeader
        title="Drop a folder, get a URL"
        description="HTML and markdown render in the browser; everything else downloads."
      />

      <DeployCard spaces={spaces} />

      <section className="space-y-4">
        <SectionHeader index={1} title="Your sites" />
        {sites.length === 0 ? (
          <EmptyState
            icon={Rocket}
            title="No sites yet"
            description="Drop a folder above to ship your first."
          />
        ) : (
          <div className="grid gap-3">
            {sites.map((s) => (
              <SiteCard key={s.id} site={s} />
            ))}
          </div>
        )}
      </section>

      {shared.length > 0 && (
        <section className="space-y-4">
          <SectionHeader index={2} title="Shared with me" />
          <div className="grid gap-3">
            {shared.map((s) => (
              <SharedSiteRow key={s.id} site={s} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4">
        <SectionHeader index={3} title="Your spaces">
          <NewSpaceDialog />
        </SectionHeader>
        {groupSpaces.length === 0 ? (
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
        )}
      </section>

      <section className="space-y-4">
        <SectionHeader index={4} title="Team activity" />
        {team.length === 0 ? (
          <EmptyState
            icon={Rocket}
            title="Nothing shipped yet"
            description="Team- and public-visible sites show up here as people deploy them."
          />
        ) : (
          <Card className="gap-0 py-0">
            <ul className="divide-y">
              {team.map((u) => (
                <TeamActivityRow key={u.id} upload={u} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  )
}

// ─── Team activity ───────────────────────────────────────────────────────────

// Relative "time ago" for the activity feed — compact, no dependency.
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function TeamActivityRow({ upload }: { upload: TeamUpload }) {
  const who = upload.uploaderName ?? upload.uploaderEmail
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{upload.title ?? upload.siteSlug}</span>
          <VisibilityBadge value={upload.visibility} />
        </div>
        <a
          href={upload.url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          {upload.url}
        </a>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right text-sm">
          <div className="truncate font-medium">{who}</div>
          <time
            className="text-xs text-muted-foreground"
            dateTime={upload.createdAt}
            title={new Date(upload.createdAt).toLocaleString()}
          >
            {timeAgo(upload.createdAt)}
          </time>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={upload.url} target="_blank" rel="noreferrer">
            <ExternalLink />
            Open
          </a>
        </Button>
      </div>
    </li>
  )
}

// ─── Deploy ────────────────────────────────────────────────────────────────

// Mirror the API's slug rules (lib/slug.ts): lowercase alphanumeric + hyphens.
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

// Guess a slug from what was dropped: the top folder name, or — for loose files —
// any one file's name with its extension stripped. Pre-fills the input so the user
// can tweak it before deploying.
function deriveSlug(files: DroppedFile[]): string {
  const path = files[0]?.path ?? ''
  const [top, ...rest] = path.split('/')
  const base = rest.length > 0 ? top : (top ?? '').replace(/\.[^.]+$/, '')
  return slugify(base ?? '')
}

function DeployCard({ spaces }: { spaces: SpaceSummary[] }) {
  const revalidator = useRevalidator()
  const slugCheck = useFetcher<SlugExists>()
  const folderInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const defaultSpace = spaces.find((s) => s.type === 'personal')?.slug ?? spaces[0]?.slug ?? ''
  const [space, setSpace] = useState(defaultSpace)
  const [slug, setSlug] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('team')
  const [dragActive, setDragActive] = useState(false)
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' })
  // Controlled replace-confirm: holds the files awaiting an overwrite decision.
  const [pendingReplace, setPendingReplace] = useState<DroppedFile[] | null>(null)
  // Files dropped before a slug was set — held until the user confirms via Deploy.
  const [staged, setStaged] = useState<DroppedFile[] | null>(null)

  const conflict = slugCheck.data
  const checking = slugCheck.state !== 'idle'
  const takenByOther = conflict?.exists === true && conflict.owned === false
  const ownedConflict = conflict?.exists === true && conflict.owned === true
  const available = conflict?.exists === false

  const busy = upload.phase === 'uploading'
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  function checkSlug() {
    if (slug && space) slugCheck.load(`/api/sites/${space}/${slug}/exists`)
  }

  async function doUpload(files: DroppedFile[], replace: boolean) {
    setUpload({ phase: 'uploading', pct: 0, count: files.length })
    try {
      const res = await uploadFiles(`/api/upload/${space}/${slug}`, files, {
        visibility,
        replace,
        onProgress: (pct) => setUpload({ phase: 'uploading', pct, count: files.length }),
      })
      setUpload({ phase: 'done', url: res.url })
      setStaged(null)
      toast.success('Deployed', { description: res.url })
      slugCheck.load(`/api/sites/${space}/${slug}/exists`) // now owned
      revalidator.revalidate()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      setUpload({ phase: 'error', message })
      toast.error('Upload failed', { description: message })
    }
  }

  function startUpload(files: DroppedFile[]) {
    if (!space || !slug) {
      toast.error('Pick a space and a slug first.')
      return
    }
    if (files.length === 0) return
    if (takenByOther) {
      toast.error('That URL is taken by someone else.')
      return
    }
    if (ownedConflict) {
      setPendingReplace(files) // open controlled AlertDialog
      return
    }
    void doUpload(files, false)
  }

  // Dropped/picked files. With a slug already set, deploy straight away ("drop, get a
  // URL"). Otherwise guess a slug from the folder/file name, pre-fill it, and stage the
  // files so the user can edit the slug before hitting Deploy.
  function handleIncoming(files: DroppedFile[]) {
    if (files.length === 0) return
    if (slug) {
      startUpload(files)
      return
    }
    const derived = deriveSlug(files)
    if (derived) {
      setSlug(derived)
      if (space) slugCheck.load(`/api/sites/${space}/${derived}/exists`)
    }
    setStaged(files)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UploadCloud className="size-5 text-primary" />
          Deploy
        </CardTitle>
        <CardDescription>Pick a destination, then drop your files.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="deploy-space">Space</Label>
            <Select value={space} onValueChange={setSpace}>
              <SelectTrigger id="deploy-space" className="w-full">
                <SelectValue placeholder="Select a space" />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((s) => (
                  <SelectItem key={s.id} value={s.slug}>
                    <span className="font-mono">{s.slug}</span>
                    {s.type === 'personal' && (
                      <span className="text-muted-foreground"> · personal</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deploy-slug">Slug</Label>
            <Input
              id="deploy-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              onBlur={checkSlug}
              placeholder="my-runbook"
              className="font-mono"
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Visibility</Label>
            <div>
              <VisibilityMenu value={visibility} onChange={setVisibility} disabled={busy} />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
          <span className="font-mono text-muted-foreground break-all">
            {origin}/{space || '—'}/{slug || '…'}
          </span>
          <SlugStatus
            slug={slug}
            checking={checking}
            available={available}
            takenByOther={takenByOther}
            ownedConflict={ownedConflict}
          />
        </div>

        <Dropzone
          dragActive={dragActive}
          available={available}
          takenByOther={takenByOther}
          ownedConflict={ownedConflict}
          busy={busy}
          onDragActive={setDragActive}
          onChooseFolder={() => folderInput.current?.click()}
          onChooseFiles={() => fileInput.current?.click()}
          onDropFiles={async (dt) => {
            setDragActive(false)
            handleIncoming(await filesFromDataTransfer(dt))
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          // @ts-expect-error non-standard attribute required for folder selection
          webkitdirectory=""
          hidden
          onChange={(e) => {
            if (e.target.files) handleIncoming(filesFromInput(e.target.files))
            e.target.value = '' // allow re-selecting the same folder
          }}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) handleIncoming(filesFromInput(e.target.files))
            e.target.value = '' // allow re-selecting the same file
          }}
        />

        {staged && !busy && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {staged.length} {staged.length === 1 ? 'file' : 'files'}
              </span>{' '}
              ready — edit the slug above, then deploy.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStaged(null)}>
                Clear
              </Button>
              <Button
                size="sm"
                onClick={() => startUpload(staged)}
                disabled={!slug || !space || takenByOther || checking}
              >
                <UploadCloud />
                Deploy
              </Button>
            </div>
          </div>
        )}

        {upload.phase === 'uploading' && (
          <div className="space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-200"
                style={{ width: `${upload.pct}%` }}
              />
            </div>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              {upload.pct}% · {upload.count} files
            </p>
          </div>
        )}

        {upload.phase === 'done' && (
          <Card className="gap-3 border-success/40 bg-success/5 py-4">
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-success">Deployed</p>
                <p className="truncate font-mono text-sm text-muted-foreground">{upload.url}</p>
              </div>
              <div className="flex items-center gap-2">
                <CopyButton text={upload.url} />
                <Button asChild size="sm">
                  <a href={upload.url} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Open
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </CardContent>

      {/* Controlled replace confirmation — state holds the pending files. */}
      <AlertDialog
        open={pendingReplace !== null}
        onOpenChange={(o) => {
          if (!o) setPendingReplace(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace{' '}
              <span className="font-mono">
                {space}/{slug}
              </span>
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>This overwrites all files.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const files = pendingReplace
                setPendingReplace(null)
                if (files) void doUpload(files, true)
              }}
            >
              Replace
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function SlugStatus({
  slug,
  checking,
  available,
  takenByOther,
  ownedConflict,
}: {
  slug: string
  checking: boolean
  available: boolean
  takenByOther: boolean
  ownedConflict: boolean
}) {
  if (!slug) return null
  if (checking)
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Spinner className="size-3.5" />
        checking…
      </span>
    )
  if (takenByOther) return <span className="font-medium text-destructive">taken by someone else</span>
  if (ownedConflict)
    return (
      <span className="font-medium text-primary">you already own this — uploading replaces it</span>
    )
  if (available) return <span className="font-medium text-success">available</span>
  return null
}

function Dropzone({
  dragActive,
  available,
  takenByOther,
  ownedConflict,
  busy,
  onDragActive,
  onChooseFolder,
  onChooseFiles,
  onDropFiles,
}: {
  dragActive: boolean
  available: boolean
  takenByOther: boolean
  ownedConflict: boolean
  busy: boolean
  onDragActive: (v: boolean) => void
  onChooseFolder: () => void
  onChooseFiles: () => void
  onDropFiles: (dt: DataTransfer) => void
}) {
  const tint = takenByOther
    ? 'border-destructive/50 bg-destructive/5'
    : ownedConflict
      ? 'border-primary/50 bg-primary/5'
      : available
        ? 'border-success/50 bg-success/5'
        : 'border-border bg-muted/30'

  // The whole zone is the click target → file picker (the common single/multi-file case).
  // A full-zone overlay <button> is the click target → file picker (the common single/multi-file
  // case); the labels above set pointer-events-none so a click anywhere in the zone falls through
  // to it. Folders go via drag-drop, or the separate "upload a folder" button. One native dialog
  // can't offer files AND folders at once, and a real button can't nest another — hence two
  // sibling buttons rather than one role="button" wrapper.
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors',
        dragActive ? 'border-primary bg-primary/10' : tint,
        busy && 'pointer-events-none opacity-60',
      )}
      onDragOver={(e) => {
        e.preventDefault()
        onDragActive(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        onDragActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropFiles(e.dataTransfer)
      }}
    >
      <button
        type="button"
        aria-label="Choose files to upload"
        className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onChooseFiles}
        disabled={busy}
      />
      <div className="pointer-events-none relative flex size-12 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm">
        <FolderUp className="size-6" />
      </div>
      <div className="pointer-events-none relative">
        <p className="font-medium">Drop files or a folder here</p>
        <p className="text-sm text-muted-foreground">
          click to choose files, or{' '}
          <button
            type="button"
            className="pointer-events-auto font-medium text-primary underline-offset-2 hover:underline"
            onClick={onChooseFolder}
            disabled={busy}
          >
            upload a folder
          </button>
        </p>
      </div>
    </div>
  )
}

// ─── Your sites ──────────────────────────────────────────────────────────────

function SiteCard({ site }: { site: SiteSummary }) {
  const revalidator = useRevalidator()
  const [pendingVis, setPendingVis] = useState<Visibility | null>(null)
  const visibility = pendingVis ?? site.visibility
  const archived = site.status === 'archived'

  async function changeVisibility(v: Visibility) {
    setPendingVis(v)
    try {
      await api.patch(`/api/sites/${site.spaceSlug}/${site.siteSlug}`, { visibility: v })
      toast.success('Visibility updated', { description: VISIBILITY_LABEL(v) })
      setPendingVis(null) // drop the optimistic value; revalidated loader is source of truth
      revalidator.revalidate()
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
          <RenameDialog site={site} onDone={() => revalidator.revalidate()} />
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
              revalidator.revalidate()
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

function VISIBILITY_LABEL(v: Visibility): string {
  return v.charAt(0).toUpperCase() + v.slice(1)
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
  const [searchParams] = useSearchParams()
  // Open immediately when arriving via ?new=space — read in the initializer, not an effect.
  const [open, setOpen] = useState(() => searchParams.get('new') === 'space')
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

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
