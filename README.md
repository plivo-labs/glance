# Glance

**Artifacts for every agent — open-source and self-hosted.** Your agent builds a self-contained page, dashboard, or app and ships it to a live URL with one command — from Claude Code, Cursor, Codex, Cline, Aider, or any harness that runs a shell command. Then you review it in the browser and drop comments like a Google Doc, and the agent reads your comments and fixes it.

An open-source alternative to Claude Artifacts — except you host it, you own it, and any agent can drive it. No more screenshotting your agent's output and pasting it back into the chat.

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/glance-demo.gif" alt="Glance demo: an agent deploys a folder to a URL, you leave review comments in the browser, and the agent reads the comments and fixes it" width="900">
</p>

```
  agent builds  →  glance deploy → URL
       ↑                              ↓
  reads comments, fixes  ←  you comment in the browser
```

Self-hosted on **Cloudflare's free tier** — $0/month, you own the whole loop. Ships with a CLI and an agent skill, so any agent — Claude Code, Cursor, Codex, Cline, Aider — drives deploy → pull comments → reply → redeploy with no human in the copy-paste path.

Stack: Cloudflare Workers + Hono · React Router v7 · D1 · R2 · KV.

## Deploy

First enable **R2** on your account ([dashboard](https://dash.cloudflare.com) → R2 → accept terms — still free), then:

```bash
bun install
bunx wrangler login
scripts/setup.sh      # provisions D1/KV/R2, deploys both workers, sets secrets, migrates, prints URL + token
```

`setup.sh` is idempotent. At the end it prints a **bootstrap token** — open the printed `/login`, paste it into **Complete setup**, and you become the first superadmin. No Google account needed.

> Multiple Cloudflare accounts? `export CLOUDFLARE_ACCOUNT_ID=<id>` first. Manual provisioning, secrets, and optional Google SSO: see [DEPLOY.md](DEPLOY.md).

## The app

Pick a space, drop a folder, and your sites are live behind private/members/team visibility:

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/dashboard.png" alt="Glance dashboard — deploy panel and your sites" width="900">
</p>

Superadmins get usage at a glance — users, sites, storage, page views, comments, and CLI activity.

## Audio & voice comments

Glance is also a home for **audio** — and the review loop works by voice.

- **Serve & play** — audio files (`mp3/wav/m4a/ogg/flac/aac/webm`) serve with the right MIME type and HTTP Range, and render in a dedicated player (not the sandboxed HTML iframe), with page-anchored comments and a `[m:ss]` timestamp-insert shortcut.
- **Record → URL** — tap the mic on the dashboard, record (live waveform, pause/resume), name it, and it deploys and opens straight in the player. Uploading a file is still one tap away.
- **Voice comments** — record a voice note right in the review composer (and in replies). It's stored, transcribed best-effort with Workers AI (Whisper), and shown as a voice card: inline player + transcript + badge. The transcript is the comment body, so the CLI/agent loop still reads everything as text.

Audio sites carry a mic badge across the dashboard, and `glance comments` prefixes voice comments with `[voice]` in the digest.

## CLI

```bash
curl -fsSL https://glance.your-subdomain.workers.dev/api/install | sh   # installs to ~/.local/bin/glance
glance login          # device-code flow, opens browser
glance deploy <path>  # file or folder → publishes to your personal space
```

The installer bakes in your instance URL and installs the agent skill so coding agents can drive the CLI. Any agent that can run a shell command drives Glance by calling the `glance` CLI directly — it's harness-agnostic.

### Any agent, any harness

The bundled skill teaches your agent to drive Glance. Install it into **any** harness — Claude Code, Cursor, Codex, OpenCode, Amp, and more — with the [skills.sh](https://skills.sh) installer:

```bash
npx skills add plivo-labs/glance   # installs the glance-cli skill universally (Codex, Cursor, OpenCode, Claude Code …)
```

The `curl … /api/install | sh` line above already installs the skill for Claude Code alongside the binary. The skill only wraps the `glance` CLI, so any shell-capable agent works with or without it.

| command | what it does |
|---|---|
| `login` | device-code flow, saves token to `~/.glance/config.json` |
| `deploy <path> [--space <slug>] [--name <slug>] [--visibility <v>]` | uploads a file or folder (folders recurse, skip `.git`/`node_modules`) |
| `list` | your sites, with visibility + URL |
| `comments <space/slug>` | pull a site's review comments (voice comments show as `[voice]`) |
| `reply <thread>` | reply to a comment thread from the terminal |
| `delete <space/slug>` | confirms, then deletes |
| `move <space/slug> <new-space>` | moves a site (keeps files/comments/shares; URL changes) |
| `upgrade` / `version` / `logout` | self-update · print version · revoke session |

Defaults: `--space` = your personal space · `--name` = file/folder name slugified · `--visibility` = `team` (`private` · `members` also available). Point at another instance with `GLANCE_API_URL=https://… glance <cmd>`.

The CLI keeps itself current (once-a-day background check, atomic in-place swap). Opt out with `GLANCE_NO_UPDATE=1`.

## Security model

- **Uploaded HTML/JS is untrusted** — served from a separate content origin (`CONTENT_URL`), so app session cookies never reach it. This is why Glance stands up two Workers, not one.
- **Gated links** carry short-lived, single-use HMAC tokens. Every tier requires an authenticated user — there is no public/anonymous access.
- **Markdown** renders with raw HTML neutralized under a strict CSP, so injected `<script>` is inert.

## Shared backend — `glance.db` (experimental, opt-in)

Hosted sites can get browser-callable persistence — no keys, no config. Off by default; an operator enables it per deploy (see [SHARED_BACKEND.md](SHARED_BACKEND.md)).

```js
// Injected automatically when the site is opened through the Glance app; every request is
// brokered by the parent frame, so the page never holds a credential.
const notes = glance.db.collection('notes')
await notes.create({ text: 'hello' })   // create · list · get · put · delete
```

Docs are JSON ≤100KB in named collections. Every viewer can create and read their own docs; `shared-*` collections are readable by all viewers; the site owner reads everything and can moderate. Access is re-checked live, so revoking a share cuts data access immediately.

## Layout

```
packages/api   Hono Worker — /api/* + file serving, ships the React app as static assets
packages/web   Vite + React Router v7
packages/cli   `glance` CLI (Go)
```

Local dev: `bun install && bun run db:migrate:local && bun run dev` (main :8787 + content :8788 + vite :5173), then open http://localhost:5173. CI auto-deploys both workers on push to `main`.
