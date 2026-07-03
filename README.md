# Glance

Self-hostable static-file hosting on Cloudflare's free tier. Drop a folder of HTML/markdown/assets → get a URL. $0/month.

Stack: Cloudflare Workers + Hono · React Router v7 · D1 · R2 · KV.

## Deploy in one command

First enable **R2** on your account ([dashboard](https://dash.cloudflare.com) → R2 → accept terms — still free), then:

```bash
bun install
bunx wrangler login
scripts/setup.sh      # provisions D1/KV/R2, deploys both workers, sets secrets, migrates, prints URL + token
```

`setup.sh` is idempotent (reuses resources, never rotates `SESSION_SECRET`). At the end it prints a **bootstrap token** — open the printed `/login`, paste it into **Complete setup**, and you become the first superadmin. No Google account needed.

> Multiple Cloudflare accounts? `export CLOUDFLARE_ACCOUNT_ID=<id>` first.
>
> Why two Workers (and no one-click button)? The app runs separately from a content origin that sandboxes untrusted uploads, so no app cookie ever reaches user HTML. A deploy button only provisions one Worker; `setup.sh` stands up both.

## Local dev

```bash
bun install
cp packages/api/.dev.vars.example packages/api/.dev.vars   # set SESSION_SECRET + BOOTSTRAP_TOKEN
bun run db:migrate:local
bun run build:web
bun run dev           # main :8787 + content :8788 + vite :5173
```

Open http://localhost:5173.

## Layout

```
packages/api   Hono Worker — /api/* + file serving, ships the React app as static assets
packages/web   Vite + React Router v7
packages/cli   `glance` CLI (Bun)
```

## CLI

```bash
curl -fsSL https://glance.your-subdomain.workers.dev/api/install | sh   # installs to ~/.local/bin/glance
glance login          # device-code flow, opens browser
glance deploy <path>  # file or folder → publishes to your personal space
```

The installer bakes in your instance URL (so `glance login` targets it immediately, same shell) and installs the AI-agent skill so coding agents can drive the CLI.

| command | what it does |
|---|---|
| `login` | device-code flow, saves token to `~/.glance/config.json` |
| `deploy <path> [--space <slug>] [--name <slug>] [--visibility <v>]` | uploads a file or folder (folders recurse, skip `.git`/`node_modules`) |
| `list` | your sites, with visibility + URL |
| `delete <space/slug>` | confirms, then deletes |
| `move <space/slug> <new-space>` | moves a site (keeps files/comments/shares; URL changes) |
| `logout` | revokes session, removes local token |

Defaults: `--space` = your personal space · `--name` = file/folder name slugified · `--visibility` = `team`.
Visibility: `team` · `private` · `members` (own space only).

Point at another instance any time with `GLANCE_API_URL=https://… glance <cmd>`.

## Security model

- **Uploaded HTML/JS is untrusted** — served from a separate content origin (`CONTENT_URL`), so app session cookies never reach it.
- **Gated links** carry short-lived, single-use HMAC tokens signed with `CONTENT_TOKEN_SECRET`.
- **Markdown** renders with raw HTML neutralized under a strict CSP, so injected `<script>` is inert.

## Shared backend — `glance.db` (experimental, opt-in)

Hosted sites can get browser-callable persistence — no keys, no config. Off by default; an
operator enables it per deploy (`DATA_TOKEN_SECRET`, see [DEPLOY.md](DEPLOY.md#2-secrets)).

```js
// On a page served from the APP origin (hosted-page support lands with the broker, see SHARED_BACKEND.md):
window.__GLANCE_DB__ = { space: 'sam', site: 'demo' }
// <script src="/api/glance.js"></script>
const notes = glance.db.collection('notes')
await notes.create({ text: 'hello' })      // POST   /api/_data/notes        → {id, data, createdAt, updatedAt}
await notes.list()                          // GET    /api/_data/notes        → {items: [...]} newest-first, ?limit≤200
await notes.get(id)                         // GET    /api/_data/notes/:id
await notes.put(id, { text: 'edited' })     // PUT    /api/_data/notes/:id    (upsert at your own id)
await notes.delete(id)                      // DELETE /api/_data/notes/:id
```

Programmatic use (cron jobs, scripts) works today with a CLI token:

```bash
TOKEN=$(curl -s -X POST -H "Authorization: Bearer $GLANCE_CLI_TOKEN" \
  "$GLANCE_API_URL/api/data-token/<space>/<site>" | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" "$GLANCE_API_URL/api/_data/notes"
```

Rules: docs are JSON objects ≤100KB in named collections · writes need the site **owner** (viewers
get read-only tokens) · reads return only **your own** documents ("public within site" is a
planned opt-in) · every request re-checks live site access, so revoking a share cuts data access
immediately. Design + threat model: [SHARED_BACKEND.md](SHARED_BACKEND.md).

## Advanced

- **Manual provisioning / deploy** (skip `setup.sh`), **secrets reference**, and **Google OAuth SSO** (optional) — see [DEPLOY.md](DEPLOY.md).
- CI auto-deploys both workers on push to `main` (`.github/workflows/deploy.yml`).
