import { Building2, ChevronDown, Lock, type LucideIcon, Users } from 'lucide-react'
import type { Visibility } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export const VISIBILITIES: Visibility[] = ['private', 'members', 'team']

export const VISIBILITY_META: Record<
  Visibility,
  { label: string; hint: string; icon: LucideIcon; badge: string }
> = {
  private: { label: 'Private', hint: 'Only you', icon: Lock, badge: 'bg-muted text-muted-foreground' },
  members: { label: 'Members', hint: 'This space only', icon: Users, badge: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' },
  team: { label: 'Team', hint: 'Everyone in your org', icon: Building2, badge: 'bg-primary/15 text-primary' },
}

export function VisibilityBadge({ value, className }: { value: Visibility; className?: string }) {
  const m = VISIBILITY_META[value]
  const Icon = m.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        m.badge,
        className,
      )}
    >
      <Icon className="size-3" />
      {m.label}
    </span>
  )
}

export function VisibilityMenu({
  value,
  onChange,
  disabled,
  trigger = 'button',
}: {
  value: Visibility
  onChange: (v: Visibility) => void
  disabled?: boolean
  // 'chip' renders the status badge itself as the trigger (for dense table rows); 'button' is
  // the standalone form-control look used on the deploy card.
  trigger?: 'button' | 'chip'
}) {
  const m = VISIBILITY_META[value]
  const Icon = m.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger === 'chip' ? (
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50',
              m.badge,
            )}
          >
            <Icon className="size-3" />
            {m.label}
            <ChevronDown className="size-3 opacity-60" />
          </button>
        ) : (
          <Button variant="outline" size="sm" disabled={disabled} className="gap-1.5">
            <Icon className="size-3.5" />
            {m.label}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Who can see this</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as Visibility)}>
          {VISIBILITIES.map((v) => {
            const meta = VISIBILITY_META[v]
            const I = meta.icon
            return (
              <DropdownMenuRadioItem key={v} value={v} className="gap-2">
                <I className="size-3.5 shrink-0" />
                <span className="flex-1">{meta.label}</span>
                <span className="text-xs text-muted-foreground">{meta.hint}</span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
