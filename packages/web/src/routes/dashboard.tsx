import { useRef, useState } from 'react'
import {
  Link,
  type LoaderFunctionArgs,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from 'react-router'
import {
  ExternalLink,
  FolderUp,
  Plus,
  Rocket,
  UploadCloud,
} from 'lucide-react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { SitesTable } from '@/components/SitesTable'
import { SpaceSelect } from '@/components/SpaceSelect'
import { EmptyState, PageHeader, Spinner } from '@/components/states'
import { VisibilityBadge, VisibilityMenu } from '@/components/visibility'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import { timeAgo } from '@/lib/time'
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

      <Tabs defaultValue="sites" className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="sites">
            Your sites
            <TabCount n={sites.length} />
          </TabsTrigger>
          {shared.length > 0 && (
            <TabsTrigger value="shared">
              Shared with me
              <TabCount n={shared.length} />
            </TabsTrigger>
          )}
          <TabsTrigger value="spaces">
            Your spaces
            <TabCount n={groupSpaces.length} />
          </TabsTrigger>
          <TabsTrigger value="team">Team activity</TabsTrigger>
        </TabsList>

        <TabsContent value="sites">
          {sites.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="No sites yet"
              description="Drop a folder above to ship your first."
            />
          ) : (
            <SitesTable sites={sites} />
          )}
        </TabsContent>

        {shared.length > 0 && (
          <TabsContent value="shared" className="grid gap-3">
            {shared.map((s) => (
              <SharedSiteRow key={s.id} site={s} />
            ))}
          </TabsContent>
        )}

        <TabsContent value="spaces" className="space-y-4">
          <div className="flex justify-end">
            <NewSpaceDialog />
          </div>
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
        </TabsContent>

        <TabsContent value="team">
          {team.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="Nothing shipped yet"
              description="Team-visible sites show up here as people deploy them."
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
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TabCount({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{n}</span>
  )
}

// ─── Team activity ───────────────────────────────────────────────────────────

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
  const folderInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // Slug-conflict probe. MUST use the `api` helper, not useFetcher().load() — `/api/*`
  // has no client route, so a fetcher.load matches the `*` not-found splat and throws a
  // 404 into the AppShell error boundary (renders the 404 page, URL stuck on /dashboard).
  const checkSeq = useRef(0)

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

  const [conflict, setConflict] = useState<SlugExists | null>(null)
  const [checking, setChecking] = useState(false)
  const takenByOther = conflict?.exists === true && conflict.owned === false
  const ownedConflict = conflict?.exists === true && conflict.owned === true
  const available = conflict?.exists === false

  const busy = upload.phase === 'uploading'
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  async function checkSlug(targetSlug = slug) {
    if (!targetSlug || !space) return
    const seq = ++checkSeq.current
    setChecking(true)
    try {
      const res = await api.get<SlugExists>(`/api/sites/${space}/${targetSlug}/exists`)
      if (seq === checkSeq.current) setConflict(res)
    } catch {
      if (seq === checkSeq.current) setConflict(null)
    } finally {
      if (seq === checkSeq.current) setChecking(false)
    }
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
      void checkSlug() // now owned
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
      void checkSlug(derived)
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
            <SpaceSelect id="deploy-space" value={space} onChange={setSpace} spaces={spaces} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deploy-slug">Slug</Label>
            <Input
              id="deploy-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              onBlur={() => checkSlug()}
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
