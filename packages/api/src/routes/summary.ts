import { and, eq, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { files, siteSummaries, sites, spaces, type SiteSummary } from '../db/schema'
import { extractText, isSupportedEntry, pickEntry } from '../lib/extract'
import type { ResolvedSite } from '../lib/site-access'
import { fetchAccessFacts, siteAccessFromFacts } from '../lib/site-access'
import { PROMPT_VERSION, resolveProvider, summarizeDeps, summarizeSite } from '../lib/summarize'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

export const summary = new Hono<AppEnv>()

type StoredSummary = Pick<
  SiteSummary,
  'summary' | 'contentVersion' | 'promptVersion' | 'provider' | 'model' | 'updatedAt' | 'truncated'
>

const isStale = (row: Pick<SiteSummary, 'contentVersion' | 'promptVersion'>, currentVersion: number) =>
  row.contentVersion !== currentVersion || row.promptVersion !== PROMPT_VERSION

const readyBody = (row: StoredSummary, currentVersion: number) => ({
  status: 'ready' as const,
  stale: isStale(row, currentVersion),
  currentVersion,
  summary: row.summary,
  meta: {
    provider: row.provider,
    model: row.model,
    forVersion: row.contentVersion,
    generatedAt: row.updatedAt,
    truncated: row.truncated,
  },
})

const notReadyBody = (status: 'none' | 'unavailable', stale: boolean, currentVersion: number) => ({
  status,
  stale,
  currentVersion,
})

const SUMMARY_COLUMNS = {
  id: siteSummaries.id,
  siteId: siteSummaries.siteId,
  summary: siteSummaries.summary,
  contentVersion: siteSummaries.contentVersion,
  promptVersion: siteSummaries.promptVersion,
  provider: siteSummaries.provider,
  model: siteSummaries.model,
  generatedBy: siteSummaries.generatedBy,
  truncated: siteSummaries.truncated,
  createdAt: siteSummaries.createdAt,
  updatedAt: siteSummaries.updatedAt,
}

type EntryFileRow = { path: string; mimeType: string | null; storageKey: string }

async function gated(
  c: Context<AppEnv>,
  { withFiles = false } = {},
): Promise<{ site: ResolvedSite; row: SiteSummary | undefined; fileRows: EntryFileRow[] } | Response> {
  const db = c.get('db')
  const { space, site: siteSlug } = c.req.param()
  const bySlugs = and(eq(spaces.slug, space), eq(sites.slug, siteSlug))
  const summaryStmt = db
    .select(SUMMARY_COLUMNS)
    .from(siteSummaries)
    .innerJoin(sites, eq(siteSummaries.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .where(bySlugs)
    .limit(1)
  // The generation path reads the file rows INSIDE the same batch as the access facts and the
  // version snapshot: storage keys are minted per upload, so an atomic row read pins the exact
  // bytes belonging to the snapshotted contentVersion (a mid-request publish can't mix versions).
  const filesStmt = db
    .select({ path: files.path, mimeType: files.mimeType, storageKey: files.storageKey })
    .from(files)
    .innerJoin(sites, eq(files.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .where(bySlugs)
  const { facts, extras } = withFiles
    ? await fetchAccessFacts(db, space, siteSlug, c.get('user').id, summaryStmt, filesStmt)
    : await fetchAccessFacts(db, space, siteSlug, c.get('user').id, summaryStmt)
  const { site, access } = siteAccessFromFacts(facts, c.get('user'))
  if (!site) return c.json({ error: 'not found' }, 404)
  if (!access.ok) return c.json({ error: 'forbidden' }, access.status)
  const [summaryRows, fileRows] = extras as [SiteSummary[], EntryFileRow[] | undefined]
  return { site, row: summaryRows[0], fileRows: fileRows ?? [] }
}

summary.use('*', requireAuth)

summary.get('/:space/:site/summary', async (c) => {
  const gate = await gated(c)
  if (gate instanceof Response) return gate
  const { site, row } = gate
  if (row) return c.json(readyBody(row, site.contentVersion))

  const deps = summarizeDeps(c.env)
  return c.json(notReadyBody(resolveProvider(deps) ? 'none' : 'unavailable', false, site.contentVersion))
})

summary.post('/:space/:site/summary', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const gate = await gated(c, { withFiles: true })
  if (gate instanceof Response) return gate
  const { site, row: existing, fileRows } = gate
  const force = ((await c.req.json().catch(() => null)) as { force?: unknown } | null)?.force === true
  const fresh = existing && !isStale(existing, site.contentVersion)
  if (fresh && !force) return c.json(readyBody(existing, site.contentVersion))

  const deps = summarizeDeps(c.env)
  const provider = resolveProvider(deps)
  if (!provider) {
    return c.json(notReadyBody('unavailable', existing ? isStale(existing, site.contentVersion) : false, site.contentVersion))
  }
  if (c.env.SUMMARY_LIMITER) {
    const { success } = await c.env.SUMMARY_LIMITER.limit({ key: user.id })
    if (!success) return c.json({ error: 'rate limited' }, 429)
  }

  const entry = pickEntry(fileRows)
  let extracted = null
  if (entry && isSupportedEntry(entry)) {
    const object = await c.env.GLANCE_FILES.get(entry.storageKey)
    if (object) extracted = await extractText(entry, await object.text())
  }
  if (!extracted?.ok) return c.json({ error: 'nothing to summarize' }, 422)

  const generated = await summarizeSite(deps, extracted.text)
  if (!generated.ok) return c.json({ error: 'generation failed', retryable: true } as const, 502)

  // Stamps site.contentVersion as read BEFORE generation, so a mid-flight content bump makes
  // the stored row (correctly) stale rather than claiming coverage of content it never saw.
  const fields = {
    summary: generated.summary,
    contentVersion: site.contentVersion,
    promptVersion: PROMPT_VERSION,
    provider: generated.provider,
    model: generated.model,
    generatedBy: user.id,
    truncated: extracted.truncated,
    updatedAt: new Date().toISOString(),
  }
  // One transactional batch: the guarded upsert (a slow stale generation must never overwrite a
  // row for a NEWER contentVersion) plus a read-back of the surviving row and the live version,
  // so the response reports what is actually stored — not what this request happened to compute.
  const [, survivorRows, versionRows] = await db.batch([
    db
      .insert(siteSummaries)
      .values({ siteId: site.id, ...fields })
      .onConflictDoUpdate({
        target: siteSummaries.siteId,
        set: fields,
        setWhere: sql`${siteSummaries.contentVersion} <= ${fields.contentVersion}`,
      }),
    db.select(SUMMARY_COLUMNS).from(siteSummaries).where(eq(siteSummaries.siteId, site.id)).limit(1),
    db.select({ contentVersion: sites.contentVersion }).from(sites).where(eq(sites.id, site.id)).limit(1),
  ])
  const survivor = survivorRows[0] ?? { ...fields, id: '', siteId: site.id, createdAt: fields.updatedAt }
  return c.json(readyBody(survivor, versionRows[0]?.contentVersion ?? site.contentVersion))
})
