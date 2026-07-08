import type { ReactNode } from 'react'
import { ExternalLink, Mic } from 'lucide-react'
import type { Column } from '@/components/SortableTable'
import { VisibilityBadge } from '@/components/visibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { timeAgo } from '@/lib/time'
import type { SiteSummary, Visibility } from '@/lib/types'

// Reusable site-table columns. Every site-collection shares Name / URL / Visibility / Created so
// the three tables read as one system; the owner table swaps in its own interactive visibility
// cell + actions.

const VIS_RANK: Record<Visibility, number> = { private: 0, members: 1, team: 2 }
export const visRank = (v: Visibility): number => VIS_RANK[v]

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
        <span className="truncate font-medium">{s.title ?? s.siteSlug}</span>
        {s.status === 'archived' && <Badge variant="secondary">archived</Badge>}
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
