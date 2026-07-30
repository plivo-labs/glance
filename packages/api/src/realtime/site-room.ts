import { type DataCapability, type DataClaims, verifyDataToken } from '../lib/data-token'
import { canViewerRead } from '../lib/data-visibility'
import type { Bindings } from '../types'
import { type ChangeEvent, toEvent } from './change-log'
import { type CommentEvent, selectCommentRecipients } from './comment-events'
import { encodeCursor } from './cursor'
export { TOKEN_HEADER } from './protocol'
import { type Channel, TOKEN_HEADER, parseChannel } from './protocol'

// ONE hibernating Durable Object per site: a pure fan-out relay that STORES NOTHING. D1 stays the
// source of truth (the change_log is already committed before a broadcast is even attempted), so
// the worst a lost room can cost a page is one push it re-fetches from the catch-up endpoint.
//
// THREE RULES KEEP THIS FREE-PLAN VIABLE, and each one is load-bearing:
//   1. Sockets are adopted with `state.acceptWebSocket()`, never `server.accept()`. An accepted
//      in-memory socket pins the object resident: 86,400s x 0.128GB = 11,059 GB-s/day — 85% of the
//      whole free daily budget, for ONE site.
//   2. NO setTimeout/setInterval anywhere on this path. A pending timer blocks hibernation and
//      silently restores rule 1's cost with nothing to show for it.
//   3. Heartbeats are answered by `setWebSocketAutoResponse` — the runtime replies without waking
//      the object, so a keepalive costs no duration at all.
// Together they mean the object is evictable between events; per-connection state therefore CANNOT
// live in module or instance variables (they vanish on hibernation) and lives in each socket's
// attachment instead, restored through `state.getWebSockets(tag)`.
//
// The class is written import-free (no `import … from 'cloudflare:workers'`): bun cannot resolve
// that specifier, and index.ts — which must re-export this class for the binding to resolve — is
// in the test import graph. `DurableObjectState`, `WebSocket`, `WebSocketPair` and
// `WebSocketRequestResponsePair` are ambient workerd globals; the last two are absent in bun, so
// tests install fakes on globalThis (the seam content.ts uses for `caches.default`).


/** Everything one connection is allowed to be, small enough to sit far under the attachment's 16KB
 *  cap. `subject` is the viewer, `owner` the site. THE BEARER TOKEN IS NEVER STORED — only this
 *  snapshot of its verified claims, so a leaked attachment cannot be replayed as a credential. */
export type SocketAuth = { subject: string; owner: string; exp: number; caps: DataCapability[] }

const siteTag = (siteId: string) => `site:${siteId}`
const viewerTag = (viewerId: string) => `viewer:${viewerId}`
const chanTag = (channel: Channel) => `chan:${channel}`

/** Project verified claims onto the snapshot — a WHITELIST, so no extra field (a token, a session)
 *  can ride along into storage just because a caller passed a wider object. */
export function encodeAttachment(auth: SocketAuth): SocketAuth {
  return { subject: auth.subject, owner: auth.owner, exp: auth.exp, caps: auth.caps }
}

/** Read a snapshot back after a hibernation cycle. Null for anything malformed or absent: an
 *  unreadable attachment is not a weaker identity, it is NO identity, and the caller closes it. */
export function decodeAttachment(raw: unknown): SocketAuth | null {
  const a = raw as SocketAuth | null
  if (!a || typeof a !== 'object') return null
  if (typeof a.subject !== 'string' || !a.subject) return null
  if (typeof a.owner !== 'string' || !a.owner) return null
  if (typeof a.exp !== 'number' || !Number.isFinite(a.exp)) return null
  if (!Array.isArray(a.caps)) return null
  return encodeAttachment(a)
}

/** Same boundary `verifyDataToken` applies (valid while `now <= exp`) — a socket must never outlive
 *  the 300s token that authorized it, and the DO has no D1 session to re-authorize with. */
export function isAttachmentExpired(auth: SocketAuth, nowSec: number): boolean {
  return nowSec > auth.exp
}

type Attached = { deserializeAttachment(): unknown }

