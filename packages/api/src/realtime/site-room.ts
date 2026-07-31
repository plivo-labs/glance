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

/** How long one `typing` ping keeps an indicator alive on the receiving page. It rides the wire as
 *  an ABSOLUTE `expiresAt` so the receiver forgets it on its own clock — the room schedules nothing
 *  (rule 2). Longer than the send cap the composer will apply, or a viewer who never stops typing
 *  would flicker between pings. */
const TYPING_TTL_MS = 20_000

/** The composer caps itself at one ping per 15s per thread — but that cap lives in the BROWSER, and
 *  any authenticated viewer skips it from devtools. This is the abuse floor on the server side: one
 *  inbound typing frame per socket per 500ms. No human composer reaches it (a ping, a stop, then a
 *  ping on another thread is still three distinct half-seconds), and it turns a devtools flood from
 *  "N sends per keystroke, forever" into a rounding error. A MAP, not a timer — rule 2 stands, and
 *  hibernation clearing it is harmless: a socket flooding this room is what keeps the room awake. */
const TYPING_FLOOR_MS = 500
/** A threadId is echoed verbatim to every peer, so its size is multiplied by the size of the room.
 *  Real ones are UUIDs; this only has to be small enough that a megabyte cannot be amplified. */
const MAX_THREAD_ID = 64

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

export type Attached = { deserializeAttachment(): unknown }
export type Partitioned<T> = { deliver: { ws: T; auth: SocketAuth }[]; close: T[] }

/**
 * The AUTHORIZATION bar every fan-out on this object applies first — PURE, decided from the
 * attachment snapshots alone, so the policy is testable without a socket runtime.
 *
 * `close` is for sockets that are no longer AUTHORIZED at all: no readable snapshot, past exp, or
 * bound to another site. The site wall is defence in depth behind the room-name binding — one room
 * only ever holds one site's sockets, so a mismatch here means something upstream is wrong and the
 * connection is dropped rather than quietly skipped.
 *
 * Everything a caller adds on top is a VISIBILITY question, and visibility is silent: a socket the
 * caller then filters out of `deliver` is skipped, never closed. That split is why this is shared
 * by all three fan-outs (documents, comments, typing) while each keeps its own policy.
 */
export function partitionAuthorized<T extends Attached>(sockets: T[], siteId: string, nowSec: number): Partitioned<T> {
  const deliver: { ws: T; auth: SocketAuth }[] = []
  const close: T[] = []
  for (const ws of sockets) {
    const auth = decodeAttachment(ws.deserializeAttachment())
    if (!auth || isAttachmentExpired(auth, nowSec) || auth.owner !== siteId) close.push(ws)
    else deliver.push({ ws, auth })
  }
  return { deliver, close }
}

/**
 * Who receives one document event.
 *
 * A push is a SECOND READ PATH, so the question is asked of `canViewerRead` (the one policy shared
 * with the SELECT in routes/data.ts) against the DOCUMENT's creator — never re-implemented here.
 * That predicate is a VISIBILITY filter, so it only ever narrows `deliver`; `partitionAuthorized`
 * above owns the close-vs-skip line.
 */
