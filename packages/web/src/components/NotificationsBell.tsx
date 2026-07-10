import { Bell } from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { Await, useNavigate } from 'react-router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { notificationHref } from '@/lib/mentions'
import { type Notification, type NotificationList, notifications } from '@/lib/notifications'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'

// Header bell + unread badge. The root loader's DEFERRED promise seeds the FIRST paint (via <Await>,
// no mount-fetch flash); from there the Bell OWNS its data in local state — a self-contained 60s
// poll and optimistic mark-read keep it fresh. No router revalidation, so nothing else (the
// dashboard's heavy feeds) re-fetches on the Bell's account. Lives only on shell pages — the viewer
// route is outside AppShell, so a notification click navigates INTO the viewer.
export function NotificationsBell({ notifications: promise }: { notifications: Promise<NotificationList> }) {
  return (
    <Suspense fallback={<BellButton unread={0} />}>
      <Await resolve={promise} errorElement={<BellButton unread={0} />}>
        {(data: NotificationList) => <BellMenu initial={data} />}
      </Await>
    </Suspense>
  )
}

function BellButton({ unread, ...props }: { unread: number } & React.ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="icon" className="relative" aria-label="Notifications" {...props}>
      <Bell className="size-4" />
      {unread > 0 && (
        <span className="-right-0.5 -top-0.5 absolute flex min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono font-semibold text-[10px] text-primary-foreground leading-4">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Button>
  )
}

function BellMenu({ initial }: { initial: NotificationList }) {
  const navigate = useNavigate()
  const [data, setData] = useState(initial)

  // Self-contained 60s freshness: poll the list into local state. Nothing else re-fetches (the Bell
  // is the only consumer). The root loader's promise is stable for the shell's lifetime, so seeding
  // `initial` once is correct — this poll is what keeps it current.
  useEffect(() => {
    const id = window.setInterval(() => {
      void notifications.list().then(setData, () => {})
    }, 60_000)
    return () => window.clearInterval(id)
  }, [])

  // Opening the bell marks everything read (decision #6): optimistic local flip, then persist.
  function onOpenChange(open: boolean) {
    if (open && data.unreadCount > 0) {
      setData((d) => ({ items: d.items.map((n) => ({ ...n, read: true })), unreadCount: 0 }))
      void notifications.markRead().catch(() => {})
    }
  }

  // Open a notification: optimistic read + persist, then deep-link into the viewer's review rail.
  function openItem(n: Notification) {
    setData((d) => ({
      items: d.items.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
      unreadCount: n.read ? d.unreadCount : Math.max(0, d.unreadCount - 1),
    }))
    void notifications.markRead([n.id]).catch(() => {})
    navigate(notificationHref(n))
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <BellButton unread={data.unreadCount} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 font-medium text-sm">Notifications</div>
        {data.items.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted-foreground text-sm">You're all caught up.</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto py-1">
            {data.items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => openItem(n)}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent',
                    !n.read && 'bg-primary/5',
                  )}
                >
                  <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-primary')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <span className="font-medium">{n.actorName ?? 'Someone'}</span> mentioned you
                    </span>
                    {n.snippet && <span className="block truncate text-muted-foreground text-xs">{n.snippet}</span>}
                    <span className="block text-muted-foreground text-xs">
                      {n.siteLabel ?? 'a site'} · {timeAgo(n.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
