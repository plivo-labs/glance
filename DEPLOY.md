# Deploy (manual / advanced)

The fast path is `scripts/setup.sh` (see [README](README.md#deploy-in-one-command)). It provisions D1/KV/R2, generates secrets, sets a one-time `BOOTSTRAP_TOKEN`, migrates, deploys both workers, wires the live `workers.dev` URLs into config, and prints the first-run link + token. The manual equivalent is below.

## 1. Provision

```bash
wrangler login

wrangler d1 create glance-db            # → database_id = "xxxx…"
wrangler kv namespace create GLANCE_SESSIONS   # → id = "yyyy…"
wrangler r2 bucket create glance-files  # enable R2 in the dashboard first
```

Paste the IDs into **both** `packages/api/wrangler.jsonc` and `packages/api/wrangler.content.jsonc` (they ship with `YOUR_*` placeholders):

```jsonc
"d1_databases": [{ "database_id": "<database_id>" }],
"kv_namespaces": [{ "id": "<kv id>" }],
```

**Delete the `account_id` line** (it ships as a `YOUR_ACCOUNT_ID` placeholder) so the account resolves from `wrangler login`, or set it to your real id.

Set the `vars` block in both configs:

| var | example |
|---|---|
| `APP_URL` | `https://glance.your-subdomain.workers.dev` |
| `CONTENT_URL` | `https://glance-content.your-subdomain.workers.dev` |
| `ALLOWED_HD` | `yourcompany.com` (Google Workspace domain) |
| `SUPERADMIN_EMAIL` | `you@yourcompany.com` |

Also update `_headers` `frame-src` and the content worker `frame-ancestors` to the real `CONTENT_URL`.

Apply migrations to remote D1:

```bash
cd packages/api && wrangler d1 migrations apply glance-db --remote
```

## 2. Secrets

Both workers need `SESSION_SECRET` and `CONTENT_TOKEN_SECRET` (keep them distinct). The main worker also needs `BOOTSTRAP_TOKEN` for first-run admin setup.

```bash
cd packages/api
# generate with: openssl rand -hex 32
for w in "" "--config wrangler.content.jsonc"; do
  echo "$SESSION_SECRET"       | wrangler secret put SESSION_SECRET       $w
  echo "$CONTENT_TOKEN_SECRET" | wrangler secret put CONTENT_TOKEN_SECRET $w
done
echo "$(openssl rand -hex 32)" | wrangler secret put BOOTSTRAP_TOKEN
```

- `SESSION_SECRET` — HMAC key for signed cookies + KV session tokens.
- `CONTENT_TOKEN_SECRET` — HMAC key for short-lived gated-content URL tokens.

## 3. Ship

```bash
bun run deploy   # build web → deploy main worker (with assets) → deploy content worker
```

## 4. First run

Open `https://glance.<your-subdomain>.workers.dev/login`, paste `BOOTSTRAP_TOKEN` into **Complete setup**, and submit. This claims `SUPERADMIN_EMAIL` as the first superadmin and signs you in. Once an admin exists the setup panel disappears and the token is inert.

## Google OAuth (optional)

Glance runs fine on bootstrap auth alone. To add Google Workspace SSO, create an OAuth client at console.cloud.google.com → Credentials (authorized redirect URI `https://glance.<your-subdomain>.workers.dev/api/auth/callback`), then:

```bash
cd packages/api
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
bun run deploy
```

The Google button appears automatically once both credentials are set. A later Google login on the same email backfills onto your bootstrap admin (role preserved). While unset, the Google routes return 404 and the button is hidden.

## CI auto-deploy

`.github/workflows/deploy.yml` deploys both workers + runs the D1 migrate on push to `main`. The only repo secret needed is `CLOUDFLARE_API_TOKEN` (scopes: Workers Scripts, D1, KV, R2). Worker secrets are set once via `wrangler secret put` and persist across deploys.