/**
 * Who receives one event, decided from the attachment snapshots alone — PURE, so the fan-out
 * policy is testable without a socket runtime.
 *
 * A push is a SECOND READ PATH, so the question is asked of `canViewerRead` (the one policy shared
 * with the SELECT in routes/data.ts) against the DOCUMENT's creator — never re-implemented here.
 * `close` is for sockets that are no longer AUTHORIZED at all (no snapshot, past exp, or bound to
 * another site); merely being filtered out by the read policy is silent.
 */
export function selectRecipients<T extends Attached>(
  event: ChangeEvent,
  sockets: T[],
  nowSec: number,
): { deliver: { ws: T; auth: SocketAuth }[]; close: T[] } {
  const deliver: { ws: T; auth: SocketAuth }[] = []
  const close: T[] = []
  for (const ws of sockets) {
    const auth = decodeAttachment(ws.deserializeAttachment())
    // The site wall is defence in depth behind the room-name binding: one room only ever holds one
    // site's sockets, so a mismatch here means something upstream is wrong — drop the connection.
    if (!auth || isAttachmentExpired(auth, nowSec) || auth.owner !== event.siteId) {
      close.push(ws)
      continue
    }
    if (canViewerRead({ viewerId: auth.subject, caps: auth.caps }, event.collection, event.createdBy)) {
      deliver.push({ ws, auth })
    }
  }
  return { deliver, close }
}

function claimsToAuth(claims: DataClaims): SocketAuth {
  return { subject: claims.viewerId, owner: claims.siteId, exp: claims.exp, caps: claims.caps }
}

/** Closing a socket must never abort a fan-out: the peer may already be gone. */
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // already closed
  }
}

export class SiteRoom {
  constructor(
    private state: DurableObjectState,
    private env: Bindings,
  ) {}

  /** The one place the optional binding becomes a required string. `fetch` below 404s before any
   *  path that needs it, and a socket can only exist by having gone through there — so the throw
   *  states the invariant rather than a cast quietly asserting it at each use. */
  private get secret(): string {
    const s = this.env.DATA_TOKEN_SECRET
    if (!s) throw new Error('SiteRoom: DATA_TOKEN_SECRET is unset')
    return s
  }

  async fetch(req: Request): Promise<Response> {
    // Inert when the data plane is (routes/data.ts does the same): realtime is opt-in per deploy.
    if (!this.env.DATA_TOKEN_SECRET) return new Response('not found', { status: 404 })
    const { pathname } = new URL(req.url)
    if (pathname === '/broadcast' && req.method === 'POST') {
      await this.broadcast((await req.json()) as ChangeEvent)
      return new Response(null, { status: 204 })
    }
    if (pathname === '/broadcast-comment' && req.method === 'POST') {
      await this.broadcastComment((await req.json()) as CommentEvent)
      return new Response(null, { status: 204 })
    }
    if (pathname === '/subscribe') return this.subscribe(req)
    return new Response('not found', { status: 404 })
  }

  /** Adopt one subscriber. The worker has already checked this token cheaply (so junk traffic never
   *  reaches a DO), but the authority that matters is re-derived HERE, from the token itself. */
  private async subscribe(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const claims = await verifyDataToken(this.secret, req.headers.get(TOKEN_HEADER))
    if (!claims) return new Response('unauthorized', { status: 401 })
    // The room is NAMED by siteId, so its own name is the authoritative tenant wall: a token for
    // another site landing here is a full IDOR, not a routing accident. (`name` is populated for
    // every idFromName-derived id, which is the only way this class is ever addressed.)
    const name = this.state.id.name
    if (name !== undefined && name !== claims.siteId) return new Response('forbidden', { status: 403 })

    // Absent/unrecognised defaults to 'db' so the shipped client, which dials with no `channel`
    // param at all, keeps behaving exactly as it does today.
    const channel = parseChannel(new URL(req.url).searchParams.get('channel'))

    const pair = new WebSocketPair()
    const server = pair[1]
    // Tags are the only per-connection state readable WITHOUT deserializing an attachment, so they
    // carry exactly the keys a woken room selects on — including the channel, so one stream's
    // broadcast never even considers a socket subscribed to the other.
    this.state.acceptWebSocket(server, [siteTag(claims.siteId), viewerTag(claims.viewerId), chanTag(channel)])
    server.serializeAttachment(encodeAttachment(claimsToAuth(claims)))
    // Answered by the runtime itself: no wake, no duration charge, no timer.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /** The ONLY message the room understands is a re-auth: a data token lives 300s, and a page that
   *  merely listens would otherwise have its socket closed out from under it. A fresh token can
   *  only ever REFRESH the identity a socket already has — never widen or re-point it. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let msg: { type?: string; token?: string }
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    if (msg?.type !== 'auth' || typeof msg.token !== 'string') return
    const current = decodeAttachment(ws.deserializeAttachment())
    const claims = await verifyDataToken(this.secret, msg.token)
    if (!claims || !current || claims.viewerId !== current.subject || claims.siteId !== current.owner) {
      return closeQuietly(ws, 1008, 'unauthorized')
    }
    ws.serializeAttachment(encodeAttachment(claimsToAuth(claims)))
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Mirror the client's close so the peer isn't left half-open; the runtime forgets the socket.
    closeQuietly(ws, code, reason)
  }

