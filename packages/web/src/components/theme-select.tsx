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
let inflight: Promise<ThemeInfo[]> | null = null

function loadThemes(): Promise<ThemeInfo[]> {
  if (catalog) return Promise.resolve(catalog)
  inflight ??= api
    .get<{ themes: ThemeInfo[] }>('/api/themes')
    .then((r) => {
      // Tolerate a malformed payload (or a test double answering something else) — an empty
      // catalog degrades to "No theme" everywhere instead of crashing the viewer.
      const themes = Array.isArray(r?.themes) ? r.themes : []
      if (themes.length > 0) catalog = themes
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
}: {
  value: string | null
  onChange: (v: string | null) => void
  themes: ThemeInfo[]
}) {
  return (
    <DropdownMenuRadioGroup value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <DropdownMenuRadioItem value={NONE} className="gap-2">
        <span className="flex-1">Default</span>
        <span className="text-xs text-muted-foreground">the page's own design</span>
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
}: {
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
  // 'chip' matches VisibilityMenu's dense-row look (viewer top bar); 'button' is the deploy-card
  // form control.
  trigger?: 'button' | 'chip'
}) {
  const themes = useThemes()
  const label = themeLabel(themes, value)
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
        <DropdownMenuLabel>Design theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeRadioItems value={value} onChange={onChange} themes={themes} />
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
