---
name: glance-cli
description: Use the `glance` CLI to deploy a local folder of static files (HTML/markdown/assets) to a Glance instance and get a URL. Use when the user wants to publish/upload/deploy a folder, list their Glance sites, delete a site, or log in/out of Glance from the terminal. Covers pointing the CLI at a self-hosted instance via GLANCE_API_URL.
---

# Glance CLI

`glance` uploads a local folder to a Glance instance (static hosting on Cloudflare Workers) and returns a URL. Lives in `packages/cli/index.ts` (Bun, zero deps).

## Install

```bash
cd packages/cli
bun link            # makes `glance` global
# or
bun install -g .
```

Run ad-hoc without installing: `bun packages/cli/index.ts <command>`.

## Target instance

The CLI talks to `GLANCE_API_URL` (default `http://localhost:8787`). It's read on **every** command. For a self-hosted deploy:

```bash
export GLANCE_API_URL=https://glance.your-subdomain.workers.dev
```

Put it in your shell profile to make it permanent. Token + URL are saved to `~/.glance/config.json`.

## Commands

| command | what it does |
|---|---|
| `glance login` | device-code flow: prints a URL + code, opens a browser, polls until you approve, saves the token |
| `glance deploy <path> --space <slug> --name <slug> [--visibility team\|public\|private\|group]` | uploads every file under `<path>` |
| `glance list` | lists your sites — `space/slug  visibility  url` |
| `glance delete <space/slug>` | confirms (y/N), then deletes |
| `glance logout` | revokes the server session and removes the local token |

### login
Device-code flow. If no browser opener is available (SSH/headless), open the printed URL and enter the code manually. Must run before any authed command — others fail with "Not logged in."

### deploy
- `<path>`, `--space`, `--name` are all **required**; `--visibility` defaults to `team`.
- Walks `<path>` recursively, skipping `.git`, `node_modules`, `.DS_Store`. Relative paths are preserved as the site's file layout.
- If `space/slug` already exists and you own it, prompts `Replace? (y/N)`. If it's owned by someone else, it aborts.
- Prints `✓ Deployed → <url>`.

```bash
glance deploy ./dist --space docs --name api-reference --visibility public
```

### delete
Argument must be `space/slug` (with the slash), e.g. `glance delete docs/api-reference`.

## Visibility values
`team` (default) · `public` · `private` · `group`.

## Gotchas
- Commands other than `login`/`logout` require a saved token; run `glance login` first.
- Wrong `GLANCE_API_URL` → you'll log in / deploy against the wrong instance silently. Verify with `glance list`.
- `deploy` errors print the HTTP status and a truncated server message — check `--space`/`--name` are valid slugs and you're pointed at the right instance.
