# COMMENTS_PLAN — Comments on deployed HTML

Anchored, threaded review comments on deployed sites: comment on a page, select+quote a passage,
reply (one level — flat thread), resolve. Reconciled from the design + two 3-way consults (codex +
cursor + arbiter — design review, then plan review); grounded in the real worker code.

**Bias:** additive feature, not a refactor. Order = **correctness before mechanics before UI**:
pure anchoring core + data model → access-gated API → content-origin boundary → client annotator → UI.
Each phase independently shippable and fully gated.

## Two governing constraints (drive every decision)
Uploaded HTML is served from a **separate origin** (`glance-content.*`) and iframed (`viewer.tsx:32`,
rationale `content.ts:16`). The parent SPA **cannot read the iframe DOM**.
1. **Trust — iframe JS is hostile by design.** An `event.origin`/`event.source` check is necessary but
   **NOT sufficient**: hostile uploaded HTML shares the content origin and can forge any message. So
   `parseIntent` is only a *shape/size/source filter*, never a trust oracle. The real guard is an
   **architectural invariant**: iframe→parent messages may only open UI or *suggest* an anchor; **every
   mutation is parent-initiated after an explicit user action**, and **all anchor resolution is computed
   server-side over trusted R2 bytes** — never trusted from iframe-computed offsets/status.
2. **Durability — redeploy replaces files.** `upload.ts:121` deletes all file rows + `:131` purges R2,
   but the site row stays. Comments re-anchor against the new bytes and are **never deleted** — worst case
   `orphaned`.

> **v1 anchoring scope (honest limitation):** anchors resolve over the **normalized static HTML source
> text**. For the target docs (reports, decks, generated HTML) rendered text ≈ source, so it works. For
> **JS-generated DOM content** source ≠ rendered, so such anchors reconcile to `suggested`/`orphaned` or
> fall back to page-level. Element/region + DOM-rendered anchoring is **v2**.

---

## Phase 1 — Pure anchoring core + data model
Foundational + greenfield; fully covered by the S-D in-memory SQLite harness and pure unit tests.

- **Step 1** — pure `lib/anchor.ts` (no DOM, no network): `normalizeText(s)` (whitespace/unicode fold),
  `buildAnchor({quote,prefix,suffix})`, and `resolveAnchor(anchor, docText) → {status, start, end}` — the
  re-anchor ladder: exact-unique→`anchored`; exact resolves elsewhere via prefix/suffix→`shifted`; fuzzy ≥
  threshold→`suggested`; none→`orphaned`. Fuzzy = a **minimal in-house bounded matcher** (avoid a new dep;
  `diff-match-patch` is the documented fallback if it proves too weak). Used by BOTH upload hashing and the
  server-side reconciler, so the normalizer is a single shared owner. · *high* · dep:none
- **Step 2** — `files.contentHash` (text, nullable) computed at upload via `normalizeText` (create +
  replace paths, `upload.ts`). *Reason:* the cheap "hash unchanged → skip re-anchor" gate is unbuildable
  today — `files` stores only path/mime/size (`schema.ts:50`). Define the read-once/streaming approach to
  avoid double-reading the body. · *med* · dep:1
- **Step 3** — **upload-time duplicate-path rejection** + a pre-migration audit for existing duplicate
  `(siteId,path)` rows. *Reason:* upload sanitizes filenames then blindly inserts (`upload.ts:36,102`); two
  multipart names can collapse to one path; serving picks one via `.limit(1)` (`content.ts:92`). Must
  reject dupes *before* the constraint, or a client mistake becomes a post-R2-write 500. · *med* · dep:none
