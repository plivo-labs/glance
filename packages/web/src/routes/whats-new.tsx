import { Sparkles } from 'lucide-react'
import { useEffect } from 'react'
import { type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { ReleaseBody, formatReleaseDate } from '@/components/ReleaseBody'
import { ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import { type Release, type WhatsNewList, whatsNew } from '@/lib/whatsNew'

// Full archive of release notes at /whats-new. Registered BEFORE the `:space` catch-all so the
// reserved slug resolves here, not as a space. Logged-out → /login (the API 401s, we translate it).
export async function loader({ request }: LoaderFunctionArgs): Promise<WhatsNewList> {
  try {
    return await whatsNew.list()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

export function Component() {
  const data = useLoaderData() as WhatsNewList

  // Deep-link support: after the timeline renders, scroll to #slug if the URL carries a hash.
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash) document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8 flex items-center gap-2">
        <Sparkles className="size-5 text-primary" />
        <h1 className="font-semibold text-2xl tracking-tight">What's New</h1>
      </div>
      {data.items.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground text-sm">No release notes yet.</p>
      ) : (
        <ol className="space-y-12 border-border/60 border-l pl-6">
          {data.items.map((r) => (
            <li key={r.slug} id={r.slug} className="relative scroll-mt-24">
              <span className="-left-[1.9rem] absolute top-1.5 size-2.5 rounded-full bg-primary ring-4 ring-background" />
              <ArchiveEntry release={r} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function ArchiveEntry({ release }: { release: Release }) {
  return (
    <article>
      <div className="flex items-center gap-2">
        {release.featured && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary uppercase tracking-wide">
            Featured
          </span>
        )}
        <time className="font-mono text-muted-foreground text-xs">{formatReleaseDate(release.date, 'long')}</time>
        {release.version && <span className="font-mono text-muted-foreground text-xs">· {release.version}</span>}
      </div>
      <h2 className="mt-1.5 font-semibold text-lg leading-snug">{release.title}</h2>
      {release.subtitle && <p className="mt-0.5 text-muted-foreground">{release.subtitle}</p>}
      <ReleaseBody html={release.bodyHtml} className="mt-3" />
    </article>
  )
}
