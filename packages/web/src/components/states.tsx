import { Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin', className)} />
}

export function PageHeader({
  title,
  description,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="font-mono text-xs text-muted-foreground">
          <span className="text-primary">~/work</span> $ glance
        </div>
        <h1 className="mt-2 font-mono text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}

// Section heading with a mono index tick + a hairline rule trailing off to the
// right — the "01 02" treatment from the login, carried into the app.
export function SectionHeader({
  index,
  title,
  children,
}: {
  index?: number
  title: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="bp-rule flex min-w-0 flex-1 items-center gap-3">
        {index != null && (
          <span className="font-mono text-xs tabular-nums text-primary">
            {String(index).padStart(2, '0')}
          </span>
        )}
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 px-6 py-16 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
      )}
      <div className="font-medium">{title}</div>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {children && <div className="mt-4 flex items-center gap-2">{children}</div>}
    </div>
  )
}
