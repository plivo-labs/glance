# COMMENTS_TEST_PLAN — Comments on deployed HTML

Bind every case to a **real public interface** (a pure helper or `app.request(path, init, env)`), never a
struct shape. Repo idiom = pure helpers + light route requests with injected `env`; S-D in-memory SQLite
harness (`test/harness.ts`) with seed helpers. Frontend has no web test runner → **manual browser smoke**
(localhost stack + bootstrap auth), the established pattern.

Class ∈ { `red-now-bug`, `characterization`, `property-equivalence`, `new-module-spec` }. This is an
additive feature, so most cases are `new-module-spec` (drive a new abstraction into existence); the
`red-now-bug` ones are genuine pre-existing gaps (no auth/dup-path guard) that the change closes.

## Seams (land before the cases they unlock)
- **S-MIGRATE** — register every new `drizzle/*.sql` in the hard-coded `MIGRATIONS` array
  (`test/harness.ts:22`). Without it the harness never sees the new tables/columns. Unlocks every S-D case
  below. (= part of Steps 4/5.)
- **S-SEED+** — extend harness seeds: `seedFile(siteId, {path, contentHash, text})`, `seedThread(...)`,
  `seedComment(...)`. Unlocks repo + reconcile + access cases.
- **S-RESOLVE** — export `resolveSiteForAccess` (Step 6). Unlocks comments-route access/authz cases.
- **S-R2** — minimal `GLANCE_FILES` R2 mock on the harness env (get→text/body). Unlocks upload-hash,
  dedupe, server-side reconcile, and annotate-injection cases.

## Cases

### Phase 1 — pure anchoring core (`lib/anchor.ts`) — writable today, no seam
- `normalize-folds-whitespace-unicode` · P0 · new-module-spec · Today — `normalizeText` collapses
  whitespace runs + folds unicode so formatting-only edits still match.
- `resolve-exact-unique-anchored` · P0 · new-module-spec · Today — quote once in doc → `anchored` + correct offsets.
- `resolve-repeated-quote-disambiguated` · P0 · new-module-spec · Today — quote 2×; prefix/suffix select the right instance.
- `resolve-moved-shifted` · P0 · new-module-spec · Today — same exact text relocated (prefix/suffix match) → `shifted`, new offsets.
- `resolve-gone-orphaned` · P0 · new-module-spec · Today — quoted text removed → `orphaned`, no offsets.
- `resolve-fuzzy-suggested` · P1 · new-module-spec · Today — near-match above threshold (small edit) → `suggested`.
- `resolve-ambiguous-not-silently-wrong` · P1 · new-module-spec · Today — repeated quote, weak/absent
  prefix/suffix → `suggested`/ambiguous, NEVER a confident wrong pick (false-positive guard).

### Phase 1 — data model / upload (S-MIGRATE, S-R2)
- `files-contentHash-persisted-on-upload` · P0 · new-module-spec · S-R2 — after upload, `files.contentHash`
  == `normalizeText` digest of the file text (create + replace paths).
- `upload-rejects-duplicate-path` · P0 · **red-now-bug** · S-R2 — two parts sanitizing to the same path →
  400 BEFORE any R2 commit; no orphaned rows/objects. (Today blind-inserts → would 500 post-constraint.)
- `unique-siteId-path-enforced` · P1 · new-module-spec · S-D — two `files` rows same `(siteId,path)` →
  constraint error (proves the migration applied through the harness).

### Phase 2 — repo helpers + reconciliation (S-SEED+, S-R2)
- `create-thread-resolves-anchor-server-side` · P0 · new-module-spec · S-R2 — `createThread` resolves the
  quote against the file's CURRENT text → stores `anchored`+`contentHash`; quote absent → `orphaned`/page
  fallback. Proves resolution is server-side, not iframe-trusted.
- `reply-appends-flat-row-same-thread` · P0 · new-module-spec · S-D — `addComment` appends a `comments` row
  with the same `threadId`, ordered after the opener; no `parentId`/nesting.
- `list-threads-returns-ordered-comments` · P1 · new-module-spec · S-D — `listThreads(siteId,filePath)` →
  threads + their comments in `createdAt` order.
- `reconcile-shifted-on-hash-change` · P0 · new-module-spec · S-R2 — anchored thread; file replaced so the
  quote moves; `listThreads` sees hash mismatch → re-resolves → persists `shifted` + new offsets.
- `reconcile-orphaned-when-text-removed` · P0 · new-module-spec · S-R2 — quote removed on replace →
  persists `orphaned`; thread + comments KEPT (never deleted).
- `reconcile-skips-when-hash-unchanged` · P1 · new-module-spec · S-R2 — stored hash == current → no R2 read,
  status untouched (zero-work gate; assert R2.get not invoked).

