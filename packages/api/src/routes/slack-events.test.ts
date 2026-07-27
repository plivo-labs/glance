import { describe, expect, test } from 'bun:test'
import { APP_URL, makeRouteApp, signSlack } from '../test/route-fixtures'
import { seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'

// Route-level Slack unfurl: a signed link_shared event → chat.unfurl, exercised through
// app.request with an injected SLACK_FETCH (the same env DI seam comments-slack.test.ts uses).
// In app.request there is no executionCtx, so fireAndForget awaits inline — the unfurl is already
// posted by the time the 200 resolves.

const TEST_SIGNING_KEY = 'not-a-real-slack-signing-key'
const NOW = () => Math.floor(Date.now() / 1000)

/** Recording SLACK_FETCH: users.info answers from `emails` (Slack id → email), chat.unfurl records
 *  the posted body. Any other Slack URL is a test bug and throws. */
function slackFetch(emails: Record<string, string> = {}) {
  const unfurls: Record<string, unknown>[] = []
  let infoCalls = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('users.info')) {
      infoCalls++
      const id = new URL(url).searchParams.get('user') ?? ''
      const email = emails[id]
      return email
        ? Response.json({ ok: true, user: { profile: { email } } })
        : Response.json({ ok: false, error: 'user_not_found' })
    }
    if (url.includes('chat.unfurl')) {
      unfurls.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true })
    }
    throw new Error(`unexpected slack url: ${url}`)
  }) as unknown as typeof fetch
  return { fetchImpl, unfurls, infoCalls: () => infoCalls }
}

/** The production-shaped fixture env plus the two Slack secrets; `extra` overrides either (or
 *  injects the recording SLACK_FETCH). */
const envWith = (env: AppEnv['Bindings'], extra: Record<string, unknown>) =>
  ({ ...env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: TEST_SIGNING_KEY, ...extra }) as unknown as AppEnv['Bindings']

async function post(
  app: ReturnType<typeof makeRouteApp>['app'],
  env: AppEnv['Bindings'],
  payload: unknown,
  opts: { signature?: string; timestamp?: number } = {},
) {
  const body = JSON.stringify(payload)
  const timestamp = opts.timestamp ?? NOW()
  const signature = opts.signature ?? (await signSlack(TEST_SIGNING_KEY, body, timestamp))
  return app.request(
    '/api/slack/events',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': signature,
      },
      body,
    },
    env,
  )
}

const linkShared = (urls: string[], user = 'Usharer') => ({
  type: 'event_callback',
  event: {
    type: 'link_shared',
    user,
    channel: 'C123',
    message_ts: '1700000000.1',
    unfurl_id: 'C123.1700000000.1.1',
    source: 'conversations_history',
    links: urls.map((url) => ({ url, domain: 'glance.example.com' })),
  },
})

/** Owner + space + one site; `sharer` is a separate user whose Slack profile email maps to them. */
async function seedWorld(opts: { visibility?: 'private' | 'members' | 'team'; status?: 'active' | 'archived' } = {}) {
  const world = makeRouteApp()
  const owner = await seedUser(world.db, { id: 'owner', email: 'owner@x.com' })
  await seedUser(world.db, { id: 'sharer', email: 'sharer@x.com' })
  const spaceId = await seedSpace(world.db, { createdBy: owner, slug: 'acme' })
  await seedSite(world.db, {
    id: 'site-1',
    spaceId,
    ownerId: owner,
    slug: 'report',
    title: 'Q3 Report',
    description: 'How the numbers moved',
    visibility: opts.visibility ?? 'team',
    status: opts.status ?? 'active',
  })
  return world
}

describe('POST /api/slack/events — gating', () => {
  test('inert (404) when either secret is unset', async () => {
    const { app, env } = makeRouteApp()
    const noToken = await post(app, envWith(env, { SLACK_BOT_TOKEN: undefined }), { type: 'url_verification' })
    expect(noToken.status).toBe(404)
    const noSecret = await post(app, envWith(env, { SLACK_SIGNING_SECRET: undefined }), { type: 'url_verification' })
    expect(noSecret.status).toBe(404)
  })

  test('answers the url_verification challenge on a signed request', async () => {
    const { app, env } = makeRouteApp()
    const res = await post(app, envWith(env, {}), { type: 'url_verification', challenge: 'abc123' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: 'abc123' })
  })

  test('401 on a bad signature — and no Slack HTTP happens', async () => {
    const world = await seedWorld()
    const { fetchImpl, infoCalls } = slackFetch({ Usharer: 'sharer@x.com' })
    const res = await post(
      world.app,
      envWith(world.env, { SLACK_FETCH: fetchImpl }),
      linkShared([`${APP_URL}/acme/report`]),
      { signature: 'v0=deadbeef' },
    )
    expect(res.status).toBe(401)
    expect(infoCalls()).toBe(0)
  })

  test('a cookieless Slack POST is not blocked by the same-origin CSRF guard', async () => {
    const { app, env } = makeRouteApp()
    const res = await post(app, envWith(env, {}), { type: 'url_verification', challenge: 'x' })
    expect(res.status).not.toBe(403)
  })
})

