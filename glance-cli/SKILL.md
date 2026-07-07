---
name: glance-cli
description: Use the `glance` CLI to deploy a file or folder to a Glance instance and get a URL, manage sites (list, delete, move), and close the review loop from the terminal — pull a site's review comments, reply to a thread, then redeploy. Also use it to build a self-contained HTML explainer/dashboard for a codebase or system and publish it — "explain with html", "make an html dashboard", "visualize this architecture", "a simple HTML summary for my boss". Covers pointing the CLI at a self-hosted instance via GLANCE_API_URL.
---

# Glance CLI

`glance` uploads a local folder to a Glance instance (static hosting on Cloudflare Workers) and returns a URL. It's a single self-contained binary — nothing else to install.

## Install

```bash
curl -fsSL <your-glance-instance>/api/install | sh
```

This drops the `glance` binary on your PATH (pre-pointed at that instance) and it keeps itself up to date. Run `glance` with no arguments to list every command.

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
| `glance reply <space/slug> <threadId> [message] [--tag <label>\|--no-tag]` | posts a reply to a comment thread (get the `threadId` from `glance comments`) |
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

### index.md · OPEN · k3f9q2
> "the quoted span this thread anchors to"
- @Ada: please reword this paragraph
- @Bob (deleted): [deleted]

### guide.md · RESOLVED · p1x7d4
- @Ada: fixed in the latest deploy
```

- A header line counts `open` vs `resolved` over the shown threads.
- Threads are **grouped by file** (first-appearance order); each thread is a `###` heading `<filePath> · <STATUS> · <threadId>`. The trailing **threadId** is what you pass to `glance reply` to respond on that thread.
- A present quote renders as a `> "…"` blockquote; each comment is a `- @<author>: <body>` line. Deleted comments show `- @<author> (deleted): [deleted]` (original text is gone); a missing author falls back to `@unknown`.
- Empty result prints `No comments.`.

**Agent loop** — this command closes the review loop without a browser: `glance comments <space/slug> --open` to pull outstanding feedback → edit the local doc to address it → `glance reply <space/slug> <threadId>` to note what you changed on the thread → `glance deploy` to redeploy, then re-run `glance comments` to see the updated threads. A comment's highlight is re-located in the page when you reopen it in the browser; the comment itself always stays in the digest regardless.

### reply
Posts a reply to an existing comment thread — so you can respond after addressing feedback, right from the terminal.

- `<space/slug>` is required and must contain the slash (e.g. `docs/api-reference`).
- `<threadId>` is required — copy it from the `###` heading in `glance comments` output (the value after the status).
- The reply body comes from **either** a positional `[message]` **or** stdin:
  - **stdin is the recommended channel** for anything an agent writes, or any multiline/arbitrary text — pipe it in: `echo "done — reworded the intro" | glance reply docs/api-reference k3f9q2`. A here-doc works for multiple lines.
  - A positional `[message]` is fine for a short, one-line note: `glance reply docs/api-reference k3f9q2 "fixed in the latest deploy"`. Quote it so the shell keeps it as one argument.
  - A positional message that **starts with a dash** is taken as a flag unless you put `--` first: `glance reply docs/api-reference k3f9q2 -- "-- see the note above"`. (Everything after `--` is literal.) For anything tricky, prefer stdin.
