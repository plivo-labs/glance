import { useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import type { ViewerSite } from '@/lib/types'
import { Spinner } from '@/components/states'

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    return await api.get<ViewerSite>(`/api/sites/${params.space}/${params.site}`)
  } catch (err) {
    // 401 → sign in, returning here afterward; 403/404/410 bubble to the ErrorBoundary.
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

// Full-bleed preview: the site's HTML fills the entire tab — no app shell, no toolbar.
// Reached only by opening in a new tab from the dashboard / space / command palette.
export function Component() {
  const site = useLoaderData() as ViewerSite
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
      {!loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <Spinner className="size-6" />
          <span className="text-sm">Loading preview…</span>
        </div>
      )}
    </div>
  )
}