  /** Fan out one committed change. Recipients come from `state.getWebSockets()` — the runtime's
   *  own list — so a freshly woken instance with zero memory of the past delivers identically. */
  private async broadcast(e: ChangeEvent): Promise<void> {
    // The room is NAMED by siteId (mirrors `subscribe`'s check, same reasoning: `name` is the
    // authoritative tenant identity, `undefined` for ids not derived from idFromName). A body
    // whose siteId disagrees is a MISROUTED call, not a foreign socket — every socket here already
    // belongs to this site, so treating it as "close everyone" would turn one bad caller into a
    // site-wide disconnect. Not reachable via notify.ts today (it addresses by e.siteId), but the
    // site wall exists to make exactly this safe.
    if (this.state.id.name !== undefined && this.state.id.name !== e.siteId) return
    const secret = this.secret
    // Selecting on the CHANNEL tag (not the site tag) means a comments-channel socket is never
    // even a candidate for a document event — selectRecipients' site-wall check below is defence
    // in depth behind this, not a replacement for it (the room being named by siteId already means
    // every socket here belongs to this site).
    const { deliver, close } = selectRecipients(
      e,
      this.state.getWebSockets(chanTag('db')),
      Math.floor(Date.now() / 1000),
    )
    for (const ws of close) closeQuietly(ws, 1008, 'unauthorized')

    // Byte-identical to a catch-up response, so a replayed and a pushed event are the same thing to
    // a page. The cursor is minted PER VIEWER: it seals that viewer's position, and the raw seq
    // never crosses the wire.
    const events = [toEvent(e)]
    await Promise.all(
      deliver.map(async ({ ws, auth }) => {
        const cursor = await encodeCursor(secret, { siteId: e.siteId, viewerId: auth.subject, seq: e.seq })
        try {
          // Additive only: `events`/`cursor` stay at the same keys, so dbBroker.ts's parseFrame
          // (which reads only those two and ignores unknown keys) parses this with zero changes.
          ws.send(JSON.stringify({ channel: 'db', events, cursor }))
        } catch {
          // One dead socket must never cost the rest of the site its event.
          closeQuietly(ws, 1011, 'send failed')
        }
      }),
    )
  }

  /** Fan out one comment event over the comments-channel sockets only. Selecting on `chan:comments`
   *  (not the site tag) means a db-channel socket is never even a candidate — mirroring `broadcast`'s
   *  channel narrowing above. No per-viewer cursor: there is no comment change log and no seq to
   *  seal into one. */
  private async broadcastComment(e: CommentEvent): Promise<void> {
    // Same misrouted-call guard as `broadcast` above — mirrors `subscribe`'s room-name check.
    if (this.state.id.name !== undefined && this.state.id.name !== e.siteId) return
    const { deliver, close } = selectCommentRecipients(
      e,
      this.state.getWebSockets(chanTag('comments')),
      Math.floor(Date.now() / 1000),
    )
    for (const ws of close) closeQuietly(ws, 1008, 'unauthorized')

    await Promise.all(
      deliver.map(async ({ ws }) => {
        try {
          ws.send(JSON.stringify({ channel: 'comments', siteId: e.siteId, body: e.body }))
        } catch {
          // One dead socket must never cost the rest of the site its event.
          closeQuietly(ws, 1011, 'send failed')
        }
      }),
    )
  }
}
