import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Copy, ExternalLink, Folder, History, LayoutDashboard, LogOut, Plus, Shield, SunMoon, Terminal } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { toggleTheme } from '@/components/theme'
import { api } from '@/lib/api'
import { groupBySite, useRecents } from '@/lib/recents'
import type { Me, SiteSummary, SpaceSummary } from '@/lib/types'

const SEARCH_DEBOUNCE_MS = 200

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
  // Data comes from the `api` fetch helper, not useFetcher: useFetcher().load() resolves a
  // React Router route, but /api/* are worker endpoints with no client route (they'd match
  // the splat). Site search is driven by the input; spaces load when the palette opens.
  const [query, setQuery] = useState('')
  const [sites, setSites] = useState<SiteSummary[]>([])
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reqSeq = useRef(0)

  const term = query.trim()

  // Same store the viewer's recents sidebar reads — shown only in the empty (no-search) state,
  // like the sites/spaces search results it'd otherwise compete with.
  const recentEntries = useRecents(user?.id ?? null)
  const recentSites = useMemo(() => groupBySite(recentEntries).slice(0, 5), [recentEntries])

  // Radix mounts the dialog content on open and unmounts it on close — for EVERY trigger
  // (header button, ⌘K, Escape), unlike onOpenChange which the externally-controlled `open`
  // prop bypasses. So load spaces / reset search here, via a ref callback (the codebase's
  // effect-free idiom; see AppShell hotkeys).
  const onPaletteMount = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        if (timer.current) clearTimeout(timer.current)
        ++reqSeq.current // invalidate any in-flight search so a late response can't repopulate on reopen
        setQuery('')
        setSites([])
        return
      }
      if (user)
        api
          .get<SpaceSummary[]>('/api/spaces/mine')
          .then(setSpaces)
          .catch(() => {})
    },
    [user],
  )

  // Debounced remote search. A monotonic request id drops out-of-order responses. cmdk
  // filters items client-side by their `value`, so each result embeds the live query to
  // survive that filter while the static commands still filter naturally.
  function onSearchChange(v: string) {
    setQuery(v)
    if (timer.current) clearTimeout(timer.current)
    const q = v.trim()
    if (!q) {
      // Bump the seq so an in-flight fetch for the PRIOR query fails its id===reqSeq guard and
      // can't repopulate results after the input was cleared (#39).
      ++reqSeq.current
      setSites([])
      return
    }
    const id = ++reqSeq.current
    timer.current = setTimeout(() => {
      api
        .get<SiteSummary[]>(`/api/sites/search?q=${encodeURIComponent(q)}`)
        .then((res) => {
          if (id === reqSeq.current) setSites(res)
        })
        .catch(() => {
          if (id === reqSeq.current) setSites([])
        })
    }, SEARCH_DEBOUNCE_MS)
  }

  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }
  const copyUrl = (url: string) => {
    void navigator.clipboard?.writeText(url)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search sites and run actions"
    >
      <CommandInput placeholder="Search all your sites or run a command…" onValueChange={onSearchChange} />
      <CommandList>
        <div ref={onPaletteMount} className="hidden" aria-hidden="true" />
        <CommandEmpty>{term ? 'No matching sites.' : 'No results.'}</CommandEmpty>
        {!term && recentSites.length > 0 && (
          <CommandGroup heading="Recent">
            {recentSites.map((s) => (
              <CommandItem
                key={`${s.spaceSlug}/${s.siteSlug}`}
                value={`recent ${s.spaceSlug}/${s.siteSlug} ${s.title ?? ''}`}
                onSelect={() => run(() => navigate(`/${s.spaceSlug}/${s.siteSlug}`))}
              >
                <History />
                <span className="truncate">
                  {s.title ? `${s.title} · ` : ''}
                  {s.spaceSlug}/{s.siteSlug}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {sites.length > 0 && (
          <CommandGroup heading="Sites">
            {sites.map((s) => (
              <CommandItem
                key={s.id}
                value={`${query} site ${s.spaceSlug}/${s.siteSlug} ${s.title ?? ''}`}
                onSelect={() => run(() => window.open(s.url, '_blank', 'noopener,noreferrer'))}
              >
                <ExternalLink />
                <span className="truncate">
                  {s.title ? `${s.title} · ` : ''}
                  {s.spaceSlug}/{s.siteSlug}
                </span>
                <button
                  type="button"
                  aria-label="Copy URL"
                  title="Copy URL"
                  className="ml-auto rounded-sm p-1 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyUrl(s.url)
                  }}
                >
                  <Copy className="size-4" />
                </button>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
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
          <CommandItem onSelect={() => run(() => navigate('/cli'))}>
            <Terminal />
            Install CLI
          </CommandItem>
        </CommandGroup>
        {spaces.length > 0 && (
          <CommandGroup heading="Spaces">
            {spaces.map((sp) => (
              <CommandItem
                key={sp.id}
                value={`space ${sp.slug} ${sp.name}`}
                onSelect={() => run(() => navigate(`/${sp.slug}`))}
              >
                <Folder />
                <span className="truncate">{sp.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{sp.slug}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandSeparator />
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
      </CommandList>
    </CommandDialog>
  )
}
