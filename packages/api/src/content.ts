import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { type Context, Hono } from 'hono'
import { sessionDb } from './db/client'
import { ANNOTATE_CSS, ANNOTATE_JS, ANNOTATE_VERSION } from './annotate/bundle'
import { GLANCE_DB_JS, GLANCE_DB_VERSION } from './glancedb/bundle'
import { type NewEvent, files, sites, spaces } from './db/schema'
import { fireAndForget, recordEvent } from './lib/events'
import { checkAccess } from './lib/access'
import { escapeHtml, markdown } from './lib/markdown'
import { contentType } from './lib/mime'
import { type CacheLike, IMMUTABLE, readFullObject } from './lib/object-read'
import { verifyOgSig } from './lib/og-image'
import { renderOgPng } from './lib/og-render'
import { decideRange } from './lib/range'
import { fetchAccessFacts, isSharedFromFacts, resolveSite } from './lib/site-access'
import { THEME_CSS, THEMES_VERSION } from './themes/css'
import { verifyToken } from './lib/token'
import type { Bindings } from './types'

// Re-exported so cache-key consumers (tests) keep a single import site next to the route.
export { storageCacheKey } from './lib/object-read'

// `db`/`caches` are optional: production runs no middleware that sets them — getDb() falls back
// to a request-scoped client built from the D1 binding, getCache() to the runtime's global
// `caches.default`. Tests inject the in-memory harness db and cache mocks.
type ContentEnv = { Bindings: Bindings; Variables: { db?: DrizzleD1Database; caches?: { default: CacheLike } } }
type Ctx = Context<ContentEnv>

// Content worker (glance-content.<acct>.workers.dev): streams uploaded file bytes from
// R2. Separate origin so untrusted uploaded HTML/JS can never reach the main app's
// session cookie. Gated sites carry an HMAC token IN THE PATH (/_t/<token>/...) so
// relative sub-resources inherit it without cookies — survives 3rd-party-cookie blocking.
const app = new Hono<ContentEnv>()

// Per-request drizzle client. The D1 binding is request-scoped, so the client must not be
// memoized across requests; tests inject a harness db via c.set('db').
// 'first-unconstrained': every read may hit the nearest replica. Replica lag on this origin is
// an accepted posture — a just-uploaded site can already miss transiently (404s are no-store,
// see notFound), and share revocation propagating within seconds matches KV session semantics.
function getDb(c: Ctx): DrizzleD1Database {
  return c.get('db') ?? sessionDb(c.env.GLANCE_DB, 'first-unconstrained')
}

// The edge cache for full-200 object reads. In the Workers runtime this is the global
// `caches.default`; bun has no global `caches` (and no `.default` on a standard CacheStorage),
// so uninjected tests resolve null and serve straight from R2 — today's exact op shape.
function getCache(c: Ctx): CacheLike | null {
  const injected = c.get('caches')
  if (injected) return injected.default
  const global = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches
  return global?.default ?? null
}

// Full-200 reads of immutable objects live in lib/object-read (cache-fronted, tee'd warm).
// This shim owns the Hono plumbing: the request-scoped cache/bucket and the waitUntil hook.
function readStoredObject(c: Ctx, storageKey: string, contentTypeHeader: string) {
  return readFullObject(getCache(c), c.env.GLANCE_FILES, storageKey, contentTypeHeader, (p) => fireAndForget(c, p))
}

// A 404 on the content origin must never be cached. Right after an upload a read can miss
// transiently (edge/timing); a cached 404 would then outlive the miss and strand a freshly
// published site. `no-store` keeps every not-found re-checked against live state.
function notFound(c: Ctx): Response {
  return c.text('404 Not Found', 404, { 'cache-control': 'no-store' })
}

app.get('/', (c) => c.text('Glance content origin', 200))

