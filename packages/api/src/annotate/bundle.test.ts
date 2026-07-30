import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANNOTATE_CSS, ANNOTATE_JS, ANNOTATE_VERSION } from './bundle'

// The content worker has no static-asset pipeline, so production serves the COMMITTED bundle.ts —
// not client.ts. Every source test in this directory can be green while the shipped bytes are the
// previous protocol: that is a real failure mode, not a hypothetical one (a slice deleted a message
// listener from client.ts, the whole api suite stayed green, and the old listener was still live in
// the bundle until `bun run build:annotate` was re-run).
//
// This rebuilds the client exactly as scripts/build-annotate.ts does and requires the result to be
// byte-identical to what is committed. A failure means one thing: run `bun run build:annotate` and
// commit the result. Bun is pinned in CI (.github/workflows/ci.yml), so the minifier's output is
// reproducible there.

const srcDir = import.meta.dir

async function buildClient(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(srcDir, 'client.ts')],
    minify: true,
    format: 'iife',
    target: 'browser',
  })
  expect(built.success).toBe(true)
  return await built.outputs[0]!.text()
}

describe('the committed annotate bundle matches its source', () => {
  test('ANNOTATE_JS is what client.ts builds to today', async () => {
    expect(ANNOTATE_JS).toBe(await buildClient())
  })

  test('ANNOTATE_CSS is client.css verbatim', () => {
    expect(ANNOTATE_CSS).toBe(readFileSync(join(srcDir, 'client.css'), 'utf8'))
  })

  test('ANNOTATE_VERSION is the hash of the bytes actually being served — the cache-buster cannot lag', async () => {
    const js = await buildClient()
    const expected = new Bun.CryptoHasher('sha256').update(js + ANNOTATE_CSS).digest('hex').slice(0, 8)
    expect(ANNOTATE_VERSION).toBe(expected)
  })
})
