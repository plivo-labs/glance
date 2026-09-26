// Slack delivery lib: pure + dependency-injected (fetchImpl/kv like SummarizeDeps), so routes stay
// unit-testable and nothing here touches global fetch or KV directly. Layered onto the existing
// comment-notification seam as a DELIVERY channel — no new recipient logic, no schema change.

import type { Bindings } from '../types'
import { notificationLink } from './notification-link'
import { describeError } from './errors'

/** Why a recipient is being notified — drives the message verb. Precedence (owner > participant >
 *  share) is resolved upstream in resolveCommentAudience; here each recipient carries one reason.
 *  `mention` recipients always carry reason='mention'. `shared` is the non-comment event: a site
 *  was just directly shared with the recipient (notifyForShare). */
export type SlackReason = 'mention' | 'owner' | 'participant' | 'share' | 'shared'

/** KV + token + fetch handle every Slack HTTP helper needs. `token` optional: unset = kill-switch. */
export type SlackHttpDeps = {
  kv: KVNamespace
  token?: string
  fetchImpl?: typeof fetch
}

/** The Slack kill-switch predicate: a present, non-blank bot token. Shared by deliverSlack's
 *  line-one no-op and the route's zero-work gate so "off" means the same at both boundaries (a
 *  whitespace-only token is OFF everywhere, never doing wasted D1/HTTP work). */
export const slackEnabled = (token?: string): boolean => !!token && token.trim() !== ''

/** The unfurl surface needs BOTH secrets — the bot token to post the card and the signing secret to
 *  authenticate Slack's inbound request — and both must mean "off" the same way, so a whitespace-only
 *  secret goes dark rather than leaving the endpoint live behind a guessable key. Shape mirrors
 *  `isGoogleEnabled`. */
export const slackUnfurlEnabled = (env: Pick<Bindings, 'SLACK_BOT_TOKEN' | 'SLACK_SIGNING_SECRET'>): boolean =>
  slackEnabled(env.SLACK_BOT_TOKEN) && slackEnabled(env.SLACK_SIGNING_SECRET)

const LOOKUP_URL = 'https://slack.com/api/users.lookupByEmail'
const INFO_URL = 'https://slack.com/api/users.info'
const CACHE_PREFIX = 'slackuid:'
const EMAIL_CACHE_PREFIX = 'slackemail:'
// Positive results are stable, so cache ~30d; a definitive not-found only ~1h (the person may join
// the workspace). TTLs are product-chosen (see tracker 3.1).
const POSITIVE_TTL = 2_592_000 // 30d
const NEGATIVE_TTL = 3_600 // 1h
// Sentinel for a cached "no such Slack user" — a leading '-' is never a valid Slack id (ids are
// opaque but always alphanumeric, U…/W…), so it can never be mistaken for a DM channel.
const NEGATIVE_MARKER = '-'

const cacheKey = (email: string) => `${CACHE_PREFIX}${email.toLowerCase()}`

type LookupResponse = { ok?: boolean; error?: string; user?: { id?: unknown; profile?: { email?: unknown } } }

/** Slack GET with the bot token. Returns the parsed body, or null when the call failed in a way the
 *  caller must treat as RETRYABLE (429, 5xx, network throw, unparseable body) — never as an answer.
 *  Every Slack read goes through here so the transient-failure policy is stated exactly once. */