// Annotate-mode client assets. Registered BEFORE the /:space/:site/* catch-all so `_glance`
// isn't captured as a space slug. Long-cache (IMMUTABLE) + content-versioned query (?v=) makes
// them immutable per build. The bundle is the string produced by scripts/build-annotate.ts.
app.get('/_glance/annotate.js', (c) =>
  c.body(ANNOTATE_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': IMMUTABLE }),
)
app.get('/_glance/annotate.css', (c) =>
  c.body(ANNOTATE_CSS, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': IMMUTABLE }),
)
app.get('/_glance/db.js', (c) =>
  c.body(GLANCE_DB_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': IMMUTABLE }),
)
// Design-theme stylesheets (scripts/build-themes.ts). Same contract as annotate.css: content-
// versioned query (?v=THEMES_VERSION) + IMMUTABLE. Served from THIS origin so the injected
// <link> is same-origin from the framed page's perspective — no CORS, no CSP widening for HTML.
app.get('/_glance/theme/:file{[a-z0-9-]+\\.css}', (c) => {
  const css = THEME_CSS[c.req.param('file').replace(/\.css$/, '')]
  if (!css) return notFound(c)
  return c.body(css, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': IMMUTABLE })
})

// The Slack unfurl card's PNG (lib/og-image.ts). Slack fetches image_url server-side,
// unauthenticated, and caches it — a PUBLIC GET whose only gate is the HMAC minted alongside
// the card (signed on the MAIN worker with the shared CONTENT_TOKEN_SECRET, the same direction
// as content tokens). It lives on THIS worker so the satori/resvg wasm (lib/og-render.ts) never
// bloats the main worker bundle. The signature check runs BEFORE any D1 read, and every failure
// is the same opaque 404 (no existence signal — the enumeration posture of the unfurl itself).
app.get('/_glance/og/:space/:site{[a-z0-9-]+\\.png}', async (c) => {
  const spaceSlug = c.req.param('space')
  const siteSlug = c.req.param('site').replace(/\.png$/, '')
  const verified = await verifyOgSig(c.env.CONTENT_TOKEN_SECRET, spaceSlug, siteSlug, c.req.query('sig') ?? '')
  if (!verified) return notFound(c)

  const site = await resolveSite(getDb(c), spaceSlug, siteSlug)
  // A signed URL outlives the site it was minted for — deleted or archived sites stop serving.
  if (site?.status !== 'active') return notFound(c)

  const render = c.env.OG_RENDER ?? renderOgPng
  const image = await render({ title: site.title ?? site.slug, spaceSlug, siteSlug })
  // A day keeps Slack's and the edge's caches warm without pinning a renamed title forever.
  return new Response(image.body, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
  })
})

// Gated access: token is bound to the viewer's userId AND scoped to "<space>/<site>".
// Path: /_t/<token>/<space>/<site>/<rest>. We verify the signature (recovering the bound
// userId) then re-run the live access check against current DB state, so a revoked share
// or tightened visibility blocks serving immediately — not just at the next mint.
app.get('/_t/:token/:space/:site/*', async (c) => {
  const { token, space, site } = c.req.param()
  const userId = await verifyToken(c.env.CONTENT_TOKEN_SECRET, `${space}/${site}`, token)
  if (!userId) return c.text('Invalid or expired link', 403)
  return serve(c, space, site, restOf(c.req.url, 4), userId)
})

// Untokened path: there is no public tier, so an anonymous request can never be authorized.
// Kept so the URL shape still resolves (serve → 403) rather than 404ing the route. Path: /<space>/<site>/<rest>
app.get('/:space/:site/*', (c) => serve(c, c.req.param('space'), c.req.param('site'), restOf(c.req.url, 2), null))

// `userId` is the token-bound viewer for gated requests, or null for public requests.
async function serve(c: Ctx, spaceSlug: string, siteSlug: string, rest: string, userId: string | null): Promise<Response> {
  const db = getDb(c)
  const reqPath = normalizePath(rest)
  const cols = { path: files.path, storageKey: files.storageKey, mimeType: files.mimeType, size: files.size, etag: files.etag }
  // ONE D1 round trip: the slug-keyed access facts (site / user / membership / shares) plus the
  // file row, fused into a single batch. The file statement joins by BOTH slugs too (the site id
  // is unknown before the batch runs), and every statement returns empty rows rather than
  // throwing, so the 404/403/410 precedence below is decided AFTER the batch in today's order.
  // Statements are built fresh PER ATTEMPT (drizzle builders own their SQL chunks) — see the
  // retry below.
  const fileStmt = () =>
    db
      .select(cols)
      .from(files)
      .innerJoin(sites, eq(files.siteId, sites.id))
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
      .where(and(eq(spaces.slug, spaceSlug), eq(sites.slug, siteSlug), eq(files.path, reqPath)))
      .limit(1)
  // Index-ish request (`…/` or explicit index.html): the single-file/dir-listing fallback's
  // all-files read rides the SAME batch — a single-file site's every page view otherwise pays a
  // serial follow-up round trip. Bounded by the 200-file upload cap; non-index assets (css/js/
  // img — the traffic bulk) keep the lean batch.
  const isIndexReq = reqPath === 'index.html' || reqPath.endsWith('/index.html')
  const allFilesStmt = () =>
    db
      .select(cols)
      .from(files)
      .innerJoin(sites, eq(files.siteId, sites.id))
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
      .where(and(eq(spaces.slug, spaceSlug), eq(sites.slug, siteSlug)))
  const readFacts = () =>
    isIndexReq
      ? fetchAccessFacts(db, spaceSlug, siteSlug, userId, fileStmt(), allFilesStmt())
      : fetchAccessFacts(db, spaceSlug, siteSlug, userId, fileStmt())
  // D1 occasionally surfaces a TRANSIENT internal error (and local dev makes them easy to hit:
  // two `wrangler dev` processes share one --persist-to sqlite, so a concurrent control-plane
  // write — e.g. a theme switch racing the page reload it triggers — can fail this read). The
  // batch is read-only and idempotent, so retrying is safe and turns a user-visible 500 into a
  // served page. Two retries with a short backoff (an immediate retry lands inside the same
  // contention window and fails with it); a third consecutive failure is a real outage and
  // propagates as before. Total added latency on the unhappy path is ≤240ms.
  let read: Awaited<ReturnType<typeof readFacts>> | null = null
  for (let attempt = 0; ; attempt++) {
    try {
      read = await readFacts()
      break
    } catch (err) {
      if (attempt >= 2) throw err
      await new Promise((r) => setTimeout(r, [60, 240][attempt]))
    }
  }
  const { facts, extras } = read
  const [fileRows, allFileRows] = extras as [(typeof extras)[0], (typeof extras)[0]?]

  const siteRow = facts.site
  if (!siteRow) return notFound(c)

  if (userId === null) {
    // Untokened request: no public tier exists, so anonymous access is never allowed.
    return c.text('Forbidden', 403)
  }
  // Gated path: the token-bound user was re-read live in the batch; a deleted user fails closed
  // exactly like the old authorizeViewerById did. Authorization then runs through the same
  // checkAccess the data plane uses — both surfaces enforce the SAME rules. The archive decision
  // lives THERE (410 for everyone except superadmin), so routing it through checkAccess lets a
  // superadmin still view an archived site instead of a blanket early 410.
  if (!facts.user) return c.text('Forbidden', 403)
  const access = checkAccess(siteRow, facts.user, facts.isMember, isSharedFromFacts(facts))
  if (!access.ok) {
    if (access.status === 410) return c.text('This site has been archived', 410)
    return c.text('Forbidden', access.status)
  }

  let file = fileRows[0]

  // Directory request (root, or any `…/`) with no index.html. Rather than a bare 404 — which
  // leaves an author who dropped a folder without a root index.html staring at a blank frame
  // with no clue what's wrong — fall back to either the single uploaded file or a navigable
  // listing of what IS in the site, so they can see the contents and click straight in.
  if (!file && isIndexReq) {
    const dir = reqPath.slice(0, -'index.html'.length) // '' at the root, else `docs/`
    const all = allFileRows ?? [] // fused into the access batch above — never a follow-up trip
    // Single-file site: serve the lone uploaded file at the root (e.g. a dropped `report.html`).
    if (dir === '' && all.length === 1) {
      file = all[0]
    } else {
      const here = all.map((f) => f.path).filter((p) => p.startsWith(dir))
      if (here.length > 0) return directoryListing(c, `${spaceSlug}/${siteSlug}`, here, dir)
    }
  }
  if (!file) return notFound(c)
  const { path, storageKey, size } = file
  const mime = contentType(path, file.mimeType)
  const isMd = /\.(md|markdown)$/i.test(path)
  const isHtml = isHtmlFile(path)

  const frameAncestors = `frame-ancestors 'self' ${c.env.APP_URL}`
  // The content origin this page is served from — the yardstick for "is this link external?".
  // A link to any OTHER origin is rewritten to open in a new tab (see transformServedHtml).
  const selfOrigin = new URL(c.req.url).origin
  // The site's design theme, resolved to an injectable stylesheet href (null = unthemed). The
  // theme column rides the access-facts batch, so this costs nothing extra per request.
  const themeHref = themeHrefFor(siteRow.theme)
  // Usage analytics: count this as a viewer hit only for actual page loads (HTML + rendered
  // markdown), not every CSS/JS/image sub-resource — otherwise one navigation inflates to many.
  // userId is guaranteed non-null here (anonymous requests 403'd above), so every view is
  // attributable to a known team member: exact unique-viewer counts, no IP hashing needed.
  const view = () =>
    trackView(c, db, { type: 'view', action: path, userId, siteId: siteRow.id, siteLabel: `${spaceSlug}/${siteSlug}` })

  // Raw source mode (`glance read --pull`): stream the stored bytes verbatim — NO markdown render,
  // NO annotate injection, NOT counted as a view, and NEVER through the cache (a pull must always
  // reflect live R2, and must not warm entries it will never revisit). The pull needs the exact
  // `.md` source (the default path renders it to HTML) so a pull → deploy round-trip is
  // byte-identical. Already token-gated above; served as text/plain + nosniff so a browser can't
  // be tricked into executing pulled bytes.
  if (c.req.query('raw') === '1') {
    const object = await c.env.GLANCE_FILES.get(storageKey)
    if (!object) return notFound(c)
    return new Response(object.body, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    })
  }

  // Markdown → rendered HTML (served as text/html), BEFORE any conditional/range handling — a
  // Range header on a .md is ignored, exactly as before. The raw source is a full-body read of
  // an immutable object, so it rides the cache layer like every other full read. Use the
  // RESOLVED file's path for type detection so a single `.md` file rendered at the root still
  // renders. Raw HTML in the source is escaped (see `markdown`), strict CSP as defense-in-depth.
  if (isMd) {
    const read = await readStoredObject(c, storageKey, mime)
    if (!read) return notFound(c)
    await view()
    const html = await markdown.parse(await new Response(read.body).text())
    // Annotate mode applies to rendered markdown too — select-to-comment works against the rendered
    // DOM exactly like uploaded HTML (element pinpointing is gone, slice C2a). Markdown's baseline
    // CSP forbids scripts outright, so the injected pair runs under a PER-RESPONSE nonce: our two
    // tags are admitted by name and nothing else is (raw HTML in the source is escaped anyway).
    // Nonce'd bytes differ per request, hence no-store and no ETag.
    const annotate = c.req.query('glance_annotate') === '1'
    const nonce = annotate ? crypto.randomUUID().replace(/-/g, '') : null
    const doc = nonce
      ? injectAnnotate(renderMarkdownDoc(path, html), { siteId: siteRow.id, filePath: path, appOrigin: c.env.APP_URL }, nonce)
      : renderMarkdownDoc(path, html)
    const res = c.html(doc, 200, {
      'content-security-policy': markdownCsp(frameAncestors, nonce, themeHref !== null),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(nonce ? { 'cache-control': 'no-store' } : {}),
    })
    return transformServedHtml(res, selfOrigin, themeHref)
  }

  // Annotate mode: gated HTML + ?glance_annotate=1 → buffer the body and inject the annotate
  // client + boot payload, plus the glance.db SDK (broker mode — the page gets an API, never a
  // credential; the app viewer's parent frame answers). Every serve here is already token-gated
  // (anonymous requests 403 above), so the flag always applies to an authed viewer. The RAW
  // bytes come through the cache layer (immutable full read); the INJECTED bytes change per
  // request, so the response DROPS the ETag and is never cached.
  if (c.req.query('glance_annotate') === '1' && isHtml) {
    const read = await readStoredObject(c, storageKey, mime)
    if (!read) return notFound(c)
    await view()
    const injected = injectAnnotate(injectDb(await new Response(read.body).text(), c.env.APP_URL), {
      siteId: siteRow.id,
      filePath: path, // the RESOLVED path (single-file fallback), not the URL guess
      appOrigin: c.env.APP_URL,
    })
    const res = c.html(injected, 200, {
      'content-security-policy': frameAncestors,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    })
    return transformServedHtml(res, selfOrigin, themeHref)
  }

  const headers = new Headers()
  headers.set('content-type', mime)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('content-security-policy', frameAncestors)
  // Uploaded HTML lives at a path that carries the gated-content token; no-referrer stops
  // that token leaking to third parties via the Referer header on outbound requests.
  headers.set('referrer-policy', 'no-referrer')
  // These bytes are per-viewer (the URL carries a user-bound token): `private` keeps shared/proxy
  // caches from retaining them, while `no-cache` lets the viewer's OWN browser store-and-revalidate
  // against the ETag (→ the 304 in serveStoredObject), so a revalidation costs a header
  // round-trip, not the body.
  headers.set('cache-control', 'private, no-cache')
  // HTML isn't a seekable media type here (annotate-injected pages already took the branch
  // above; a plain gated page has no player to seek in) — advertise + honor ranges only for
  // everything else (audio today; any other binary falls out the same door for free).
  const rangeable = !isHtml
  if (rangeable) headers.set('accept-ranges', 'bytes')
  return serveStoredObject(c, { storageKey, size, etag: file.etag, headers, rangeable, isHtml, mime, view, selfOrigin, themeHref })
}

/** The storage tail of serve(): conditional (If-None-Match) handling, both Range flows (sized
 *  single-ranged-get and the legacy null-size full-get-first fallback), and the cache-fronted
 *  full-200 read — plus the HTML-only view() record and external-link rewrite. `headers`
 *  arrives pre-built (type/CSP/cache-control/accept-ranges); etag and range headers are
 *  stamped onto it here. */
async function serveStoredObject(
  c: Ctx,
  args: {
    storageKey: string
    size: number | null
    etag: string | null
    headers: Headers
    rangeable: boolean
    isHtml: boolean
    mime: string
    view: () => Promise<void>
    selfOrigin: string
    themeHref: string | null
  },
): Promise<Response> {
  const { storageKey, size, etag: rowEtag, headers, rangeable, isHtml, mime, view, selfOrigin, themeHref } = args

  // Themed HTML differs from the stored bytes AND can change without a content replace (a PATCH
  // theme switch re-skins the same object), so the raw object etag would let a browser 304 its
  // way into a stale theme. Fold the theme identity (slug + themes version — both live in the
  // href) into the validator for themed HTML only; every other response keeps the raw etag, and
  // any theme transition (on/off/switch/CSS bump) changes the comparison → fresh 200.
  const themeTag = isHtml && themeHref ? themeHref.replace(/[^a-z0-9]+/gi, '') : null
  const withTheme = (etag: string): string =>
    themeTag ? (etag.endsWith('"') ? `${etag.slice(0, -1)}+${themeTag}"` : `${etag}+${themeTag}`) : etag

  // Honor the conditional request: when the viewer already holds this exact ETag, answer 304 and
  // skip re-streaming the body. This MUST win over Range (RFC 7233 §3.1), so it runs before any
  // Range handling. The current etag comes from D1 (denormalized at upload — storage keys are
  // immutable, so the row's etag is the object's for life): a revalidation hit costs ZERO R2 ops.
  // Legacy pre-denormalization rows (etag NULL) fall back to the old head() probe.
  const inm = c.req.header('if-none-match')
  let probedEtag: string | undefined
  if (inm !== undefined) {
    let current = rowEtag
    if (current === null) {
      const probe = await c.env.GLANCE_FILES.head(storageKey)
      if (!probe) return notFound(c)
      probedEtag = probe.httpEtag
      current = probe.httpEtag
    }
    if (inm === withTheme(current)) {
      headers.set('etag', withTheme(current))
      if (isHtml) await view() // parity with the 200 path: an HTML revalidation is still a page load
      return new Response(null, { status: 304, headers })
    }
  }

  // Full 200 straight from R2, bypassing the cache — the fallout paths of a Range-carrying
  // request (multi-range / malformed spec / stale If-Range). Range requests never touch the
  // cache in either direction, so these stay off it too. decideRange may already have stamped
  // slice headers; a full body must not carry them.
  const serveFullDirect = async (): Promise<Response> => {
    headers.delete('content-range')
    headers.delete('content-length')
    const object = await c.env.GLANCE_FILES.get(storageKey)
    if (!object) return notFound(c)
    headers.set('etag', object.httpEtag)
    return new Response(object.body, { headers })
  }

  const rangeHeader = rangeable ? c.req.header('range') : undefined
  if (rangeHeader && size != null) {
    // D1 already told us the total (`files.size`), so the range is decided BEFORE any R2 op —
    // a satisfiable single range then costs exactly ONE ranged get, never a full one.
    // (`!= null` — a zero-byte object is a real size, not a falsy skip.)
    const ifRange = c.req.header('if-range')
    const decision = decideRange(rangeHeader, size, headers)
    if (decision.status === 416) {
      // The 416 must still carry the current etag — from D1 when denormalized, else ONE head()
      // probe, zero body bytes (reuse the If-None-Match probe's etag when it already paid).
      const etag = rowEtag ?? probedEtag ?? (await c.env.GLANCE_FILES.head(storageKey))?.httpEtag
      if (etag === undefined) return notFound(c)
      // A STALE If-Range means the Range no longer applies at all (RFC 7233 §3.2) → full 200.
      if (ifRange !== undefined && ifRange !== etag) return serveFullDirect()
      headers.set('etag', etag)
      return new Response(null, { status: 416, headers })
    }
    if (decision.status === 206) {
      const { start, end } = decision
      const ranged = await c.env.GLANCE_FILES.get(storageKey, { range: { offset: start, length: end - start + 1 } })
      if (!ranged) return notFound(c)
      // If-Range is checked against the etag the ranged get itself reports, so the matching
      // (common) case still costs a single R2 op; a stale one falls back to a full 200 (rare).
      if (ifRange !== undefined && ifRange !== ranged.httpEtag) return serveFullDirect()
      headers.set('etag', ranged.httpEtag)
      return new Response(ranged.body, { status: 206, headers })
    }
    // 'none' / 'multi' → full body (the request carried a Range header, so stay off the cache).
    return serveFullDirect()
  }
  if (rangeHeader) {
    // Legacy pre-size-column row (files.size NULL): the full get supplies total + etag first, so
    // a 206 here still costs full + ranged — today's exact shape, kept only for rare old rows.
    const object = await c.env.GLANCE_FILES.get(storageKey)
    if (!object) return notFound(c)
    headers.set('etag', object.httpEtag)
    const ifRange = c.req.header('if-range')
    // A stale If-Range precondition (client's cached range predates this ETag) means the Range
    // no longer applies — fall through to the full 200 body instead of a mismatched slice.
    if (!ifRange || ifRange === object.httpEtag) {
      const decision = decideRange(rangeHeader, object.size, headers)
      if (decision.status === 416) return new Response(null, { status: 416, headers })
      if (decision.status === 206) {
        const { start, end } = decision
        const ranged = await c.env.GLANCE_FILES.get(storageKey, { range: { offset: start, length: end - start + 1 } })
        if (!ranged) return notFound(c)
        return new Response(ranged.body, { status: 206, headers })
      }
    }
    return new Response(object.body, { headers })
  }

  // Full-200 read of an immutable object → served through the cache layer (live D1 auth already
  // ran in serve() — the cache is never consulted before the access gate).
  const read = await readStoredObject(c, storageKey, mime)
  if (!read) return notFound(c)
  headers.set('etag', withTheme(read.etag))
  if (isHtml) await view()
  const res = new Response(read.body, { headers })
  // Uploaded HTML gets the streamed rewrite pass (external links → new tab, theme <link>). Other
  // file types (audio, images, CSS/JS, …) stream through verbatim — the rewriter only touches HTML.
  return isHtml ? transformServedHtml(res, selfOrigin, themeHref) : res
}

// Record a page-view event without blocking the response. fireAndForget hands the D1 write to
// ctx.waitUntil in the Workers runtime (off the serving critical path) and awaits inline in tests;
// recordEvent never throws, so a failed insert can never break serving.
async function trackView(c: Ctx, db: DrizzleD1Database, e: NewEvent): Promise<void> {
  await fireAndForget(c, recordEvent(db, e))
}

// Extract the file path after the first `skip` path segments (e.g. /space/site → skip 2).
// Decodes percent-encoding and preserves a trailing slash so directories map to index.html.
export function restOf(url: string, skip: number): string {
  const pathname = new URL(url).pathname
  const trailing = pathname.endsWith('/')
  const segs = pathname
    .split('/')
    .filter(Boolean)
    .slice(skip)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  return segs.join('/') + (trailing ? '/' : '')
}

/** True for HTML files (the only anchorable type). Markdown is handled on its own branch. */
export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** Inject the annotate client + boot payload into an HTML document. The payload is the trusted
 *  server-resolved context (siteId, resolved files.path, parent origin); `<` is escaped so a
 *  path can't break out of the inline script. Inserted before </body> (else </head>, else end).
 *  `nonce` (rendered markdown only) stamps both script tags so they pass that branch's
 *  script-src 'nonce-…' CSP; uploaded HTML passes null and keeps its permissive policy. */
export function injectAnnotate(
  html: string,
  payload: { siteId: string; filePath: string; appOrigin: string },
  nonce: string | null = null,
): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  const n = nonce ? ` nonce="${nonce}"` : ''
  const tags =
    `<link rel="stylesheet" href="/_glance/annotate.css?v=${ANNOTATE_VERSION}">` +
    `<script${n}>window.__GLANCE__=${json}</script>` +
    `<script${n} src="/_glance/annotate.js?v=${ANNOTATE_VERSION}" defer></script>`
  // Replacement FUNCTIONS, not strings: `tags` embeds a user-controlled filePath, and `$&`/`$1`/`$$`
  // in a replacement STRING are special (they'd corrupt output). A function's return is used verbatim.
  if (html.includes('</body>')) return html.replace('</body>', () => `${tags}</body>`)
  if (html.includes('</head>')) return html.replace('</head>', () => `${tags}</head>`)
  // No close tag to anchor to: append after the document. The client is `defer`, so it still runs
  // after parse, and appending (never prepending) keeps any leading doctype first — no quirks flip.
  return html + tags
}

/** Inject the glance.db SDK (broker mode) into an HTML document. Goes into <head> and loads
 *  SYNCHRONOUSLY — unlike the passive annotate client, page scripts call `glance.db` directly,
 *  so the API must exist before any of them run. Boot carries only the app origin (the
 *  postMessage target); the parent decides which site requests bind to — the page can't. */
export function injectDb(html: string, appOrigin: string): string {
  const json = JSON.stringify({ appOrigin }).replace(/</g, '\\u003c')
  const tags =
    `<script>window.__GLANCE_DB__=${json}</script>` +
    `<script src="/_glance/db.js?v=${GLANCE_DB_VERSION}"></script>`
  // Replacement FUNCTIONS so any `$`-sequence inside `tags` is inserted verbatim (and `$1` stays the
  // captured <body> attributes). db.js loads SYNCHRONOUSLY, so anchor it as early as possible.
  if (html.includes('</head>')) return html.replace('</head>', () => `${tags}</head>`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, (_m, attrs) => `<body${attrs}>${tags}`)
  // No <head>/<body> to anchor to: insert right AFTER any leading doctype rather than before it —
  // prepending `tags` ahead of the doctype would push it off the first line and flip into quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return html.slice(0, doctype[0].length) + tags + html.slice(doctype[0].length)
  return tags + html
}

/** True when an anchor href points OFF this content origin — an absolute http(s) URL to another
 *  origin. Relative paths, fragments, same-origin links, and non-http(s) schemes (mailto:, tel:)
 *  are internal and left untouched. `base` is the content origin the page is served from. */
export function isExternalHref(href: string, base: string): boolean {
  let u: URL
  try {
    u = new URL(href, base)
  } catch {
    return false // unparseable (e.g. a bare fragment against a bad base) — treat as internal
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return u.origin !== new URL(base).origin
}

/** Stylesheet href for a site's stored theme, or null when unthemed. A slug retired from the
 *  registry may still sit on an old row — fail OPEN to unthemed rather than injecting a 404 link. */
export function themeHrefFor(theme: string | null): string | null {
  return theme && THEME_CSS[theme] ? `/_glance/theme/${theme}.css?v=${THEMES_VERSION}` : null
}

/** The streamed HTMLRewriter pass every served HTML document goes through — no full-body buffering.
 *  Two rewrites:
 *  1. Links to OTHER origins open in a new tab (`target="_blank"` + `rel="noopener noreferrer"`);
 *     same-site/relative links keep in-viewer navigation. Paired with the viewer iframe's
 *     `allow-popups allow-popups-to-escape-sandbox` sandbox so the new tab actually opens and isn't
 *     itself sandboxed. Only ever applied to HTML the site owns — NOT the directory-listing shell,
 *     whose `target="_top"` app links must stay as-is.
 *  2. When the site carries a theme, its stylesheet <link> is appended at the END of <head>, so it
 *     wins cascade-order ties against the page's own element rules while class/inline styling still
 *     takes precedence (classless themes are defaults, not overrides). Stored bytes are NEVER
 *     mutated — `?raw=1` bypasses this entirely. A headless document gets the link appended at the
 *     document end instead (CSS applies regardless of position; the doctype stays first). */
export function transformServedHtml(res: Response, base: string, themeHref: string | null = null): Response {
  const rewriter = new HTMLRewriter().on('a[href]', {
    element(el) {
      const href = el.getAttribute('href')
      if (href && isExternalHref(href, base)) {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }
    },
  })
  if (themeHref) {
    // themeHref is registry-derived (slug is [a-z0-9-]+, version is a hex hash) — no escaping needed.
    const link = `<link rel="stylesheet" href="${themeHref}">`
    let injected = false
    rewriter.on('head', {
      element(el) {
        el.append(link, { html: true }) // append = right before </head>
        injected = true
      },
    })
    rewriter.onDocument({
      end(end) {
        if (!injected) end.append(link, { html: true })
      },
    })
  }
  return rewriter.transform(res)
}

export function normalizePath(rest: string): string {
  const isDir = rest === '' || rest.endsWith('/')
  const cleaned = rest
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
  if (isDir || cleaned === '') return cleaned ? `${cleaned}/index.html` : 'index.html'
  return cleaned
}

// escapeHtml / safeUrl / the escaping `markdown` instance moved to lib/markdown.ts so the
// build-time What's-New bake can reuse the exact same XSS net. Re-exported here to keep
// existing importers of `./content` (and content*.test.ts) working unchanged.
export { escapeHtml, markdown } from './lib/markdown'

// Strict CSP for rendered markdown: no scripts, no plugins, no external loads. Inline
// styles are allowed because renderMarkdownDoc inlines its stylesheet; images may be
// self-hosted or data: (markdown can embed both). frame-ancestors is preserved so the
// app can still iframe the rendered doc.
// In annotate mode a `nonce` is supplied: script-src then admits EXACTLY the two injected tags
// (never 'unsafe-inline' — an unnonced script in the document still can't run), and style-src
// additionally allows 'self' so /_glance/annotate.css loads alongside the inlined shell styles.
// A THEMED site widens style-src to 'self' (the injected /_glance/theme/*.css link) plus the
// Google Fonts pair a theme's @import may pull — still a strict allowlist, and scripts stay off.
function markdownCsp(frameAncestors: string, nonce: string | null = null, themed = false): string {
  const styleSelf = nonce !== null || themed
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    styleSelf
      ? `style-src 'self' 'unsafe-inline'${themed ? ' https://fonts.googleapis.com' : ''}`
      : "style-src 'unsafe-inline'",
    themed ? 'font-src \'self\' https://fonts.gstatic.com' : "font-src 'self'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    frameAncestors,
  ].join('; ')
}

// Auto-index for a directory that has no index.html. `dir` is '' (root) or `docs/`; `paths`
// are full site paths under it. Links point at the APP viewer URL with target="_top" so a click
// breaks OUT of the content iframe — the browser address bar updates to the file's app route and
// the SPA chrome (toolbar/comments) is kept; the viewer re-mints any gated token for that path.
// Status 200 (like nginx/Apache autoindex) so it renders cleanly in the viewer iframe; never
// cached since a replace can change the file set.
function directoryListing(c: Ctx, site: string, paths: string[], dir: string): Response {
  const appBase = `${c.env.APP_URL}/${site}` // e.g. https://app.example.com/space/site
  const rels = [...new Set(paths.map((p) => p.slice(dir.length)).filter(Boolean))].sort()
  const rows = rels
    .map((rel) => {
      const full = `${dir}${rel}` // path from the SITE root, what the app route needs
      const href = `${appBase}/${full.split('/').map(encodeURIComponent).join('/')}`
      return `<li><a href="${escapeHtml(href)}" target="_top">${escapeHtml(rel)}</a></li>`
    })
    .join('')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    site,
  )}${escapeHtml(dir ? `/${dir}` : '')}</title><style>html{color-scheme:light dark}body{max-width:760px;margin:3rem auto;padding:0 1.25rem;font:15px/1.6 -apple-system,system-ui,sans-serif}h1{font-size:1.1rem;margin:0 0 .25rem}p{margin:.25rem 0 1.5rem;color:#6b7280}ul{list-style:none;padding:0;margin:0;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}li+li{border-top:1px solid #e5e7eb}a{display:block;padding:.6rem .9rem;color:#0969da;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}a:hover{background:#f6f8fa}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media(prefers-color-scheme:dark){p{color:#9ca3af}ul{border-color:#30363d}li+li{border-color:#30363d}a:hover{background:#161b22}}</style></head><body><h1>No <code>index.html</code> here</h1><p>Glance serves <code>index.html</code> at ${
    dir ? `<code>${escapeHtml(dir)}</code>` : 'the root'
  } — add one to set the landing page, or open a file below.</p><ul>${rows}</ul></body></html>`
  return c.html(html, 200, {
    'content-security-policy': `frame-ancestors 'self' ${c.env.APP_URL}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
}

function renderMarkdownDoc(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><style>html{color-scheme:light;background:#fff}body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.6 -apple-system,system-ui,sans-serif;color:#1a1a1a;background:#fff}pre{background:#f6f8fa;padding:1rem;border-radius:6px;overflow:auto}code{background:#f6f8fa;padding:.2em .4em;border-radius:3px;font-size:.9em}pre code{padding:0;background:none}a{color:#0969da}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:.4rem .8rem}</style></head><body>${body}</body></html>`
}

export default app
