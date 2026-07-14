import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { makeDb, seedSite, seedSpace, seedUser } from '../test/harness'
import { siteSummaries, sites, users } from './schema'

async function seedSummarySite(db: DrizzleD1Database) {
  const ownerId = await seedUser(db)
  const generatedBy = await seedUser(db)
  const spaceId = await seedSpace(db, { createdBy: ownerId })
  const siteId = await seedSite(db, { spaceId, ownerId })
  return { generatedBy, ownerId, siteId }
}

describe('site summaries', () => {
  test('C15.1 migration creates exactly the site_summaries columns', async () => {
    const db = makeDb()
    const columns = await db.all(sql`SELECT name FROM pragma_table_info('site_summaries')`)

    expect(columns.map(({ name }) => name).sort()).toEqual(
      [
        'id',
        'siteId',
        'summary',
        'contentVersion',
        'promptVersion',
        'provider',
        'model',
        'generatedBy',
        'truncated',
        'createdAt',
        'updatedAt',
      ].sort(),
    )
  })

  test('C15.2 upsert keeps one row with every freshness field from the second write', async () => {
    const db = makeDb()
    const { generatedBy, ownerId, siteId } = await seedSummarySite(db)
    await db.insert(siteSummaries).values({
      siteId,
      summary: 'first summary',
      contentVersion: 1,
      promptVersion: 1,
      provider: 'first-provider',
      model: 'first-model',
      generatedBy: ownerId,
      truncated: false,
      updatedAt: '2026-07-11T10:00:00.000Z',
    })

    const second = {
      summary: 'second summary',
      contentVersion: 2,
      promptVersion: 3,
      provider: 'second-provider',
      model: 'second-model',
      generatedBy,
      truncated: true,
      updatedAt: '2026-07-11T11:00:00.000Z',
    }
    await db
      .insert(siteSummaries)
      .values({ siteId, ...second })
      .onConflictDoUpdate({ target: siteSummaries.siteId, set: second })

    expect(await db.$count(siteSummaries)).toBe(1)
    const [row] = await db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(row.summary).toBe(second.summary)
    expect(row.contentVersion).toBe(second.contentVersion)
    expect(row.promptVersion).toBe(second.promptVersion)
    expect(row.provider).toBe(second.provider)
    expect(row.model).toBe(second.model)
    expect(row.generatedBy).toBe(second.generatedBy)
    expect(row.truncated).toBe(second.truncated)
    expect(row.updatedAt).toBe(second.updatedAt)
  })

  test('C15.3 deleting a site cascades its summary', async () => {
    const db = makeDb()
    const { generatedBy, siteId } = await seedSummarySite(db)
    await db.insert(siteSummaries).values({
      siteId,
      summary: 'summary',
      contentVersion: 1,
      promptVersion: 1,
      provider: 'provider',
      model: 'model',
      generatedBy,
    })

    await db.delete(sites).where(eq(sites.id, siteId))

    expect(await db.$count(siteSummaries)).toBe(0)
  })

  test('C15.4 deleting the generating user keeps the summary and clears generatedBy', async () => {
    const db = makeDb()
    const { generatedBy, siteId } = await seedSummarySite(db)
    await db.insert(siteSummaries).values({
      siteId,
      summary: 'summary',
      contentVersion: 1,
      promptVersion: 1,
      provider: 'provider',
      model: 'model',
      generatedBy,
    })

    await db.delete(users).where(eq(users.id, generatedBy))

    expect(await db.$count(siteSummaries)).toBe(1)
    const [row] = await db.select().from(siteSummaries).where(eq(siteSummaries.siteId, siteId))
    expect(row.generatedBy).toBeNull()
  })
})
