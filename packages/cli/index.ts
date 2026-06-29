#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { SKILL_MD, SKILL_NAME } from './skill-content'

// Glance CLI — deploy folders to Glance from the terminal.
//   glance login | deploy <path> --space <s> --name <s> [--visibility v] | list | delete <space/slug> | move <space/slug> <new-space> | logout

const CONFIG_DIR = join(homedir(), '.glance')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

interface Config {
  apiUrl: string
  token: string
}

function readConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config
  } catch {
    return null
  }
}

function writeConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

// Instance URL precedence: explicit env override → persisted config (written at login, or seeded by
// the installer) → local dev default. Reading the config here is what lets `glance login` work in the
// SAME shell right after install — before the profile's GLANCE_API_URL export has been sourced.
function apiBase(): string {
  // `||` (not `??`) so an empty/blank GLANCE_API_URL falls through instead of yielding a bad base URL.
  return process.env.GLANCE_API_URL?.trim() || readConfig()?.apiUrl || 'http://localhost:8787'
}

function die(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function requireAuth(): Config {
  const cfg = readConfig()
  if (!cfg?.token) die('Not logged in. Run `glance login` first.')
  return cfg
}

function authed(cfg: Config, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${cfg.apiUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${cfg.token}` },
  })
}

// Parse `--flag value` pairs and positionals. Flags named in `booleanFlags` are valueless
// (`--open` → true) and do NOT consume the next token, so a positional after them survives
// (e.g. `comments --open x/y` keeps `x/y`). Everything else stays a value-flag as before.
export function parseArgs(
  argv: string[],
  booleanFlags: Set<string> = new Set(),
): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (booleanFlags.has(key)) flags[key] = true
      else flags[key] = argv[++i] ?? ''
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

// Derive a Glance site slug from a file/folder name. Mirrors the server's rule
// (api lib/slug.ts): lowercase alphanumeric + hyphens, 3–40 chars, no edge hyphen.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

// The caller's personal space — the default target when --space is omitted.
async function personalSpace(cfg: Config): Promise<string> {
  const res = await authed(cfg, '/api/spaces/mine')
  if (!res.ok) die(`Could not resolve your space (${res.status}). Pass --space <slug>.`)
  const spaces = (await res.json()) as { slug: string; type: string }[]
  const space = spaces.find((s) => s.type === 'personal') ?? spaces[0]
  if (!space) die('No space found for your account. Pass --space <slug>.')
  return space.slug
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry === '.DS_Store') continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base))
    else out.push(abs)
  }
  return out
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// Best-effort convenience only. On a headless box (SSH, no $DISPLAY, no xdg-open) the
// opener is missing — `spawn` reports that via an async 'error' event, NOT a throw, so a
// try/catch can't catch it and the unhandled event would crash login. Swallow it and let
// the user open the printed URL + code on any device (this is a device-code flow).
function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {}) // no opener available — fall back to manual open
    child.unref()
  } catch {
    /* ignore — manual open */
  }
}

async function login(): Promise<void> {
  const api = apiBase()
  const res = await fetch(`${api}/api/auth/cli/start`, { method: 'POST' })
  if (!res.ok) die(`Could not start login (${res.status})`)
  const { deviceCode, userCode, verificationUri, interval } = (await res.json()) as {
    deviceCode: string
    userCode: string
    verificationUri: string
    interval: number
  }
  console.log(`\n  Open ${verificationUri}`)
  console.log(`  and approve code: ${userCode}\n`)
  openBrowser(verificationUri)

  process.stdout.write('  Waiting for approval')
  for (;;) {
    await new Promise((r) => setTimeout(r, Math.max(1, interval) * 1000))
    process.stdout.write('.')
    const poll = await fetch(`${api}/api/auth/cli/poll?device_code=${encodeURIComponent(deviceCode)}`)
    if (poll.status === 404) die('\nLogin request expired. Try again.')
    const data = (await poll.json()) as { status: string; accessToken?: string }
    if (data.status === 'complete' && data.accessToken) {
      writeConfig({ apiUrl: api, token: data.accessToken })
      console.log('\n✓ Logged in.')
      return
    }
  }
}

async function deploy(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv)
  const path = positional[0]
  // deploy passes no booleanFlags, so every flag is a value-flag (string) here.
  let visibility = (flags.visibility as string | undefined) ?? 'team'
  // `group` was renamed to `members`; keep old commands/scripts working (server normalizes too).
  if (visibility === 'group') {
    console.warn("note: --visibility group is now 'members' (this space’s people) — using members.")
    visibility = 'members'
  }
  if (!path)
    die('Usage: glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team|public|private|members]')

  const cfg = requireAuth()
  const root = resolve(path)
  let isDir = false
  try {
    isDir = statSync(root).isDirectory()
  } catch {
    die(`No such file or directory: ${root}`)
  }

  // Accept a single file OR a folder. A lone file uploads under its own name and is
  // served at the site root (the content worker falls back to the only file).
  let entries: { abs: string; rel: string }[]
  let derived: string
  if (isDir) {
    entries = walk(root).map((abs) => ({ abs, rel: relative(root, abs).split(sep).join('/') }))
    derived = basename(root) // default name = folder name
  } else {
    entries = [{ abs: root, rel: basename(root) }]
    derived = basename(root).replace(/\.[^.]+$/, '') // default name = file name, sans extension
  }
  if (entries.length === 0) die('No files to upload.')

  // Name defaults to the file/folder name; space defaults to your personal space.
  const name = (flags.name as string | undefined) ?? slugify(derived)
  if (!SLUG_RE.test(name)) {
    die(`Couldn't derive a valid name from "${basename(root)}". Pass --name <slug> (lowercase, 3–40 chars).`)
  }
  const space = (flags.space as string | undefined) ?? (await personalSpace(cfg))

  // Replace prompt if the site already exists and the caller owns it.
  const exists = await authed(cfg, `/api/sites/${space}/${name}/exists`)
  const ex = (await exists.json()) as { exists: boolean; owned?: boolean }
  let replace = false
  if (ex.exists) {
    if (!ex.owned) die(`${space}/${name} is taken by another user.`)
    const ans = await prompt(`Site exists at ${space}/${name}. Replace? (y/N) `)
    if (ans.toLowerCase() !== 'y') return console.log('Cancelled.')
    replace = true
  }

  const form = new FormData()
  form.append('visibility', visibility)
  for (const { abs, rel } of entries) {
    form.append('files', new Blob([readFileSync(abs)]), rel)
  }
  console.log(`Uploading ${entries.length} file(s) to ${space}/${name}…`)
  const res = await authed(cfg, `/api/upload/${space}/${name}${replace ? '?replace=true' : ''}`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) die(`Upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const { url } = (await res.json()) as { url: string }
  console.log(`✓ Deployed → ${url}`)
}

async function list(): Promise<void> {
  const cfg = requireAuth()
  const res = await authed(cfg, '/api/sites/mine')
  if (!res.ok) die(`Failed to list (${res.status})`)
  const sites = (await res.json()) as { siteSlug: string; spaceSlug: string; visibility: string; url: string }[]
  if (sites.length === 0) return console.log('No sites yet.')
  for (const s of sites)
    console.log(`  ${`${s.spaceSlug}/${s.siteSlug}`.padEnd(36)} ${s.visibility.padEnd(8)} ${s.url}`)
}

async function del(argv: string[]): Promise<void> {
  const target = argv[0]
  if (!target?.includes('/')) die('Usage: glance delete <space/slug>')
  const [space, name] = target.split('/')
  const cfg = requireAuth()
  const ans = await prompt(`Delete ${space}/${name}? (y/N) `)
  if (ans.toLowerCase() !== 'y') return console.log('Cancelled.')
  const res = await authed(cfg, `/api/sites/${space}/${name}`, { method: 'DELETE' })
  if (!res.ok) die(`Delete failed (${res.status})`)
  console.log('✓ Deleted.')
}

async function move(argv: string[]): Promise<void> {
  const target = argv[0]
  const dest = argv[1]
  if (!target?.includes('/') || !dest) die('Usage: glance move <space/slug> <new-space>')
  const [space, name] = target.split('/')
  const cfg = requireAuth()
  const res = await authed(cfg, `/api/sites/${space}/${name}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ space: dest }),
  })
  if (!res.ok) die(`Move failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const { url } = (await res.json()) as { url: string }
  console.log(`✓ Moved → ${url}`)
}

// Install the bundled AI-agent skill with NO Node/npx dependency — writes it into Claude Code's
// user skills dir. Other agents (Codex, Cursor) can pull the same skill via `npx skills add`.
function skillCmd(argv: string[]): void {
  const sub = argv[0] ?? 'install'
  if (sub !== 'install') die('Usage: glance skill install')
  const dir = join(homedir(), '.claude', 'skills', SKILL_NAME)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'SKILL.md')
  writeFileSync(dest, SKILL_MD)
  console.log(`✓ Installed the ${SKILL_NAME} skill for Claude Code → ${dest}`)
  console.log('  Other agents (Codex, Cursor): npx skills add plivo-labs/glance --global')
}

async function logout(): Promise<void> {
  const cfg = readConfig()
  if (cfg?.token) await authed(cfg, '/api/auth/logout', { method: 'POST' }).catch(() => {})
  try {
    rmSync(CONFIG_PATH)
  } catch {
    /* already gone */
  }
  console.log('✓ Logged out.')
}

// --- comments digest --------------------------------------------------------
// Local mirror of the server ThreadView/CommentView fields the digest reads (the CLI is
// zero-dep, so we don't import from other packages). Extra server fields pass through --json.
type DigestComment = {
  author: string | null // display name (name ?? email); kept even when deleted
  body: string | null // null when the comment is soft-deleted
  deleted: boolean
}
type DigestThread = {
  filePath: string
  anchorStatus: 'anchored' | 'shifted' | 'suggested' | 'orphaned'
  quote: string | null
  status: 'open' | 'resolved'
  comments: DigestComment[]
}

// anchorStatus → glyph; orphaned is a loud warning so a drifted anchor stands out.
const ANCHOR_GLYPH: Record<DigestThread['anchorStatus'], string> = {
  anchored: '✓',
  shifted: '~',
  suggested: '?',
  orphaned: '⚠',
}

// Render a site's comment threads as a markdown digest (or raw JSON). PURE — no I/O.
export function renderDigest(threads: DigestThread[], opts: { open?: boolean; json?: boolean }): string {
  const shown = opts.open ? threads.filter((t) => t.status === 'open') : threads
  if (opts.json) return JSON.stringify(shown, null, 2)
  if (shown.length === 0) return 'No comments.'

  const open = shown.filter((t) => t.status === 'open').length
  const lines: string[] = [`# ${open} open · ${shown.length - open} resolved`]

  // Group by filePath, preserving first-appearance order, so a file's threads stay adjacent.
  const byFile = new Map<string, DigestThread[]>()
  for (const t of shown) {
    const group = byFile.get(t.filePath)
    if (group) group.push(t)
    else byFile.set(t.filePath, [t])
  }

  for (const [filePath, group] of byFile) {
    for (const t of group) {
      lines.push('', `### ${filePath} · ${ANCHOR_GLYPH[t.anchorStatus]} · ${t.status.toUpperCase()}`)
      if (t.quote) lines.push(`> "${t.quote}"`)
      for (const c of t.comments) {
        const author = c.author ?? 'unknown'
        if (c.deleted) lines.push(`- @${author} (deleted): [deleted]`)
        else lines.push(`- @${author}: ${c.body ?? ''}`)
      }
    }
  }
  return lines.join('\n')
}

