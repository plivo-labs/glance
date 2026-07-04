import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import pkg from './package.json'

// Self-update — three entry points sharing one code path:
//   `glance upgrade`          manual, foreground, loud
//   `glance upgrade --quiet`  the detached background pass spawned by maybeAutoUpdate()
//   announceUpdate()          one-line stderr notice on the run AFTER a background swap
//
// There is no staged "apply on next run" step: the CLI ships darwin/linux only, where rename(2)
// over a running binary is safe (the running process keeps its inode) — the background pass swaps
// in place, and the next invocation simply IS the new version.

const CONFIG_DIR = join(homedir(), '.glance')
const STATE_PATH = join(CONFIG_DIR, 'update.json')
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

// Overridable so tests (and forks) can point at a fake release host. The URL shapes below mirror
// GitHub's: `<base>/latest` (redirects to …/releases/tag/<tag>) and `<base>/download/<tag>/<asset>`.
function releaseBase(): string {
  return process.env.GLANCE_RELEASE_BASE?.trim() || 'https://github.com/plivo-labs/glance/releases'
}

export interface UpdateState {
  lastCheckedAt?: number
  updatedTo?: string // a background swap landed; notice pending
  available?: string // newer release exists but the install dir isn't writable
  notifiedAvailable?: string // version already nagged about (once per version)
}

function readState(): UpdateState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as UpdateState
  } catch {
    return {}
  }
}

// Update machinery must never break the CLI proper — state writes are best-effort.
function saveState(state: UpdateState): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch {
    /* ignore */
  }
}

