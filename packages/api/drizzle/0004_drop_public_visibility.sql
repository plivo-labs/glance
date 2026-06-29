-- Remove the `public` visibility tier (no anonymous/public sites). Every remaining tier requires
-- an authenticated viewer; existing public sites are promoted to `team` (everyone in the org), the
-- broadest live tier. `visibility` is a plain text column (no CHECK), so a data update suffices —
-- no table rebuild. The enum narrowing is enforced in app code (schema.ts / lib/visibility.ts).
UPDATE `sites` SET `visibility` = 'team' WHERE `visibility` = 'public';
