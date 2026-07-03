# Shared backend — `glance.db` (Phase 0 + 1)

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
- **`glance.js` SDK** (`glance-sdk.ts`, served at `/api/glance.js`) — the browser DX. Mints
  same-origin via the session, re-mints before expiry and once on a 401 (long-lived pages keep
  working across the 300s TTL). Boot global is `__GLANCE_DB__` (`__GLANCE__` belongs to the
  annotate overlay). No demo page ships — it gets rebuilt broker-side in Phase 2.
- **D1 migration** `0006_glance_documents.sql` (+ journal + harness `MIGRATIONS`).
- Feature is **opt-in per deploy**: unset `DATA_TOKEN_SECRET` → `/api/_data` is inert (404).

## P0 coverage (design-review findings → control → test)

| P0 | Control | Test |
|----|---------|------|
| 1 Confused deputy | No privileged token minted into an untrusted page; SDK/demo run on the trusted app origin (full parent-frame broker deferred, see below) | design/scope |
| 2 Token type confusion | Separate secret + `aud`/caps inside the MAC; content token can't verify as data token | `data-token.test.ts` (content-token, aud, widened-caps, tamper) |
| 3 CORS / CSRF boundary | ACAO pinned to `CONTENT_URL`, no `Allow-Credentials`, cookie ignored on the data plane | `data.test.ts` CORS; live curl (cookie-only → 401) |
| 4 Write ≠ view | `dataCapsFor` grants write to owner/superadmin only; routes gate on the `write` cap | `data.test.ts` (dataCapsFor + read-only-token → 403) |
| 5 Per-document read policy | `get`/`list` filtered by `createdBy = token.viewerId` (default per-creator) | `data.test.ts` cross-viewer isolation |
| 6 Tenant isolation (IDOR) | Every query ANDs `siteId = token.siteId`; siteId never from the body | `data.test.ts` (B's siteB token can't reach siteA) |
| 7 Mass assignment | `siteId`/`createdBy`/timestamps set from the token, never spread from the body | `data.test.ts` (spoofed body keys ignored) |
| 8 Stored-XSS amplification | No credential in the untrusted page realm (SDK runs on the trusted app origin only until the broker) | design/scope |
| 10 Live re-authorization | Every request re-runs `checkAccess` against live DB (revoked share / archived / private) | `data.test.ts` (visibility tighten → 403, archive → 410) |
| 11 Query-injection | No arbitrary filters shipped; collection/docId allowlisted; all queries drizzle-parameterized | `data.test.ts` validation; deferred filters |

## Deferred (follow-ups, called out honestly)

- **Parent-frame credential broker** (P0-1/P0-2 full form) — injecting the SDK into untrusted
  *hosted* pages requires the postMessage broker so no bearer token lives in the page. Until then
  the SDK is used from the trusted app origin only; it is NOT wired into the content worker.
- **`glance.fs` / `glance.ai`** (Phase 2/3) — with serve-time non-exec fs serving + AI quotas.
- **`glance.config.json` capability manifest** + "public-within-site" read opt-in.
- **Per-site quotas / rate-limits** (abuse controls).
- Arbitrary `list()` filters (only ship behind bound JSON paths + a field allowlist).

## Verification

- `bun run test` → 182 API tests pass (27 shared-backend: `data-token.test.ts` 9, `data.test.ts`
  16, `index.test.ts` 2), `typecheck` + `biome lint` clean.
- End-to-end on the real wrangler worker: bootstrap → create site → mint token → create/list docs;
  and negatives: no-token/garbage → 401, session-cookie-only → 401 (data plane ignores the cookie),
  CORS preflight from a foreign origin returns `Access-Control-Allow-Origin: <CONTENT_URL>` with no
  credentials.