- **Tagging / attribution.** A reply is attributed **server-side to the logged-in account** — there is no separate "agent" identity. So the body is prefixed to mark authorship:
  - default: `[agent] ` — signals the reply was written by an agent (the **only** signal of that; the author on record is still the human who's logged in).
  - `--tag <label>`: use a custom prefix, e.g. `--tag claude` → `[claude] …`.
  - `--no-tag`: no prefix — a plain reply as the logged-in human.
- Empty bodies are rejected; a body over the server's size limit fails with the server's error. Prints `✓ Replied to <threadId>` on success.

```bash
glance comments docs/api-reference --open                 # find the threadId on the heading
echo "reworded the intro as requested" | glance reply docs/api-reference k3f9q2
glance reply docs/api-reference k3f9q2 "typo fixed" --no-tag
```

### read
Prints a deployed file's **raw contents** to stdout — the bytes as stored (HTML stays HTML; markdown stays markdown source, NOT the server-rendered HTML).

- `<space/slug>` is required and must contain the slash (e.g. `docs/api-reference`).
- `--file <path>` selects a file within the site (e.g. `--file guide.html`); omit it for the site root (a single-file site serves its lone file there).
- Output is the file body only — no headers, no trailing newline — so it pipes cleanly: `glance read docs/api-reference --file index.html > index.html`.
- Every tier is access-gated (there is no anonymous tier), so `read` works only on sites you can view; a tier you can't access fails with the server's status. Errors print the HTTP status + a truncated server message.

## Visibility values
`team` (default) · `private` · `members`.

`members` = people in the site's own space only (it was renamed from `group`; the old value is still accepted and mapped to `members`). There is no public/anonymous tier — `public` is still accepted on the wire but mapped to `team` (everyone in your org).

## Saving data from your pages — `glance.db` (experimental)

Each site gets a small JSON document store, and any HTML page you deploy can use it directly —
no keys, no setup, no script tag. When someone opens the site through the Glance app, `glance.db`
is available to the page's JavaScript automatically:

```js
const notes = glance.db.collection('notes')
await notes.create({ text: 'hello' })       // returns {id, data, createdAt, updatedAt}
await notes.list()                           // your documents, newest first
await notes.get(id); await notes.put(id, {...}); await notes.delete(id)
```

So a deployed page can have a working form, notes list, or per-viewer state with just that.
(Only when viewed through the app — opening the raw content URL directly gives a clear
"open this site through the Glance app" error.)

Scripts and cron jobs can write to the same store — exchange your CLI token
(`~/.glance/config.json`) for a short-lived data token:

```bash
TOKEN=$(curl -s -X POST -H "Authorization: Bearer <cli-token>" \
  "$GLANCE_API_URL/api/data-token/<space>/<slug>" | jq -r .token)     # valid 5 min
curl -H "Authorization: Bearer $TOKEN" -X POST -d '{"text":"hi"}' \
  "$GLANCE_API_URL/api/_data/notes"
# also: GET /api/_data/notes (list) · GET/PUT/DELETE /api/_data/notes/<id>
```

Rules of thumb: documents are JSON objects up to 100KB, grouped into named collections ·
**anyone viewing the site can add** documents (attributed to them) — so forms and surveys just
work · by default you only see documents **you** created; name a collection `shared-…` and every
viewer sees all of it (polls, boards) · the site **owner** sees everything and can edit/delete
any document (moderation); other viewers can never change existing documents · access follows
the site's sharing — lose access to the site, lose access to its data. If it errors with "not
enabled", ask your Glance admin to turn the feature on.

## Explaining code or a system as HTML

When the user wants to understand — or share understanding of — a codebase, module, system, or technical query, don't answer in prose: build ONE self-contained, visually distinctive `.html` page and deploy it. This turns "explain X" into an artifact someone can open, click through, and share via URL.

### Loop: Scope → Investigate → Verify → Render → Publish

**Scope.** Pin down: the query (what must the reader understand?), the target files/dirs, the output filename (slug the topic, e.g. `<topic>-explainer.html`, or `-architecture.html` / `-flow.html`), and the mode:
- **Deep dashboard** (default) — dense, diagram-heavy, for someone studying the system. Everything visible, sections scroll.
- **Lightweight summary** — for a manager/exec/boss, or when asked for "simple"/"light"/"not too much upfront": only a one-screen pitch is visible up front; every detail lives behind a click.

**Investigate.** Never explain from assumption — read the real code first. Map structure and volume (`find` the tree, LOC per file/dir — the single best signal for "where the complexity lives"). Read entry points, contracts, and the biggest files yourself. Trace how modules and systems actually connect: imports/exports across boundaries, shared state read/written by multiple features, API/event/websocket/webhook edges — capture these as directional edges (`A —imports→ B`, `FE —SSE /events→ runner`) to render as a connection diagram. Name the real stack by grepping the manifest (`package.json`/equivalent) for the libraries actually in use.

**Verify.** Symptom ≠ truth. Before calling anything dead/unused, grep its imports and confirm zero reachable callers. Before claiming "duplicated," open both sites and confirm. Before stating a count or LOC number, re-run the command — don't estimate. If a claim is uncertain, label it "investigate" rather than assert it; one wrong confident claim discredits the whole page.

**Render.** A single self-contained `.html` file: inline `<style>`, no build step (Google Fonts, and a diagram CDN like mermaid for dense graphs, are fine as external deps). Commit to ONE deliberate visual point of view — a distinctive type pairing (display + body + a tabular mono for all numbers/code/paths), a cohesive palette via CSS variables with a dominant color and a sharp accent, real texture (grain, grid, shadow) over flat cards, one orchestrated page-load reveal rather than scattered micro-interactions. Avoid the generic AI-dashboard look — no purple-on-white, no default Inter/Roboto, no zebra tables with no point of view. Pick diagrams that fit the query: an architecture schematic (layered boxes + connectors), a connection/dependency map (labeled, directional edges — imports, API calls, events; group by repo/service for cross-system seams), a flow/sequence chart, a LOC heatmap, a hotspot/biggest-files table, findings cards, a ranked action table. Annotate with real names (`file:line`, actual component/store names) — never abstract placeholders like "Service A".

*Lightweight summary mode*: above the fold, only a kicker line, a headline that's a plain-English claim, one short sub-paragraph, and 3–5 stat chips. Everything else lives in native `<details>/<summary>` accordions (zero JS) — plain language, an inline flow strip instead of a diagram, small tables with status tags, a "known issues"/"not tested yet" section. An honest report that admits gaps is trusted more than a flawless one. For work that continues, treat the file as a living doc — update it in place (flip status tags, adjust chips) and add a "Journal" accordion of what happened, in order, rather than emitting new files.

**Publish.** Verify tag balance and `open <file>` locally first, then:
```bash
glance deploy <file>.html      # --name defaults to the filename slug; renders at the site root
```
Report the returned `✓ Deployed → <url>` as the deliverable — not the prose. Visibility defaults to `team`; use `--visibility public` only when the link must open for someone outside the team (e.g. a boss without a Glance account), and confirm before a public deploy. Re-deploying the same name prompts `Replace? (y/N)` and updates the live URL in place — matches the "living doc" behavior above.

### Anti-patterns
- Explaining from memory/assumption instead of reading the code.
- Asserting "dead code" / "duplicate" / an exact count without verifying it.
- Generic AI aesthetic (purple gradients, Inter, flat cards, zebra tables, no point of view).
- Multi-file output, a build step, or broken external deps — one openable file only.

## Gotchas
- Commands other than `login`/`logout` require a saved token; run `glance login` first.
- Wrong `GLANCE_API_URL` → you'll log in / deploy against the wrong instance silently. Verify with `glance list`.
- `deploy` errors print the HTTP status and a truncated server message — check `--space`/`--name` are valid slugs and you're pointed at the right instance.
