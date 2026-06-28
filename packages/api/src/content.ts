import { and, eq } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { type Context, Hono } from 'hono'
import { Marked } from 'marked'
import { ANNOTATE_CSS, ANNOTATE_JS, ANNOTATE_VERSION } from './annotate/bundle'
import { isSpaceMember, resolveIsShared, toSessionUser } from './db/repo'
import { files, sites, spaces, users } from './db/schema'
import { checkAccess } from './lib/access'
import { verifyToken } from './lib/token'
import type { Bindings } from './types'

// `db` is optional: production runs no middleware that sets it, so getDb() falls back to a
// request-scoped client built from the D1 binding; tests inject the in-memory harness db.
type ContentEnv = { Bindings: Bindings; Variables: { db?: DrizzleD1Database } }
type Ctx = Context<ContentEnv>

// Content worker (glance-content.<acct>.workers.dev): streams uploaded file bytes from
// R2. Separate origin so untrusted uploaded HTML/JS can never reach the main app's
// session cookie. Gated sites carry an HMAC token IN THE PATH (/_t/<token>/...) so
// relative sub-resources inherit it without cookies — survives 3rd-party-cookie blocking.
const app = new Hono<ContentEnv>()

// Per-request drizzle client. The D1 binding is request-scoped, so the client must not be
// memoized across requests; tests inject a harness db via c.set('db').
function getDb(c: Ctx): DrizzleD1Database {
  return c.get('db') ?? drizzle(c.env.GLANCE_DB)
}

// A 404 on the content origin must never be cached. Right after an upload a read can miss
// transiently (edge/timing); a cached 404 would then outlive the miss and strand a freshly
// published site. `no-store` keeps every not-found re-checked against live state.
function notFound(c: Ctx): Response {
  return c.text('404 Not Found', 404, { 'cache-control': 'no-store' })
}

app.get('/', (c) => c.text('Glance content origin', 200))