export function selectRecipients<T extends Attached>(event: ChangeEvent, sockets: T[], nowSec: number): Partitioned<T> {
  const { deliver, close } = partitionAuthorized(sockets, event.siteId, nowSec)
  return {
    deliver: deliver.filter(({ auth }) =>
      canViewerRead({ viewerId: auth.subject, caps: auth.caps }, event.collection, event.createdBy),
    ),
    close,
  }
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
  /** When each socket last got a typing frame past the abuse floor. In MEMORY, deliberately: it
   *  stores nothing, schedules nothing, and an eviction that clears it can only happen once the
   *  room has been idle — which is exactly when there is no flood to throttle. */
  private lastTyping = new WeakMap<WebSocket, { at: number; stopped: boolean }>()

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

  /** TWO messages, each recognised by its own full-shape guard so a second known type never turns
   *  the handler into a default-allow: anything that matches neither still falls through to a
   *  no-op. `typing` is fan-out only (below); `auth` is a re-auth — a data token lives 300s, and a
   *  page that merely listens would otherwise have its socket closed out from under it. A fresh
   *  token can only ever REFRESH the identity a socket already has — never widen or re-point it. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let msg: { type?: string; token?: string; threadId?: string }
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    // A stop is the SAME fan-out with an already-elapsed expiry. The receiver's clock is the only
    // clock this feature has (rule 2 — no timer in this object), so the only way to say "stop" is to
    // say "the ping you are holding is over". Without this branch the client's stop frame wakes the
    // room and changes nothing, which is precisely the cost the rate cap exists to avoid.
    if ((msg?.type === 'typing' || msg?.type === 'typing.stop') && typeof msg.threadId === 'string') {
      if (msg.threadId.length > MAX_THREAD_ID) return
      const stop = msg.type === 'typing.stop'
      const last = this.lastTyping.get(ws)
      const now = Date.now()
      // A STOP is not rate-limited by the clock — a viewer who types and blurs 200ms later must not
      // leave a stale "…is replying" up for the full 20s TTL. It is limited by the PING instead:
      // one stop per ping that actually went out, and it does not reopen the ping's window. So the
      // most a socket can put on the wire is one ping plus one stop per floor interval.
      // Dropped SILENTLY in either case, never closed: a burst is as likely to be a wedged client
      // as an attacker, and closing would only hand it a redial loop.
      if (stop) {
        if (!last || last.stopped) return
        // Keeps the PING's timestamp, so a stop cannot reopen the window: ping/stop/ping/stop would
        // otherwise walk straight through the floor forever.
        this.lastTyping.set(ws, { at: last.at, stopped: true })
      } else {
        if (last && now - last.at < TYPING_FLOOR_MS) return
        this.lastTyping.set(ws, { at: now, stopped: false })
      }
      return this.fanOutTyping(ws, msg.threadId, stop)
    }
    if (msg?.type !== 'auth' || typeof msg.token !== 'string') return
    const current = decodeAttachment(ws.deserializeAttachment())
    const claims = await verifyDataToken(this.secret, msg.token)
    if (!claims || !current || claims.viewerId !== current.subject || claims.siteId !== current.owner) {
      return closeQuietly(ws, 1008, 'unauthorized')
    }
    ws.serializeAttachment(encodeAttachment(claimsToAuth(claims)))
  }

  /** Fan out one "still typing" ping to the OTHER comments-channel sockets on this site. It STORES
   *  NOTHING and logs nothing — the frame is the whole feature, and a ping nobody is around to
   *  receive simply evaporates.
   *
   *  Attribution is read from the socket's ATTACHMENT — the subject this DO verified at upgrade and
   *  re-verifies on every re-auth. Nothing but `threadId` is ever read out of the payload: a
   *  client-supplied viewer id would make "Riya is replying…" claimable by anyone with a socket. */
  private fanOutTyping(ws: WebSocket, threadId: string, stop = false): void {
    const now = Date.now()
    const nowSec = Math.floor(now / 1000)
    const auth = decodeAttachment(ws.deserializeAttachment())
    // The same boundary the `auth` path enforces: an expired (or unreadable) attachment is not a
    // weaker identity, it is NO identity — so the ping is dropped and the socket goes.
    if (!auth || isAttachmentExpired(auth, nowSec)) {
      closeQuietly(ws, 1008, 'unauthorized')
      return
    }

    // Viewer-independent, so it is built ONCE — there is no cursor and nothing per-recipient here.
    const frame = JSON.stringify({
      channel: 'comments',
      type: 'typing',
      viewerId: auth.subject,
      threadId,
      // `0`, not `now`: an already-elapsed expiry is what a stop IS, and a constant makes it
      // unambiguous on the receiving side rather than a millisecond race with the receiver's clock.
      expiresAt: stop ? 0 : now + TYPING_TTL_MS,
    })
    // Selecting on the CHANNEL tag exactly like `broadcastComment`: a `chan:db` socket is never
    // even a candidate for a comments frame. The sender is filtered out before the partition — it
    // already knows it is typing, and echoing back would only make the rail filter its own id out.
    // Everything past that is the SAME authorization bar the two broadcasts apply, run by the same
    // `partitionAuthorized`: a socket no longer authorized at all is disconnected, not skipped.
    const peers = this.state.getWebSockets(chanTag('comments')).filter((peer) => peer !== ws)
    const { deliver, close } = partitionAuthorized(peers, auth.owner, nowSec)
    for (const peer of close) closeQuietly(peer, 1008, 'unauthorized')
    for (const { ws: peer } of deliver) {
      try {
        peer.send(frame)
      } catch {
        // One dead socket must never cost the rest of the site its frame.
        closeQuietly(peer, 1011, 'send failed')
      }
    }
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
          // e's own fields (type/siteId/filePath/thread|comment) ride the wire unchanged — S4's
          // CommentEvent IS the wire shape now, so there's no separate `body` wrapper to build.
          ws.send(JSON.stringify({ channel: 'comments', ...e }))
        } catch {
          // One dead socket must never cost the rest of the site its event.
          closeQuietly(ws, 1011, 'send failed')
        }
      }),
    )
  }
}
