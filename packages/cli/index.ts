#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'

// Glance CLI — deploy folders to Glance from the terminal.
//   glance login | deploy <path> --space <s> --name <s> [--visibility v] | list | delete <space/slug> | logout

const API = process.env.GLANCE_API_URL ?? 'http://localhost:8787'
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

// Parse `--flag value` pairs and positionals.
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[++i] ?? ''
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
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
  const res = await fetch(`${API}/api/auth/cli/start`, { method: 'POST' })
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
    const poll = await fetch(`${API}/api/auth/cli/poll?device_code=${encodeURIComponent(deviceCode)}`)
    if (poll.status === 404) die('\nLogin request expired. Try again.')
    const data = (await poll.json()) as { status: string; accessToken?: string }
    if (data.status === 'complete' && data.accessToken) {
      writeConfig({ apiUrl: API, token: data.accessToken })
      console.log('\n✓ Logged in.')
      return
    }
  }
}

async function deploy(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv)
  const path = positional[0]
  const space = flags.space
  const name = flags.name
  const visibility = flags.visibility ?? 'team'
  if (!path || !space || !name) die('Usage: glance deploy <path> --space <slug> --name <slug> [--visibility team|public|private|group]')

  const cfg = requireAuth()
  const root = resolve(path)
  if (!statSync(root).isDirectory()) die(`Not a directory: ${root}`)

  // Replace prompt if the site already exists and the caller owns it.
  const exists = await authed(cfg, `/api/sites/${space}/${name}/exists`)
  const ex = (await exists.json()) as { exists: boolean; owned?: boolean }
  let replace = false
  if (ex.exists) {
    if (!ex.owned) die(`glance.../${space}/${name} is taken by another user.`)
    const ans = await prompt(`Site exists at ${space}/${name}. Replace? (y/N) `)
    if (ans.toLowerCase() !== 'y') return console.log('Cancelled.')
    replace = true
  }

  const files = walk(root)
  if (files.length === 0) die('No files to upload.')
  const form = new FormData()
  form.append('visibility', visibility)
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join('/')
    form.append('files', new Blob([readFileSync(abs)]), rel)
  }
  console.log(`Uploading ${files.length} file(s)…`)
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
  for (const s of sites) console.log(`  ${`${s.spaceSlug}/${s.siteSlug}`.padEnd(36)} ${s.visibility.padEnd(8)} ${s.url}`)
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

const [cmd, ...rest] = process.argv.slice(2)
const commands: Record<string, () => Promise<void>> = {
  login,
  deploy: () => deploy(rest),
  list,
  delete: () => del(rest),
  logout,
}
const run = commands[cmd ?? '']
if (!run) {
  console.log('glance — deploy folders to Glance\n')
  console.log('  glance login')
  console.log('  glance deploy <path> --space <slug> --name <slug> [--visibility team|public|private|group]')
  console.log('  glance list')
  console.log('  glance delete <space/slug>')
  console.log('  glance logout')
  process.exit(cmd ? 1 : 0)
}
await run()
