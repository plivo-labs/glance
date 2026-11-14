-- Generic OIDC sign-in (lib/oidc.ts). SQLite cannot ADD COLUMN with a UNIQUE constraint, so the
-- uniqueness drizzle declares on the column is a separate index, named the way drizzle-kit names it.
-- The value is `<issuer> <sub>` (lib/oidc.ts oidcSubjectKey): `sub` alone is only unique within one
-- issuer, and a path-based issuer (Okta) keeps its org server's sub across authorization servers.
ALTER TABLE `users` ADD COLUMN `oidcSub` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidcSub_unique` ON `users` (`oidcSub`);
