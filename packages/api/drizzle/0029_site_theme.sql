-- Optional design theme applied to a site's served HTML (serve-time <link> injection — stored
-- bytes are never mutated, so `?raw=1` pulls stay byte-identical). Values are theme slugs from
-- src/themes (e.g. 'plivo', 'matrix'); NULL = no theme. Plain text with no CHECK constraint —
-- validation happens at the route boundary against the theme registry, so adding a theme needs
-- no migration. Plain ADD COLUMN (nullable, no table rebuild); existing rows stay NULL.
ALTER TABLE `sites` ADD COLUMN `theme` text;
