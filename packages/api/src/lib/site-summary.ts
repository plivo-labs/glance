import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { siteSummaries } from '../db/schema'

// Explicit alias is required because real D1 batch results map columns by name.
export function hasSummarySql(siteId: SQLWrapper): SQL.Aliased<number> {
  return sql<number>`exists (select 1 from ${siteSummaries} where ${siteSummaries.siteId} = ${siteId})`.as('hasSummary')
}
