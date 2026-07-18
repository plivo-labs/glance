import { describe, expect, test } from 'bun:test'
import { listNotifications, usersEmailsByIds } from '../db/notifications'
import { APP_URL, auth, makeRouteApp, mintUser } from '../test/route-fixtures'
import { countingKv, makeDb, seedSite, seedSpace, seedUser } from '../test/harness'
import type { AppEnv } from '../types'

// Route-level Slack delivery: comment POST → notifyForComment → deliverSlack, exercised through
// app.request with an injected SLACK_FETCH (env DI seam) so we capture chat.postMessage / lookup
// HTTP without touching global fetch. In app.request there is no executionCtx, so fireAndForget
// awaits inline — the fan-out is complete when the response resolves.

type PostBody = { channel: string; text: string }
const isLookup = (url: string) => url.includes('users.lookupByEmail')
const isPost = (url: string) => url.includes('chat.postMessage')
const bodyOf = (init?: RequestInit): PostBody => JSON.parse(String(init?.body))

/** A recording SLACK_FETCH: `lookups` maps email→id (returns users_not_found otherwise); `onPost`
 *  can override the postMessage response (throw / 429 / etc). Records every posted body. */
function slackFetch(opts: {
  lookups?: Record<string, string>
  onPost?: (n: number) => Response
} = {}) {
  const posts: PostBody[] = []
  const lookupCalls: string[] = []
  let n = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (isLookup(url)) {
      const email = decodeURIComponent(new URL(url).searchParams.get('email') ?? '')
      lookupCalls.push(email)
      const id = opts.lookups?.[email]
      return id ? Response.json({ ok: true, user: { id } }) : Response.json({ ok: false, error: 'users_not_found' })
    }
    if (isPost(url)) {
      n += 1
      if (opts.onPost) {
        const r = opts.onPost(n) // may throw
        posts.push(bodyOf(init))
        return r
      }
      posts.push(bodyOf(init))
      return Response.json({ ok: true })
    }
    throw new Error(`unexpected slack url: ${url}`)
  }) as unknown as typeof fetch
  return { fetchImpl, posts, lookupCalls }
}

/** Seed an owner + team site + a commenter session; return the app, env-builder, and ids. */
async function seedCommentApp(opts: { ownerEmail: string; commenterEmail: string }) {
  const route = makeRouteApp()
  const owner = await seedUser(route.db, { id: 'owner', email: opts.ownerEmail })
  const commenter = await mintUser(route.db, route.kv, 'commenter', { email: opts.commenterEmail })
  const spaceId = await seedSpace(route.db, { createdBy: owner, slug: 'acme' })
  await seedSite(route.db, { id: 'site-1', spaceId, ownerId: owner, slug: 'doc', visibility: 'team' })
  return { ...route, owner, commenter }
}

const bindings = (env: AppEnv['Bindings'], extra: Record<string, unknown>) =>
  ({ ...env, ...extra }) as unknown as AppEnv['Bindings']

const postComment = (app: ReturnType<typeof makeRouteApp>['app'], env: AppEnv['Bindings'], body: unknown) =>
  app.request(
    '/api/sites/acme/doc/comments',
    { method: 'POST', headers: auth('commenter'), body: JSON.stringify(body) },
    env,
  )

describe('W — comment route fans out to Slack', () => {
  test('W1: comment on an owned team site → one post to the cached owner id, owner verb + snippet + link', async () => {
    const { app, env, kv } = await seedCommentApp({ ownerEmail: 'owner@x.com', commenterEmail: 'c@x.com' })
    await kv.put('slackuid:owner@x.com', 'Uowner')
    const { fetchImpl, posts, lookupCalls } = slackFetch()
    const res = await postComment(app, bindings(env, { SLACK_BOT_TOKEN: 'xoxb', SLACK_FETCH: fetchImpl }), {
      body: 'hello world',
      filePath: 'index.html',
    })
    expect(res.status).toBe(201)
    expect(lookupCalls).toHaveLength(0) // owner was cached
    expect(posts).toHaveLength(1)
    expect(posts[0].channel).toBe('Uowner')
    expect(posts[0].text).toContain('commented on your site acme/doc')
    expect(posts[0].text).toContain('hello world')
    expect(posts[0].text).toContain(`${APP_URL}/acme/doc/index.html?thread=`)
    expect(posts[0].text).toContain('review=1')
  })

  test('W2: 1 mention + 1 comment recipient → 2 posts, mention body first', async () => {
    const { app, env, db, kv } = await seedCommentApp({ ownerEmail: 'owner@x.com', commenterEmail: 'c@x.com' })
    const mentioned = await seedUser(db, { id: 'mtn', email: 'mtn@x.com' })
    await kv.put('slackuid:owner@x.com', 'Uowner')
    await kv.put('slackuid:mtn@x.com', 'Umtn')
    const { fetchImpl, posts } = slackFetch()
    const res = await postComment(app, bindings(env, { SLACK_BOT_TOKEN: 'xoxb', SLACK_FETCH: fetchImpl }), {
      body: 'ping',
      filePath: 'index.html',
      mentions: [mentioned],
    })
    expect(res.status).toBe(201)
    expect(posts).toHaveLength(2)
    expect(posts[0].channel).toBe('Umtn') // mention first
    expect(posts[0].text).toContain('mentioned you in a comment on')
    expect(posts[1].channel).toBe('Uowner')
  })

  test('W6: actor self-mention gets no DM; another recipient still does', async () => {
    const { app, env, kv } = await seedCommentApp({ ownerEmail: 'owner@x.com', commenterEmail: 'c@x.com' })
    await kv.put('slackuid:owner@x.com', 'Uowner')
    await kv.put('slackuid:c@x.com', 'Ucommenter') // cached, to prove exclusion is by logic
    const { fetchImpl, posts } = slackFetch()
    const res = await postComment(app, bindings(env, { SLACK_BOT_TOKEN: 'xoxb', SLACK_FETCH: fetchImpl }), {
      body: 'note to self',
      filePath: 'index.html',
      mentions: ['commenter'], // the actor mentions themselves
    })
    expect(res.status).toBe(201)
    expect(posts.map((p) => p.channel)).not.toContain('Ucommenter')
    expect(posts.map((p) => p.channel)).toContain('Uowner')
  })

  test('token unset → zero Slack HTTP even with recipients present', async () => {
    const { app, env, kv } = await seedCommentApp({ ownerEmail: 'owner@x.com', commenterEmail: 'c@x.com' })
    await kv.put('slackuid:owner@x.com', 'Uowner')
    const { fetchImpl, posts, lookupCalls } = slackFetch()
    const res = await postComment(app, bindings(env, { SLACK_FETCH: fetchImpl }), {
      body: 'hi',
      filePath: 'index.html',
    })
    expect(res.status).toBe(201)
    expect(posts).toHaveLength(0)
    expect(lookupCalls).toHaveLength(0)
  })
})

