import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'

// Fork = copy a site's files into a space of your own. ANY user who can READ a site can fork it,
// so this is offered to plain viewers too — not just owners/editors (cf. the owner-only kebab
// actions, which are gated by the table they live in).
//
// The empty body is the happy path: the API forks into the caller's personal space under
// `<slug>-copy` (auto-deduped to `-copy-2`…), so the UI needs no dialog and no inputs.
// On success we navigate to the fork — the response carries its space/site — which both shows the
// result and (on the dashboard) leaves a route whose loader refetches the site list on return.
interface ForkedSite {
  spaceSlug: string
  siteSlug: string
  url: string
}

export function useForkSite(site: { spaceSlug: string; siteSlug: string }) {
  const navigate = useNavigate()
  const [forking, setForking] = useState(false)

  async function fork() {
    if (forking) return
    setForking(true)
    try {
      const forked = await api.post<ForkedSite>(
        `/api/sites/${site.spaceSlug}/${site.siteSlug}/fork`,
        {},
      )
      toast.success('Site forked', { description: `${forked.spaceSlug}/${forked.siteSlug}` })
      navigate(`/${forked.spaceSlug}/${forked.siteSlug}`)
    } catch (err) {
      toast.error('Could not fork site', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setForking(false)
    }
  }

  return { fork, forking }
}