async function comments(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv, new Set(['open', 'json']))
  const target = positional[0]
  if (!target?.includes('/')) die('Usage: glance comments <space/slug> [--file <path>] [--open] [--json]')
  const [space, name] = target.split('/')

  const file = typeof flags.file === 'string' && flags.file ? flags.file : undefined
  const cfg = requireAuth()
  const query = file ? `?filePath=${encodeURIComponent(file)}` : ''
  const res = await authed(cfg, `/api/sites/${space}/${name}/comments${query}`)
  if (!res.ok) die(`Failed to fetch comments (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const threads = (await res.json()) as DigestThread[]
  console.log(renderDigest(threads, { open: flags.open === true, json: flags.json === true }))
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const commands: Record<string, () => Promise<void>> = {
    login,
    deploy: () => deploy(rest),
    list,
    delete: () => del(rest),
    move: () => move(rest),
    comments: () => comments(rest),
    skill: async () => skillCmd(rest),
    logout,
  }
  const run = commands[cmd ?? '']
  if (!run) {
    console.log('glance — deploy folders to Glance\n')
    console.log('  glance login')
    console.log('  glance deploy <path> [--space <slug>] [--name <slug>] [--visibility team|public|private|members]')
    console.log('  glance list')
    console.log('  glance delete <space/slug>')
    console.log('  glance move <space/slug> <new-space>')
    console.log('  glance comments <space/slug> [--file <path>] [--open] [--json]')
    console.log('  glance skill install')
    console.log('  glance logout')
    process.exit(cmd ? 1 : 0)
  }
  await run()
}
