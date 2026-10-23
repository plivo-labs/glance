-- Generic OIDC sign-in (lib/oidc.ts). SQLite cannot ADD COLUMN with a UNIQUE constraint, so the
-- uniqueness drizzle declares on both columns is a separate index, named the way drizzle-kit names it.
ALTER TABLE `users` ADD COLUMN `oidcSub` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidcSub_unique` ON `users` (`oidcSub`);
--> statement-breakpoint
ALTER TABLE `spaces` ADD COLUMN `oidcGroup` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_oidcGroup_unique` ON `spaces` (`oidcGroup`);
