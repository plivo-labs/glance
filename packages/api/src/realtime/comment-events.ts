import type { CommentView, ThreadView } from '../db/comments'
import { type Attached, type Partitioned, partitionAuthorized } from './site-room'

// The comments-channel fan-out policy. A comment event has neither a document `collection` nor a
// `createdBy` — canViewerRead asks about a document's creator/collection, and there is no such
// thing here — so this is deliberately NOT selectRecipients with one field renamed. It is SITE +
// EXPIRY only. CHANNEL narrowing is not this module's job either: exactly like `broadcast()`
// selects `chanTag('db')` sockets before ever calling selectRecipients, SiteRoom selects
// `chanTag('comments')` sockets before calling this — so a db-channel socket is never even a
// candidate, and this function never has to ask what channel a socket is on.
//
// No cursor: there is no comment change log and no seq to seal into one (ruled decisions 1 + 4).

/** S4's real discriminated shape: a push carries the WHOLE view — the exact ThreadView /
 *  CommentView the list route returns for the same row, built by db/comments.ts's
 *  buildThreadCreatedView / buildCommentCreatedView — never a hand-rolled second shape.
 *  `siteId` is what routes the event to the right room (matched against a socket's attachment);
 *  `filePath` is what the open rail compares against to decide whether the event is for the file
 *  it is showing. No cursor (ruled decisions 1 + 4). Only create and reply push (ruled decision
 *  5) — resolve/delete/edit have no event here. Every reaction row is empty by construction
 *  (ruled decision 2), so nothing per-viewer ever reaches this type. */
export type CommentEvent =
  | { type: 'thread.created'; siteId: string; filePath: string; thread: ThreadView }
  | { type: 'comment.created'; siteId: string; filePath: string; threadId: string; comment: CommentView }

/** Who receives one comment event. The whole policy is `partitionAuthorized`'s bar and nothing on
 *  top: every socket that clears it is delivered, because (per the note above) there is no
 *  per-document visibility question left to ask — which is exactly where this parts ways with
 *  `selectRecipients`, whose `canViewerRead` filter narrows `deliver` further. */
export function selectCommentRecipients<T extends Attached>(
  event: CommentEvent,
  sockets: T[],
  nowSec: number,
): Partitioned<T> {
  return partitionAuthorized(sockets, event.siteId, nowSec)
}
