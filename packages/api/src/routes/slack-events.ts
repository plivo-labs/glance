import { type Context, Hono } from 'hono'
import { getUserByEmail, toSessionUser } from '../db/repo'
import { fireAndForget } from '../lib/events'
import { ogImageUrl, signOgSig } from '../lib/og-image'
import { fetchAccessFacts, siteAccessFromFacts } from '../lib/site-access'
import { lookupSlackEmail, slackDepsFromEnv, slackUnfurlEnabled } from '../lib/slack'
import {
  buildUnfurlBlocks,
  parseSiteUrl,
  type ParsedSiteUrl,
  postUnfurl,
  type SlackBlock,
  type UnfurlCard,
  type UnfurlTarget,
} from '../lib/slack-unfurl'
import { verifySlackSignature } from '../lib/slack-verify'
import type { AppEnv } from '../types'

// Slack Events API endpoint (mounted at /api/slack), handling `link_shared` → chat.unfurl.
//
// Auth: Slack sends no cookie and no Origin, so requireSameOrigin passes it through (it only guards
// COOKIE-authed unsafe methods) — the HMAC signature is the whole gate, and an unsigned request
// never reaches any D1 read. Both Slack secrets must be set or the route is inert (404), matching
// how Google OAuth and the data plane go dark when unconfigured.

export const slackEvents = new Hono<AppEnv>()

// Bound the work one event can trigger, counted in SITES actually resolved (not raw links, which are
// filtered first) — five cards is already more than a channel wants to read.
const MAX_SITES_PER_EVENT = 5

type LinkSharedEvent = UnfurlTarget & { type?: string; user?: string; links?: { url?: unknown }[] }
type SlackEnvelope = { type?: string; challenge?: string; event?: LinkSharedEvent }

slackEvents.post('/events', async (c) => {
  if (!slackUnfurlEnabled(c.env)) return c.notFound()

  // The RAW body is what Slack signed — read it as text and parse only after verifying. Re-encoding
  // a parsed object would change the bytes and break every signature.
  const body = await c.req.text()
  const verified = await verifySlackSignature({
    signingSecret: c.env.SLACK_SIGNING_SECRET ?? '',
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    body,
    nowSeconds: Math.floor(Date.now() / 1000),
  })
  if (!verified) return c.json({ error: 'bad signature' }, 401)

  let envelope: SlackEnvelope
  try {
    envelope = JSON.parse(body) as SlackEnvelope
  } catch {
    return c.json({ error: 'bad request' }, 400)
  }

  // One-time handshake when you paste the Request URL into the Slack app config.
  if (envelope.type === 'url_verification') return c.json({ challenge: envelope.challenge ?? '' })

  const event = envelope.event
  if (envelope.type !== 'event_callback' || event?.type !== 'link_shared') return c.body(null, 200)

  // Slack wants a 200 immediately; the resolve + post rides waitUntil (awaited inline under the test
  // harness, which has no executionCtx). A throw in there can never fail the ack.
  await fireAndForget(c, unfurlLinks(c, event))
  return c.body(null, 200)
})

/** The distinct sites a message linked to, each with the URLs that pointed at it. Two deep links into
 *  one site (`/space/site` + `/space/site/report.html` — the common paste) resolve that site ONCE and
 *  fan the result back onto both URLs, since Slack keys unfurls by URL. */
function siteTargets(event: LinkSharedEvent, appUrl: string): { parsed: ParsedSiteUrl; urls: string[] }[] {
  const bySite = new Map<string, { parsed: ParsedSiteUrl; urls: string[] }>()
  for (const link of event.links ?? []) {
    if (typeof link.url !== 'string') continue
    const parsed = parseSiteUrl(link.url, appUrl)
    if (!parsed) continue
    const key = `${parsed.spaceSlug}/${parsed.siteSlug}`
    const target = bySite.get(key) ?? { parsed, urls: [] }
    if (!target.urls.includes(link.url)) target.urls.push(link.url)
    bySite.set(key, target)
  }
  return [...bySite.values()].slice(0, MAX_SITES_PER_EVENT)
}

/** Resolve every linked site the SHARER is allowed to see and post the cards.
 *
 *  The access check is deliberately on the person who pasted the link, not each channel member:
 *  chat.unfurl renders one card for the whole channel, so there is no per-viewer rendering to
 *  authorize. This means pasting a link you cannot open produces NO card at all (no title, no
 *  existence signal), while a link you can open shows its title to that channel — the same thing
 *  that would happen if you typed the title out yourself. */
async function unfurlLinks(c: Context<AppEnv>, event: LinkSharedEvent): Promise<void> {
  // Parse first: URL parsing is free, while resolving the sharer costs a KV read, a Slack subrequest,
  // and a D1 round trip. A message whose links aren't Glance sites must cost none of that.
  const targets = siteTargets(event, c.env.APP_URL)
  if (targets.length === 0 || !event.user) return

  const deps = slackDepsFromEnv(c.env)
  // No email → no way to map the sharer onto a Glance identity → fail closed (no card).
  const email = await lookupSlackEmail(deps, event.user)
  if (!email) return
  const db = c.get('db')
  const row = await getUserByEmail(db, email)
  if (!row) return
  const user = toSessionUser(row)

  // One batched access read per site, all in flight together — the sites are independent, and D1's
  // primary is far enough away that serializing these would dominate the whole handler.
  const now = Date.now()
  const cards = await Promise.all(
    targets.map(async ({ parsed, urls }) => {
      // checkAccess is the single source of truth (lib/access.ts) — archived sites and every
      // visibility tier resolve exactly as they do in the app and the content worker.
      const { facts } = await fetchAccessFacts(db, parsed.spaceSlug, parsed.siteSlug, user.id)
      const { site, access } = siteAccessFromFacts(facts, user)
      if (!site || !access.ok) return []
      // The card image is fetched by Slack unauthenticated, so its URL carries an HMAC minted
      // HERE — only sites that already passed the sharer's access check ever get a signed URL.
      // CONTENT_TOKEN_SECRET because the image is served by the CONTENT worker (lib/og-image.ts).
      const sig = await signOgSig(c.env.CONTENT_TOKEN_SECRET, parsed.spaceSlug, parsed.siteSlug)
      const card: UnfurlCard = {
        title: site.title,
        slug: site.slug,
        description: site.description,
        updatedAt: site.updatedAt,
        imageUrl: ogImageUrl(c.env.CONTENT_URL, parsed.spaceSlug, parsed.siteSlug, sig),
      }
      return urls.map((url) => [url, { blocks: buildUnfurlBlocks(card, parsed.spaceSlug, url, now) }] as const)
    }),
  )

  await postUnfurl(deps, event, Object.fromEntries(cards.flat()) as Record<string, { blocks: SlackBlock[] }>)
}
