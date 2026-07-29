import type { ReactNode } from 'react'
import { ExternalLink, Mic, Sparkles, Star } from 'lucide-react'
import { CopyButton } from '@/components/CopyButton'
import type { Column } from '@/components/SortableTable'
import { VisibilityBadge } from '@/components/visibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStar } from '@/hooks/useStar'
import { timeAgo } from '@/lib/time'
import type { SiteSummary, Visibility } from '@/lib/types'

// Reusable site-table columns. Every site-collection shares Name / URL / Visibility / Created so
// the three tables read as one system; the owner table swaps in its own interactive visibility
// cell + actions.

const VIS_RANK: Record<Visibility, number> = { private: 0, members: 1, team: 2 }
export const visRank = (v: Visibility): number => VIS_RANK[v]

// Leading star cell — defined here, beside nameColumn, so all five site tables get the identical
// control rather than five near-copies. A PRIVATE row renders no control at all (not a disabled
// one): the server refuses to star a private site, and an inert button would only invite the click.
// Sorting by star is deliberately not offered — the Starred tab is the "show me these" affordance.
export function starColumn<T extends SiteSummary>(): Column<T> {
  return {
    key: 'star',
    label: '',
    srLabel: 'Star',
    headClassName: 'w-8',
    cellClassName: 'w-8',
    render: (s) => (s.visibility === 'private' ? null : <StarCell site={s} />),
  }
}

function StarCell({ site }: { site: SiteSummary }) {
  const { starred, toggle } = useStar(site)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:text-foreground"
      aria-label={starred ? 'Remove star' : 'Star this page'}
      aria-pressed={starred}
      onClick={toggle}
    >
      <Star className={starred ? 'fill-primary text-primary' : undefined} />
    </Button>
  )
}

export function nameColumn<T extends SiteSummary>(): Column<T> {
  return {
    key: 'name',
    label: 'Name',
    headClassName: 'max-w-[15rem]',
    cellClassName: 'max-w-[15rem]',
    compare: (a, b) => (a.title ?? a.siteSlug).localeCompare(b.title ?? b.siteSlug),
    render: (s) => (
      <div className="flex items-center gap-2">
        {s.audio && <Mic className="size-3.5 shrink-0 text-primary" aria-label="Audio" />}
        {s.hasSummary && <Sparkles className="size-3.5 shrink-0 text-primary" aria-label="Has AI summary" />}
        <span className="truncate font-medium">{s.title ?? s.siteSlug}</span>
        {s.status === 'archived' && <Badge variant="secondary">archived</Badge>}
        {/* "Shared with me" feed only: an editor grantee can redeploy this site's content. */}
        {s.role === 'editor' && <Badge>You can edit</Badge>}
      </div>
    ),
  }
}

export function urlColumn<T extends SiteSummary>(): Column<T> {
  return {
    key: 'url',
    label: 'URL',
    cellClassName: 'max-w-[22rem]',
    render: (s) => (
      <a
        href={s.url}
        target="_blank"
        rel="noreferrer"
        className="block truncate font-mono text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        {s.url.replace(/^https?:\/\//, '')}
      </a>
    ),
  }
}

// Visibility column owns the rank-compare; callers supply the cell (a static badge, or the
// owner's interactive tier picker) so the sort stays defined in one place.
export function visibilityColumn<T extends SiteSummary>(render: (row: T) => ReactNode): Column<T> {
  return {
    key: 'visibility',
    label: 'Visibility',
    compare: (a, b) => visRank(a.visibility) - visRank(b.visibility),
    render,
  }
}

export function visibilityBadgeColumn<T extends SiteSummary>(): Column<T> {
  return visibilityColumn<T>((s) => <VisibilityBadge value={s.visibility} />)
}

// "Open in a new tab" button — the trailing action every site row carries.
export function OpenLinkButton({ url }: { url: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={url} target="_blank" rel="noreferrer">
        <ExternalLink />
        Open
      </a>
    </Button>
  )
}

// Trailing actions cell — the right-aligned shape shared by all three tables; `render` supplies
// the buttons (Open + kebab / Copy + Open / Open).
export function actionsColumn<T>(render: (row: T) => ReactNode): Column<T> {
  return { key: 'actions', label: '', headClassName: 'text-right', cellClassName: 'text-right', render }
}

// The read-only feed table — Name / URL / Visibility / Created plus caller-supplied trailing
// actions. Shared by the dashboard's "Shared with me" tab and the space page's sites table.
export function feedColumns<T extends SiteSummary>(actions: (row: T) => ReactNode): Column<T>[] {
  return [starColumn(), nameColumn(), urlColumn(), visibilityBadgeColumn(), createdColumn(), actionsColumn(actions)]
}

/** Copy + Open trailing cell; `children` appends row-specific extras (e.g. an owner's Share). */
export function CopyOpenActions({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <CopyButton text={url} label="" variant="outline" />
      <OpenLinkButton url={url} />
      {children}
    </div>
  )
}

export function createdColumn<T extends SiteSummary>(key = 'created', label = 'Created'): Column<T> {
  return {
    key,
    label,
    defaultDir: 'desc',
    compare: (a, b) => a.createdAt.localeCompare(b.createdAt), // ISO 8601 sorts lexicographically
    cellClassName: 'text-sm text-muted-foreground',
    render: (s) => (
      <time dateTime={s.createdAt} title={new Date(s.createdAt).toLocaleString()}>
        {timeAgo(s.createdAt)}
      </time>
    ),
  }
}

// Like createdColumn but on updatedAt (last content activity) — used by the Team activity feed so a
// re-deployed site sorts to the top. Falls back to createdAt for any legacy row without an updatedAt.
export function updatedColumn<T extends SiteSummary>(key = 'updated', label = 'Updated'): Column<T> {
  return {
    key,
    label,
    defaultDir: 'desc',
    compare: (a, b) => (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt),
    cellClassName: 'text-sm text-muted-foreground',
    render: (s) => {
      const when = s.updatedAt ?? s.createdAt
      return (
        <time dateTime={when} title={new Date(when).toLocaleString()}>
          {timeAgo(when)}
        </time>
      )
    },
  }
}
