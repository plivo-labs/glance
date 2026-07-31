// The realtime wire constants, in one place because BOTH sides of the upgrade read them: the
// route in routes/data.ts negotiates the subprotocol, and the injected SDK in glancedb/client.ts
// offers it. A copy that drifts on one side is an upgrade that silently never connects.
//
// Deliberately dependency-free: client.ts is browser code bundled into bundle.ts, so anything it
// imports is inlined there. Keep it to constants and pure wire helpers the CLIENT could also want
// — the worker-only upgrade plumbing lives in ./upgrade.ts precisely so it never enters this
// graph. (Even a tree-shaken addition here re-mangles the minified bundle and forces a
// `bun run build:db`; the committed hash test is what catches it.)
//
// (packages/web/src/lib/dbBroker.ts keeps its own copy — a cross-package import would be the only
// api→web coupling in the repo, which is a worse trade for one string.)

/** Offered by the browser as `new WebSocket(url, [WS_PROTOCOL, token])`. Browsers cannot set
 *  `Authorization` on a WebSocket and a token in the query string lands in request logs forever,
 *  so the subprotocol list is the only channel that is neither. */
export const WS_PROTOCOL = 'glance.db.v1'

/** The upgrade credential on the worker→Durable Object hop. The worker has already validated the
 *  token cheaply (so junk never costs DO quota); the DO verifies it again, authoritatively. */
export const TOKEN_HEADER = 'x-glance-data-token'

/** One room, two independent streams: `db` (document/db events, the only stream that exists
 *  today) and `comments`. Every socket and every frame is tagged with exactly one, so a room can
 *  carry both without either leaking into the other. */
export type Channel = 'db' | 'comments'

/** Absent or unrecognised MUST resolve to `db` — the shipped client (dbBroker.ts, and the
 *  injected SDK) dials `/subscribe` with no `channel` param at all and must keep working
 *  unchanged. */
export function parseChannel(raw: string | null): Channel {
  return raw === 'comments' ? 'comments' : 'db'
}
