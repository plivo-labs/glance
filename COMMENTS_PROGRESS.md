# Comments on deployed HTML — Progress Tracker

Tracks `COMMENTS_PLAN.md` (16 steps / 5 phases) and `COMMENTS_TEST_PLAN.md` (39 cases + 4 seams).
Reconciled after two 3-agent reviews (self + codex + cursor): design review, then plan review, 2026-06-28.
Status keys: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.

> **Locked decisions (user, 2026-06-28):** (1) replies are **flat, one level** — no `parentId`.
> (2) **No comments on `public` sites** (the anonymous-spam vector) → per-user rate limiting unnecessary;
> v1 keeps only a body-length cap. (3) Anchor resolution is **server-side over trusted R2 bytes**, never
> trusted from iframe-computed offsets/status. (4) v1 anchors over **static HTML source text**;
> JS-rendered DOM degrades to `suggested`/`orphaned`/page-level.

---

## Steps

### Phase 1 — Pure anchoring core + data model
- [x] **Step 1** — pure `lib/anchor.ts`: `normalizeText` · `buildAnchor` · `resolveAnchor` (the
      anchored/shifted/suggested/orphaned ladder; in-house bounded fuzzy). Single shared normalizer owner. · *high*
- [x] **Step 2** — `files.contentHash` computed via `normalizeText` at upload (create+replace). · *med* · dep:1
- [x] **Step 3** — upload-time duplicate-path rejection + pre-migration dup audit. · *med*
- [x] **Step 4** — `unique(files.siteId, files.path)` constraint migration. · *low* · dep:3
- [x] **Step 5** — `comment_threads` + flat `comments` tables (set-null user FKs, indexes). · *low*
- [x] **Gate P1** — thermo-nuclear PASS → 104 tests + typecheck + lint green → committed `Phase 1: …` (8251ece)

### Phase 2 — Authenticated comments API (correctness surface)
- [x] **Step 6** — extract shared `resolveSiteForAccess` from private `resolveSite` → `lib/site-access.ts` (sites.ts now reuses it). · *med*
- [x] **Step 7** — repo helpers (`db/comments.ts`): create/list/reply/resolve/reopen/edit/soft-delete. · *med* · dep:5
- [x] **Step 8** — server-side re-anchor reconciliation in `listThreads` (hash-gated single R2 read → `resolveAnchor` → persist-on-change). · *high* · dep:7,1,2
- [x] **Step 9** — routes `/api/sites/:space/:site/comments…` · `requireAuth` → `canComment` (no public) → `checkAccess` · authz · body cap. · *high* · dep:6,7,8
- [x] **Gate P2** — thermo-nuclear PASS → 118 tests + typecheck + lint green → commit `Phase 2: …`

### Phase 3 — Content-worker annotate mode (boundary mechanics)
- [ ] **Step 10** — register `/_glance/annotate.{js,css}` before the catch-all + client-bundle build/serve. · *med*
- [ ] **Step 11** — annotate-mode HTML transform: buffer body · inject script+boot payload (resolved path) · drop/`Vary` ETag · HTML-only · markdown untouched · gated path only. · *high* · dep:10
- [ ] **Gate P3** — thermo-nuclear on Phase-3 diff → full suite green → commit `Phase 3: …`

### Phase 4 — Client annotator + parent intent filter (thin, trust-free)
- [ ] **Step 12** — pure `parseIntent(event, expected)` — shape/size/origin/source FILTER (not a trust guard). · *med*
- [ ] **Step 13** — injected `annotate.js`: selection capture · Custom Highlight paint at parent-supplied offsets · intent-only `postMessage`. · *med* · dep:1,11
- [ ] **Gate P4** — thermo-nuclear on Phase-4 diff → full suite green → commit `Phase 4: …`

### Phase 5 — Review-mode UI (manual smoke)
- [ ] **Step 14** — opt-in review-mode split layout in `viewer.tsx` (persistent rail, not modal `Sheet`); append `?glance_annotate=1`; non-public only. · *med* · dep:9,11
- [ ] **Step 15** — rail thread list · on-select composer (prefilled quote) · flat reply · resolve · **Outdated** group · mutations = explicit parent action. · *high* · dep:12,13,14
- [ ] **Step 16** — gutter pins inside the iframe; mobile bottom drawer. · *med* · dep:15
- [ ] **Gate P5** — thermo-nuclear on Phase-5 diff → manual browser smoke → typecheck + lint + `build:web` green → commit `Phase 5: …`

