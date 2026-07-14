-- Fork ("remix"): provenance for a site copied from another site. Nullable — null means the site
-- was deployed directly, not forked. ON DELETE SET NULL (not cascade): deleting the SOURCE must
-- never delete its forks — a fork owns its own R2 objects (the bytes are COPIED to a fresh prefix,
-- never shared), so only the provenance link is lost, not the content. Plain ADD COLUMN (nullable,
-- no default) — no table rebuild, backfills every existing row to NULL.
ALTER TABLE `sites` ADD COLUMN `forkedFrom` text REFERENCES `sites`(`id`) ON DELETE SET NULL;
