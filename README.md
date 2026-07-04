# Glance

**The human-in-the-loop review layer for coding agents.** Your agent builds something, deploys it to a URL with one command — you review it in the browser and drop comments like a Google Doc — and the agent reads your comments and fixes it.

No more screenshotting your agent's output and pasting it back into the chat.

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/glance-demo.gif" alt="Glance demo: an agent deploys a folder to a URL, you leave review comments in the browser, and the agent reads the comments and fixes it" width="900">
</p>

```
  agent builds  →  glance deploy → URL
       ↑                              ↓
  reads comments, fixes  ←  you comment in the browser
```

Self-hosted on **Cloudflare's free tier** — $0/month, you own the whole loop. Ships with a CLI and an AI-agent skill, so agents drive deploy → pull comments → reply → redeploy with no human in the copy-paste path.

**Why not just Cloudflare Pages?** Pages is a git-and-build pipeline for one account. Glance is an agent-native review loop on the same free infra: agents drop a folder (no build, no git), you comment on the result, agents read the comments back and fix it. Untrusted uploads are sandboxed, and it's multi-tenant with per-link gating.

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

## The app

Pick a space, drop a folder, and your sites are live behind private/members/team visibility:

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/dashboard.png" alt="Glance dashboard — deploy panel and your sites" width="900">
</p>

Superadmins get usage at a glance — users, sites, storage, page views, comments, and CLI activity:

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/admin.png" alt="Glance admin — usage overview with stat tiles and 30-day activity" width="900">
</p>

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
| `upgrade` | updates the CLI to the latest release now |
| `version` | prints the CLI version |
| `logout` | revokes session, removes local token |

Defaults: `--space` = your personal space · `--name` = file/folder name slugified · `--visibility` = `team`.
Visibility: `team` · `private` · `members` (own space only).

Point at another instance any time with `GLANCE_API_URL=https://… glance <cmd>`.

The CLI keeps itself current: at most once a day it checks for a new release in the background,
swaps the binary in place, and mentions it on the next run. Opt out with `GLANCE_NO_UPDATE=1`
(checks are also skipped in CI).

## Security model

- **Uploaded HTML/JS is untrusted** — served from a separate content origin (`CONTENT_URL`), so app session cookies never reach it.
- **Gated links** carry short-lived, single-use HMAC tokens signed with `CONTENT_TOKEN_SECRET`.
- **Markdown** renders with raw HTML neutralized under a strict CSP, so injected `<script>` is inert.

## Shared backend — `glance.db` (experimental, opt-in)

Hosted sites can get browser-callable persistence — no keys, no config. Off by default; an
operator enables it per deploy (`DATA_TOKEN_SECRET`, see [DEPLOY.md](DEPLOY.md#2-secrets)).

```js
// In any HTML page you deploy — no setup, no keys, no script tag. When the site is opened
// through the Glance app, the SDK is injected automatically and every request is brokered by
// the parent frame (postMessage + MessagePort), so the page NEVER holds a credential.
const notes = glance.db.collection('notes')
await notes.create({ text: 'hello' })      // POST   /api/_data/notes        → {id, data, createdAt, updatedAt}
await notes.list()                          // GET    /api/_data/notes        → {items: [...]} newest-first, ?limit≤200
await notes.get(id)                         // GET    /api/_data/notes/:id
await notes.put(id, { text: 'edited' })     // PUT    /api/_data/notes/:id    (upsert at your own id)
await notes.delete(id)                      // DELETE /api/_data/notes/:id
```

Pages on the app origin can use the same client directly: set
`window.__GLANCE_DB__ = { space, site }` and load `<script src="/api/glance.js"></script>` —
same five methods, token minted via the session.

Programmatic use (cron jobs, scripts) works today with a CLI token:

```bash
TOKEN=$(curl -s -X POST -H "Authorization: Bearer $GLANCE_CLI_TOKEN" \
  "$GLANCE_API_URL/api/data-token/<space>/<site>" | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" "$GLANCE_API_URL/api/_data/notes"
```

Rules: docs are JSON objects ≤100KB in named collections · every viewer can **create**
(submissions are attributed to them) and read **their own** docs · collections named `shared-*`
are readable by every viewer of the site (polls, boards) · the site **owner** additionally reads
everything and can update/delete (moderation) — viewers can never modify existing docs · every
request re-checks live site access, so revoking a share cuts data access immediately. Design +
threat model: [SHARED_BACKEND.md](SHARED_BACKEND.md).

## Advanced

- **Manual provisioning / deploy** (skip `setup.sh`), **secrets reference**, and **Google OAuth SSO** (optional) — see [DEPLOY.md](DEPLOY.md).
- CI auto-deploys both workers on push to `main` (`.github/workflows/deploy.yml`).
