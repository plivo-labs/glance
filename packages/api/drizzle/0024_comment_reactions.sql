-- Emoji reactions on a comment. The composite primary key (commentId, userId, emoji) is what makes
-- the toggle idempotent by construction: one user may hold several DIFFERENT emojis on a comment,
-- but the same one only once, so a double-click cannot write a second row. There is deliberately NO
-- separate index on commentId — unlike site_stars, whose userId index exists precisely because
-- userId is not the key's prefix, commentId IS this key's leftmost column, so the primary key's own
-- index already serves the read fold. Both foreign keys cascade: a reaction is a pointer with no
-- historical value once the comment or the reactor is gone, the contrast being comments.authorId,
-- which is SET NULL so review history survives a deleted user.
CREATE TABLE `comment_reactions` (
	`commentId` text NOT NULL,
	`userId` text NOT NULL,
	`emoji` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`commentId`, `userId`, `emoji`),
	FOREIGN KEY (`commentId`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
