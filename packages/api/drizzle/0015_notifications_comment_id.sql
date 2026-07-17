ALTER TABLE `notifications` ADD `commentId` text REFERENCES `comments`(`id`) ON DELETE SET NULL;
