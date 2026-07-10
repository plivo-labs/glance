// Shared fixtures for the content-worker route specs (content-access / content-storage):
// the wired Hono app + harness mocks, the standard team-visibility site, and token minting.
// Op-shape helpers and assertions stay LOCAL to each spec file — only the wiring lives here.
import { Hono } from 'hono'
import contentApp from '../content'
import { signToken } from '../lib/token'
import { makeCaches, makeDb, makeR2, makeRecorder, seedFile, seedMember, seedSite, seedSpace, seedUser } from './harness'

const tokenKey = 'test-secret'

/** Mint a gated-content token bound to `userId` and scoped to `"<space>/<site>"`. */
export const mintToken = (userId: string, scope: string) => signToken(tokenKey, userId, scope, 300)

/** The content app wired to the in-memory harness: db always injected, the cache mock only
 *  when `withCaches` (the access specs pin the cache-less op shape — getCache resolves null,
 *  serving straight from R2; the storage specs exercise the cache-fronted path). */
export function setup({ withCaches = true }: { withCaches?: boolean } = {}) {
  const recorder = makeRecorder()
  const db = makeDb(recorder)
  const r2 = makeR2(recorder)
  const caches = makeCaches(recorder)
  const env = {
    APP_URL: 'https://glance.example.com',
    CONTENT_TOKEN_SECRET: tokenKey,
    GLANCE_FILES: r2,
  } as unknown as Parameters<typeof contentApp.request>[2]
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('db', db)
    if (withCaches) c.set('caches', caches)
    await next()
  })
  app.route('/', contentApp)
  return { db, r2, caches, env, app, recorder }
}

export type Setup = ReturnType<typeof setup>

export type FileSpec = { path: string; text?: string; mimeType?: string; storageKey?: string }

/** The standard authed fixture: team-visibility site `sp/site` + a token for an authed
 *  non-owner viewer (team visibility admits any authed user). Counters reset AFTER seeding so
 *  seed ops never leak into assertions. Returns storageKeys in `keys`, spec order. */
export async function teamSite(s: Setup, specs: FileSpec[]) {
  const owner = await seedUser(s.db)
  const viewer = await seedUser(s.db)
  const sp = await seedSpace(s.db, { createdBy: owner, slug: 'sp' })
  await seedMember(s.db, sp, owner)
  const siteId = await seedSite(s.db, { spaceId: sp, ownerId: owner, slug: 'site', visibility: 'team' })
  const keys: string[] = []
  for (const f of specs) keys.push(await seedFile(s.db, s.r2, siteId, f))
  const token = await mintToken(viewer, 'sp/site')
  s.db.resetCounters()
  s.recorder.resetCounters()
  return { owner, viewer, sp, siteId, token, keys }
}