// Annotate-mode client assets. Registered BEFORE the /:space/:site/* catch-all so `_glance`
// isn't captured as a space slug. Long-cache + content-versioned query (?v=) makes them
// immutable per build. The bundle is the string produced by scripts/build-annotate.ts.
const IMMUTABLE = 'public, max-age=31536000, immutable'
app.get('/_glance/annotate.js', (c) =>
  c.body(ANNOTATE_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': IMMUTABLE }),
)
app.get('/_glance/annotate.css', (c) =>
  c.body(ANNOTATE_CSS, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': IMMUTABLE }),
)

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

// Public access: only `public` sites are served without a token. Path: /<space>/<site>/<rest>
app.get('/:space/:site/*', (c) => serve(c, c.req.param('space'), c.req.param('site'), restOf(c.req.url, 2), null))

// `userId` is the token-bound viewer for gated requests, or null for public requests.
async function serve(c: Ctx, spaceSlug: string, siteSlug: string, rest: string, userId: string | null): Promise<Response> {
  const db = getDb(c)
  const siteRow = (
    await db
      .select({
        id: sites.id,
        spaceId: sites.spaceId,
        visibility: sites.visibility,
        status: sites.status,
        ownerId: sites.ownerId,
      })
      .from(sites)
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
      .where(and(eq(spaces.slug, spaceSlug), eq(sites.slug, siteSlug)))
      .limit(1)
  )[0]
  if (!siteRow) return notFound(c)
  if (siteRow.status === 'archived') return c.text('This site has been archived', 410)

  if (userId === null) {
    // Public path: no token, so only `public` sites are allowed.
    if (siteRow.visibility !== 'public') return c.text('Forbidden', 403)
  } else {
    // Gated path: reconstruct the bound user from D1 and re-authorize against live state.
    const userRow = (
      await db
        .select({ id: users.id, email: users.email, name: users.name, role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )[0]
    if (!userRow) return c.text('Forbidden', 403)
    const user = toSessionUser(userRow)
    const isMember = await isSpaceMember(db, siteRow.spaceId, user.id)
    const isShared = await resolveIsShared(db, siteRow.id, user.id)
    const access = checkAccess(siteRow, user, isMember, isShared)
    if (!access.ok) return c.text('Forbidden', access.status)
  }

  const reqPath = normalizePath(rest)
  const cols = { path: files.path, storageKey: files.storageKey, mimeType: files.mimeType }
  let file = (
    await db.select(cols).from(files).where(and(eq(files.siteId, siteRow.id), eq(files.path, reqPath))).limit(1)
  )[0]

  // Single-file site: when the root has no index.html, serve the one uploaded file.
  // (Dropping a lone `report.html` should still render at the site root.)
  if (!file && reqPath === 'index.html') {
    const all = await db.select(cols).from(files).where(eq(files.siteId, siteRow.id)).limit(2)
    if (all.length === 1) file = all[0]
  }
  if (!file) return notFound(c)

  const object = await c.env.GLANCE_FILES.get(file.storageKey)
  if (!object) return notFound(c)

  const frameAncestors = `frame-ancestors 'self' ${c.env.APP_URL}`

  // Markdown → rendered HTML (served as text/html). Use the RESOLVED file's path for
  // type detection so a single `.md` file rendered at the root still renders. Raw HTML in
  // the source is escaped (see `markdown`), and a strict CSP is applied as defense-in-depth.
  if (/\.(md|markdown)$/i.test(file.path)) {
    const html = await markdown.parse(await object.text())
    return c.html(renderMarkdownDoc(file.path, html), 200, {
      'content-security-policy': markdownCsp(frameAncestors),
      'referrer-policy': 'no-referrer',
    })
  }

  // Annotate mode: gated (non-public) HTML + ?glance_annotate=1 → buffer the body and inject the
  // annotate client + boot payload. Public sites have no comments, so the flag is ignored there
  // (userId === null). The bytes change, so we DROP the ETag and don't cache.
  if (userId !== null && c.req.query('glance_annotate') === '1' && isHtmlFile(file.path)) {
    const injected = injectAnnotate(await object.text(), {
      siteId: siteRow.id,
      filePath: file.path, // the RESOLVED path (single-file fallback), not the URL guess
      appOrigin: c.env.APP_URL,
    })
    return c.html(injected, 200, {
      'content-security-policy': frameAncestors,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    })
  }

  const headers = new Headers()
  headers.set('content-type', contentType(file.path, file.mimeType))
  headers.set('etag', object.httpEtag)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('content-security-policy', frameAncestors)
  // Uploaded HTML lives at a path that carries the gated-content token; no-referrer stops
  // that token leaking to third parties via the Referer header on outbound requests.
  headers.set('referrer-policy', 'no-referrer')
  return new Response(object.body, { headers })
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
 *  path can't break out of the inline script. Inserted before </body> (else </head>, else end). */
export function injectAnnotate(html: string, payload: { siteId: string; filePath: string; appOrigin: string }): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  const tags =
    `<link rel="stylesheet" href="/_glance/annotate.css?v=${ANNOTATE_VERSION}">` +
    `<script>window.__GLANCE__=${json}</script>` +
    `<script src="/_glance/annotate.js?v=${ANNOTATE_VERSION}" defer></script>`
  if (html.includes('</body>')) return html.replace('</body>', `${tags}</body>`)
  if (html.includes('</head>')) return html.replace('</head>', `${tags}</head>`)
  return html + tags
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

const EXT_MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain',
  xml: 'application/xml',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
}

// Textual types are stored as UTF-8; pin the charset in the header so the browser never
// falls back to a locale default (latin-1) and double-decodes UTF-8 bytes into mojibake.
function withCharset(mime: string): string {
  return /^text\/|\/(json|xml|javascript|svg\+xml)$/.test(mime) ? `${mime}; charset=utf-8` : mime
}

// Static-hosting content-type: prefer the extension (authoritative), fall back to the
// stored upload type, then octet-stream.
export function contentType(path: string, stored: string | null): string {
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : ''
  if (EXT_MIME[ext]) return withCharset(EXT_MIME[ext])
  if (stored && stored !== 'application/octet-stream') return withCharset(stored)
  return 'application/octet-stream'
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  )
}

// Neutralize dangerous link/image URL schemes (javascript:, vbscript:, data: in links, …)
// while leaving relative paths, fragments, and http(s)/mailto intact. `data:` is allowed
// only for images, where the CSP img-src already permits it. Anything with a disallowed
// scheme collapses to a harmless target.
function safeUrl(href: string, allowData: boolean): string {
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(href)
  if (!m) return href // relative / fragment / scheme-less — safe
  const scheme = m[1].toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return href
  if (allowData && scheme === 'data') return href
  return allowData ? '' : '#'
}

// Isolated marked instance that ESCAPES raw HTML instead of passing it through. Both
// block-level (`Tokens.HTML`) and inline (`Tokens.Tag`) raw-HTML tokens render via the
// `html` method, so escaping its `text` neutralizes `<script>`, `<img onerror>`, etc.
// `walkTokens` additionally scrubs unsafe schemes from `[text](url)` / `![alt](url)` before
// rendering, so e.g. `[x](javascript:alert(1))` can't produce a live javascript: URL.
// Normal markdown (headings, code, links, images, tables) is unaffected.
export const markdown = new Marked({
  renderer: { html: ({ text }) => escapeHtml(text) },
  walkTokens: (token) => {
    if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string') {
      token.href = safeUrl(token.href, token.type === 'image')
    }
  },
})

// Strict CSP for rendered markdown: no scripts, no plugins, no external loads. Inline
// styles are allowed because renderMarkdownDoc inlines its stylesheet; images may be
// self-hosted or data: (markdown can embed both). frame-ancestors is preserved so the
// app can still iframe the rendered doc.
function markdownCsp(frameAncestors: string): string {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    "font-src 'self'",
    "script-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    frameAncestors,
  ].join('; ')
}

function renderMarkdownDoc(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><style>html{color-scheme:light;background:#fff}body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.6 -apple-system,system-ui,sans-serif;color:#1a1a1a;background:#fff}pre{background:#f6f8fa;padding:1rem;border-radius:6px;overflow:auto}code{background:#f6f8fa;padding:.2em .4em;border-radius:3px;font-size:.9em}pre code{padding:0;background:none}a{color:#0969da}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:.4rem .8rem}</style></head><body>${body}</body></html>`
}

export default app
