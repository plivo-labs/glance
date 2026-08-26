import { ChevronDown, Palette } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { ThemeInfo } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Design-theme pickers. The catalog comes from GET /api/themes (public, server-defined) — a
// module-level cache keeps it to one fetch per session; every picker/submenu shares it.

// Radix radio items compare string values, so "no theme" travels as this sentinel and is
// mapped back to null at the onChange boundary (null is what the API stores/serves).
const NONE = 'none'

let catalog: ThemeInfo[] | null = null
let catalogVersion: string | null = null
let inflight: Promise<ThemeInfo[]> | null = null

function loadThemes(): Promise<ThemeInfo[]> {
  if (catalog) return Promise.resolve(catalog)
  inflight ??= api
    .get<{ themes: ThemeInfo[]; version?: string }>('/api/themes')
    .then((r) => {
      // Tolerate a malformed payload (or a test double answering something else) — an empty
      // catalog degrades to "No theme" everywhere instead of crashing the viewer.
      const themes = Array.isArray(r?.themes) ? r.themes : []
      if (themes.length > 0) catalog = themes
      if (typeof r?.version === 'string') catalogVersion = r.version
      return themes
    })
    .catch(() => {
      inflight = null // a failed fetch retries on the next open instead of caching the failure
      return []
    })
  return inflight
}

export function useThemes(): ThemeInfo[] {
  const [themes, setThemes] = useState<ThemeInfo[]>(catalog ?? [])
  useEffect(() => {
    let live = true
    void loadThemes().then((t) => {
      if (live && t.length > 0) setThemes(t)
      return undefined
    })
    return () => {
      live = false
    }
  }, [])
  return themes
}

export function themeLabel(themes: ThemeInfo[], slug: string | null): string {
  if (!slug) return 'Default'
  return themes.find((t) => t.slug === slug)?.name ?? slug
}

/** Stylesheet href for a viewer-LOCAL theme override (the glance:theme frame command). Resolves
 *  after the catalog loads so the href carries the cache-busting version; null clears back to the
 *  site's own theme. */
export async function viewThemeHref(slug: string | null): Promise<string | null> {
  if (!slug) return null
  await loadThemes()
  return `/_glance/theme/${slug}.css${catalogVersion ? `?v=${catalogVersion}` : ''}`
}

/** PATCH a site's theme with the standard success/error toasts. Returns whether it stuck, so the
 *  caller decides its own refresh (feed revalidate vs full viewer reload). */
export async function patchTheme(spaceSlug: string, siteSlug: string, theme: string | null): Promise<boolean> {
  try {
    await api.patch(`/api/sites/${spaceSlug}/${siteSlug}`, { theme })
    toast.success('Theme updated', { description: themeLabel(catalog ?? [], theme) })
    return true
  } catch (err) {
    toast.error('Could not update theme', { description: err instanceof Error ? err.message : undefined })
    return false
  }
}

function ThemeRadioItems({
  value,
  onChange,
  themes,
  defaultLabel = 'Default',
  defaultHint = "the page's own design",
}: {
  value: string | null
  onChange: (v: string | null) => void
  themes: ThemeInfo[]
  defaultLabel?: string
  defaultHint?: string
}) {
  return (
    <DropdownMenuRadioGroup value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <DropdownMenuRadioItem value={NONE} className="gap-2">
        <span className="flex-1">{defaultLabel}</span>
        <span className="text-xs text-muted-foreground">{defaultHint}</span>
      </DropdownMenuRadioItem>
      {themes.map((t) => (
        <DropdownMenuRadioItem key={t.slug} value={t.slug} title={t.description}>
          {t.name}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

export function ThemeMenu({
  value,
  onChange,
  disabled,
  trigger = 'button',
  menuLabel = 'Design theme',
  defaultLabel,
  defaultHint,
}: {
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
  // 'chip' matches VisibilityMenu's dense-row look (viewer top bar); 'button' is the deploy-card
  // form control.
  trigger?: 'button' | 'chip'
  // Overridable chrome: the viewer-local (non-owner) chip explains that the choice is personal.
  menuLabel?: string
  defaultLabel?: string
  defaultHint?: string
}) {
  const themes = useThemes()
  // The collapsed chip mirrors the menu's vocabulary: a custom default label ("Site default")
  // must show on the trigger too, not only inside the open menu.
  const label = value ? themeLabel(themes, value) : (defaultLabel ?? themeLabel(themes, null))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger === 'chip' ? (
          <button
            type="button"
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground text-xs transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            <Palette className="size-3" />
            {label}
            <ChevronDown className="size-3 opacity-60" />
          </button>
        ) : (
          <Button variant="outline" size="sm" disabled={disabled} className="gap-1.5">
            <Palette className="size-3.5" />
            {label}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeRadioItems value={value} onChange={onChange} themes={themes} defaultLabel={defaultLabel} defaultHint={defaultHint} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Theme picker as a submenu, for embedding in an existing kebab/hamburger menu. */
export function ThemeSubMenu({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const themes = useThemes()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <Palette className="size-4 text-muted-foreground" />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <ThemeRadioItems value={value} onChange={onChange} themes={themes} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
