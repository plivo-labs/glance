import { ChartColumn } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Spinner } from '@/components/states'
import { Button } from '@/components/ui/button'
import { MountSensor } from '@/components/ui/mount-sensor'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { type SiteInsights, siteInsights } from '@/lib/insights'

type Props = {
  spaceSlug: string
  siteSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

type State = { kind: 'loading' } | { kind: 'ready'; data: SiteInsights } | { kind: 'failed' }

const count = new Intl.NumberFormat().format
const plural = (n: number) => `${count(n)} view${n === 1 ? '' : 's'}`
// The series dates are UTC calendar days; format them in UTC so a viewer west of Greenwich does
// not see every bar labelled a day early.
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-3 py-2.5">
      <div className="font-mono text-label text-muted-foreground uppercase">{label}</div>
      <div className="font-mono font-semibold text-2xl tabular-nums tracking-tight">{count(value)}</div>
    </div>
  )
}

function ViewsChart({ series }: { series: SiteInsights['series'] }) {
  const max = Math.max(1, ...series.map((p) => p.views))
  return (
    <div>
      <div role="img" aria-label="Views per day" className="flex h-24 items-end gap-px">
        {series.map((p) => (
          <div key={p.date} title={`${dayLabel(p.date)}: ${plural(p.views)}`} className="flex h-full flex-1 items-end">
            <div
              className={p.views > 0 ? 'w-full rounded-t-[1px] bg-brand' : 'w-full bg-border'}
              style={{ height: p.views > 0 ? `${Math.max(4, (p.views / max) * 100)}%` : '1px' }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-muted-foreground text-xs">
        <span>{dayLabel(series[0].date)}</span>
        <span>{dayLabel(series[series.length - 1].date)}</span>
      </div>
    </div>
  )
}

function InsightsBody({ data }: { data: SiteInsights }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Views" value={data.totalViews} />
        <Stat label="Unique viewers" value={data.uniqueViewers} />
        <Stat label="Avg / day" value={Number((data.totalViews / data.days).toFixed(1))} />
      </div>
      {data.totalViews === 0 ? (
        <p className="py-6 text-center text-muted-foreground text-sm">No views in the last {data.days} days.</p>
      ) : (
        <>
          <ViewsChart series={data.series} />
          <div>
            <h3 className="mb-2 font-mono text-label text-muted-foreground uppercase">Top pages</h3>
            <ul className="divide-y rounded-md border">
              {data.pages.map((p) => (
                <li key={p.path} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="truncate font-mono text-xs" title={p.path}>
                    {p.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{count(p.views)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

// Owner-only (the API 403s anyone else). Numbers are fetched each time the sheet opens — Radix
// unmounts the content on close, so MountSensor re-fires and the counts are never stale.
export function InsightsSheet({ spaceSlug, siteSlug, open, onOpenChange }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const latest = useRef(0)

  const load = useCallback(() => {
    latest.current += 1
    const token = latest.current
    setState({ kind: 'loading' })
    siteInsights
      .get(spaceSlug, siteSlug)
      .then((data) => token === latest.current && setState({ kind: 'ready', data }))
      .catch(() => token === latest.current && setState({ kind: 'failed' }))
  }, [spaceSlug, siteSlug])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <MountSensor onMount={load} />
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <ChartColumn className="size-4 text-brand-text" />
            Insights
          </SheetTitle>
          <SheetDescription>Last 30 days (UTC). Counts only, no names.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {state.kind === 'loading' && (
            <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
              <Spinner />
              Loading insights…
            </div>
          )}
          {state.kind === 'failed' && (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm">Could not load insights.</p>
              <Button variant="ghost" onClick={load}>
                Try again
              </Button>
            </div>
          )}
          {state.kind === 'ready' && <InsightsBody data={state.data} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
