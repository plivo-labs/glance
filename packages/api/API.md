# Glance HTTP API

The HTTP control plane. Every endpoint below is callable with an **API key** (`glk_…`) minted from
`/settings/keys`.

Base URL is your instance origin (`https://glance.<your-subdomain>.workers.dev` by default).
All request and response bodies are JSON unless noted; the one exception is
[deploy](#deploy-files), which is `multipart/form-data`.

> Looking for the `glance` CLI instead? See the [README](../../README.md#cli). The CLI is a client
> of this API, not part of its contract — nothing here requires it.

- [Authentication](#authentication)
- [What a key may do](#what-a-key-may-do)
- [API keys](#api-keys)
- [Sites](#sites)
- [Deploy files](#deploy-files)
- [Spaces](#spaces)
- [Data tokens (glance.db)](#data-tokens-glancedb)
- [Errors](#errors)

---

## Authentication

Send the key as a bearer token:

```bash
curl -H "Authorization: Bearer $GLANCE_TOKEN" https://your-instance/api/sites/mine
```

Three credential kinds reach these routes, and the server records *which* one authenticated a
request. The [grant limits](#what-a-key-may-do) apply to API keys only:

| Credential | Presented as | Governed by |
| --- | --- | --- |
| API key | `Authorization: Bearer glk_…` | Ownership **and** its grants |
| Device token | `Authorization: Bearer <uuid>` | Ownership alone |
| Browser session | `__Host-glance_session` cookie | Ownership alone; unsafe methods also require same-origin (CSRF) |

A `glk_`-prefixed bearer is dispatched to the key store and never falls through to the device-token
store, or the reverse — an invalid key is `401`, not a retry against the other store.

`POST /api/auth/logout` is a *session* verb: it destroys a browser session and revokes a device
token. Presented with an API key it returns `400 not_a_session` — a key is revoked with
[`DELETE /api/api-keys/:id`](#delete-apiapi-keysid--revoke), not by logging out.

## What a key may do

A key carries a `grants` object fixed at mint time. It can only ever *narrow* what you can already
do — a key never grants access you don't have.

```jsonc
{
  "control": true,          // may change control-plane state (deploy, create, fork, move, share)
  "data": {                 // or null — null means the key cannot mint data tokens at all
    "scope": { "kind": "all-owned" },        // or { "kind": "sites", "siteIds": ["…"] }
    "caps": ["read"]                          // ceiling on a minted data token
  }
}
```

Without `control: true`, every `POST`/`PUT`/`PATCH`/`DELETE` on the control plane is `403`; reads
still work, which is what a data-only key needs to resolve a site before minting a token.

Two things are refused for **every** key regardless of grants:

| Operation | Result | Why |
| --- | --- | --- |
| `DELETE /api/sites/:space/:site` | `403` | A key may create and deploy sites, not destroy them. |
| `POST` / `DELETE` on `/api/api-keys` | `403` | A leaked key must not mint a successor or revoke your other keys. |

> **Caveat — space deletion is not covered by that rule.** `DELETE /api/spaces/:slug` carries no
> key check, so a key with `control: true` can delete a **group space it created**, which hard-
> destroys every site inside it. Personal spaces are protected (`403`), and the delete is refused
> with `409` if the space holds sites owned by other members — but your own sites in your own
> group space can be erased this way despite the per-site rule above. Scope keys accordingly.

A key may also **list** your keys (`GET /api/api-keys`) — names, grants, expiries and
`glk_…abcd` hints, never a secret or hash.

## API keys

Mounted at `/api/api-keys`. Every route is scoped to the caller's own keys; there is no
surface for managing anyone else's.

### `POST /api/api-keys` — mint

Session or CLI token only (`403` for a key credential).

```jsonc
// request
{
  "name": "CI deploy bot",           // required, ≤200 chars
  "expiresInDays": 30,               // required, one of 1 | 7 | 30 | 90 | 180 | 365
  "grants": { "control": true, "data": null }
}
```

```jsonc
// 201, Cache-Control: no-store
{
  "id": "…",
  "name": "CI deploy bot",
  "secret": "glk_…",                 // shown EXACTLY ONCE — only its hash is stored
  "grants": { "control": true, "data": null },
  "createdAt": "2026-07-31T10:16:21.208Z",
  "expiresAt": "2026-08-30T10:16:21.208Z"
}
```

`expiresAt` is always derived server-side from `expiresInDays`; an `expiresAt` in the request body
is ignored outright. Ten **active** keys per user (`400` beyond that) — revoked and expired keys are
tombstones and don't count, so revoking one frees a slot immediately.

### `GET /api/api-keys` — list

```jsonc
{
  "items": [{
    "id": "…",
    "name": "CI deploy bot",
    "grants": { "control": true, "data": null },
    "createdAt": "…", "expiresAt": "…",
    "revokedAt": null,                // set once revoked; the row is kept, not deleted
    "lastUsedAt": "…",                // touched at most hourly, not per request
    "secretHint": "glk_…6HJQ"         // last 4 chars only
  }]
}
```

### `DELETE /api/api-keys/:id` — revoke

Session or CLI token only (`403` for a key credential). Idempotent — revoking an already-revoked
key still succeeds. A key that isn't yours is `404`, not `403`, so ids can't be probed.

```jsonc
{ "revoked": true }
```

A revoked key stops authenticating immediately. One documented exception: a
[data token](#data-tokens-glancedb) the key already minted keeps working for the remainder of its
≤300s life, because that token is a self-contained signed credential and not a lookup against the key.

## Sites

`requireAuth` on all; the ones marked ✱ additionally need `control: true` on a key.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/sites` ✱ | Create an empty site record |
| `GET` | `/api/sites/mine` | Sites you own, newest first |
| `GET` | `/api/sites/shared` | Sites shared with you |
| `GET` | `/api/sites/team` | Team feed |
| `GET` | `/api/sites/search?q=` | Search |
| `GET` | `/api/sites/:space/:site` | Viewer metadata + a token-gated content URL |
| `GET` | `/api/sites/:space/:site/exists` | Slug-conflict probe |
| `GET` | `/api/sites/:space/:site/shares` | Current shares |
| `PUT` | `/api/sites/:space/:site/shares` ✱ | Replace shares |
| `PATCH` | `/api/sites/:space/:site` ✱ | Rename / change visibility |
| `POST` | `/api/sites/:space/:site/move` ✱ | Move to another space |
| `POST` | `/api/sites/:space/:site/fork` ✱ | Fork |
| `DELETE` | `/api/sites/:space/:site` | Delete — **always `403` for a key** |

```jsonc
// POST /api/sites
{ "spaceSlug": "sam", "siteSlug": "q3-metrics", "title": "Q3 Metrics", "visibility": "private" }
// 201
{ "id": "…", "spaceSlug": "sam", "siteSlug": "q3-metrics", "url": "https://your-instance/sam/q3-metrics" }
```

`siteSlug` must be a valid slug and not a reserved word (`docs` among them, which is broader than
the space-level collision that motivated it — a site literally named `docs` is rejected `400`).
Visibility is `private`, `team`, or a share list; there is no public tier — every viewer needs a login.

## Deploy files

```
POST /api/upload/:spaceSlug/:siteSlug        multipart/form-data      ✱ control grant
```

| Field | Notes |
| --- | --- |
| `files` | Repeated. Each file's name is its in-site path. ≤20MB each, ≤200 files. |
| `visibility` | Optional. Create defaults to `team`; on replace, omitting it keeps the current tier. |
| `title` | Optional display title. Never renames an already-titled site on replace. |
| `expectedVersion` | The `contentVersion` you last read. Required for an **editor** replace (optimistic concurrency); advisory for the owner. |

```jsonc
// 200
{ "url": "https://your-instance/sam/q3-metrics", "siteSlug": "q3-metrics", "fileCount": 3, "contentVersion": 4 }
```

`409 {"conflict": true}` on a version conflict or an unexpected create-vs-replace mismatch;
`413` if a file exceeds 20MB; `429` if the per-IP rate limit (10/60s) trips.

```bash
curl -X POST "https://your-instance/api/upload/sam/q3-metrics" \
  -H "Authorization: Bearer $GLANCE_TOKEN" \
  -F "files=@dist/index.html;filename=index.html" \
  -F "files=@dist/app.js;filename=app.js" \
  -F "visibility=team"
```

## Spaces

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/spaces` ✱ | Create a group space |
| `GET` | `/api/spaces/mine` | Spaces you belong to |
| `GET` | `/api/spaces/:slug` | One space |
| `GET` | `/api/spaces/:slug/sites` | Its sites |
| `POST` | `/api/spaces/:slug/members` ✱ | Add a member |
| `DELETE` | `/api/spaces/:slug/members/:userId` ✱ | Remove a member |
| `DELETE` | `/api/spaces/:slug` ✱ | Delete a group space — see the caveat above |

## Data tokens (glance.db)

The control plane never touches site data. To read or write a site's document store, exchange your
credential for a short-lived data token and use that against `/api/_data`:

```
POST /api/data-token/:space/:site
```

```jsonc
{ "token": "…", "caps": ["read"], "expiresIn": 300 }
```

The token lives **300 seconds** — mint per run, never bake one into an env var or config file; a
`401` on the data plane means it aged out. `404` if the instance has no `DATA_TOKEN_SECRET`
configured (the feature is off).

When a key mints one, the resulting capabilities are the intersection of three things: your own
access to that site, the key's `grants.data.caps` ceiling, and the key's `scope` allowlist. Narrower
always wins — a key can restrict what you could otherwise do, never widen it. A key whose
`grants.data` is `null` is `403` here.

```bash
TOKEN=$(curl -s -X POST -H "Authorization: Bearer $GLANCE_TOKEN" \
  "https://your-instance/api/data-token/sam/q3-metrics" | jq -r .token)
```

## Errors

Every error is `{"error": "<reason>"}` with a meaningful status.

| Status | Means |
| --- | --- |
| `400` | Malformed body, invalid grants, bad slug, or the active-key cap |
| `401` | No credential, or one that is expired, revoked, or unknown |
| `403` | Authenticated but not allowed — missing control grant, a key hitting a key-denied route, or CSRF on a cookie request |
| `404` | Not found, **or** deliberately indistinguishable from not-yours (revoking someone else's key) |
| `409` | Slug taken, version conflict, or a space holding other members' sites |
| `413` | File over 20MB |
| `429` | Rate limited |
