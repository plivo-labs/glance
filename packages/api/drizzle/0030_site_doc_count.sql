-- Per-site glance.db document counter, so the MAX_DOCS_PER_SITE check on every insert reads ONE
-- row instead of COUNT(*)-scanning the site's documents. The scan made filling one site to the
-- 5000 cap cost ~12.5M D1 rows read (0+1+…+5000), 2.5x the free tier's whole daily budget.
--
-- Triggers (not app code) keep it in sync because rows also leave `documents` through FK cascades
-- (a deleted user takes their documents with them) that no route ever sees.
ALTER TABLE `sites` ADD COLUMN `docCount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `documents_doc_count_insert` AFTER INSERT ON `documents` BEGIN
	UPDATE `sites` SET `docCount` = `docCount` + 1 WHERE `id` = NEW.`siteId`;
END;
--> statement-breakpoint
CREATE TRIGGER `documents_doc_count_delete` AFTER DELETE ON `documents` BEGIN
	UPDATE `sites` SET `docCount` = `docCount` - 1 WHERE `id` = OLD.`siteId`;
END;
--> statement-breakpoint
UPDATE `sites` SET `docCount` = (SELECT count(*) FROM `documents` WHERE `documents`.`siteId` = `sites`.`id`)
WHERE `id` IN (SELECT `siteId` FROM `documents`);