- **Step 4** — `unique(files.siteId, files.path)` constraint migration. · *low* · dep:3
- **Step 5** — `comment_threads` + `comments` tables (Drizzle + migration). Threads: `anchorType`, `anchor`
  JSON, `quote`, `contentHash`, `anchorStatus`, `status`, `resolvedBy`, `resolvedAt`, `createdBy`,
  `createdAt`, `updatedAt`. Comments **flat**: `threadId`, `authorId`, `body`, `createdAt`, `editedAt`,
  `deletedAt`. **FKs to `users` are `set-null`** (deleting a user must not nuke history); cascade only on
  `siteId`/`threadId`. Indexes: `threads(siteId,filePath,status)`, `threads(siteId,status,updatedAt)`,
  `comments(threadId,createdAt)`, `comments(authorId)`. · *low* · dep:none
- **Gate P1** — `/thermo-nuclear-code-quality-review` on the diff → full `bun test` + typecheck + lint
  green → commit.

## Phase 2 — Authenticated comments API (the correctness surface)
All server-side, harness-testable. **Anchor resolution is server-side here** — the trusted path.

- **Step 6** — extract a shared `resolveSiteForAccess(db, space, site, user)` from the **private**
  `resolveSite` in `sites.ts:34` (resolve row → `isMember` → `isShared` → `checkAccess`). *Reason:*
  comments routes must not duplicate that logic; it's currently un-exported. Seam. · *med* · dep:none
- **Step 7** — repo helpers (exported for tests): `createThread` (resolves the anchor **server-side over
  current file text**, stamps `contentHash`+`anchorStatus`), `addComment` (reply = append a row to the same
  `threadId`), `listThreads(siteId,filePath)` (+ ordered comments), `resolveThread`/`reopenThread`,
  `editComment`, `deleteComment` (soft → `deletedAt`). · *med* · dep:5
- **Step 8** — **server-side re-anchor reconciliation** inside `listThreads`: for each thread compare
  stored `contentHash` vs the file's *current* hash (cheap gate — usually equal, zero work); on mismatch,
  read the current file text from R2, run `resolveAnchor` (Step 1) over **trusted bytes**, persist
  rewritten offsets + `anchorStatus`, bump the hash. *Reason:* without this, `shifted`/`orphaned` is stale
  forever; computing it in the hostile iframe would be a confused-deputy write. · *high* · dep:7,1,2
- **Step 9** — routes `/api/sites/:space/:site/comments...` (list / create-thread / reply / resolve / edit /
  delete): each runs `requireAuth` **then** a pure `canComment(site, user, access)` = `access.ok && user &&
  site.visibility !== 'public'`. *Reason:* **comments are disallowed on `public` sites entirely** (user
  decision) — public is anonymous-viewable (`checkAccess` returns `ALLOW` for anon on public, `access.ts:32`),
  which is exactly the abuse vector; excluding it removes the anonymous-spam surface and makes per-user rate
  limiting unnecessary. CSRF is already global (`requireSameOrigin` mounts for all `/api/*` in `index.ts:43`)
  — do **not** re-add it route-local; tests must mount via `index.ts` to exercise it. Authz: author
  edits/deletes **own**; owner+superadmin resolve/delete any; non-public view-access can read+reply.
  Body-length cap in-route. · *high* · dep:6,7,8
- **Gate P2** — thermo-nuclear → full suite green → commit.

## Phase 3 — Content-worker annotate mode (the boundary mechanics)
Server-side injection; testable via `app.request` against the content app.

- **Step 10** — register `GET /_glance/annotate.{js,css}` **before** the `/:space/:site/*` route
  (`content.ts:48` would otherwise capture it as a site) + a **build/serve pipeline** for the client
  bundle (the worker has no static-asset pipeline today — bundle the TS to a string the route serves, long
  cache). · *med* · dep:none
