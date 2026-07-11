DROP INDEX IF EXISTS `comments_author`;--> statement-breakpoint
CREATE INDEX `comments_author_deleted_created` ON `comments` (`authorId`,`deletedAt`,`createdAt`);