describe('POST /api/slack/events — link_shared', () => {
  test('a site the sharer can read → one card with its title, blurb, and link', async () => {
    const world = await seedWorld({ visibility: 'team' })
    const { fetchImpl, unfurls } = slackFetch({ Usharer: 'sharer@x.com' })
    const url = `${APP_URL}/acme/report`
    const res = await post(world.app, envWith(world.env, { SLACK_FETCH: fetchImpl }), linkShared([url]))

    expect(res.status).toBe(200)
    expect(unfurls).toHaveLength(1)
    expect(unfurls[0]).toMatchObject({ unfurl_id: 'C123.1700000000.1.1', source: 'conversations_history' })
    const card = JSON.stringify((unfurls[0].unfurls as Record<string, unknown>)[url])
    expect(card).toContain('Q3 Report')
    expect(card).toContain('How the numbers moved')
    expect(card).toContain(url)
  })

  test('a PRIVATE site the sharer cannot read → no card at all (no title, no existence signal)', async () => {
    const world = await seedWorld({ visibility: 'private' })
    const { fetchImpl, unfurls } = slackFetch({ Usharer: 'sharer@x.com' })
    const res = await post(
      world.app,
      envWith(world.env, { SLACK_FETCH: fetchImpl }),
      linkShared([`${APP_URL}/acme/report`]),
    )
    expect(res.status).toBe(200)
    expect(unfurls).toHaveLength(0)
  })

  test('the site OWNER pasting their own private link does get a card', async () => {
    const world = await seedWorld({ visibility: 'private' })
    const { fetchImpl, unfurls } = slackFetch({ Uowner: 'owner@x.com' })
    await post(
      world.app,
      envWith(world.env, { SLACK_FETCH: fetchImpl }),
      linkShared([`${APP_URL}/acme/report`], 'Uowner'),
    )
    expect(unfurls).toHaveLength(1)
  })

  test('an archived site is not unfurled (checkAccess 410 applies here too)', async () => {
    const world = await seedWorld({ status: 'archived' })
    const { fetchImpl, unfurls } = slackFetch({ Usharer: 'sharer@x.com' })
    await post(world.app, envWith(world.env, { SLACK_FETCH: fetchImpl }), linkShared([`${APP_URL}/acme/report`]))
    expect(unfurls).toHaveLength(0)
  })

  test('an unknown Slack user, or one with no Glance account, yields no card', async () => {
    const world = await seedWorld()
    const noEmail = slackFetch({})
    await post(
      world.app,
      envWith(world.env, { SLACK_FETCH: noEmail.fetchImpl }),
      linkShared([`${APP_URL}/acme/report`]),
    )
    expect(noEmail.unfurls).toHaveLength(0)

    const stranger = slackFetch({ Ustranger: 'nobody@x.com' })
    await post(
      world.app,
      envWith(world.env, { SLACK_FETCH: stranger.fetchImpl }),
      linkShared([`${APP_URL}/acme/report`], 'Ustranger'),
    )
    expect(stranger.unfurls).toHaveLength(0)
  })

  test('non-site links (foreign origin, missing site, reserved path) are skipped, valid ones still unfurl', async () => {
    const world = await seedWorld()
    const { fetchImpl, unfurls } = slackFetch({ Usharer: 'sharer@x.com' })
    const good = `${APP_URL}/acme/report`
    await post(
      world.app,
      envWith(world.env, { SLACK_FETCH: fetchImpl }),
      linkShared(['https://evil.example/acme/report', `${APP_URL}/api/sites`, `${APP_URL}/acme/missing`, good]),
    )
    expect(unfurls).toHaveLength(1)
    expect(Object.keys(unfurls[0].unfurls as object)).toEqual([good])
  })

  test('nothing unfurlable → zero chat.unfurl calls', async () => {
    const world = await seedWorld()
    const { fetchImpl, unfurls } = slackFetch({ Usharer: 'sharer@x.com' })
    await post(world.app, envWith(world.env, { SLACK_FETCH: fetchImpl }), linkShared([`${APP_URL}/acme/missing`]))
    expect(unfurls).toHaveLength(0)
  })

  test("a mixed-case Slack profile email still matches the (lowercase-canonical) Glance account", async () => {
    const world = await seedWorld()
    const { fetchImpl, unfurls } = slackFetch({ Usharer: 'Sharer@X.Com' })
    await post(world.app, envWith(world.env, { SLACK_FETCH: fetchImpl }), linkShared([`${APP_URL}/acme/report`]))
    expect(unfurls).toHaveLength(1)
  })

  test('two links into the SAME site resolve it once and produce a card per URL', async () => {
    const world = await seedWorld()
    const { fetchImpl, unfurls } = slackFetch({ Usharer: 'sharer@x.com' })
    const root = `${APP_URL}/acme/report`
    const deep = `${APP_URL}/acme/report/docs/page.html`
    await post(world.app, envWith(world.env, { SLACK_FETCH: fetchImpl }), linkShared([root, deep, root]))
    expect(unfurls).toHaveLength(1)
    // Slack keys unfurls by URL, so both pasted URLs get a card — from one access resolution.
    expect(Object.keys(unfurls[0].unfurls as object).sort()).toEqual([root, deep].sort())
  })

  test('a non-link_shared event is acked and ignored', async () => {
    const world = await seedWorld()
    const { fetchImpl, unfurls, infoCalls } = slackFetch({ Usharer: 'sharer@x.com' })
    const res = await post(world.app, envWith(world.env, { SLACK_FETCH: fetchImpl }), {
      type: 'event_callback',
      event: { type: 'message', user: 'Usharer' },
    })
    expect(res.status).toBe(200)
    expect(unfurls).toHaveLength(0)
    expect(infoCalls()).toBe(0)
  })
})
