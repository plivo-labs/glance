import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import contentApp from './content'
import { signToken } from './lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from './test/harness'

// The serve() access-facts batch is read-only and idempotent, so a transient D1 internal error
// (rare in prod; easy to hit in local dev where two wrangler processes share one sqlite) is
// retried with backoff instead of 500ing the page. Three consecutive failures still propagate.

const tokenKey = 'test-secret'

/** Wrap the harness db so its next `failures` batch() calls reject like a transient D1 error. */
function flakyDb(db: ReturnType<typeof makeDb>, failures: number) {
  let remaining = failures
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return (...args: unknown[]) => {
          if (remaining > 0) {
            remaining--
            return Promise.reject(new Error('D1_ERROR: internal error'))
          }
          return (target as { batch: (...a: unknown[]) => unknown }).batch(...args)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as ReturnType<typeof makeDb>
}

async function setup(failures: number) {
  const db = makeDb()
  const r2 = makeR2()
  const uid = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team', theme: 'broadsheet' })
  await seedFile(db, r2, siteId, { path: 'index.html', text: '<html><head></head><body>hi</body></html>' })
  const token = await signToken(tokenKey, uid, 'sam/site', 300)

  const env = {
    APP_URL: 'https://glance.example.com',
    CONTENT_TOKEN_SECRET: tokenKey,
    GLANCE_FILES: r2,
  } as unknown as Parameters<typeof contentApp.request>[2]
  const app = new Hono()
  const wrapped = flakyDb(db, failures)
  app.use('*', async (c, next) => {
    c.set('db', wrapped)
    await next()
  })
  app.route('/', contentApp)
  return { app, env, token }
}

describe('serve() retries transient access-batch failures', () => {
  test('two consecutive failures → third attempt serves the themed page', async () => {
    const { app, env, token } = await setup(2)
    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('/_glance/theme/broadsheet.css')
  })

  test('three consecutive failures → the error propagates (real outage, not a flake)', async () => {
    const { app, env, token } = await setup(3)
    const res = await app.request(`/_t/${token}/sam/site/`, {}, env)
    expect(res.status).toBe(500)
  })
})
