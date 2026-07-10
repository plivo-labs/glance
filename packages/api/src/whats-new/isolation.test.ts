import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

// CW1 — the content worker (src/content.ts) must NEVER transitively import the What's New catalog.
// Baking the rendered release-note bodies into the content worker's bundle is the schema→catalog
// bloat footgun the design explicitly rejected: content.ts pulls in db/schema, and if the schema
// (or anything content.ts reaches) imported catalog.ts, every uploaded-file request would ship the
// whole release archive. This walks the real relative-import graph from content.ts and asserts the
// catalog is unreachable — a fast structural guard, no bundler needed.

const SRC = join(import.meta.dir, '..')
const IMPORT_RE = /(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]/g

function resolveModule(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && cand.endsWith('.ts')) return cand
  }
  return null
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const code = readFileSync(file, 'utf8')
    for (const m of code.matchAll(IMPORT_RE)) {
      const dep = resolveModule(file, m[1])
      if (dep && !seen.has(dep)) stack.push(dep)
    }
  }
  return seen
}

describe('CW1 content worker does not bake in the What\'s New catalog', () => {
  test('src/content.ts cannot transitively reach whats-new/catalog.ts', () => {
    const reachable = reachableFrom(join(SRC, 'content.ts'))
    const catalog = join(SRC, 'whats-new', 'catalog.ts')
    expect(reachable.has(catalog)).toBe(false)
  })

  test('sanity: the crawler DOES find a known content.ts dependency (db/schema.ts)', () => {
    const reachable = reachableFrom(join(SRC, 'content.ts'))
    expect(reachable.has(join(SRC, 'db', 'schema.ts'))).toBe(true)
  })
})