- **Step 11** — annotate-mode HTML transform in `serve()`: only when `?glance_annotate=1` **and** the
  resolved file is HTML — **buffer** the R2 body (today it streams raw, `content.ts:121`), inject
  `<script>` + a boot payload carrying the **resolved `files.path`** (the annotator can't infer it from the
  URL — single-file fallback `content.ts:97`, gated `/_t/...` paths), `siteId`, content origin; **drop/`Vary`
  the ETag** (bytes differ). Markdown stays untouched (`script-src 'none'`, `content.ts:243`) → markdown is
  page-level comments only. Access checks in `serve()` are unchanged — the flag grants nothing. Inject only
  on the **gated (non-public) serve path** (`/_t/...`) since `public` sites have no comments. · *high* · dep:10
- **Gate P3** — thermo-nuclear → full suite green → commit.

## Phase 4 — Client annotator + parent intent filter (thin, trust-free)
The hard logic already shipped pure in Phase 1; this is glue.

- **Step 12** — pure `parseIntent(event, expected) → intent | null`: filters `origin === CONTENT_URL`,
  `source === iframe.contentWindow`, known shape, size. **Explicitly a filter, NOT a trust/authority guard**
  (see constraint 1). · *med* · dep:none
- **Step 13** — the injected `annotate.js` (thin client): selection capture, Custom Highlight API paint
  (span-wrap fallback) at offsets **handed down by the parent** (from the Phase-2 API), emit intent-only
  `postMessage(…, APP_URL)` carrying `{quote,prefix,suffix}` for new anchors. Computes **no persisted
  status**. · *med* · dep:1,11
- **Gate P4** — thermo-nuclear → full suite green → commit.

## Phase 5 — Review-mode UI (manual smoke — no web test runner)
- **Step 14** — opt-in **review mode** in `viewer.tsx`: a persistent right-rail **split layout** (NOT the
  modal `Sheet` — it traps focus); immersive full-bleed stays default; append `?glance_annotate=1` to the
  (tokenized) `contentUrl`. Offer review mode only when `site.visibility !== 'public'`. · *med* · dep:9,11
- **Step 15** — rail thread list (open/resolved filter, `updatedAt` sort) + on-select floating Comment
  button → composer pre-filled with the quote → create via the Phase-2 API; flat reply box; resolve control;
  **Outdated** group for `orphaned`. Parent consumes iframe messages via `parseIntent`; **every mutation is
  an explicit parent-side user action** (the confused-deputy guard). · *high* · dep:12,13,14
- **Step 16** — gutter pins painted **inside** the iframe (parent can't cheaply track cross-origin scroll);
  mobile collapses the rail to a bottom drawer. · *med* · dep:15
- **Gate P5** — thermo-nuclear → manual browser smoke (localhost stack, bootstrap auth) → typecheck + lint
  + `build:web` green → commit.

---

## Dependencies (critical path)
`1 → 2 → 8`, `3 → 4`, `5 → 7 → 8 → 9`, `6 → 9` (Phase 1–2) ; `10 → 11` (Phase 3, parallel) ;
`12`, `1,11 → 13` (Phase 4) ; `9,11 → 14 → 15 → 16` (UI converges last).

## Test seams (land before the cases they unlock)
- **S-MIGRATE** — register every new `drizzle/*.sql` in the hard-coded `MIGRATIONS` array in
  `test/harness.ts:22`, else harness tests never see the new tables/columns.
- **S-RESOLVE** — export `resolveSiteForAccess` (Step 6) so comments-route access cases are authorable.
- **S-SEED+** — extend the existing seed helpers with `seedThread`/`seedComment`/`seedFile(contentHash)`.
- **S-R2** — minimal R2 mock on the harness env (Step 8 reconciliation reads file text; Step 11 transform).

## v2 non-goals (explicit)
Durable-Object live multi-user; email-on-reply; `@mentions`/reactions; `site_revisions` diff-snapshot
(the orphan ladder works without it); guest (no-login) commenting; **comments on `public` sites**
(excluded by design — the anonymous-spam vector); element/region + JS-rendered-DOM anchors. **Per-user
rate limiting** is unnecessary given the public-site exclusion — v1 ships only an in-route body-length cap.
