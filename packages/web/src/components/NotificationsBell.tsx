import { Bell } from 'lucide-react'
import { Suspense } from 'react'
import { Await, useNavigate, useRevalidator } from 'react-router'
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

// Open a notification: deep-link into the viewer's review rail, mark that one read, and refresh via
// the router revalidator.
function useOpenNotification(): (n: Notification) => void {
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  return (n) => {
    void notifications.markRead([n.id]).then(() => revalidator.revalidate())
    navigate(notificationHref(n))
  }
}

// Header bell + unread badge, fed by the root loader's DEFERRED notifications promise. Opening the
// bell marks all read; clicking an item deep-links into the viewer's review rail and marks that one
// read. Every mutation refreshes via the router revalidator (no bespoke store). Lives only on shell
// pages — the viewer route is outside AppShell, so a notification click navigates INTO the viewer.
export function NotificationsBell({ notifications: promise }: { notifications: Promise<NotificationList> }) {
  return (
    <Suspense fallback={<BellButton unread={0} />}>
      <Await resolve={promise} errorElement={<BellButton unread={0} />}>
        {(data: NotificationList) => <BellMenu data={data} />}
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

function BellMenu({ data }: { data: NotificationList }) {
  const revalidator = useRevalidator()
  const openItem = useOpenNotification()

  // Opening the bell marks everything read (decision #6). Fire-and-forget, then revalidate so the
  // badge + read styling reflect it.
  function onOpenChange(open: boolean) {
    if (open && data.unreadCount > 0) {
      void notifications.markRead().then(() => revalidator.revalidate())
    }
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