async function slackGet(deps: SlackHttpDeps, url: string): Promise<LookupResponse | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${deps.token ?? ''}` } })
    if (res.status === 429 || res.status >= 500) return null
    return (await res.json()) as LookupResponse
  } catch {
    return null
  }
}

/** Slack POST with a JSON body. Best-effort by contract: every failure mode (non-2xx, `{ok:false}`,
 *  network throw) means "this message didn't land", and there is nothing to retry or report — so it
 *  returns nothing and never throws. */
export async function slackPost(deps: SlackHttpDeps, url: string, body: unknown): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.token ?? ''}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

/** What a lookup response means, as the caching policy sees it: a resolved value, a DEFINITIVE miss
 *  (worth remembering briefly), or a transient failure (never cached). */
type LookupOutcome = { value: string } | 'not-found' | 'transient'

/** KV-cached Slack identity lookup, shared by both directions (email→id, id→email). Cache hit →
 *  return (the negative marker resolves to null, never leaking as a channel id). Miss → one
 *  `slackGet`, then: a value caches ~30d, a definitive miss caches the marker ~1h (so a bot or
 *  email-less guest doesn't re-hit Slack on every event), and a transient failure caches NOTHING so
 *  a later call re-attempts. Caching is best-effort — a KV put failure must never lose an already
 *  resolved value. Never throws. */
async function cachedLookup(
  deps: SlackHttpDeps,
  key: string,
  url: string,
  read: (data: LookupResponse) => LookupOutcome,
): Promise<string | null> {
  const cached = await deps.kv.get(key)
  if (cached !== null) return cached === NEGATIVE_MARKER ? null : cached

  const data = await slackGet(deps, url)
  const outcome = data === null ? 'transient' : read(data)
  if (outcome === 'transient') return null
  if (outcome === 'not-found') {
    await deps.kv.put(key, NEGATIVE_MARKER, { expirationTtl: NEGATIVE_TTL }).catch((err) =>
      console.error('slack: kv put (negative) failed', describeError(err)),
    )
    return null
  }
  await deps.kv.put(key, outcome.value, { expirationTtl: POSITIVE_TTL }).catch((err) =>
    console.error('slack: kv put failed', describeError(err)),
  )
  return outcome.value
}

/** Resolve a Slack user-id (usable directly as a DM channel) for an email. */
export function lookupSlackId(deps: SlackHttpDeps, email: string): Promise<string | null> {
  return cachedLookup(deps, cacheKey(email), `${LOOKUP_URL}?email=${encodeURIComponent(email)}`, (data) => {
    if (data.ok && typeof data.user?.id === 'string') return { value: data.user.id }
    // `users_not_found` is definitive; invalid_auth / other errors / ok-but-no-id are not.
    return data.error === 'users_not_found' ? 'not-found' : 'transient'
  })
}

/** Resolve the profile email of a Slack user-id — the inverse binding, used to map whoever shared a
 *  link back onto a Glance account. An `ok` response with no readable email is DEFINITIVE (a bot, a
 *  guest, or a workspace that never granted `users:read.email`), not a transient failure. */
export function lookupSlackEmail(deps: SlackHttpDeps, userId: string): Promise<string | null> {
  return cachedLookup(deps, `${EMAIL_CACHE_PREFIX}${userId}`, `${INFO_URL}?user=${encodeURIComponent(userId)}`, (data) => {
    if (!data.ok) return 'transient'
    const email = data.user?.profile?.email
    return typeof email === 'string' && email !== '' ? { value: email } : 'not-found'
  })
}

/** The per-event context shared by every DM: the actor and the link/snippet fields. */
export type SlackEvent = {
  actorName: string | null
  actorEmail: string | null
  siteLabel: string
  filePath: string | null
  threadId: string | null
  snippet: string | null
}

/** Everything the message text needs: the per-event context (SlackEvent) plus the recipient's
 *  `reason`, which drives the verb. `actorEmail` is the fallback when `actorName` is null; the link
 *  fields feed notificationLink; `snippet` is the already-truncated comment body (may be null/empty). */
export type SlackMessageInput = SlackEvent & { reason: SlackReason }

// Slack mrkdwn only reserves &, <, > in message text (order matters — & first). Exported because
// EVERY Slack-wire string (DM text, unfurl card blocks) must pass through this one copy.
export const escapeSlack = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Slack's hyperlink idiom, `<url|label>`. The `&` in a query string must be entity-escaped even
 *  inside the URL (mrkdwn's rule), and the label is escaped like any other text. */
export const slackLink = (url: string, label: string): string =>
  `<${url.replace(/&/g, '&amp;')}|${escapeSlack(label)}>`

// The verb clause per reason (owner > participant > share precedence is decided upstream). The
// wording is Slack-only — the in-app bell keeps its terse "commented" (no schema change).
const VERB: Record<SlackReason, (siteLabel: string) => string> = {
  mention: (s) => `mentioned you in a comment on ${s}`,
  owner: (s) => `commented on your site ${s}`,
  participant: (s) => `replied in a thread you commented on · ${s}`,
  share: (s) => `commented on ${s}`,
  shared: (s) => `shared ${s} with you`,
}

/** Build the Slack DM text: `*{actor}* {verb clause}` where the site label is a BOLD hyperlink
 *  (`<url|label>`) to the review thread, then an optional italic block-quoted snippet. Actor falls
 *  back name → email → "Someone"; snippet is HTML-escaped and a null/blank snippet drops the quote
 *  line so the message is never empty (Slack rejects an empty `text` with no_text). The deep link
 *  rides the site label — no trailing raw URL. */
export function formatSlackMessage(input: SlackMessageInput, appUrl: string): string {
  const actor = `*${escapeSlack(input.actorName ?? input.actorEmail ?? 'Someone')}*`
  const url = notificationLink(appUrl, {
    siteLabel: input.siteLabel,
    filePath: input.filePath,
    threadId: input.threadId,
  })
  const site = `*${slackLink(url, input.siteLabel)}*` // bold hyperlink
  const lines = [`${actor} ${VERB[input.reason](site)}`]
  const snippet = input.snippet ? escapeSlack(input.snippet).trim() : ''
  if (snippet) lines.push(`> _${snippet}_`) // block-quoted + italic
  return lines.join('\n')
}

// Slack DMs can carry far more than the in-app feed's 200-char snippet (chat.postMessage allows
// ~40k chars of text), so the Slack quote gets its own, roomier cap — 1500 keeps a long comment
// readable in the DM without flooding it.
export const SLACK_SNIPPET_LENGTH = 1_500

const POST_URL = 'https://slack.com/api/chat.postMessage'
// Cap on Slack DMs per comment event, mentions first — bounds the blast radius of a wide @-everyone
// or a large shared audience. Slack-ONLY: the in-app fan-out (createNotifications) is intentionally
// uncapped, so an audience >15 gets in-app bells for everyone but Slack DMs for the first 15
// (mentions prioritized).
const MAX_DMS_PER_EVENT = 15

/** A resolved delivery target: the D1 recipient id, their email (for the Slack lookup — null when
 *  unknown), and why they're being notified (drives the verb + mention priority). */
export type SlackRecipient = { id: string; email: string | null; reason: SlackReason }

/** deliverSlack's deps: the HTTP/KV handles plus the absolute-link base. */
export type SlackDeps = SlackHttpDeps & { appUrl: string }

/** Build deliverSlack's deps from the worker env: the sessions KV, the bot token, the app origin,
 *  and the injected fetch (SLACK_FETCH is the test seam — unset in prod → deliverSlack's global-fetch
 *  fallback). */
export const slackDepsFromEnv = (
  env: Pick<Bindings, 'GLANCE_SESSIONS' | 'SLACK_BOT_TOKEN' | 'APP_URL' | 'SLACK_FETCH'>,
): SlackDeps => ({
  kv: env.GLANCE_SESSIONS,
  token: env.SLACK_BOT_TOKEN,
  appUrl: env.APP_URL,
  fetchImpl: env.SLACK_FETCH,
})

/** Mentions first (priority, NOT array order), de-duplicated by recipient id (mention wins the tie),
 *  then truncated to the per-event cap. */
function capMentionFirst(recipients: SlackRecipient[]): SlackRecipient[] {
  const ordered = [
    ...recipients.filter((r) => r.reason === 'mention'),
    ...recipients.filter((r) => r.reason !== 'mention'),
  ]
  const seen = new Set<string>()
  const deduped = ordered.filter((r) => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })
  return deduped.slice(0, MAX_DMS_PER_EVENT)
}

/** Fan one comment event out to Slack DMs. Token absent/blank → no-op on line one (0 KV, 0 HTTP),
 *  so the whole feature is inert without a bot token — this MUST stay first (the test harness awaits
 *  fireAndForget inline). Otherwise mention-first cap 15, then per recipient: skip if no email,
 *  resolve the Slack id (skip if unresolvable), post sequentially — EACH in its own try/catch so one
 *  failure (429/5xx/{ok:false}/network throw) skips just that recipient and never aborts the fan-out
 *  or surfaces to the caller. Never throws. */
export async function deliverSlack(deps: SlackDeps, event: SlackEvent, recipients: SlackRecipient[]): Promise<void> {
  if (!slackEnabled(deps.token)) return
  for (const r of capMentionFirst(recipients)) {
    try {
      if (!r.email) continue
      const channel = await lookupSlackId(deps, r.email)
      if (!channel) continue
      // slackPost is best-effort by contract (see its docstring); the try/catch here is the
      // per-recipient isolation for the lookup, so one bad DM never aborts the remaining fan-out.
      await slackPost(deps, POST_URL, { channel, text: formatSlackMessage({ ...event, reason: r.reason }, deps.appUrl) })
    } catch {
      // Per-recipient isolation — swallow so one bad DM never fails the comment that already committed.
    }
  }
}
