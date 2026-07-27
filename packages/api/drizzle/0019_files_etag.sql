-- R2's httpEtag, denormalized onto the file row at upload. Storage keys are immutable (a replace
-- mints new keys), so the etag is fixed for the row's life — the content worker can answer
-- If-None-Match 304s and Range 416s straight from the access batch with ZERO R2 ops. Plain
-- ADD COLUMN (nullable, no table rebuild); existing rows stay NULL and keep the head() probe
-- fallback until their next deploy.
ALTER TABLE `files` ADD COLUMN `etag` text;
