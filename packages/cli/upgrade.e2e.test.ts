import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { SKILL_NAME } from './skill-content'
import { assetName } from './upgrade.ts'

// End-to-end proof of the self-update loop on REAL compiled binaries: an old binary must discover
// a release on a (fake, GitHub-shaped) host, background-download it, atomically swap itself, and
// announce once — plus every guard rail (checksum, opt-out, CI, read-only dir, TTL).
// Compiles two binaries in beforeAll (~seconds); network is loopback-only.

setDefaultTimeout(180_000)

const OLD = '0.0.1'
const NEW = '0.0.2'
const ASSET = assetName(process.platform, process.arch)!

let e2eRoot: string
let oldBinary: string // pristine 0.0.1 — copied into a fresh "install" per scenario
let newGz: Buffer
let newSha: string
let base: string
let badSha = false
let latestHits = 0
let server: ReturnType<typeof Bun.serve>

// Compile the CLI exactly as release.yml does: stamp a version into package.json, then
// `bun build --compile`. process.execPath is the bun running this test.
function compile(version: string, outfile: string): void {
  const src = mkdtempSync(join(e2eRoot, 'src-'))
  for (const f of ['index.ts', 'upgrade.ts', 'skill-content.ts']) cpSync(join(import.meta.dir, f), join(src, f))
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, 'package.json'), 'utf8'))
  pkg.version = version
  writeFileSync(join(src, 'package.json'), JSON.stringify(pkg))
  const res = spawnSync(process.execPath, ['build', '--compile', './index.ts', '--outfile', outfile], {
    cwd: src,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`compile ${version} failed: ${res.stderr}`)
}

// A fresh, isolated "installation": its own bin dir holding the OLD binary and its own $HOME,
// so ~/.glance state and ~/.claude skills never leak between scenarios (or into the real user's).
function freshInstall(): { glance: string; bin: string; home: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(e2eRoot, 'install-'))
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  mkdirSync(bin)
  mkdirSync(home)
  const glance = join(bin, 'glance')
  cpSync(oldBinary, glance)
  chmodSync(glance, 0o755)
  // Full env replacement (not a merge) so the outer CI/GLANCE_NO_UPDATE can't leak in.
  return { glance, bin, home, env: { HOME: home, PATH: process.env.PATH ?? '', GLANCE_RELEASE_BASE: base } }
}

