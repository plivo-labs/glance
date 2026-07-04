# Shared backend — `glance.db` (Phase 0 + 1 + broker)

Quick-style shared backend: static sites get browser-callable persistence with no keys and no
config. This PR lands the **server-side security spine + the `glance.db` document store**. It is
deliberately scoped so every P0 finding from the design security review is designed-in from the
first commit — not retrofitted.

## What ships

- **Data-plane token** (`lib/data-token.ts`) — a capability token DISTINCT from the content/view
  token: separate secret (`DATA_TOKEN_SECRET`), and every claim (`aud`, `siteId`, `viewerId`,
  `caps`, `exp`) is inside the MAC.
- **`/api/_data`** (`routes/data.ts` → `dataApi`) — bearer-only, exact-origin CORS, its own DB,
  mounted BEFORE the `/api/*` cookie/same-origin guards. `collection().create/get/list/put/delete`
  over a generic `documents(siteId, collection, docId, json, createdBy, …)` table.
- **`/api/data-token/:space/:site`** (`dataToken`) — session-authenticated mint. Owner/superadmin
  → `read+write`; any other authorized viewer → `read`.
- **Browser SDK** (`glancedb/client.ts` → built to `glancedb/bundle.ts` via `bun run build:db`;
  served at `/api/glance.js` and `/_glance/db.js`) — two transports picked from the
  `__GLANCE_DB__` boot global: same-origin (app pages: session mint, re-mint before expiry and
  once on 401) and **broker** (hosted pages: see below). `__GLANCE__` belongs to the annotate
  overlay.
- **Parent-frame credential broker** (P0-1's full fix — `web/src/lib/dbBroker.ts` + injection in
  `content.ts`): the content worker injects the SDK into gated HTML served through the app
  viewer; the SDK hands the parent a `MessagePort` (`glance:db-hello`); the viewer adopts it only
  from the exact content-origin iframe it mounted, then executes each shape-validated op with
  ITS token against `/api/_data` and answers with data only. No credential ever enters the
  untrusted page realm; the page cannot name another site (requests bind to the viewed site) or
  reach any other route (op → fixed path template).
- **D1 migration** `0006_glance_documents.sql` (+ journal + harness `MIGRATIONS`).
- Feature is **opt-in per deploy**: unset `DATA_TOKEN_SECRET` → `/api/_data` is inert (404).

## P0 coverage (design-review findings → control → test)

| P0 | Control | Test |
|----|---------|------|
| 1 Confused deputy | Parent-frame broker: hosted pages get a MessagePort, never a token; parent validates origin+source+shape and binds every request to the viewed site | `dbBroker.test.ts` (spoofed origin/source, op smuggling, token never crosses) |
| 2 Token type confusion | Separate secret + `aud`/caps inside the MAC; content token can't verify as data token | `data-token.test.ts` (content-token, aud, widened-caps, tamper) |
| 3 CORS / CSRF boundary | ACAO pinned to `CONTENT_URL`, no `Allow-Credentials`, cookie ignored on the data plane | `data.test.ts` CORS; live curl (cookie-only → 401) |
| 4 Modify ≠ view | Every viewer gets `read`+`create` (attributed submissions); `write` (put/delete) is owner/superadmin-only — a viewer cannot touch any existing document | `data.test.ts` (dataCapsFor + viewer put/delete → 403) |
| 5 Per-document read policy | Default `createdBy = token.viewerId`; opt-outs: `shared-*` collections (all viewers) and `read_all` tokens (owner sees + moderates everything) | `data.test.ts` (policy v2 block) |
| 6 Tenant isolation (IDOR) | Every query ANDs `siteId = token.siteId`; siteId never from the body | `data.test.ts` (B's siteB token can't reach siteA) |
| 7 Mass assignment | `siteId`/`createdBy`/timestamps set from the token, never spread from the body | `data.test.ts` (spoofed body keys ignored) |
| 8 Stored-XSS amplification | No credential in the untrusted page realm (SDK runs on the trusted app origin only until the broker) | design/scope |
| 10 Live re-authorization | Every request re-runs `checkAccess` against live DB (revoked share / archived / private) | `data.test.ts` (visibility tighten → 403, archive → 410) |
| 11 Query-injection | No arbitrary filters shipped; collection/docId allowlisted; all queries drizzle-parameterized | `data.test.ts` validation; deferred filters |

## Deferred (follow-ups, called out honestly)

- **Standalone tabs** — a site opened directly on the content origin has no parent frame, so
  `glance.db` calls fail with a clear "open this site through the Glance app" error. By design
  for now.
- **`glance.fs` / `glance.ai`** (Phase 2/3) — with serve-time non-exec fs serving + AI quotas;
  both ride the same broker channel.
- **`glance.config.json` capability manifest** (the `shared-*` naming convention covers the
  read opt-in for now); resolving `createdBy` ids to display names.
- **Per-site quotas / rate-limits** (abuse controls).
- Arbitrary `list()` filters (only ship behind bound JSON paths + a field allowlist).

## Verification

- `bun run test` → 182 API tests pass (27 shared-backend: `data-token.test.ts` 9, `data.test.ts`
  16, `index.test.ts` 2), `typecheck` + `biome lint` clean.
- End-to-end on the real wrangler worker: bootstrap → create site → mint token → create/list docs;
  and negatives: no-token/garbage → 401, session-cookie-only → 401 (data plane ignores the cookie),
  CORS preflight from a foreign origin returns `Access-Control-Allow-Origin: <CONTENT_URL>` with no
  credentials.