// Numeric dotted-part compare (release tags are plain vX.Y.Z). Non-numeric parts count as 0, so a
// malformed or non-CLI tag (e.g. a screenshots release) never compares newer and never triggers a swap.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [pa, pb] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// `<base>/latest` resolves (via redirect) to `…/releases/tag/<tag>` — the tag rides in the final URL.
export function parseLatestTag(url: string): string | null {
  const m = url.match(/\/tag\/([^/?#]+)/)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}

// Release asset naming — must match release.yml: glance-<arm64|x64>-<darwin|linux>.
export function assetName(platform: string, arch: string): string | null {
  const os = platform === 'darwin' || platform === 'linux' ? platform : null
  const cpu = arch === 'arm64' || arch === 'x64' ? arch : null
  return os && cpu ? `glance-${cpu}-${os}` : null
}

export function shouldCheck(state: UpdateState, now: number): boolean {
  return !state.lastCheckedAt || now - state.lastCheckedAt > CHECK_INTERVAL_MS
}

// What (if anything) to tell the user this run, and the state to persist after saying it. PURE —
// returns the SAME state reference when nothing changes so the caller can skip the write.
export function planAnnouncement(state: UpdateState, current: string): { message: string | null; next: UpdateState } {
  if (state.updatedTo) {
    // Only claim the update if we're actually running it (a manual reinstall may have raced us).
    const message = state.updatedTo === current ? `✓ glance auto-updated to ${current}` : null
    return { message, next: { ...state, updatedTo: undefined } }
  }
  if (state.available) {
    if (compareVersions(state.available, current) <= 0)
      return { message: null, next: { ...state, available: undefined, notifiedAvailable: undefined } }
    if (state.notifiedAvailable !== state.available)
      return {
        message: `glance ${state.available} is available — run \`glance upgrade\``,
        next: { ...state, notifiedAvailable: state.available },
      }
  }
  return { message: null, next: state }
}

// Compiled executables run their sources from Bun's embedded virtual FS ($bunfs), where
// process.execPath is the installed binary. Under `bun index.ts` import.meta.url is a real on-disk
// path — and execPath is the bun runtime, which must NEVER be swapped. Every update path gates on this.
export function isCompiledBinary(): boolean {
  return import.meta.url.includes('/$bunfs/')
}

function dirWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function fetchLatestTag(base: string): Promise<string | null> {
  const res = await fetch(`${base}/latest`, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': `glance-cli/${pkg.version}` },
  })
  return parseLatestTag(res.url)
}

// Same contract as install.sh: gzipped binary + sha256 of the UNCOMPRESSED bytes. The verified
// binary is written next to the install target (same filesystem) then rename(2)d over it, so a
// crash or a concurrent updater can never leave a torn binary at the install path.
async function downloadAndSwap(base: string, tag: string, execPath: string): Promise<void> {
  const asset = assetName(process.platform, process.arch)
  if (!asset) throw new Error(`unsupported platform: ${process.platform}/${process.arch}`)
  const url = `${base}/download/${tag}/${asset}`
  const timeout = { signal: AbortSignal.timeout(120_000) }
  const [gz, sum] = await Promise.all([fetch(`${url}.gz`, timeout), fetch(`${url}.sha256`, timeout)])
  if (!gz.ok || !sum.ok) throw new Error(`release ${tag} is missing the ${asset} asset`)
  const binary = gunzipSync(Buffer.from(await gz.arrayBuffer()))
  const expected = (await sum.text()).trim().split(/\s+/)[0]
  const actual = createHash('sha256').update(binary).digest('hex')
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset} (${tag})`)
  const tmp = join(dirname(execPath), `.glance-update-${process.pid}`)
  try {
    writeFileSync(tmp, binary, { mode: 0o755 })
    renameSync(tmp, execPath)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

// The new binary embeds a matching SKILL.md — refresh it so agent docs track the CLI. Runs the
// swapped binary, so `skill` must stay excluded from the startup hooks (see index.ts) or this
// child would consume the pending updatedTo notice before the user ever sees it.
function refreshSkill(execPath: string): void {
  try {
    spawnSync(execPath, ['skill', 'install'], { stdio: 'ignore', timeout: 10_000 })
  } catch {
    /* non-fatal — the binary is what matters */
  }
}

export async function upgradeCmd(argv: string[]): Promise<void> {
  const background = argv.includes('--quiet')
  const fail = (msg: string): never => {
    console.error(`✗ ${msg}`)
    process.exit(1)
  }
  try {
    if (!isCompiledBinary()) {
      if (background) return
      return fail('upgrade works on the installed standalone binary only (dev checkout: git pull)')
    }
    const base = releaseBase()
    const tag = await fetchLatestTag(base)
    if (!tag) throw new Error('could not resolve the latest release')
    const latest = tag.replace(/^v/, '')
    if (compareVersions(latest, pkg.version) <= 0) {
      if (!background) console.log(`✓ glance ${pkg.version} is up to date.`)
      return
    }
    const dir = dirname(process.execPath)
    if (!dirWritable(dir)) {
      if (background) return saveState({ ...readState(), available: latest })
      return fail(`cannot write to ${dir} — re-run the installer, or: sudo glance upgrade`)
    }
    await downloadAndSwap(base, tag, process.execPath)
    refreshSkill(process.execPath)
    if (background) saveState({ ...readState(), updatedTo: latest, available: undefined, notifiedAvailable: undefined })
    else console.log(`✓ Updated glance ${pkg.version} → ${latest}`)
  } catch (err) {
    if (background) return // background failures are silent by design — next TTL expiry retries
    fail(`upgrade failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Fire-and-forget: stamp the TTL, then hand off to a detached `upgrade --quiet` and return
// immediately — the user's command never waits on the network. Stamping BEFORE spawning means
// concurrent invocations within the window don't pile on; a rare simultaneous pair is harmless
// anyway (both download verified bytes, rename is atomic, last one wins).
export function maybeAutoUpdate(): void {
  if (process.env.GLANCE_NO_UPDATE || process.env.CI) return
  if (!isCompiledBinary()) return
  const state = readState()
  if (!shouldCheck(state, Date.now())) return
  saveState({ ...state, lastCheckedAt: Date.now() })
  try {
    const child = spawn(process.execPath, ['upgrade', '--quiet'], { detached: true, stdio: 'ignore' })
    child.on('error', () => {}) // a spawn failure must never surface into the user's command
    child.unref()
  } catch {
    /* ignore */
  }
}

// One line on stderr — never stdout, which gets piped (`read`, `comments --json`) — the first run
// after a background swap, or once per version when an update exists but the install dir is read-only.
export function announceUpdate(): void {
  const state = readState()
  const { message, next } = planAnnouncement(state, pkg.version)
  if (message) console.error(message)
  if (next !== state) saveState(next)
}