// MUST be async (never spawnSync): the fake release server lives in THIS process, and a sync wait
// would freeze its event loop — the child's fetch would deadlock until its abort timeout.
async function run(bin: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([bin, ...args], { env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, status }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readState(home: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(home, '.glance', 'update.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function until(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await Bun.sleep(100)
  }
  return cond()
}

beforeAll(() => {
  e2eRoot = mkdtempSync(join(tmpdir(), 'glance-upgrade-e2e-'))
  oldBinary = join(e2eRoot, `glance-${OLD}`)
  const newBinary = join(e2eRoot, `glance-${NEW}`)
  compile(OLD, oldBinary)
  compile(NEW, newBinary)
  const newBytes = readFileSync(newBinary)
  newGz = gzipSync(newBytes, { level: 1 })
  newSha = createHash('sha256').update(newBytes).digest('hex')

  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/releases/latest') {
        latestHits++
        return Response.redirect(`${base}/tag/v${NEW}`, 302)
      }
      if (path === `/releases/tag/v${NEW}`) return new Response('tag page')
      if (path === `/releases/download/v${NEW}/${ASSET}.gz`) return new Response(newGz)
      if (path === `/releases/download/v${NEW}/${ASSET}.sha256`)
        // shasum-style "hex  filename" line — the updater must take the first token.
        return new Response(`${badSha ? '0'.repeat(64) : newSha}  ${ASSET}\n`)
      return new Response('not found', { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}/releases`
})

afterAll(() => {
  server?.stop(true)
  rmSync(e2eRoot, { recursive: true, force: true })
})

describe('auto-update e2e', () => {
  test('background-swap-announce-once-then-ttl-quiet', async () => {
    const { glance, home, env } = freshInstall()
    const hitsBefore = latestHits

    const first = await run(glance, ['version'], env)
    expect(first.status).toBe(0)
    expect(first.stdout.trim()).toBe(OLD)
    // The TTL is stamped by the parent BEFORE the detached checker runs.
    expect(readState(home).lastCheckedAt).toBeNumber()

    // The detached child downloads, verifies, and rename(2)s over the binary, then records the swap.
    expect(await until(() => sha256(glance) === newSha)).toBe(true)
    expect(await until(() => readState(home).updatedTo === NEW)).toBe(true)
    // Post-swap refresh: the NEW binary re-installed the agent skill into this $HOME.
    expect(existsSync(join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md'))).toBe(true)

    // Next invocation IS the new version and announces exactly once, on stderr.
    const second = await run(glance, ['version'], env)
    expect(second.stdout.trim()).toBe(NEW)
    expect(second.stderr).toContain(`auto-updated to ${NEW}`)
    const third = await run(glance, ['version'], env)
    expect(third.stderr).not.toContain('auto-updated')

    // All of the above rode ONE release check — later runs sat inside the 24h TTL.
    await Bun.sleep(300)
    expect(latestHits - hitsBefore).toBe(1)
  })

  test('opt-out-and-ci-never-check', async () => {
    const { glance, home, env } = freshInstall()
    expect((await run(glance, ['version'], { ...env, GLANCE_NO_UPDATE: '1' })).stdout.trim()).toBe(OLD)
    expect((await run(glance, ['version'], { ...env, CI: 'true' })).stdout.trim()).toBe(OLD)
    await Bun.sleep(400)
    // No TTL stamp, no checker spawned, binary untouched.
    expect(existsSync(join(home, '.glance', 'update.json'))).toBe(false)
    expect(sha256(glance)).not.toBe(newSha)
  })

  test('foreground-upgrade-loud-and-no-later-notice', async () => {
    const { glance, env } = freshInstall()
    const up = await run(glance, ['upgrade'], env)
    expect(up.status).toBe(0)
    expect(up.stdout).toContain(`${OLD} → ${NEW}`)
    expect(sha256(glance)).toBe(newSha)
    // The user watched this one — no queued announcement.
    const next = await run(glance, ['version'], env)
    expect(next.stdout.trim()).toBe(NEW)
    expect(next.stderr).not.toContain('auto-updated')
    // Already latest → idempotent.
    expect((await run(glance, ['upgrade'], env)).stdout).toContain('up to date')
  })

  test('checksum-mismatch-rejects-loud-in-foreground-silent-in-background', async () => {
    badSha = true
    try {
      const fg = freshInstall()
      const up = await run(fg.glance, ['upgrade'], fg.env)
      expect(up.status).toBe(1)
      expect(up.stderr).toContain('checksum mismatch')
      expect(sha256(fg.glance)).not.toBe(newSha) // binary untouched
      expect(readdirSync(fg.bin)).toEqual(['glance']) // no temp file left behind

      const bg = freshInstall()
      await run(bg.glance, ['version'], bg.env)
      await Bun.sleep(1500)
      expect(sha256(bg.glance)).not.toBe(newSha)
      expect(readState(bg.home).updatedTo).toBeUndefined()
      expect((await run(bg.glance, ['version'], bg.env)).stderr).toBe('') // failure never surfaces
    } finally {
      badSha = false
    }
  })

  test('readonly-install-dir-notifies-instead-of-swapping', async () => {
    const { glance, bin, home, env } = freshInstall()
    chmodSync(bin, 0o555)
    try {
      await run(glance, ['version'], env)
      expect(await until(() => readState(home).available === NEW)).toBe(true)
      expect(sha256(glance)).not.toBe(newSha)
      // Nag exactly once per version.
      expect((await run(glance, ['version'], env)).stderr).toContain(`${NEW} is available`)
      expect((await run(glance, ['version'], env)).stderr).not.toContain('available')
    } finally {
      chmodSync(bin, 0o755)
    }
  })
})
