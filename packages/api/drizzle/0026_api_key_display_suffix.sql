-- Non-secret display fragment for the key list UI (e.g. "glk_…4mR2"). ONLY the last 4 characters
-- of the plaintext secret are stored — never enough to be useful to an attacker even combined with
-- the public API_KEY_PREFIX constant, and the hash alone can never be reversed into it. Nullable so
-- pre-migration rows (none in prod yet, but the column must still tolerate it) render with no hint.
ALTER TABLE `api_keys` ADD `displaySuffix` text;
