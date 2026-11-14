-- The offboarding kill-switch for provider-issued CLI tokens (lib/oidc-bearer.ts). Glance cannot
-- delete a token the provider signed, so /api/admin/users/:id/revoke-cli stamps the moment (epoch
-- seconds) and the bearer path refuses any token from a sign-in before it.
ALTER TABLE `users` ADD COLUMN `cliRevokedAt` integer;
