import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { seedMember, seedSite, seedSpace, seedUser } from '../test/harness'
import { auth, makeRouteApp, mintUser } from '../test/route-fixtures'
import { THEME_INFO } from '../themes/registry'
import { themes } from './themes'

// Theme as a site property: PATCH switches/clears it (owner-only, validated against the
// registry), the viewer GET carries it, the feeds carry it, and the public /api/themes catalog
// serves the pickers and the agent briefs.

describe('PATCH /api/sites theme', () => {
  test('owner sets, switches, and clears the theme; content stays untouched', async () => {
    const { app, env, db, kv } = makeRouteApp()
    await mintUser(db, kv, 'owner')
    const sp = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, sp, 'owner')
    const siteId = await seedSite(db, { spaceId: sp, ownerId: 'owner', slug: 'report' })

    const patch = (body: unknown) =>
      app.request(
        '/api/sites/docs/report',
        { method: 'PATCH', headers: auth('owner'), body: JSON.stringify(body) },
        env,
      )
    const themeOf = async () =>
      (await db.select({ theme: sites.theme }).from(sites).where(eq(sites.id, siteId)))[0]?.theme
    const versionOf = async () =>
      (await db.select({ v: sites.contentVersion }).from(sites).where(eq(sites.id, siteId)))[0]?.v

    expect((await patch({ theme: 'plivo' })).status).toBe(200)
    expect(await themeOf()).toBe('plivo')

    expect((await patch({ theme: 'matrix' })).status).toBe(200)
    expect(await themeOf()).toBe('matrix')

    expect((await patch({ theme: null })).status).toBe(200)
    expect(await themeOf()).toBeNull()

    // Presentation-only: no contentVersion bump across any of the switches above.
    expect(await versionOf()).toBe(0)
  })

  test('unknown slug → 400; non-owner → 403', async () => {
    const { app, env, db, kv } = makeRouteApp()
    await mintUser(db, kv, 'owner')
    await mintUser(db, kv, 'other')
    const sp = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, sp, 'owner')
    await seedMember(db, sp, 'other')
    await seedSite(db, { spaceId: sp, ownerId: 'owner', slug: 'report' })

    const asUser = (id: string, body: unknown) =>
      app.request('/api/sites/docs/report', { method: 'PATCH', headers: auth(id), body: JSON.stringify(body) }, env)

    expect((await asUser('owner', { theme: 'clippy' })).status).toBe(400)
    expect((await asUser('other', { theme: 'plivo' })).status).toBe(403)
  })
})

describe('theme in read payloads', () => {
  test('viewer GET and the /mine feed both carry the theme', async () => {
    const { app, env, db, kv } = makeRouteApp()
    await mintUser(db, kv, 'owner')
    const sp = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, sp, 'owner')
    await seedSite(db, { spaceId: sp, ownerId: 'owner', slug: 'report', theme: 'academic' })

    const view = await app.request('/api/sites/docs/report', { headers: auth('owner') }, env)
    expect(((await view.json()) as { theme: string | null }).theme).toBe('academic')

    const mine = await app.request('/api/sites/mine', { headers: auth('owner') }, env)
    const rows = (await mine.json()) as { siteSlug: string; theme: string | null }[]
    expect(rows.find((r) => r.siteSlug === 'report')?.theme).toBe('academic')
  })
})

describe('GET /api/themes', () => {
  test('catalog lists every registry theme with name + description', async () => {
    const res = await themes.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { themes: { slug: string; name: string; description: string }[] }
    expect(body.themes.map((t) => t.slug).sort()).toEqual(
      THEME_INFO.map((t) => t.slug)
        .slice()
        .sort(),
    )
    for (const t of body.themes) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  test('DESIGN.md brief serves as markdown; unknown slug 404s', async () => {
    const res = await themes.request('/plivo/DESIGN.md')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('markdown')
    const brief = await res.text()
    expect(brief).toContain('name: Plivo')
    expect(brief).toContain('## Agent Prompt Guide')

    expect((await themes.request('/clippy/DESIGN.md')).status).toBe(404)
  })
})
