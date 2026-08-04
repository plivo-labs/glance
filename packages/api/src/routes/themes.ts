import { Hono } from 'hono'
import { THEME_BRIEFS } from '../themes/briefs'
import { THEME_INFO } from '../themes/registry'

// Design-theme catalog. Public GETs registered BEFORE the /api/* guards (the /api/install
// idiom): no DB, no auth — a brief is design documentation, and the agent loop fetches it with
// plain curl (`curl $GLANCE_API_URL/api/themes/plivo/DESIGN.md`) before generating themed HTML.
// The list feeds the deploy panel's theme picker and the viewer's theme switcher.
export const themes = new Hono()

// GET /api/themes — the catalog: slug + display name + one-line description per theme.
themes.get('/', (c) =>
  c.json({ themes: THEME_INFO }, 200, {
    // Cacheable but short-lived: the catalog only changes on deploy, and a stale minute is harmless.
    'cache-control': 'public, max-age=60',
  }),
)

// GET /api/themes/:slug/DESIGN.md — the full agent brief (frontmatter tokens + prose guardrails).
themes.get('/:slug/DESIGN.md', (c) => {
  const brief = THEME_BRIEFS[c.req.param('slug')]
  if (!brief) return c.json({ error: 'unknown theme' }, 404)
  return c.text(brief, 200, {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': 'public, max-age=60',
  })
})
