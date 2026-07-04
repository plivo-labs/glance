import { cn } from '@/lib/utils'

// A compact segmented control (a boxed row of mutually-exclusive options). Used for the review
// Read·Annotate toggle and the canvas width selector — same look, one implementation.
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'rounded px-2 py-0.5 text-xs capitalize transition-colors',
            value === o.value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
