// Pure model for the annotate overlay's comment badges (slice B2b). No React, no DOM, no globals:
// it turns the latest rect batch (from the iframe's reflow protocol, see parseIntent.ts) and the
// current threads into the badge chips the overlay renders. Modeled on commentPopover.ts's
// reducer-plus-builder shape.

import type { Thread } from '@/lib/comments'
import type { DOMRectLike } from '@/lib/parseIntent'

export type AnchorRect = { id: string; rect: DOMRectLike }

export type BadgeState = {
  epoch: number
  rects: AnchorRect[]
  viewport: { width: number; height: number }
}

// One person on a chip. The id is what the overlay's avatar proxy is keyed by (a null id has no
// photo and renders initials); the name is only ever the initials fallback.
export type BadgeAuthor = { id: string | null; name: string | null }

export type Badge = {
  key: string
  top: number
  left: number
  threadIds: string[]
  authors: BadgeAuthor[]
  extra: number
  count: number
}

export function initialBadges(): BadgeState {
  // epoch -1 is below every real epoch (the client's first batch is epoch 0), so that first batch
  // always applies instead of being mistaken for a stale replay.
  return { epoch: -1, rects: [], viewport: { width: 0, height: 0 } }
}

export function stepBadges(
  state: BadgeState,
  batch: { epoch: number; rects: AnchorRect[] },
  viewport: { width: number; height: number },
): BadgeState {
  // A batch lands asynchronously; one whose epoch is behind what we've already seen describes
  // positions the DOM has since moved on from. Returning the SAME object (not a copy) lets a
  // React memo bail out instead of re-rendering with data we're discarding anyway.
  if (batch.epoch < state.epoch) return state
  // SNAPSHOT, never a merge: rects move on every scroll frame at the same epoch, so an
  // "only apply on epoch change" guard would freeze badges at their first position. And an id
  // missing from this batch (orphaned/resolved/unpainted thread) must lose its badge, which a
  // merge would prevent.
  return { epoch: batch.epoch, rects: batch.rects, viewport }
}

// A rect entirely outside the viewport box contributes no badge — a viewport of {0,0} (not
// measured yet) makes every rect "outside", which is the desired "nothing visible yet" behavior.
function offscreen(rect: DOMRectLike, viewport: { width: number; height: number }): boolean {
  return (
    rect.top + rect.height <= 0 ||
    rect.top >= viewport.height ||
    rect.left + rect.width <= 0 ||
    rect.left >= viewport.width
  )
}

// The person a thread's badge shows: its own creator, else the first non-deleted comment's author,
// else nobody (the overlay paints '?'). id and name always come from the SAME source, so a chip can
// never pair one person's photo with another person's initial.
function authorOf(thread: Thread): BadgeAuthor {
  if (thread.createdBy || thread.createdByName) return { id: thread.createdBy, name: thread.createdByName }
  const comment = thread.comments.find((c) => !c.deleted)
  return { id: comment?.authorId ?? null, name: comment?.author ?? null }
}

export function buildBadges(state: BadgeState, threads: Thread[]): Badge[] {
  const byId = new Map(threads.map((t) => [t.id, t]))

  // Rule 4 (no thread / resolved) + rule 5 (offscreen) filter before clustering, so a hidden
  // anchor never occupies a cluster slot another visible one could have merged into.
  const visible = state.rects.filter(({ id, rect }) => {
    const thread = byId.get(id)
    if (!thread || thread.status === 'resolved') return false
    return !offscreen(rect, state.viewport)
  })

  // Sort by (top, left) so the greedy merge below is deterministic and each cluster's FIRST
  // member (by this order) is unambiguous — its position is what the merged badge inherits.
  const sorted = [...visible].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)

  const clusters: AnchorRect[][] = []
  for (const anchor of sorted) {
    const prev = clusters[clusters.length - 1]
    const head = prev?.[0]
    // Overlapping anchors on one line become one chip: within 12px vertically and 24px
    // horizontally of the cluster's first member.
    if (head && Math.abs(anchor.rect.top - head.rect.top) <= 12 && Math.abs(anchor.rect.left - head.rect.left) <= 24) {
      prev.push(anchor)
    } else {
      clusters.push([anchor])
    }
  }

  return clusters.map((cluster) => {
    const first = cluster[0] as AnchorRect
    const threadIds = cluster.map((a) => a.id)
    const memberThreads = threadIds.map((id) => byId.get(id) as Thread)

    // Dedupe authors by user id, in encounter order, so the same person across threads in a cluster
    // contributes one avatar rather than one per thread. Id, not name: two different people who
    // share a display name are two faces, and only a null id falls back to grouping by name.
    const authors: BadgeAuthor[] = []
    const seen = new Set<string>()
    for (const thread of memberThreads) {
      const author = authorOf(thread)
      const key = author.id ?? author.name ?? '' // '' groups every unknown author together, like '?'
      if (seen.has(key)) continue
      seen.add(key)
      authors.push(author)
    }
    const extra = Math.max(0, authors.length - 3)

    // Skip soft-deleted comments, matching authorName's rule above — otherwise a thread whose
    // only comment was deleted still shows a count pointing at nothing readable.
    const count = memberThreads.reduce((sum, t) => sum + t.comments.filter((c) => !c.deleted).length, 0)

    return {
      // Stable across frames for the same member set, so React reuses the DOM node instead of
      // remounting it every scroll frame.
      key: threadIds.join(','),
      top: first.rect.top,
      left: first.rect.left + first.rect.width,
      threadIds,
      authors: authors.slice(0, 3),
      extra,
      count,
    }
  })
}
