# Glance

**Self-hosted artifacts for any coding agent.** Your agent builds a page, dashboard, or app and publishes it to a live URL with one command. You leave comments in the browser, like in a Google Doc. The agent reads them and fixes the page.

Works with Claude Code, Cursor, Codex, Cline, Aider, or anything else that can run a shell command. Runs on Cloudflare's free tier.

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/glance-demo.gif" alt="Glance demo: an agent deploys a folder to a URL, you leave review comments in the browser, and the agent reads the comments and fixes it" width="900">
</p>

```
  agent builds  →  glance deploy  →  URL
       ↑                               ↓
  reads comments, fixes  ←  you comment in the browser
```

## Self-host

You need a Cloudflare account with **R2** turned on ([dashboard](https://dash.cloudflare.com) → R2 → accept the terms; it's still free). Then run:

```bash
bun install
bunx wrangler login
scripts/setup.sh
```

`setup.sh` creates the resources, deploys the app, and prints your URL plus a **bootstrap token**. Open the printed `/login` page and paste the token into **Complete setup** to become the first admin. You can run the script again safely.

Using more than one Cloudflare account? Run `export CLOUDFLARE_ACCOUNT_ID=<id>` first. For manual setup or Google SSO, see [DEPLOY.md](DEPLOY.md).

## Use it

```bash
curl -fsSL https://<your-instance>/api/install | sh   # installs the CLI and the agent skill
glance login
glance deploy ./my-report                             # file or folder → live URL
glance comments <space/slug>                          # read review comments
```

Run `glance` with no arguments to see every command.

The install script also adds the agent skill for Claude Code. For other agents, run:

```bash
npx skills add plivo-labs/glance
```

**CI:** create an API key at `/settings/keys` and set `GLANCE_TOKEN=glk_...`. For the HTTP API, see [packages/api/API.md](packages/api/API.md).

## Features

- **Visibility:** each site is `private`, `members`, or `team`. Every link requires a login; nothing is public.
- **Audio:** audio files play in a built-in player. You can record audio or leave voice comments in the browser. Voice comments are transcribed, so agents read them as text.
- **`glance.db`** (experimental, opt-in): a small JSON document store your pages can use directly from the browser. See [SHARED_BACKEND.md](SHARED_BACKEND.md).

## Security

Uploaded HTML and JS are treated as untrusted. They are served from a separate domain, so they can't read your login session. That's why Glance runs two Workers. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

Built with Cloudflare Workers + Hono, React Router v7, D1, R2, and KV. The CLI is written in Go.

```
packages/api   Worker: API + file serving
packages/web   React app
packages/cli   glance CLI
```

For local setup and checks, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
