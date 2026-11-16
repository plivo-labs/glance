import { Hono } from 'hono'
import { containsToken, PdfPageNotFound, parsePdfQuery, pdfDisposition, pdfPagePath, pdfPlan, type PdfRenderRequest, redactToken } from '../lib/pdf'
import { fetchAccessFacts, siteAccessFromFacts } from '../lib/site-access'
import { signToken } from '../lib/token'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// One-click "Download PDF" without the browser's print dialog: the page is loaded by a headless
// browser (Cloudflare Browser Rendering) through its normal content-worker URL and printed.
export const sitePdf = new Hono<AppEnv>()

// The headless browser only needs the token for one navigation.
const PDF_TOKEN_TTL_SEC = 120

type Renderer = (req: PdfRenderRequest) => Promise<Uint8Array>

// PDF_RENDER is the test seam (like OG_RENDER); production uses the BROWSER binding. Neither bound
// (local dev, a deploy without Browser Rendering) → null → 501 and the web app prints instead.
function pickRenderer(env: AppEnv['Bindings']): Renderer | null {
  if (env.PDF_RENDER) return env.PDF_RENDER
  const binding = env.BROWSER
  if (!binding) return null
  return async (req) => (await import('../lib/pdf-render')).renderPdf(binding, req)
}

sitePdf.use('*', requireAuth)

sitePdf.get('/:space/:site/pdf', async (c) => {
  const { space, site: siteSlug } = c.req.param()
  const user = c.get('user')
  const { facts } = await fetchAccessFacts(c.get('db'), space, siteSlug, user.id)
  const { site, access } = siteAccessFromFacts(facts, user)
  if (!site) return c.json({ error: 'not found' }, 404)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)

  const options = parsePdfQuery(c.req.query())
  if ('error' in options) return c.json({ error: options.error }, 400)
  const pagePath = pdfPagePath(c.req.query('path'))
  if (pagePath === null) return c.json({ error: 'path must be an html or markdown file in the site' }, 400)

  const render = pickRenderer(c.env)
  if (!render) return c.json({ error: 'pdf export is not enabled on this deployment' }, 501)
  if (c.env.PDF_LIMITER) {
    const { success } = await c.env.PDF_LIMITER.limit({ key: user.id })
    if (!success) return c.json({ error: 'rate limited' }, 429)
  }

  const token = await signToken(c.env.CONTENT_TOKEN_SECRET, user.id, `${space}/${siteSlug}`, PDF_TOKEN_TTL_SEC)
  // The token is minted for this site, but a relative link can climb out of it (../other-site/), so
  // the rewrite covers the whole tokened origin and sends every such link to the viewer.
  const tokenRoot = `${c.env.CONTENT_URL}/_t/${token}/`
  try {
    const pdf = await render({
      url: `${tokenRoot}${space}/${siteSlug}/${pagePath}`,
      plan: pdfPlan(options),
      themeHref: options.themeHref,
      title: site.title?.trim() || siteSlug,
      linkRewrite: { from: tokenRoot, to: `${c.env.APP_URL}/` },
    })
    // Fail closed: the rewrite and the title fallback should leave the token nowhere, and this is
    // what makes that a guarantee. The viewer falls back to the browser's print dialog.
    if (containsToken(pdf, token)) {
      console.error('sitePdf: the render still carried the content token, refusing it', { space, site: siteSlug })
      return c.json({ error: 'pdf render failed' }, 502)
    }
    return new Response(pdf as BodyInit, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': pdfDisposition(site.title, siteSlug),
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    // A path that passed validation but is not a file in the site: say so, not "render failed".
    if (err instanceof PdfPageNotFound) return c.json({ error: 'page not found' }, 404)
    console.error('sitePdf: render failed', { space, site: siteSlug, error: redactToken(err instanceof Error ? err.message : String(err)) })
    return c.json({ error: 'pdf render failed' }, 502)
  }
})
