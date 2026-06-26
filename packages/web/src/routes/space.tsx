import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  useFetcher,
  useLoaderData,
  useNavigate,
} from 'react-router'
import { ExternalLink, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ShareDialog } from '@/components/ShareDialog'
import { EmptyState, PageHeader, SectionHeader, Spinner } from '@/components/states'
import { VisibilityBadge } from '@/components/visibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import type { SpaceDetail, Visibility } from '@/lib/types'
import { cn } from '@/lib/utils'

interface SpaceSite {
  id: string
  spaceSlug: string
  siteSlug: string
  title: string | null
  visibility: Visibility
  status: 'active' | 'archived'
  isOwner: boolean
  url: string
  createdAt: string
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

export async function action({ request, params }: ActionFunctionArgs) {
  const email = String((await request.formData()).get('email') ?? '')
  try {
    await api.post(`/api/spaces/${params.space}/members`, { email })
    return { ok: true as const }
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Invite failed' }
  }
}

type InviteResult = { ok?: boolean; error?: string }

function InviteCard() {
  const fetcher = useFetcher<InviteResult>()
  const busy = fetcher.state !== 'idle'
  const data = fetcher.data

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a member</CardTitle>
        <CardDescription>Add a teammate by email to grant them access to this space.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fetcher.Form method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              name="email"
              type="email"
              placeholder="teammate@example.com"
              required
              disabled={busy}
              autoComplete="email"
            />
          </div>
          <Button type="submit" disabled={busy} className="sm:w-28">
            {busy ? <Spinner /> : <UserPlus />}
            Invite
          </Button>
        </fetcher.Form>

        {data?.ok && (
          <output className="block rounded-md border border-success/30 bg-success/15 px-3 py-2 text-sm font-medium text-success">
            Invited.
          </output>
        )}
        {data?.error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
          >
            {data.error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SiteCard({ site }: { site: SpaceSite }) {
  const archived = site.status === 'archived'
  return (
    <Card className={cn(archived && 'opacity-75')}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="min-w-0 truncate text-base">{site.title ?? site.siteSlug}</CardTitle>
          <VisibilityBadge value={site.visibility} />
          {archived && <Badge variant="secondary">Archived</Badge>}
        </div>
        <CardDescription className="truncate font-mono text-xs">{site.url}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button asChild variant="secondary" size="sm">
          <a href={site.url} target="_blank" rel="noreferrer">
            <ExternalLink />
            Open
          </a>
        </Button>
        <CopyButton text={site.url} />
        {site.isOwner && (
          <ShareDialog spaceSlug={site.spaceSlug} siteSlug={site.siteSlug} title={site.title} />
        )}
      </CardContent>
    </Card>
  )
}

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
      />

      {isGroup && <InviteCard />}

      <section className="space-y-4">
        <SectionHeader index={1} title="Sites" />
        {sites.length === 0 ? (
          <EmptyState
            icon={ExternalLink}
            title="No sites yet"
            description="No sites you can access here yet."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {sites.map((s) => (
              <SiteCard key={s.id} site={s} />
            ))}
          </div>
        )}
      </section>

      {isGroup && <DangerZone space={space} />}
    </div>
  )
}
