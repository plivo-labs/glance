import type { Context, Env } from 'hono'
import { fireAndForget } from '../lib/events'
import type { Bindings } from '../types'
import type { ChangeEvent } from './change-log'
import type { CommentEvent } from './comment-events'
import { describeError } from '../lib/errors'

// Fan-out hop: main worker → the site's SiteRoom Durable Object. D1 stays the source of truth and
// the change_log row is already committed by the time we get here, so a failed broadcast costs a
// client one push — never a write. NOTHING here may reject into the request: the notify runs off
// ctx.waitUntil and every path is caught.

/** The DO is named by `siteId` — the value inside the verified data token — NOT by a space/slug
 *  pair, which the token does not carry and a rename would change. Same key on the write side and
 *  the subscribe side, or one site silently splits across two rooms. */
async function post(env: Bindings, path: string, e: ChangeEvent | CommentEvent): Promise<void> {
  const ns = env.SITE_ROOM
  // Optional binding: a deploy that never enabled realtime keeps writing the change_log (so a
  // later deploy can replay it) and simply never pushes.
  if (!ns) return
  const stub = ns.get(ns.idFromName(e.siteId))
  await stub.fetch(`https://site-room/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(e),
  })
}

/** Hand one committed change to the fan-out, off the response's critical path. `undefined` means
 *  the mutation wrote no log row (a delete that matched nothing, a lost put race) — there is
 *  nothing to push, and inventing an event there would be a phantom. */
export async function notifyChange<E extends Env & { Bindings: Bindings }>(
  c: Context<E>,
  e: ChangeEvent | undefined,
): Promise<void> {
  if (!e) return
  await fireAndForget(
    c,
    post(c.env, 'broadcast', e).catch((err) =>
      console.error('notify: broadcast failed', describeError(err)),
    ),
  )
}

/** Hand one comment event to the fan-out — the comment-channel analog of `notifyChange`. Same DO,
 *  same siteId key, different route, since a comment event carries no `collection` for SiteRoom
 *  to dispatch on. `undefined` means the caller has nothing to push. */
export async function notifyCommentEvent<E extends Env & { Bindings: Bindings }>(
  c: Context<E>,
  e: CommentEvent | undefined,
): Promise<void> {
  if (!e) return
  await fireAndForget(
    c,
    post(c.env, 'broadcast-comment', e).catch((err) =>
      console.error(
        'notify: broadcast-comment failed',
        describeError(err),
      ),
    ),
  )
}
