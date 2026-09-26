import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { slugify } from '@/lib/slug'
import type { Visibility } from '@/lib/types'

// Fork = copy a site's files into a space of your own. ANY user who can READ a site can fork it,
// so this is offered to plain viewers too — not just owners/editors (cf. the owner-only kebab
// actions, which are gated by the table they live in).
//
// Fork asks first: ForkDialog collects the name and the visibility tier and calls this hook, which
// owns the POST, the toast and the navigate. The destination space is NOT asked for — the fork
// always lands in the caller's personal space, which is what an empty `space` means to the API.
// On success we navigate to the fork — the response carries its space/site — which both shows the
// result and (on the dashboard) leaves a route whose loader refetches the site list on return.
interface ForkedSite {
  spaceSlug: string
  siteSlug: string
  url: string
}

// The API's slug rules bottom out at 3 characters (packages/api/src/lib/slug.ts), so a name that
// slugifies to nothing ("🙂", "---") or to a stub ("hi") would 400. Send no slug at all in that
// case and let the fork route's own `<slug>-copy` dedupe name the copy.
export function forkSlug(name: string): string | undefined {
  const slug = slugify(name)
  return slug.length >= 3 ? slug : undefined
}

export function useForkSite(site: { spaceSlug: string; siteSlug: string }) {
  const navigate = useNavigate()
  const [forking, setForking] = useState(false)

  // Resolves true only when the fork landed. The dialog closes on true and STAYS OPEN on false, so
  // a rejected name (the 409 slug conflict) can be edited and retried instead of being lost.
  async function fork({ title, visibility }: { title: string; visibility: Visibility }): Promise<boolean> {
    if (forking) return false
    setForking(true)
    try {
      const slug = forkSlug(title)
      const body: { title: string; visibility: Visibility; slug?: string } = { title, visibility }
      if (slug) body.slug = slug
      const forked = await api.post<ForkedSite>(`/api/sites/${site.spaceSlug}/${site.siteSlug}/fork`, body)
      toast.success('Site forked', { description: `${forked.spaceSlug}/${forked.siteSlug}` })
      navigate(`/${forked.spaceSlug}/${forked.siteSlug}`)
      return true
    } catch (err) {
      toast.error('Could not fork site', {
        description: err instanceof Error ? err.message : undefined,
      })
      return false
    } finally {
      setForking(false)
    }
  }

  return { fork, forking }
}
