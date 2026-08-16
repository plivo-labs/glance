# Shared backend — `glance.db`

Quick-style shared backend: hosted static sites get browser-callable persistence with no keys and
no config — a per-site document store (`glance.db`) behind a dedicated server-side security spine.
Every P0 finding from the design security review is designed-in, not retrofitted.

## Enabling it

The feature is **opt-in per deploy**. Set the data-plane secret on the main worker:

```sh
cd packages/api && wrangler secret put DATA_TOKEN_SECRET
```

Unset → `/api/_data` is inert (404). The `documents` table ships with the standard D1 migrations
(`0006_glance_documents.sql`).

## How it works

- **Data-plane token** (`lib/data-token.ts`) — a capability token DISTINCT from the content/view
  token: separate secret (`DATA_TOKEN_SECRET`), and every claim (`aud`, `siteId`, `viewerId`,
  `caps`, `exp`) is inside the MAC.
- **`/api/_data`** (`routes/data.ts` → `dataApi`) — bearer-only, exact-origin CORS, its own DB,
  mounted BEFORE the `/api/*` cookie/same-origin guards. `collection().create/get/list/put/delete`
  over a generic `documents(siteId, collection, docId, json, createdBy, …)` table.
- **`/api/data-token/:space/:site`** (`dataToken`) — session-authenticated mint. The site owner
  → `read+write`; any other authorized viewer → `read`.
- **Browser SDK** (`glancedb/client.ts` → built to `glancedb/bundle.ts` via `bun run build:db`;
  served at `/api/glance.js` and `/_glance/db.js`) — two transports picked from the
  `__GLANCE_DB__` boot global: same-origin (app pages: session mint, re-mint before expiry and
  once on 401) and **broker** (hosted pages: see below). `__GLANCE__` belongs to the annotate
  overlay.
- **Parent-frame credential broker** (`web/src/lib/dbBroker.ts` + injection in `content.ts`):
  the content worker injects the SDK into gated HTML served through the app viewer; the SDK
  hands the parent a `MessagePort` (`glance:db-hello`); the viewer adopts it only from the exact
  content-origin iframe it mounted, then executes each shape-validated op with ITS token against
  `/api/_data` and answers with data only. No credential ever enters the untrusted page realm;
  the page cannot name another site (requests bind to the viewed site) or reach any other route
  (op → fixed path template).

## Security model (design-review findings → control → test)

| P0 | Control | Test |
|----|---------|------|
| 1 Confused deputy | Parent-frame broker: hosted pages get a MessagePort, never a token; parent validates origin+source+shape and binds every request to the viewed site | `dbBroker.test.ts` (spoofed origin/source, op smuggling, token never crosses) |
| 2 Token type confusion | Separate secret + `aud`/caps inside the MAC; content token can't verify as data token | `data-token.test.ts` (content-token, aud, widened-caps, tamper) |
| 3 CORS / CSRF boundary | ACAO pinned to `CONTENT_URL`, no `Allow-Credentials`, cookie ignored on the data plane | `data.test.ts` CORS; live curl (cookie-only → 401) |
| 4 Modify ≠ view | Every viewer gets `read`+`create` (attributed submissions); `write` (put/delete) is owner-only (the superadmin role grants no caps) — a viewer cannot touch any existing document | `data.test.ts` (dataCapsFor + viewer put/delete → 403) |
| 5 Per-document read policy | Default `createdBy = token.viewerId`; opt-outs: `shared-*` collections (all viewers) and `read_all` tokens (owner sees + moderates everything) | `data.test.ts` (policy v2 block) |
| 6 Tenant isolation (IDOR) | Every query ANDs `siteId = token.siteId`; siteId never from the body | `data.test.ts` (B's siteB token can't reach siteA) |
| 7 Mass assignment | `siteId`/`createdBy`/timestamps set from the token, never spread from the body | `data.test.ts` (spoofed body keys ignored) |
| 8 Stored-XSS amplification | No credential in the untrusted page realm (SDK runs on the trusted app origin only until the broker) | design/scope |
| 10 Live re-authorization | Every request re-runs `checkAccess` against live DB (revoked share / archived / private) | `data.test.ts` (visibility tighten → 403, archive → 410) |
| 11 Query-injection | No arbitrary filters shipped; collection/docId allowlisted; all queries drizzle-parameterized | `data.test.ts` validation; deferred filters |

## Known limitations

- **Standalone tabs** — a site opened directly on the content origin has no parent frame, so
  `glance.db` calls fail with a clear "open this site through the Glance app" error. By design
  for now.
- **`glance.fs` / `glance.ai`** (planned) — with serve-time non-exec fs serving + AI quotas;
  both ride the same broker channel.
- **`glance.config.json` capability manifest** (the `shared-*` naming convention covers the
  read opt-in for now); resolving `createdBy` ids to display names.
- **Per-site quotas / rate-limits** (abuse controls) not yet implemented.
- Arbitrary `list()` filters (only ship behind bound JSON paths + a field allowlist).
