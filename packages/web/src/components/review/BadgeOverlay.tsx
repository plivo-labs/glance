import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar'
import { UserAvatar } from '@/components/UserAvatar'
import type { Badge } from '@/lib/badges'

// Slice B2c — paints the badges lib/badges computes. A dumb renderer: every prop already carries
// the shape to draw (position, authors, count), so this owns zero state and no measuring.
//
// MOUNT POINT IS LOAD-BEARING, same as CommentPopover: a sibling of the iframe inside the SAME
// `relative h-full w-full` wrapper, so a rect the frame reports needs no translation.
//
// The ROOT must stay pointer-events:none — it spans the whole iframe box, and without this it
// would eat every click meant for the page underneath it. Only the individual chip buttons opt
// back in with pointer-events-auto, so just the badges themselves are clickable.
//
// B3b: `onHoverChange` reports THIS chip's own threadIds on pointerenter/focus and [] on
// pointerleave/blur — never a union across chips. Focus counts as hover so the affordance isn't
// mouse-only (a rail-card click's own highlight is wired by the caller, not here). BadgeOverlay
// itself paints nothing for this — it only reports the hover set up to whoever asked for it.
// Drop the chip below its line instead of centring it ON the text: sitting on the baseline it
// covered the words right after the quote. Presentation only — lib/badges keeps reporting the
// anchor's own top, which is what the offscreen and cluster rules are written against.
const NUDGE_Y = 8

export function BadgeOverlay({
  badges,
  onOpen,
  onHoverChange,
}: {
  badges: Badge[]
  onOpen: (threadIds: string[]) => void
  onHoverChange: (threadIds: string[]) => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {badges.map((badge) => (
        <button
          key={badge.key}
          type="button"
          aria-label={`Open comments (${badge.count})`}
          onClick={() => onOpen(badge.threadIds)}
          onPointerEnter={() => onHoverChange(badge.threadIds)}
          onPointerLeave={() => onHoverChange([])}
          onFocus={() => onHoverChange(badge.threadIds)}
          onBlur={() => onHoverChange([])}
          style={{ top: badge.top + NUDGE_Y, left: badge.left }}
          className="pointer-events-auto absolute inline-flex items-center gap-1.5 rounded-full border bg-popover py-0.5 pr-2 pl-0.5 font-medium text-popover-foreground text-xs shadow-md hover:bg-accent"
        >
          {/* The photo is same-origin (/api/avatars/:id, see UserAvatar) — an author with no photo,
              or none at all, degrades to initials without the chip changing shape. */}
          {/* Sized like the rail's own avatars (size-5), and the group's default 8px overlap and
              2px ring are scaled to match — at this size they'd swallow the initial under the next
              circle. The chip sits ON the page's text, so every pixel of width hides content. */}
          <AvatarGroup className="-space-x-1.5 *:data-[slot=avatar]:ring-1">
            {badge.authors.map((author) => (
              <UserAvatar
                key={author.id ?? author.name ?? '?'}
                userId={author.id}
                name={author.name}
                className="size-5"
                fallbackClassName="text-[0.6rem]"
              />
            ))}
            {badge.extra > 0 && (
              <AvatarGroupCount className="size-5 text-[0.6rem] ring-1">+{badge.extra}</AvatarGroupCount>
            )}
          </AvatarGroup>
          <span className="text-muted-foreground">{badge.count}</span>
        </button>
      ))}
    </div>
  )
}