### Phase 2 — routes: auth / access / authz (S-RESOLVE; mount via `index.ts` for CSRF)
- `comments-require-auth` · P0 · **red-now-bug** · S-D — unauthenticated request → 401 (even on a team site).
- `comments-forbidden-on-public-site` · P0 · new-module-spec · S-D — authed user, `public` site →
  403 (`canComment` false). The user-decision rule.
- `comments-respect-access-tier` · P0 · new-module-spec · S-D — non-member on group/private → 403 (mirrors
  `checkAccess`); member/owner → allowed.
- `author-can-edit-delete-own-only` · P1 · new-module-spec · S-D — author edits/soft-deletes own; non-author → 403.
- `owner-superadmin-resolve-and-delete-any` · P1 · new-module-spec · S-D — owner/superadmin resolve + delete
  others' comments; plain member cannot.
- `soft-delete-keeps-thread-shape` · P1 · new-module-spec · S-D — `deleteComment` sets `deletedAt`;
  `listThreads` still returns the row (body redacted), thread intact.
- `csrf-cross-origin-comment-post-403` · P1 · characterization · S-D — POST with foreign Origin → 403 from
  the global `requireSameOrigin` (don't regress CSRF; proves routes inherit it).
- `body-length-cap-rejected` · P2 · new-module-spec · S-D — over-cap body → 400.

### Phase 3 — annotate injection (content app via `app.request`, S-R2)
- `annotate-route-before-catchall` · P0 · **red-now-bug** · S-D — `GET /_glance/annotate.js` → the script
  (200, js type), NOT captured by `/:space/:site/*` as a site lookup.
- `inject-only-with-flag-and-html` · P0 · new-module-spec · S-R2 — gated HTML + `?glance_annotate=1` → body
  contains injected `<script>` + boot payload; without the flag → raw bytes unchanged.
- `boot-payload-carries-resolved-path` · P1 · new-module-spec · S-R2 — lone `report.html` at root
  (single-file fallback) → payload path = resolved `files.path`, not the URL guess.
- `inject-drops-etag` · P1 · new-module-spec · S-R2 — annotated response drops the raw object ETag / sets `Vary`.
- `markdown-not-injected` · P1 · characterization · S-R2 — `.md` + flag → still `script-src 'none'`, no script.
- `public-path-not-injected` · P1 · new-module-spec · S-R2 — public (untokened) serve + flag → no injection
  (public sites have no comments).

### Phase 4 — parent intent filter (`parseIntent`) — writable today
- `parseintent-rejects-wrong-origin` · P0 · new-module-spec · Today — `origin ≠ CONTENT_URL` → null.
- `parseintent-rejects-wrong-source` · P0 · new-module-spec · Today — `source ≠ iframe.contentWindow` → null.
- `parseintent-rejects-bad-shape-or-oversize` · P0 · new-module-spec · Today — unknown type / oversize → null.
- `parseintent-accepts-valid-select` · P1 · new-module-spec · Today — well-formed select intent → parsed object.

### Phase 4/5 — client glue + UI (manual smoke — no web test runner)
- `m-select-paints-and-posts` · P1 · manual — selecting text paints a highlight (Custom Highlight API) +
  emits an intent `postMessage`.
- `m-review-mode-split-layout` · P1 · manual — review mode = persistent rail split (not modal `Sheet`);
  full-bleed stays default.
- `m-select-to-comment-flow` · P0 · manual — select → floating Comment button → composer prefilled with the
  quote → submit → thread in rail + highlight in iframe.
- `m-reply-flat-one-level` · P1 · manual — reply appends under the thread; no reply-to-reply.
- `m-resolve-thread` · P1 · manual — resolve moves the thread under the resolved filter.
- `m-orphaned-after-redeploy` · P0 · manual — redeploy removing the quoted section → thread shows in the
  **Outdated** group with its stored quote + replies, not lost.
- `m-public-site-no-review-mode` · P1 · manual — a `public` site viewer has no review-mode affordance.

## Authoring order
1. **Writable-today pure reds:** all `lib/anchor.ts` `resolve-*`/`normalize-*` + `parseintent-*` (no seam, no DB).
2. Land **S-MIGRATE + S-SEED+** → data-model, repo, access/authz cases (S-D).
3. Land **S-R2** → upload-hash, `upload-rejects-duplicate-path`, reconcile, annotate-injection cases.
4. Land **S-RESOLVE** → comments-route access cases (mount via `index.ts` for CSRF).
5. **Manual smoke** at each UI phase gate (Phase 4 client glue, Phase 5 review-mode flows).
