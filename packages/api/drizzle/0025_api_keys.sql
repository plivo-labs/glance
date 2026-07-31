-- Control-plane API keys: a long-lived credential a user mints for CLI/CI use, distinct from the
-- GLANCE_SESSIONS browser cookie. Only `hash` (SHA-256 hex of the secret) is ever stored — the
-- secret itself is shown once at creation and never persisted. `grants` is a JSON blob holding the
-- key's scoped permissions, the same text/json-mode idiom as `documents.json`. `revokedAt` is a
-- manual kill switch; `expiresAt` is enforced independently at auth time. `userId` cascades: a
-- deleted user's keys are meaningless. The (userId, createdAt) index serves the owner's list query.
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`grants` text NOT NULL,
	`createdAt` text NOT NULL,
	`expiresAt` text NOT NULL,
	`revokedAt` text,
	`lastUsedAt` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);
--> statement-breakpoint
CREATE INDEX `api_keys_user_created` ON `api_keys` (`userId`,`createdAt`);
