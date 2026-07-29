import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

// One avatar for every person surface (account menu, comments, notifications, activity, pickers,
// admin). The photo always comes from the same-origin proxy keyed by user id — the API holds the
// Google URL, so nothing here needs it, and any payload that carries an author/actor/uploader id
// can render a real face without that id's row being re-fetched.
//
// The 404 the proxy returns for a user with no photo IS the fallback path: Radix keeps the image
// hidden until it loads, so a miss (or an offline user, or a rotated URL) simply leaves initials.

/** First letter of the display name, else the email, else '?' — the pre-avatar behaviour. */
export function initialsOf(name?: string | null, email?: string | null): string {
  return (name || email || '?').trim().slice(0, 1).toUpperCase() || '?'
}

export function UserAvatar({
  userId,
  name,
  email,
  className,
  fallbackClassName,
}: {
  // Null when the person is unknown (a deleted author, an unattributed row) — initials only.
  userId: string | null | undefined
  name?: string | null
  email?: string | null
  className?: string
  fallbackClassName?: string
}) {
  return (
    <Avatar className={cn('size-6', className)}>
      {userId && <AvatarImage src={`/api/avatars/${userId}`} alt="" loading="lazy" />}
      <AvatarFallback className={cn('bg-primary/15 font-semibold text-[0.65rem] text-primary', fallbackClassName)}>
        {initialsOf(name, email)}
      </AvatarFallback>
    </Avatar>
  )
}