> **Phase-exit gate (every phase):** after a phase's steps land, run `/thermo-nuclear-code-quality-review`
> scoped to that phase's diff → triage (fix legit, note deferred w/ rationale) → re-run the full `bun test`
> suite. **All tests pass + no unaddressed finding before the phase is done.** Then commit the phase as one
> scoped commit (`Phase <n>: <summary>`) — each phase is independently revertable. Frontend-only steps have
> no web runner → manual browser smoke (bootstrap-auth precedent).

---

## Test seams (land before the cases they unlock)
- [ ] **S-MIGRATE** — add new `drizzle/*.sql` to `MIGRATIONS` (`test/harness.ts:22`). Unlocks all S-D cases.
- [ ] **S-SEED+** — `seedFile(contentHash,text)` / `seedThread` / `seedComment`. Unlocks repo + reconcile + access cases.
- [ ] **S-RESOLVE** — export `resolveSiteForAccess` (Step 6). Unlocks comments-route access cases.
- [ ] **S-R2** — minimal `GLANCE_FILES` R2 mock on harness env. Unlocks upload-hash, dedupe, reconcile, inject cases.

---

## Test cases

### Phase 1 — anchoring core (writable today)
- [ ] `normalize-folds-whitespace-unicode` · P0 · new-module-spec · Today
- [ ] `resolve-exact-unique-anchored` · P0 · new-module-spec · Today
- [ ] `resolve-repeated-quote-disambiguated` · P0 · new-module-spec · Today
- [ ] `resolve-moved-shifted` · P0 · new-module-spec · Today
- [ ] `resolve-gone-orphaned` · P0 · new-module-spec · Today
- [ ] `resolve-fuzzy-suggested` · P1 · new-module-spec · Today
- [ ] `resolve-ambiguous-not-silently-wrong` · P1 · new-module-spec · Today

### Phase 1 — data model / upload (S-MIGRATE, S-R2)
- [ ] `files-contentHash-persisted-on-upload` · P0 · new-module-spec · S-R2
- [ ] `upload-rejects-duplicate-path` · P0 · **red-now-bug** · S-R2
- [ ] `unique-siteId-path-enforced` · P1 · new-module-spec · S-D

### Phase 2 — repo + reconciliation (S-SEED+, S-R2)
- [ ] `create-thread-resolves-anchor-server-side` · P0 · new-module-spec · S-R2
- [ ] `reply-appends-flat-row-same-thread` · P0 · new-module-spec · S-D
- [ ] `list-threads-returns-ordered-comments` · P1 · new-module-spec · S-D
- [ ] `reconcile-shifted-on-hash-change` · P0 · new-module-spec · S-R2
- [ ] `reconcile-orphaned-when-text-removed` · P0 · new-module-spec · S-R2
- [ ] `reconcile-skips-when-hash-unchanged` · P1 · new-module-spec · S-R2

### Phase 2 — routes: auth / access / authz (S-RESOLVE; mount via `index.ts`)
- [ ] `comments-require-auth` · P0 · **red-now-bug** · S-D
- [ ] `comments-forbidden-on-public-site` · P0 · new-module-spec · S-D
- [ ] `comments-respect-access-tier` · P0 · new-module-spec · S-D
- [ ] `author-can-edit-delete-own-only` · P1 · new-module-spec · S-D
- [ ] `owner-superadmin-resolve-and-delete-any` · P1 · new-module-spec · S-D
- [ ] `soft-delete-keeps-thread-shape` · P1 · new-module-spec · S-D
- [ ] `csrf-cross-origin-comment-post-403` · P1 · characterization · S-D
- [ ] `body-length-cap-rejected` · P2 · new-module-spec · S-D

