import { Sparkles } from 'lucide-react'
import { Suspense, useState } from 'react'
import { Await, Link } from 'react-router'
import { ReleaseBody, formatReleaseDate } from '@/components/ReleaseBody'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { openWhatsNew, type Release, type WhatsNewList, whatsNew } from '@/lib/whatsNew'

// Header Sparkles + unread dot, next to the Bell. The root loader's DEFERRED promise seeds the FIRST
// paint via <Await> (no mount-fetch flash); from there the panel OWNS its data locally. Opening the
// right-side Sheet catches the user up (optimistic badge clear + POST /seen), mirroring the Bell's
// seen-on-open. Body HTML is pre-escaped at build time — injected, never re-sanitized here.
export function WhatsNewButton({ whatsNew: promise }: { whatsNew: Promise<WhatsNewList> }) {
  return (
    <Suspense fallback={<SparkButton unread={0} />}>
      <Await resolve={promise} errorElement={<SparkButton unread={0} />}>
        {(data: WhatsNewList) => <WhatsNewPanel initial={data} />}
      </Await>
    </Suspense>
  )
}

function SparkButton({ unread, ...props }: { unread: number } & React.ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="icon" className="relative" aria-label="What's New" {...props}>
      <Sparkles className="size-4" />
      {unread > 0 && (
        <span className="-right-0.5 -top-0.5 absolute size-2 rounded-full bg-primary ring-2 ring-background" />
      )}
    </Button>
  )
}

function WhatsNewPanel({ initial }: { initial: WhatsNewList }) {
  const [data, setData] = useState(initial)

  // Seen-on-open (mirror the Bell): optimistic badge clear, then persist the throughDate. A no-op
  // when already caught up. Closing does nothing.
  function onOpenChange(open: boolean) {
    if (!open) return
    const { state, persist } = openWhatsNew(data)
    setData(state)
    if (persist) void whatsNew.seen(persist).catch(() => {})
  }

  return (
    <Sheet onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <SparkButton unread={data.unreadCount} />
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            What's New
          </SheetTitle>
          <SheetDescription className="sr-only">Recent Glance product updates and release notes.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {data.items.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground text-sm">Nothing new yet — check back soon.</p>
          ) : (
            <ul className="space-y-8">
              {data.items.map((r) => (
                <li key={r.slug}>
                  <ReleaseEntry release={r} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t px-5 py-3 text-center">
          <Link to="/whats-new" className="font-medium text-primary text-sm hover:underline">
            View all release notes
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ReleaseEntry({ release }: { release: Release }) {
  return (
    <article>
      <div className="flex items-center gap-2">
        {release.featured && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary uppercase tracking-wide">
            Featured
          </span>
        )}
        <time className="font-mono text-muted-foreground text-xs">{formatReleaseDate(release.date)}</time>
      </div>
      <h3 className="mt-1.5 font-semibold text-base leading-snug">{release.title}</h3>
      {release.subtitle && <p className="mt-0.5 text-muted-foreground text-sm">{release.subtitle}</p>}
      <ReleaseBody html={release.bodyHtml} className="mt-2 text-sm" />
    </article>
  )
}
