// The worker-side half of a WebSocket upgrade, shared by every route that relays a socket to a
// SiteRoom (routes/data.ts's /_sync/socket and routes/comments.ts's comments socket). Both read
// the same offer and both re-issue the same 101, so it is one implementation rather than a copy
// per route.
//
// Split out of ./protocol.ts on purpose: that module is in glancedb/client.ts's import graph and
// is inlined into the committed browser bundle, so anything added there churns the bundle hash.
// None of this is browser code.

import type { Context } from 'hono'
import { WS_PROTOCOL } from './protocol'

/** True when the request is a genuine WebSocket upgrade. */
export const isUpgrade = (c: Context): boolean => c.req.header('Upgrade')?.toLowerCase() === 'websocket'

/** The subprotocol list a browser offered, in the order it offered them. Browsers cannot set
 *  `Authorization` on `new WebSocket()` and a token in the query string is written to Cloudflare's
 *  request logs forever, so this list is also where the data plane's upgrade carries its
 *  credential — `new WebSocket(url, [WS_PROTOCOL, token])`. */
export const subprotocols = (c: Context): string[] => {
  const raw = c.req.header('Sec-WebSocket-Protocol')
  return raw ? raw.split(',').map((p) => p.trim()) : []
}

/** Re-issue a Durable Object's 101 to the browser rather than passing it through: a subrequest
 *  response's headers are IMMUTABLE, and the subprotocol offer is negotiated by the worker (the DO
 *  never sees it). A client that offered a subprotocol closes the connection unless the 101 picks
 *  one — so the header goes on here, and only when the offer actually contained ours. */
export function reissueUpgrade(c: Context, res: Response): Response {
  const negotiated = res.status === 101 && subprotocols(c).includes(WS_PROTOCOL)
  return new Response(null, {
    status: res.status,
    webSocket: res.webSocket,
    headers: negotiated ? { 'Sec-WebSocket-Protocol': WS_PROTOCOL } : {},
  })
}
