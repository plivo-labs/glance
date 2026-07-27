// Slack link-unfurl lib: parse a pasted Glance URL, build the card, post it back via chat.unfurl.
// Transport, escaping, and identity lookups all come from lib/slack.ts — this file owns only what is
// unfurl-specific (URL shape, card layout).
//
// Why app-controlled unfurling instead of public Open Graph tags: the unfurl travels over Slack's
// authenticated API, so NO site metadata is ever exposed to an anonymous fetch of the URL. Sites
// stay fully gated (lib/access.ts is untouched), and we can authorize the card against the person
// who pasted the link. Docs: https://docs.slack.dev/messaging/unfurling-links-in-messages/

import { escapeSlack, slackLink, slackPost, type SlackHttpDeps } from './slack'
import { RESERVED_SLUGS } from './slug'

const UNFURL_URL = 'https://slack.com/api/chat.unfurl'

/** A Block Kit block. Slack's schema is open-ended (dozens of block/element types), so this pins the
 *  one field every block has rather than pretending to model the union — still far tighter than the
 *  `object` it replaces. */
export type SlackBlock = { type: string } & Record<string, unknown>

/** The site slugs a pasted URL points at. Deliberately NOT the in-site file path: the card links the
 *  pasted URL verbatim, so nothing downstream needs the path split out. */
export type ParsedSiteUrl = { spaceSlug: string; siteSlug: string }

/** Parse a pasted URL into (space, site), or null when it isn't a site link on THIS instance.
 *  Rejects: another origin (a look-alike host must never be resolved against our D1), fewer than two
 *  path segments (`/dashboard`, `/:space`), and a reserved first segment (`/api/…`, `/assets/…` —
 *  never a space, see lib/slug.ts, so this skips a pointless D1 read). Slugs are `[a-z0-9-]` by
 *  `isValidSlug`, so no percent-decoding is needed to compare them. */
export function parseSiteUrl(raw: string, appUrl: string): ParsedSiteUrl | null {
  let url: URL
  let base: URL
  try {
    url = new URL(raw)
    base = new URL(appUrl)
  } catch {
    return null
  }
  if (url.origin !== base.origin) return null
  const [spaceSlug, siteSlug] = url.pathname.split('/').filter(Boolean)
  if (!spaceSlug || !siteSlug || RESERVED_SLUGS.has(spaceSlug)) return null
  return { spaceSlug, siteSlug }
}

/** Coarse "Updated …" clause for the card's context line. Sub-minute (and any clock skew that
 *  makes the timestamp look future) collapses to "just now"; an unparseable timestamp yields
 *  null so the caller drops the clause rather than rendering "NaN days ago". */
export function relativeTime(iso: string, nowMs: number): string | null {
  const diff = nowMs - Date.parse(iso)
  if (Number.isNaN(diff)) return null
  const ago = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'} ago`
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return ago(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return ago(hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 31) return ago(days, 'day')
  const months = Math.floor(days / 30)
  if (months < 12) return ago(months, 'month')
  return ago(Math.floor(months / 12), 'year')
}

/** Everything the card renders, assembled by the route from the access-facts batch. `imageUrl`
 *  is the signed brand-card PNG, absent when unavailable. */
export type UnfurlCard = {
  title: string | null
  slug: string
  description: string | null
  updatedAt: string
  imageUrl?: string
}

/** Block Kit blocks for one site card: bold linked title, the derived blurb, the brand image,
 *  and a context line with space/site · freshness. Slack renders `text` fields as mrkdwn, so the
 *  author-controlled strings (title, description) go through `escapeSlack`; the slugs are
 *  `[a-z0-9-]` and need none. */
export function buildUnfurlBlocks(card: UnfurlCard, spaceSlug: string, url: string, nowMs: number): SlackBlock[] {
  const updated = relativeTime(card.updatedAt, nowMs)
  const meta = [`Glance · ${spaceSlug}/${card.slug}`, ...(updated ? [`Updated ${updated}`] : [])]
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${slackLink(url, card.title ?? card.slug)}*` } },
    ...(card.description
      ? [{ type: 'section', text: { type: 'mrkdwn', text: escapeSlack(card.description) } } as SlackBlock]
      : []),
    ...(card.imageUrl
      ? [{ type: 'image', image_url: card.imageUrl, alt_text: card.title ?? card.slug } as SlackBlock]
      : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: meta.join(' · ') }] },
  ]
}

/** The `link_shared` fields that say WHICH message to attach the unfurl to. `unfurl_id`+`source` is
 *  the modern pair (it also covers composer-time previews); `channel`+`ts` is the fallback for an
 *  event that carries no unfurl_id. */
export type UnfurlTarget = { unfurl_id?: string; source?: string; channel?: string; message_ts?: string }

/** POST the assembled cards to chat.unfurl. Keys of `unfurls` MUST be the URLs verbatim as they
 *  appeared in the link_shared event; the nested-object form is what Slack's chat.unfurl JSON-body
 *  docs show. No cards → no request at all. */
export async function postUnfurl(
  deps: SlackHttpDeps,
  target: UnfurlTarget,
  unfurls: Record<string, { blocks: SlackBlock[] }>,
): Promise<void> {
  if (Object.keys(unfurls).length === 0) return
  await slackPost(deps, UNFURL_URL, {
    ...(target.unfurl_id
      ? { unfurl_id: target.unfurl_id, source: target.source }
      : { channel: target.channel, ts: target.message_ts }),
    unfurls,
  })
}
