// Prod-shaped latency benchmark for the perf/db-query-hot-paths work.
// Usage: bun bench/bench.ts <label> <apiOrigin> [contentOriginOverride]
//   bun bench/bench.ts cloudfront https://glance.plivo.com
//   bun bench/bench.ts workersdev https://glance.plivops.workers.dev https://glance-content.plivops.workers.dev
// Reads the CLI token from ~/.glance/config.json. All requests are GETs against the
// dedicated bench fixture samuel-lawerence/perf-bench (1 thread, 2 replies, css asset).
// Writes bench/<label>-<stamp>.json. Compare runs with: bun bench/compare.ts <before> <after>

const [label, apiOrigin, contentOverride] = process.argv.slice(2)
if (!label || !apiOrigin) {
  console.error('usage: bun bench/bench.ts <label> <apiOrigin> [contentOriginOverride]')
  process.exit(1)
}

const SITE = 'samuel-lawerence/perf-bench'
const WARMUP = 3
const N = 30

const cfg = await Bun.file(`${process.env.HOME}/.glance/config.json`).json()
const auth = { Authorization: `Bearer ${cfg.token}` }

async function timed(url: string, headers: Record<string, string> = {}): Promise<{ ms: number; status: number }> {
  const t0 = performance.now()
  const res = await fetch(url, { headers })
  await res.arrayBuffer() // include body transfer
  return { ms: performance.now() - t0, status: res.status }
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b)
  const pick = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return {
    n: s.length,
    p50: Math.round(pick(0.5)),
    p90: Math.round(pick(0.9)),
    min: Math.round(s[0]),
    max: Math.round(s[s.length - 1]),
  }
}

// One full iteration = every journey once, sequentially (mirrors real usage order).
async function iteration() {
  const out: Record<string, number> = {}
  const statuses: Record<string, number> = {}
  const grab = async (key: string, url: string, headers = {}) => {
    const r = await timed(url, headers)
    out[key] = r.ms
    statuses[key] = r.status
  }

  await grab('me', `${apiOrigin}/api/auth/me`, auth) // KV-only calibration floor

  // Site-open: meta (mints the content token) -> doc (annotate path, the real in-frame path) -> asset
  const t0 = performance.now()
  const metaRes = await fetch(`${apiOrigin}/api/sites/${SITE}`, { headers: auth })
  const meta = await metaRes.json()
  out.meta = performance.now() - t0
  statuses.meta = metaRes.status
  let contentUrl: string = meta.contentUrl // ends with '/'
  if (contentOverride) contentUrl = contentUrl.replace(/^https:\/\/[^/]+/, contentOverride)
  await grab('doc', `${contentUrl}?glance_annotate=1`)
  await grab('asset', `${contentUrl}style.css`)

  // Dashboard feeds
  await grab('shared', `${apiOrigin}/api/sites/shared`, auth)
  await grab('mine', `${apiOrigin}/api/sites/mine`, auth)
  await grab('team', `${apiOrigin}/api/sites/team`, auth)
  await grab('spaceSites', `${apiOrigin}/api/spaces/samuel-lawerence/sites`, auth)

  // Comments list (seeded: 1 thread + 2 replies)
  await grab('comments', `${apiOrigin}/api/sites/${SITE}/comments?filePath=index.html`, auth)

  return { out, statuses }
}

const first = await iteration()
const bad = Object.entries(first.statuses).filter(([, s]) => s >= 400)
if (bad.length) {
  console.error('non-2xx endpoints, aborting:', bad)
  process.exit(1)
}

console.error(`warmup x${WARMUP}...`)
for (let i = 0; i < WARMUP - 1; i++) await iteration() // first already counted as warmup

const runs: Record<string, number>[] = []
for (let i = 0; i < N; i++) {
  runs.push((await iteration()).out)
  if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${N}`)
}

const keys = Object.keys(runs[0])
const endpoints = Object.fromEntries(keys.map((k) => [k, stats(runs.map((r) => r[k]))]))
const mePool = runs.map((r) => r.me)
const result = {
  label,
  apiOrigin,
  contentOverride: contentOverride ?? null,
  site: SITE,
  when: new Date().toISOString(),
  n: N,
  calibrationFloorP50: stats(mePool).p50,
  endpoints,
  raw: runs,
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
const path = `bench/${label}-${stamp}.json`
await Bun.write(path, JSON.stringify(result, null, 2))

console.log(`\n${label} @ ${apiOrigin}  (n=${N}, /me floor p50=${result.calibrationFloorP50}ms)`)
for (const k of keys) {
  const e = endpoints[k]
  console.log(`  ${k.padEnd(11)} p50=${String(e.p50).padStart(5)}ms  p90=${String(e.p90).padStart(5)}ms`)
}
console.log(`\nsaved -> ${path}`)
