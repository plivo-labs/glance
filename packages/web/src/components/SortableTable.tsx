import { type ReactNode, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export type SortDir = 'asc' | 'desc'

export type Column<T> = {
  key: string
  label: string
  render: (row: T) => ReactNode
  // Provide `compare` to make the column sortable; omit for a static column (URL, actions).
  compare?: (a: T, b: T) => number
  // Direction applied when this column is first selected (e.g. 'desc' for dates).
  defaultDir?: SortDir
  headClassName?: string
  cellClassName?: string
}

// Below `sm` the table reflows into stacked label/value rows so actions are reachable without a
// horizontal scroll; each cell's column label rides in via `data-label`. At `sm`+ it's a table.
const mobileRow = 'max-sm:block max-sm:py-2'
const mobileCell =
  'max-sm:flex max-sm:items-center max-sm:justify-between max-sm:gap-4 max-sm:max-w-none max-sm:whitespace-normal max-sm:px-4 max-sm:py-1.5 max-sm:before:font-medium max-sm:before:text-sm max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]'

// One sortable table shell shared by every site-collection (Your sites / Shared / Team activity)
// so they stay visually identical — columns and per-cell rendering are the only differences.
// Pass a STABLE `columns` (module-scope or memoized): the sort memo keys on the resolved column.
export function SortableTable<T>({
  rows,
  columns,
  getRowKey,
  initialSort,
}: {
  rows: T[]
  columns: Column<T>[]
  getRowKey: (row: T) => string
  initialSort: { key: string; dir: SortDir }
}) {
  const [sort, setSort] = useState(initialSort)
  const active = columns.find((c) => c.key === sort.key)

  const sorted = useMemo(() => {
    if (!active?.compare) return rows
    const compare = active.compare
    const dir = sort.dir === 'asc' ? 1 : -1
    // Negate rather than `.reverse()` so equal-key rows keep their relative order in both directions.
    return [...rows].sort((a, b) => dir * compare(a, b))
  }, [rows, active, sort.dir])

  const toggle = (col: Column<T>) =>
    setSort((s) =>
      s.key === col.key
        ? { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key: col.key, dir: col.defaultDir ?? 'asc' },
    )

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <Table className="max-sm:block">
        <TableHeader className="max-sm:hidden">
          <TableRow className="hover:bg-transparent">
            {columns.map((c) =>
              c.compare ? (
                <SortHead
                  key={c.key}
                  label={c.label}
                  active={sort.key === c.key}
                  dir={sort.dir}
                  onToggle={() => toggle(c)}
                  className={c.headClassName}
                />
              ) : (
                <TableHead key={c.key} className={c.headClassName}>
                  {c.label ? c.label : <span className="sr-only">Actions</span>}
                </TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody className="max-sm:block">
          {sorted.map((row) => (
            <TableRow key={getRowKey(row)} className={mobileRow}>
              {columns.map((c) => (
                <TableCell key={c.key} data-label={c.label} className={cn(mobileCell, c.cellClassName)}>
                  {c.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function SortHead({
  label,
  active,
  dir,
  onToggle,
  className,
}: {
  label: string
  active: boolean
  dir: SortDir
  onToggle: () => void
  className?: string
}) {
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={onToggle}
        className="-mx-1 inline-flex items-center gap-1 rounded px-1 font-medium hover:text-foreground/70"
        aria-label={`Sort by ${label}`}
      >
        {label}
        <Icon className={cn('size-3.5', active ? 'opacity-80' : 'opacity-40')} />
      </button>
    </TableHead>
  )
}
