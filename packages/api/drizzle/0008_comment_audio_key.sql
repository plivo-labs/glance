-- Voice comments: nullable R2 object key for a comment's recorded audio. Text comments leave it
-- NULL; voice comments store the audio under this key and keep the server-side transcript in `body`
-- so the CLI/agent review loop reads everything as text. Plain ADD COLUMN (nullable, no default) —
-- no table rebuild, backfills every existing row to NULL.
ALTER TABLE `comments` ADD COLUMN `audioKey` text;
