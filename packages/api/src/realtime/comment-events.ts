import { type SocketAuth, decodeAttachment, isAttachmentExpired } from './site-room'

// The comments-channel fan-out policy. A comment event has neither a document `collection` nor a
// `createdBy` — canViewerRead asks about a document's creator/collection, and there is no such
// thing here — so this is deliberately NOT selectRecipients with one field renamed. It is SITE +
// EXPIRY only. CHANNEL narrowing is not this module's job either: exactly like `broadcast()`
// selects `chanTag('db')` sockets before ever calling selectRecipients, SiteRoom selects
// `chanTag('comments')` sockets before calling this — so a db-channel socket is never even a
// candidate, and this function never has to ask what channel a socket is on.
//
// No cursor: there is no comment change log and no seq to seal into one (ruled decisions 1 + 4).

/** The payload a later slice fills in with real comment fields (thread, author, text, ...). For
 *  now: just enough to route the event — `siteId` to match against a socket's attachment, and an
 *  opaque `body` carried through to the wire unchanged. */
export type CommentEvent = { siteId: string; body: unknown }

type Attached = { deserializeAttachment(): unknown }

/**
 * Who receives one comment event, decided from the attachment snapshots alone — PURE, mirroring
 * `selectRecipients`' close-vs-skip shape exactly (`close` for a socket that is no longer
 * AUTHORIZED at all: no snapshot, past exp, or bound to another site). Unlike `selectRecipients`,
 * every socket that clears that bar is delivered — there is no per-document visibility question
 * left to ask.
 */
export function selectCommentRecipients<T extends Attached>(
  event: CommentEvent,
  sockets: T[],
  nowSec: number,
): { deliver: { ws: T; auth: SocketAuth }[]; close: T[] } {
  const deliver: { ws: T; auth: SocketAuth }[] = []
  const close: T[] = []
  for (const ws of sockets) {
    const auth = decodeAttachment(ws.deserializeAttachment())
    if (!auth || isAttachmentExpired(auth, nowSec) || auth.owner !== event.siteId) {
      close.push(ws)
      continue
    }
    deliver.push({ ws, auth })
  }
  return { deliver, close }
}
