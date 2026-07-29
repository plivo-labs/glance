-- Performance: the team feed (`GET /api/sites/team`) is `WHERE status = ? AND visibility = ?
-- ORDER BY updatedAt DESC LIMIT 50`. With no index on that shape SQLite scanned every site row,
-- temp-sorted the lot, and only THEN applied the LIMIT — so the two correlated EXISTS subqueries
-- folded into the select (pureAudioSql + hasSummarySql) were evaluated once per site instead of
-- once per returned row. Measured on prod: ~4,600 rows read per feed load, the #2 rows-read query
-- in `wrangler d1 insights`. Equality on the two leading columns plus `updatedAt` last lets the
-- index satisfy the ORDER BY by reverse scan, so the LIMIT stops the scan after 50 rows.
CREATE INDEX IF NOT EXISTS `sites_status_visibility_updated` ON `sites` (`status`,`visibility`,`updatedAt`);
