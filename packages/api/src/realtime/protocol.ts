// The realtime wire constants, in one place because BOTH sides of the upgrade read them: the
// route in routes/data.ts negotiates the subprotocol, and the injected SDK in glancedb/client.ts
// offers it. A copy that drifts on one side is an upgrade that silently never connects.
//
// Deliberately dependency-free: client.ts is browser code bundled into bundle.ts, so anything it
// imports is inlined there.
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
