import { Sparkles } from 'lucide-react'
import { Suspense, useState } from 'react'
import { Await, Link } from 'react-router'
import { ReleaseBody, ReleaseImage, formatReleaseDate } from '@/components/ReleaseBody'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { catchUpWhatsNew, type Release, unreadReleases, type WhatsNewList, whatsNew } from '@/lib/whatsNew'

// Header Sparkles + unread dot, next to the Bell. The root loader's DEFERRED promise seeds the FIRST
// paint via <Await> (no mount-fetch flash); from there the panel OWNS its data locally.
//
// TWO surfaces over ONE state: a dialog that raises unread releases unprompted on arrival, and the
// always-available right-side Sheet behind the Sparkles. Either one catches the user up (optimistic
// badge clear + POST /seen), mirroring the Bell's seen-on-open — so the dialog is a once-ever
// greeting, not a recurring interstitial, and the Sheet stays the way back to the full list.
// Body HTML is pre-escaped at build time — injected, never re-sanitized here.
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
  // First-run dialog: unread releases greet the user ONCE, unprompted. Seeded from the first
  // render's data and never re-raised — catchUp() zeroes the count, so nothing here can reopen it
  // (and a later Sheet open can't resurrect it either). Persistence is the server watermark the
  // dismiss writes, NOT this flag: a reload with 0 unread simply has nothing to greet with.
  const [greeting, setGreeting] = useState(() => initial.unreadCount > 0)

  // Optimistic badge clear, then persist the throughDate (mirror the Bell). A no-op when already
  // caught up, so whichever surface the user hits first is the one that spends the POST.
  function catchUp() {
    const { state, persist } = catchUpWhatsNew(data)
    setData(state)
    if (persist) void whatsNew.seen(persist).catch(() => {})
  }

  return (
    <>
      <WhatsNewDialog
        releases={unreadReleases(initial)}
        open={greeting}
        onDismiss={() => {
          setGreeting(false)
          catchUp()
        }}
      />
      <WhatsNewSheet data={data} onOpen={catchUp} />
    </>
  )
}

// The unread releases, raised once on arrival. EVERY dismissal path — the X, Esc, the backdrop,
// "Got it" — lands on the same onOpenChange(false), so there is one catch-up, not one per button.
function WhatsNewDialog({
  releases,
  open,
  onDismiss,
}: {
  releases: Release[]
  open: boolean
  onDismiss: () => void
}) {
  const many = releases.length > 1
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            What's New
          </DialogTitle>
          <DialogDescription>
            {many
              ? `${releases.length} updates since you were last here.`
              : "Here's what shipped since you were last here."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <ul className="space-y-8">
            {releases.map((r) => (
              <li key={r.slug}>
                <ReleaseEntry release={r} />
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-6 py-3">
          <Link to="/whats-new" className="font-medium text-primary text-sm hover:underline" onClick={onDismiss}>
            View all release notes
          </Link>
          <DialogClose asChild>
            <Button size="sm">Got it</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function WhatsNewSheet({ data, onOpen }: { data: WhatsNewList; onOpen: () => void }) {
  return (
    <Sheet onOpenChange={(open) => open && onOpen()}>
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
      {release.image && <ReleaseImage src={release.image} />}
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
