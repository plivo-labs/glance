-- Google profile photo URL, captured from the OAuth id_token's `picture` claim on every login.
-- Held server-side only: the avatar route proxies it same-origin, so this URL never reaches a
-- browser. Plain ADD COLUMN (nullable, no table rebuild); every existing row stays NULL until that
-- user's next Google login backfills it, and initials keep rendering until then.
ALTER TABLE `users` ADD COLUMN `avatarUrl` text;
