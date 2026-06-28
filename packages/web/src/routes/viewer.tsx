import { useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import type { ViewerSite } from '@/lib/types'
import { Spinner } from '@/components/states'
import { PreviewToolbar } from '@/components/PreviewToolbar'
import { ReviewMode } from '@/components/review/ReviewMode'

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    return await api.get<ViewerSite>(`/api/sites/${params.space}/${params.site}`)
  } catch (err) {
    // 401 → sign in, returning here afterward; 403/404/410 bubble to the ErrorBoundary.
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

// Full-bleed preview by default; an opt-in review mode (split iframe + comment rail) is offered
// for non-public sites (public sites have no comments — the anonymous-spam exclusion).
export function Component() {
  const site = useLoaderData() as ViewerSite
  const [review, setReview] = useState(false)
  const canReview = site.visibility !== 'public'

  if (review && canReview) return <ReviewMode site={site} onExit={() => setReview(false)} />
  return <FullBleed site={site} onReview={canReview ? () => setReview(true) : undefined} />
}

// The site's HTML fills the entire tab — no app shell, just the floating toolbar.
function FullBleed({ site, onReview }: { site: ViewerSite; onReview?: () => void }) {
  const [loaded, setLoaded] = useState(false)

  return (
    <div className="fixed inset-0 bg-background">
      <iframe
        className="size-full border-0"
        src={site.contentUrl}
        title={site.title ?? site.siteSlug}
        onLoad={() => setLoaded(true)}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
      <PreviewToolbar site={site} onReview={onReview} />
      {!loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <Spinner className="size-6" />
          <span className="text-sm">Loading preview…</span>
        </div>
      )}
    </div>
  )
}
