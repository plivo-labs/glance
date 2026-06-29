---
name: glance-cli
description: Use the `glance` CLI to deploy a local folder of static files (HTML/markdown/assets) to a Glance instance and get a URL, and to PULL a deployed site's review comments back to the terminal so a coding agent can act on them. Use when the user wants to publish/upload/deploy a folder, list their Glance sites, delete a site, log in/out of Glance from the terminal, or fetch/read/pull the review comments (feedback left in the browser) on a site to address them, or read a deployed file's raw contents back to the terminal. Closes the review loop: deploy → comment in the browser → `glance comments` to pull → edit → redeploy (anchors re-resolve server-side). Covers pointing the CLI at a self-hosted instance via GLANCE_API_URL.
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
| `glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team\|private\|members]` | uploads a file or a folder |
| `glance list` | lists your sites — `space/slug  visibility  url` |
| `glance delete <space/slug>` | confirms (y/N), then deletes |
| `glance move <space/slug> <new-space>` | moves a site to another space you belong to (keeps its files, comments, shares) |
| `glance comments <space/slug> [--file <path>] [--open] [--json]` | prints a site's review comments as a markdown digest (or raw JSON) |
| `glance read <space/slug> [--file <path>]` | prints a deployed file's raw contents to stdout (HTML as stored) |
| `glance logout` | revokes the server session and removes the local token |

### login
Device-code flow. If no browser opener is available (SSH/headless), open the printed URL and enter the code manually. Must run before any authed command — others fail with "Not logged in."

### deploy
- `<path>` is the only required arg — it can be a **single file** or a **folder**.
  - **File**: uploads just that file; it renders at the site root (e.g. `glance deploy report.html`).
  - **Folder**: walks recursively, skipping `.git`, `node_modules`, `.DS_Store`; relative paths become the site's layout.
- `--name` defaults to the **file name (sans extension)** or **folder name**, slugified. Pass `--name` to override (required if the derived name isn't a valid slug — lowercase, 3–40 chars).
- `--space` defaults to your **personal space**. Pass `--space` to target a team/group space.
- `--visibility` defaults to `team`.
- If the site already exists and you own it, prompts `Replace? (y/N)`. If owned by someone else, it aborts.
- Prints `✓ Deployed → <url>`.

```bash
glance deploy report.html                                  # → /<you>/report in your personal space
glance deploy ./dist --space docs --name api-reference --visibility members
```

### delete
Argument must be `space/slug` (with the slash), e.g. `glance delete docs/api-reference`.

### move
Move an existing site into another space you belong to: `glance move <space/slug> <new-space>`, e.g. `glance move my-handle/api-reference docs`. The site keeps its files, comments and shares — only its URL changes to `/<new-space>/<slug>`. Owner-only. Fails if a site with the same slug already exists in the target space.

### comments
Pulls the review comments (threads) on a deployed site so an agent can read them from the terminal.

- `<space/slug>` is required and must contain the slash (e.g. `docs/api-reference`).
- `--file <path>` narrows to a single file's threads (e.g. `--file index.md`); omit it to get **all** of the site's threads across every file.
- `--open` hides resolved threads — only `open` ones are shown.
- `--json` prints the raw thread array (the server `ThreadView[]`) instead of the digest — pipe it into `jq`. Combines with `--open` (the array is filtered to open threads first).

Default output is a **markdown digest**:

```
# 1 open · 1 resolved

### index.md · ✓ · OPEN
> "the quoted span this thread anchors to"
- @Ada: please reword this paragraph
- @Bob (deleted): [deleted]

### guide.md · ⚠ · RESOLVED
- @Ada: fixed in the latest deploy
```

- A header line counts `open` vs `resolved` over the shown threads.
- Threads are **grouped by file** (first-appearance order); each thread is a `###` heading `<filePath> · <glyph> · <STATUS>`.
- The glyph is the **anchor status**: `✓` anchored · `~` shifted · `?` suggested · `⚠` orphaned (the warning glyph means the quoted span drifted out of the document and the anchor was lost).
- A present quote renders as a `> "…"` blockquote; each comment is a `- @<author>: <body>` line. Deleted comments show `- @<author> (deleted): [deleted]` (original text is gone); a missing author falls back to `@unknown`.
- Empty result prints `No comments.`.

**Agent loop** — this command closes the review loop without a browser: `glance comments <space/slug> --open` to pull outstanding feedback → edit the local doc to address it → `glance deploy` to redeploy. Anchors re-resolve **server-side** on the new content (a thread whose quote still matches stays `anchored`/`shifted`; one whose span vanished goes `orphaned`/`⚠`), so re-running `glance comments` reflects the new state.

### read
Prints a deployed file's **raw contents** to stdout — the bytes as stored (HTML stays HTML; markdown stays markdown source, NOT the server-rendered HTML).

- `<space/slug>` is required and must contain the slash (e.g. `docs/api-reference`).
- `--file <path>` selects a file within the site (e.g. `--file guide.html`); omit it for the site root (a single-file site serves its lone file there).
- Output is the file body only — no headers, no trailing newline — so it pipes cleanly: `glance read docs/api-reference --file index.html > index.html`.
- Every tier is access-gated (there is no anonymous tier), so `read` works only on sites you can view; a tier you can't access fails with the server's status. Errors print the HTTP status + a truncated server message.

## Visibility values
`team` (default) · `private` · `members`.

`members` = people in the site's own space only (it was renamed from `group`; the old value is still accepted and mapped to `members`). There is no public/anonymous tier — `public` is still accepted on the wire but mapped to `team` (everyone in your org).

## Gotchas
- Commands other than `login`/`logout` require a saved token; run `glance login` first.
- Wrong `GLANCE_API_URL` → you'll log in / deploy against the wrong instance silently. Verify with `glance list`.
- `deploy` errors print the HTTP status and a truncated server message — check `--space`/`--name` are valid slugs and you're pointed at the right instance.
