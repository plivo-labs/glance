-- Short blurb for a site, derived at upload from the entry HTML's <meta name="description">
-- (or og:description). Feeds the Slack link-unfurl card; unlike `title` it is CONTENT-derived, so
-- every replace overwrites it (and clears it when the new entry has none) rather than filling only
-- when null. Plain ADD COLUMN (nullable, no table rebuild); existing rows stay NULL until their
-- next deploy re-derives one.
ALTER TABLE `sites` ADD COLUMN `description` text;
