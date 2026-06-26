import { useFetcher, useNavigate } from 'react-router'
import { ExternalLink, LayoutDashboard, LogOut, Plus, Shield, SunMoon } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { toggleTheme } from '@/components/theme'
import { api } from '@/lib/api'
import type { Me, SiteSummary } from '@/lib/types'

export function CommandPalette({
  open,
  onOpenChange,
  user,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  user: Me | null
}) {
  const navigate = useNavigate()
  const fetcher = useFetcher<SiteSummary[]>()
  const sites = (fetcher.data as SiteSummary[] | undefined) ?? []

  // Lazy-load recent sites the first time the palette opens (event-driven — no effect).
  function handleOpenChange(o: boolean) {
    if (o && user && fetcher.state === 'idle' && !fetcher.data) fetcher.load('/api/sites/mine')
    onOpenChange(o)
  }
  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Command palette"
      description="Search sites and run actions"
    >
      <CommandInput placeholder="Type a command or search your sites…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => run(() => navigate('/dashboard'))}>
            <LayoutDashboard />
            Dashboard
          </CommandItem>
          {user?.role === 'superadmin' && (
            <CommandItem onSelect={() => run(() => navigate('/admin'))}>
              <Shield />
              Admin
            </CommandItem>
          )}
          <CommandItem onSelect={() => run(() => navigate('/dashboard?new=space'))}>
            <Plus />
            New space
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Preferences">
          <CommandItem onSelect={() => run(toggleTheme)}>
            <SunMoon />
            Toggle theme
          </CommandItem>
          {user && (
            <CommandItem
              onSelect={() =>
                run(async () => {
                  try {
                    await api.post('/api/auth/logout')
                  } finally {
                    window.location.href = '/login'
                  }
                })
              }
            >
              <LogOut />
              Sign out
            </CommandItem>
          )}
        </CommandGroup>
        {sites.length > 0 && (
          <CommandGroup heading="Recent sites">
            {sites.slice(0, 6).map((s) => (
              <CommandItem
                key={s.id}
                value={`site ${s.spaceSlug}/${s.siteSlug} ${s.title ?? ''}`}
                onSelect={() => run(() => window.open(s.url, '_blank', 'noopener,noreferrer'))}
              >
                <ExternalLink />
                <span className="truncate">
                  {s.spaceSlug}/{s.siteSlug}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