describe('W/R — a Slack fault never touches the comment', () => {
  test('W4: a mid-fan-out post throw → comment still 201, in-app rows kept, earlier posts survive', async () => {
    const { app, env, db, kv, owner } = await seedCommentApp({ ownerEmail: 'owner@x.com', commenterEmail: 'c@x.com' })
    const mentioned = await seedUser(db, { id: 'mtn', email: 'mtn@x.com' })
    await kv.put('slackuid:owner@x.com', 'Uowner')
    await kv.put('slackuid:mtn@x.com', 'Umtn')
    const { fetchImpl, posts } = slackFetch({
      onPost: (n) => {
        if (n === 2) throw new Error('slack down')
        return Response.json({ ok: true })
      },
    })
    const res = await postComment(app, bindings(env, { SLACK_BOT_TOKEN: 'xoxb', SLACK_FETCH: fetchImpl }), {
      body: 'ping',
      filePath: 'index.html',
      mentions: [mentioned],
    })
    expect(res.status).toBe(201) // request never rejects
    expect(posts).toHaveLength(1) // first (mention) succeeded; second threw and was skipped
    const inApp = await listNotifications(db, owner)
    expect(inApp.items.length).toBeGreaterThanOrEqual(1) // in-app fan-out committed before Slack
  })

  test('R1: a 429 + Retry-After on the post → 201, no poisoned cache', async () => {
    const { app, env, kv } = await seedCommentApp({ ownerEmail: 'owner@x.com', commenterEmail: 'c@x.com' })
    await kv.put('slackuid:owner@x.com', 'Uowner')
    const { fetchImpl, posts } = slackFetch({
      onPost: () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }),
    })
    const res = await postComment(app, bindings(env, { SLACK_BOT_TOKEN: 'xoxb', SLACK_FETCH: fetchImpl }), {
      body: 'hi',
      filePath: 'index.html',
    })
    expect(res.status).toBe(201)
    expect(posts).toHaveLength(1) // the attempt happened
    expect(kv.store.get('slackuid:owner@x.com')).toBe('Uowner') // 429 on POST never touches the lookup cache
  })

  test('R2: a KV cache-put failure after a live lookup still delivers the DM', async () => {
    const { app, env, kv } = await seedCommentApp({ ownerEmail: 'owner@x.com', commenterEmail: 'c@x.com' })
    const sessions = countingKv(kv) // wrap the route's KV (the F4 caller)
    sessions.failNextPut(new Error('kv down')) // the next put is the slackuid cache write
    const { fetchImpl, posts } = slackFetch({ lookups: { 'owner@x.com': 'Uowner' } }) // NOT pre-cached → live lookup
    const res = await postComment(
      app,
      bindings(env, { SLACK_BOT_TOKEN: 'xoxb', SLACK_FETCH: fetchImpl, GLANCE_SESSIONS: sessions }),
      { body: 'hi', filePath: 'index.html' },
    )
    expect(res.status).toBe(201)
    expect(posts).toHaveLength(1)
    expect(posts[0].channel).toBe('Uowner')
  })
})

describe('W5 — email hydration chunks at the D1 IN limit', () => {
  test('91 ids → 2 IN-chunk statements in one batch, exact id→email map', async () => {
    const db = makeDb()
    const ids: string[] = []
    for (let i = 0; i < 91; i++) ids.push(await seedUser(db, { id: `u${i}`, email: `u${i}@x.com` }))
    db.resetCounters()
    const map = await usersEmailsByIds(db, ids)
    expect(map.size).toBe(91)
    expect(map.get('u0')).toBe('u0@x.com')
    expect(map.get('u90')).toBe('u90@x.com')
    expect(db.counters.batches).toBe(1)
    expect(db.counters.batchStmts).toBe(2) // ceil(91 / 90) = 2 chunks
  })
})