### Phase 3 — annotate injection (content app, S-R2)
- [ ] `annotate-route-before-catchall` · P0 · **red-now-bug** · S-D
- [ ] `inject-only-with-flag-and-html` · P0 · new-module-spec · S-R2
- [ ] `boot-payload-carries-resolved-path` · P1 · new-module-spec · S-R2
- [ ] `inject-drops-etag` · P1 · new-module-spec · S-R2
- [ ] `markdown-not-injected` · P1 · characterization · S-R2
- [ ] `public-path-not-injected` · P1 · new-module-spec · S-R2

### Phase 4 — parseIntent (writable today)
- [ ] `parseintent-rejects-wrong-origin` · P0 · new-module-spec · Today
- [ ] `parseintent-rejects-wrong-source` · P0 · new-module-spec · Today
- [ ] `parseintent-rejects-bad-shape-or-oversize` · P0 · new-module-spec · Today
- [ ] `parseintent-accepts-valid-select` · P1 · new-module-spec · Today

### Phase 4/5 — client glue + UI (manual smoke)
- [ ] `m-select-paints-and-posts` · P1 · manual
- [ ] `m-review-mode-split-layout` · P1 · manual
- [ ] `m-select-to-comment-flow` · P0 · manual
- [ ] `m-reply-flat-one-level` · P1 · manual
- [ ] `m-resolve-thread` · P1 · manual
- [ ] `m-orphaned-after-redeploy` · P0 · manual
- [ ] `m-public-site-no-review-mode` · P1 · manual

---

## Strategy
- **Writable-today pure reds first** (`lib/anchor.ts` + `parseIntent`) — no DB, no DOM, no code change to
  the app; confirm red → proves the harness + the anchoring core before anything depends on it.
- **Per step: red → fix → green.** Don't batch. Phase 2's reconcile/access cases are the real correctness
  surface — land S-MIGRATE/S-SEED+/S-R2, write the reds against not-yet-existing helpers, implement to green.
- **Seam tests land with their seam** (S-R2 with Step 8, etc.), not up front.
- **Anchor resolution is tested server-side** (pure `resolveAnchor` + reconcile through the repo), never via
  the iframe — that's the trust boundary, so the iframe glue is deliberately thin + manual-smoke only.
- **CSRF cases mount via `index.ts`** (where `requireSameOrigin` is global), not the bare comments router.
- **End of each phase: thermo-nuclear gate** → full suite green → one scoped commit.

## Authoring order
1. Pure reds: `resolve-*` / `normalize-*` / `parseintent-*` (no seam).
2. S-MIGRATE + S-SEED+ → data-model + repo + access/authz cases.
3. S-R2 → upload-hash, `upload-rejects-duplicate-path`, reconcile, injection cases.
4. S-RESOLVE → comments-route access cases (mounted via `index.ts`).
5. Manual smoke per UI phase gate (Phase 4 client glue, Phase 5 review-mode flows).

---

## Log
- 2026-06-28 — Tracker created from `COMMENTS_PLAN.md` + `COMMENTS_TEST_PLAN.md`. Two 3-agent reviews
  (self + codex + cursor) reconciled. Key consensus folds into the plan: (1) **re-anchoring moved
  server-side** over trusted R2 bytes with a hash-gated reconciliation step in `listThreads` — closes both
  the staleness gap and the confused-deputy trust hole (was: `reanchor` in the hostile iframe + persisted
  iframe-computed status). (2) `parseIntent` demoted from "trust validator" to shape/size/source **filter**;
  the real guard is the parent-initiated-mutation invariant. (3) **dedupe + pre-migration audit before**
  the `unique(siteId,path)` constraint (blind insert today → post-R2 500 otherwise). (4) extract shared
  `resolveSiteForAccess` (private `resolveSite` in `sites.ts:34`). (5) CSRF is global in `index.ts:43` —
  don't re-add route-local; tests mount via `index.ts`. (6) fixed Phase-5 deps (review mode needs Phase-3
  injection); client annotator no longer depends on the parent's `parseIntent`. (7) S-MIGRATE seam: new SQL
  must be registered in the harness `MIGRATIONS` array. User decisions: flat one-level replies; **no
  comments on public sites** (rate-limiting therefore dropped); in-house fuzzy matcher (no `diff-match-patch`
  dep). Honest v1 limitation recorded: anchors resolve over static HTML source text; JS-rendered DOM degrades.
