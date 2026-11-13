-- Full-text search over page CONTENT. `site_text` holds one row per site: the visible text of its
-- html/md files (lib/site-search.ts builds it, capped at 200k chars). `site_search` is an FTS5
-- index over it (external-content pattern: the text is stored once, in site_text), kept in step by
-- the three documented triggers below.
--
-- Triggers (not app code) because rows also leave `site_text` through FK cascades — a deleted site,
-- space or user — that no route sees (migration 0030 is the precedent). Cascade deletes fire them.
-- The explicit integer PK is what content_rowid points at, so rowids survive a VACUUM. Never write
-- site_text with INSERT OR REPLACE: it skips the delete trigger and would leave stale index entries.
CREATE TABLE `site_text` (
	`id` integer PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL REFERENCES `sites`(`id`) ON DELETE CASCADE,
	`body` text NOT NULL,
	CONSTRAINT `site_text_site_unq` UNIQUE(`siteId`)
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `site_search` USING fts5(
	`body`,
	content = 'site_text',
	content_rowid = 'id',
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `site_text_ai` AFTER INSERT ON `site_text` BEGIN
	INSERT INTO `site_search` (`rowid`, `body`) VALUES (NEW.`id`, NEW.`body`);
END;
--> statement-breakpoint
CREATE TRIGGER `site_text_ad` AFTER DELETE ON `site_text` BEGIN
	INSERT INTO `site_search` (`site_search`, `rowid`, `body`) VALUES ('delete', OLD.`id`, OLD.`body`);
END;
--> statement-breakpoint
CREATE TRIGGER `site_text_au` AFTER UPDATE ON `site_text` BEGIN
	INSERT INTO `site_search` (`site_search`, `rowid`, `body`) VALUES ('delete', OLD.`id`, OLD.`body`);
	INSERT INTO `site_search` (`rowid`, `body`) VALUES (NEW.`id`, NEW.`body`);
END;
--> statement-breakpoint
-- Index-state marker: NULL = this site's current content is not in `site_text` yet. Upload, fork
-- and the cron backfill set it in the same batch that writes the text, so it is the work queue for
-- the backfill and "indexed, but nothing to index" stays distinct from "not looked at".
ALTER TABLE `sites` ADD COLUMN `searchIndexedAt` text;
--> statement-breakpoint
-- The backfill's `WHERE searchIndexedAt IS NULL ORDER BY updatedAt DESC LIMIT n`. Partial, so once
-- the backfill has caught up the index holds (almost) nothing.
CREATE INDEX `sites_search_unindexed` ON `sites` (`updatedAt`) WHERE `searchIndexedAt` IS NULL;
