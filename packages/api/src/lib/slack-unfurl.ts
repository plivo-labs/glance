// Slack link-unfurl lib: parse a pasted Glance URL, build the card, post it back via chat.unfurl.
// Transport, escaping, and identity lookups all come from lib/slack.ts — this file owns only what is
// unfurl-specific (URL shape, card layout).
//
// Why app-controlled unfurling instead of public Open Graph tags: the unfurl travels over Slack's
// authenticated API, so NO site metadata is ever exposed to an anonymous fetch of the URL. Sites
// stay fully gated (lib/access.ts is untouched), and we can authorize the card against the person
// who pasted the link. Docs: https://docs.slack.dev/messaging/unfurling-links-in-messages/

import { escapeSlack, slackPost, type SlackHttpDeps } from './slack'
import { RESERVED_SLUGS } from './slug'

const UNFURL_URL = 'https://slack.com/api/chat.unfurl'

/** The unfurl card as a LEGACY-style attachment, deliberately not Block Kit: Slack renders an
 *  attachment's `image_url` capped at 400×500 (the native link-preview look), while a Block Kit
 *  `image` block always stretches to the full message column — the image size is the whole
 *  reason this stays on the legacy shape. */
export type SlackAttachment = {
  title: string
  title_link: string
  text?: string
  image_url?: string
  footer: string
}

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
  spaceSlug: string
  siteSlug: string
  description: string | null
  updatedAt: string
  imageUrl?: string
}

/** One site card: linked title, the derived blurb, the brand image (400px-capped, see
 *  SlackAttachment), and a footer with space/site · freshness. The author-controlled strings
 *  (title, description) go through `escapeSlack` (Slack requires `&<>` escaped in all text);
 *  the slugs are `[a-z0-9-]` and need none. */
export function buildUnfurlAttachment(card: UnfurlCard, url: string, nowMs: number): SlackAttachment {
  const updated = relativeTime(card.updatedAt, nowMs)
  const meta = [`Glance · ${card.spaceSlug}/${card.siteSlug}`, ...(updated ? [`Updated ${updated}`] : [])]
  const attachment: SlackAttachment = {
    title: escapeSlack(card.title ?? card.siteSlug),
    title_link: url,
    footer: meta.join(' · '),
  }
  if (card.description) attachment.text = escapeSlack(card.description)
  if (card.imageUrl) attachment.image_url = card.imageUrl
  return attachment
}

/** The `link_shared` fields that say WHICH message to attach the unfurl to. `unfurl_id`+`source` is
 *  the modern pair (it also covers composer-time previews); `channel`+`ts` is the fallback for an
 *  event that carries no unfurl_id. */
export type UnfurlTarget = { unfurl_id?: string; source?: string; channel?: string; message_ts?: string }

/** The chat.unfurl POST body `postUnfurl` assembles: a target discriminant (`unfurl_id`+`source`
 *  for a link_shared event, `channel`+`ts` for a plain message) plus the per-URL card map. */
export type PostedUnfurlBody = {
  unfurl_id?: string
  source?: string
  channel?: string
  ts?: string
  unfurls: Record<string, SlackAttachment>
}

/** POST the assembled cards to chat.unfurl. Keys of `unfurls` MUST be the URLs verbatim as they
 *  appeared in the link_shared event; the nested-object form is what Slack's chat.unfurl JSON-body
 *  docs show. No cards → no request at all. */
export async function postUnfurl(
  deps: SlackHttpDeps,
  target: UnfurlTarget,
  unfurls: Record<string, SlackAttachment>,
): Promise<void> {
  if (Object.keys(unfurls).length === 0) return
  await slackPost(deps, UNFURL_URL, {
    ...(target.unfurl_id
      ? { unfurl_id: target.unfurl_id, source: target.source }
      : { channel: target.channel, ts: target.message_ts }),
    unfurls,
  })
}
