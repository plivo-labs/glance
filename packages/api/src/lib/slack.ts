// Slack delivery lib: pure + dependency-injected (fetchImpl/kv like SummarizeDeps), so routes stay
// unit-testable and nothing here touches global fetch or KV directly. Layered onto the existing
// comment-notification seam as a DELIVERY channel — no new recipient logic, no schema change.

import { notificationLink } from './notification-link'

/** Why a recipient is being notified — drives the message verb. Precedence (owner > participant >
 *  share) is resolved upstream in resolveCommentAudience; here each recipient carries one reason.
 *  `mention` recipients always carry reason='mention'. */
export type SlackReason = 'mention' | 'owner' | 'participant' | 'share'

/** KV + token + fetch handle every Slack HTTP helper needs. `token` optional: unset = kill-switch. */
export type SlackHttpDeps = {
  kv: KVNamespace
  token?: string
  fetchImpl?: typeof fetch
}

const LOOKUP_URL = 'https://slack.com/api/users.lookupByEmail'
const CACHE_PREFIX = 'slackuid:'
// Positive results are stable, so cache ~30d; a definitive not-found only ~1h (the person may join
// the workspace). TTLs are product-chosen (see tracker 3.1).
const POSITIVE_TTL = 2_592_000 // 30d
const NEGATIVE_TTL = 3_600 // 1h
// Sentinel for a cached "no such Slack user" — a leading '-' is never a valid Slack id (ids are
// opaque but always alphanumeric, U…/W…), so it can never be mistaken for a DM channel.
const NEGATIVE_MARKER = '-'

const cacheKey = (email: string) => `${CACHE_PREFIX}${email.toLowerCase()}`

type LookupResponse = { ok?: boolean; error?: string; user?: { id?: unknown } }

/** Resolve a Slack user-id (usable directly as a DM channel) for an email, KV-cached. Cache hit →
 *  return (a negative marker resolves to null, never leaks as a channel). Miss → Slack
 *  users.lookupByEmail: a hit caches ~30d, a definitive `users_not_found` caches the negative marker
 *  ~1h. Transient/auth failures (5xx, network throw, 429, invalid_auth, or a malformed ok body) →
 *  null WITHOUT caching, so a later call re-attempts and never poisons on a recoverable error.
 *  Never throws. */
export async function lookupSlackId(deps: SlackHttpDeps, email: string): Promise<string | null> {
  const key = cacheKey(email)
  const cached = await deps.kv.get(key)
  if (cached !== null) return cached === NEGATIVE_MARKER ? null : cached

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  let data: LookupResponse
  try {
    const res = await fetchImpl(`${LOOKUP_URL}?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${deps.token ?? ''}` },
    })
    // Transient HTTP (rate-limit / server) — retryable, so never cache a negative.
    if (res.status === 429 || res.status >= 500) return null
    data = (await res.json()) as LookupResponse
  } catch {
    return null // network throw / bad JSON — transient, no cache
  }

  // Caching is best-effort: a KV put failure must never lose an already-resolved id (nor turn a
  // clean not-found into a thrown error) — the caller still gets to deliver this event.
  if (data.ok && typeof data.user?.id === 'string') {
    await deps.kv.put(key, data.user.id, { expirationTtl: POSITIVE_TTL }).catch(() => {})
    return data.user.id
  }
  if (data.error === 'users_not_found') {
    await deps.kv.put(key, NEGATIVE_MARKER, { expirationTtl: NEGATIVE_TTL }).catch(() => {})
    return null
  }
  // invalid_auth, other errors, or ok-but-no-id → transient/unknown; return null without caching.
  return null
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

// Slack mrkdwn only reserves &, <, > in message text (order matters — & first).
const escapeSlack = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The verb clause per reason (owner > participant > share precedence is decided upstream). The
// wording is Slack-only — the in-app bell keeps its terse "commented" (no schema change).
const VERB: Record<SlackReason, (siteLabel: string) => string> = {
  mention: (s) => `mentioned you in a comment on ${s}`,
  owner: (s) => `commented on your site ${s}`,
  participant: (s) => `replied in a thread you commented on · ${s}`,
  share: (s) => `commented on ${s}`,
}

/** Build the Slack DM text: `{actor} {verb clause}`, an optional quoted snippet line, then the
 *  absolute deep link. Actor falls back name → email → "Someone"; the snippet is HTML-escaped and a
 *  null/blank snippet simply drops the quote line so the message is never empty (Slack rejects an
 *  empty `text` with no_text). */
export function formatSlackMessage(input: SlackMessageInput, appUrl: string): string {
  const actor = escapeSlack(input.actorName ?? input.actorEmail ?? 'Someone')
  const link = notificationLink(appUrl, {
    siteLabel: input.siteLabel,
    filePath: input.filePath,
    threadId: input.threadId,
  })
  const lines = [`${actor} ${VERB[input.reason](escapeSlack(input.siteLabel))}`]
  const snippet = input.snippet ? escapeSlack(input.snippet).trim() : ''
  if (snippet) lines.push(`> ${snippet}`)
  lines.push(link)
  return lines.join('\n')
}

const POST_URL = 'https://slack.com/api/chat.postMessage'
// Slack DMs per comment event, mentions first. Bounds the blast radius of a wide @-everyone or a
// large shared audience — the same cap the in-app fan-out already lives under.
const MAX_DMS_PER_EVENT = 15

/** A resolved delivery target: the D1 recipient id, their email (for the Slack lookup — null when
 *  unknown), and why they're being notified (drives the verb + mention priority). */
export type SlackRecipient = { id: string; email: string | null; reason: SlackReason }

/** deliverSlack's deps: the HTTP/KV handles plus the absolute-link base. */
export type SlackDeps = SlackHttpDeps & { appUrl: string }

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
  if (!deps.token || deps.token.trim() === '') return
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  for (const r of capMentionFirst(recipients)) {
    try {
      if (!r.email) continue
      const channel = await lookupSlackId(deps, r.email)
      if (!channel) continue
      const text = formatSlackMessage({ ...event, reason: r.reason }, deps.appUrl)
      // Best-effort post: every non-success outcome (429/5xx or an ok:false body) means "this DM
      // didn't land" — there's nothing to retry and nothing to do differently, so we just move on.
      // A network throw lands in the catch below. Neither ever aborts the remaining recipients.
      await fetchImpl(POST_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text }),
      })
    } catch {
      // Per-recipient isolation — swallow so one bad DM never fails the comment that already committed.
    }
  }
}
