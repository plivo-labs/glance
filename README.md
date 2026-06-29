# Glance

Self-hostable static-file hosting on Cloudflare's free tier. Drop a folder of HTML/markdown/assets → get a URL.

Cloudflare Workers + Hono · React + React Router v7 · D1 · R2 · KV. $0/month.

## Quick deploy

Self-host a fresh instance in **one command**. After a `wrangler login`, `scripts/setup.sh`
provisions everything, deploys both workers, sets the secrets, migrates, and prints your URL:

```bash
bun install
bunx wrangler login   # auth to your Cloudflare account
scripts/setup.sh      # provision D1/KV/R2 → deploy both workers → secrets → migrate → print URL + token
```

Prereqs: enable **R2** on your account first ([dashboard](https://dash.cloudflare.com) → R2 → accept
terms — still free). Multiple Cloudflare accounts on your login? `export CLOUDFLARE_ACCOUNT_ID=<id>`
before running so wrangler knows which one to use.

`setup.sh` prints a **bootstrap token** at the end. Open the printed `/login`, paste the token into
**Complete setup**, and you become the first superadmin — **no Google account required**. Google
SSO is an optional upgrade you can wire up later (see [Deploy](#deploy)). Prefer to do it by hand?
The manual path below still works.

> **Why no one-click "Deploy to Cloudflare" button?** Glance runs as **two Workers** — the app plus a
> separate content origin that sandboxes untrusted uploads (no app cookie ever reaches user HTML). A
> deploy button only provisions and deploys a *single* Worker, so it can't stand up the content origin
> or sync the shared signing secret across both. `setup.sh` does the whole thing in one command instead.

## Layout

```
packages/api   Hono Worker — /api/* + file serving, ships the React app as static assets
packages/web   Vite + React + React Router v7 (data mode, no useEffect)
packages/cli   `glance` CLI (Bun)
```

## Local dev

```bash
bun install
cp packages/api/.dev.vars.example packages/api/.dev.vars   # set SESSION_SECRET + BOOTSTRAP_TOKEN (Google optional)
bun run db:migrate:local              # apply D1 migrations to the local dev db
bun run build:web                     # build the SPA the worker serves
bun run dev                           # main worker (8787) + content worker (8788) + vite (5173)
```

Open http://localhost:5173.

## Manual provisioning (only if you skip `setup.sh`)

`scripts/setup.sh` does all of this for you (create-or-reuse by name, then wires the IDs into both
configs). Reach for the steps below only if you want to provision by hand or debug a binding.

```bash
wrangler login

# D1 database
wrangler d1 create glance-db
# → outputs: database_id = "xxxxxxxx-…"

# KV namespace for sessions
wrangler kv namespace create GLANCE_SESSIONS
# → outputs: id = "yyyyyyyy…"

# R2 bucket — enable R2 in the Cloudflare dashboard first, then:
wrangler r2 bucket create glance-files
```

Paste the IDs into **both** `packages/api/wrangler.jsonc` and `packages/api/wrangler.content.jsonc`
(they ship with `YOUR_*` placeholders):

```jsonc
// wrangler.jsonc  (and wrangler.content.jsonc — same fields)
"d1_databases": [{ "database_id": "<paste database_id here>" }],
"kv_namespaces": [{ "id": "<paste kv id here>" }],
```

**Delete the `account_id` line** (it ships as a `YOUR_ACCOUNT_ID` placeholder wrangler would reject) so
the account resolves from `wrangler login` — or set it to your real account id. `setup.sh` strips it for you.

Then set the `vars` block in both configs to your real values:

| var | example |
|---|---|
| `APP_URL` | `https://glance.your-subdomain.workers.dev` |
| `CONTENT_URL` | `https://glance-content.your-subdomain.workers.dev` |
| `ALLOWED_HD` | `yourcompany.com` (Google Workspace domain) |
| `SUPERADMIN_EMAIL` | `you@yourcompany.com` |

Also update `_headers` `frame-src` and the content worker `frame-ancestors` to the real `CONTENT_URL`.

Finally apply migrations to the remote D1:

```bash
cd packages/api
wrangler d1 migrations apply glance-db --remote
```

## Deploy

The fastest path is `scripts/setup.sh` (see [Quick deploy](#quick-deploy)). It provisions D1/KV/R2,
generates the secrets, sets a one-time `BOOTSTRAP_TOKEN`, runs the remote migration, deploys both
workers, wires the live `workers.dev` URLs into config, and prints the first-run link + token. It is
idempotent: resources are reused (never duplicated) and re-running never rotates an existing
`SESSION_SECRET` (which would drop live sessions). The manual equivalent is below.

### 1. Secrets

Both workers need `SESSION_SECRET` and `CONTENT_TOKEN_SECRET`. The main worker also needs a
`BOOTSTRAP_TOKEN` for first-run admin setup.

```bash
cd packages/api

# Generate secrets: openssl rand -hex 32
for w in "" "--config wrangler.content.jsonc"; do
  echo "$SESSION_SECRET"        | wrangler secret put SESSION_SECRET        $w
  echo "$CONTENT_TOKEN_SECRET"  | wrangler secret put CONTENT_TOKEN_SECRET  $w
done

# First-run admin gate (paste this into /login → Complete setup). Keep it secret.
echo "$(openssl rand -hex 32)" | wrangler secret put BOOTSTRAP_TOKEN
```

`SESSION_SECRET` — HMAC key for signed cookies and KV session tokens.
`CONTENT_TOKEN_SECRET` — separate HMAC key used to sign short-lived gated-content URL tokens.
Keep them distinct.

### 2. Ship

```bash
bun run deploy   # build web → deploy main worker (with assets) → deploy content worker
```

### 3. First run (bootstrap the admin)

Open `https://glance.<your-subdomain>.workers.dev/login`, paste your `BOOTSTRAP_TOKEN` into the
**Complete setup** field, and submit. This claims `SUPERADMIN_EMAIL` as the first superadmin and
signs you in — no Google account, no seed script. Once an admin exists the setup panel disappears
and the token is inert.

### Google OAuth (optional)

Glance runs fine on bootstrap auth alone. To add Google Workspace SSO later, create an OAuth client
at console.cloud.google.com → Credentials (authorized redirect URI
`https://glance.<your-subdomain>.workers.dev/api/auth/callback`), then set the credentials and
redeploy:

```bash
cd packages/api
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
bun run deploy
```

The login page shows the Google button automatically once both credentials are set. A later Google
login on the same email backfills onto your bootstrap admin (the role is preserved). While the
credentials are unset, the Google routes return 404 and the button is hidden.

## CLI

The `glance` CLI uploads local folders straight from the terminal.

### Install

```bash
# one-liner — downloads the standalone binary for your platform (no Bun/Node needed)
curl -fsSL https://raw.githubusercontent.com/plivo-labs/glance/main/install.sh | sh
```

It installs to `~/.local/bin/glance`. Override the target with `GLANCE_INSTALL_DIR`.

**Pointing teammates at your instance in one shot.** Your deployment serves the installer itself at
`/api/install`, with `GLANCE_API_URL` already baked in to that origin. Teammates run one line and the
CLI targets your instance — no env var to set, no GitHub URL to remember:

```bash
curl -fsSL https://glance.your-subdomain.workers.dev/api/install | sh
```

(Equivalent to piping the GitHub installer with `GLANCE_API_URL=…` set by hand — that still works too:
`curl -fsSL https://raw.githubusercontent.com/plivo-labs/glance/main/install.sh | GLANCE_API_URL=… sh`.)
The installer writes the instance into the CLI's own config (`~/.glance/config.json`), so `glance
login` targets it **immediately — in the same shell, no `source`/restart needed**. The URL precedence
is `GLANCE_API_URL` env → that config → `http://localhost:8787`. They just run `glance login` (Google
SSO) and start deploying.

**AI-agent skill.** The installer also runs `glance skill install` — which ships the skill inside the
binary and writes it into Claude Code's skills dir with **no Node/npx needed** — so coding agents know
how to drive the CLI. Add or refresh it anytime with `glance skill install`. Other agents (Codex,
Cursor) can pull the same skill from the repo:

```bash
npx skills add plivo-labs/glance --global
```

From a clone instead:

```bash
cd packages/cli
bun link          # makes `glance` available globally via bun's bin linking
# or
bun install -g .
```

### Commands

```
glance login
glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team|public|private|group]
glance list
glance delete <space/slug>
glance logout
```

| command | what it does |
|---|---|
| `login` | device-code flow — opens a browser, polls until approved, saves token to `~/.glance/config.json` |
| `deploy <path>` | `<path>` is a **file or a folder**. A folder uploads recursively (skips `.git`/`node_modules`); a lone file uploads on its own and renders at the site root |
| `list` | shows your sites with visibility and URL |
| `delete <space/slug>` | prompts for confirmation, then deletes |
| `logout` | revokes the server-side session and removes the local token |

The shortest deploy is just a path — `glance deploy report.html` publishes to your personal space at
`/<you>/report`:

```bash
glance deploy report.html                      # name=report, space=your personal space
glance deploy ./dist --space team --name docs   # folder, explicit space + name
```

**deploy flags**

| flag | required | default |
|---|---|---|
| `--space <slug>` | no | your **personal** space |
| `--name <slug>` | no | the file name (sans extension) or folder name, slugified |
| `--visibility` | no | `team` |

Visibility values: `team` · `public` · `private` · `group`. If a name can't be derived into a valid
slug (e.g. too short or all-symbols), the CLI asks you to pass `--name`.

### Pointing the CLI at a self-hosted instance

```bash
GLANCE_API_URL=https://glance.your-subdomain.workers.dev glance login
```

The env var is read on every command; set it in your shell profile to make it permanent.

## Security / trust model

- **Uploaded HTML/JS is untrusted.** It is served from a separate content origin (`CONTENT_URL`)
  so no session cookies from the main app ever reach it. Self-hosters are serving arbitrary
  user-supplied HTML — treat the content origin as a sandboxed domain.
- **Gated links** carry short-lived HMAC tokens signed with `CONTENT_TOKEN_SECRET`.
  Tokens are single-use and expire; the content worker verifies the signature before serving.
- **Markdown** is rendered with raw HTML neutralized and a strict `Content-Security-Policy`
  applied, so injected `<script>` tags in markdown source are inert.
- The main worker sets `frame-src` in `_headers` to `CONTENT_URL` only, so the content
  iframe cannot be substituted by an attacker-controlled origin.
