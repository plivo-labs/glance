import type { CommentItem, Thread } from './comments'

// Web-side mirror of packages/api/src/realtime/comment-events.ts's CommentEvent. The repo keeps
// api and web decoupled (no cross-package imports), so this redeclares the wire shape rather than
// importing it — same reason comments.ts's Thread/CommentItem mirror ThreadView/CommentView
// instead of importing them.
export type CommentEvent =
  | { type: 'thread.created'; siteId: string; filePath: string; thread: Thread }
  | { type: 'comment.created'; siteId: string; filePath: string; threadId: string; comment: CommentItem }

/**
 * Applies one pushed comment event to the rail's thread list. PURE — no seq, no cursor: a
 * reconnect is a plain list read (ruled decision 1), so the only thing standing between "apply
 * once" and "apply twice and duplicate everything" is idempotence (ruled decision 4). Returns the
 * SAME array reference when nothing changed, because the viewer paints anchors off `threads` by
 * identity — a fresh array for an event that changed nothing would repaint the iframe for no
 * reason (requirement 6).
 */
export function applyCommentEvent(threads: Thread[], event: CommentEvent, filePath: string): Thread[] {
  // The DO room is per SITE; the rail is per FILE — an event for another open file changes nothing here.
  if (event.filePath !== filePath) return threads

  if (event.type === 'thread.created') {
    if (threads.some((t) => t.id === event.thread.id)) return threads
    // GET .../comments orders threads (filePath, createdAt, rowid) ascending, so a just-pushed
    // thread — the newest createdAt — belongs at the end, same spot a reload would put it.
    return [...threads, event.thread]
  }

  // comment.created for a thread this rail has never seen (another file, or arrived before the
  // list load) has no anchor or author to attach to — inventing a container for it would render a
  // ghost thread, so it's dropped rather than buffered.
  const idx = threads.findIndex((t) => t.id === event.threadId)
  if (idx === -1) return threads

  const thread = threads[idx]
  if (thread.comments.some((c) => c.id === event.comment.id)) return threads

  const next = threads.slice()
  next[idx] = { ...thread, comments: [...thread.comments, event.comment] }
  return next
}
