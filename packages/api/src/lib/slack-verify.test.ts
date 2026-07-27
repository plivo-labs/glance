import { describe, expect, test } from 'bun:test'
import { MAX_SKEW_SECONDS, verifySlackSignature } from './slack-verify'

const TEST_SIGNING_KEY = 'not-a-real-slack-signing-key'
const NOW = 1_700_000_000

/** Independently re-derive the signature Slack would send, so the test proves the algorithm
 *  (v0:ts:body → HMAC-SHA256 hex) rather than replaying whatever the implementation produced. */
async function sign(body: string, timestamp: number, secret = TEST_SIGNING_KEY): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('')
  return `v0=${hex}`
}

const verify = (over: Partial<Parameters<typeof verifySlackSignature>[0]> & { signature?: string }) =>
  verifySlackSignature({
    signingSecret: TEST_SIGNING_KEY,
    timestamp: String(NOW),
    signature: '',
    body: '{}',
    nowSeconds: NOW,
    ...over,
  })

describe('verifySlackSignature', () => {
  const body = '{"type":"event_callback","event":{"type":"link_shared"}}'

  test('accepts a correctly signed, fresh request', async () => {
    expect(await verify({ body, signature: await sign(body, NOW) })).toBe(true)
  })

  test('rejects a tampered body under a valid signature', async () => {
    const signature = await sign(body, NOW)
    expect(await verify({ body: `${body} `, signature })).toBe(false)
  })

  test('rejects a signature made with a different signing secret', async () => {
    expect(await verify({ body, signature: await sign(body, NOW, 'wrong-secret') })).toBe(false)
  })

  test('rejects a replay outside the skew window, in both directions', async () => {
    const old = NOW - MAX_SKEW_SECONDS - 1
    expect(await verify({ body, timestamp: String(old), signature: await sign(body, old) })).toBe(false)
    const future = NOW + MAX_SKEW_SECONDS + 1
    expect(await verify({ body, timestamp: String(future), signature: await sign(body, future) })).toBe(false)
  })

  test('accepts right at the edge of the skew window', async () => {
    const edge = NOW - MAX_SKEW_SECONDS
    expect(await verify({ body, timestamp: String(edge), signature: await sign(body, edge) })).toBe(true)
  })

  test('rejects a signature bound to a DIFFERENT timestamp than the header claims', async () => {
    expect(await verify({ body, timestamp: String(NOW), signature: await sign(body, NOW - 10) })).toBe(false)
  })

  test('fails closed on missing headers, a non-numeric timestamp, or a blank secret', async () => {
    expect(await verify({ body, signature: undefined })).toBe(false)
    expect(await verify({ body, timestamp: undefined, signature: await sign(body, NOW) })).toBe(false)
    expect(await verify({ body, timestamp: 'not-a-number', signature: await sign(body, NOW) })).toBe(false)
    expect(await verify({ body, signingSecret: '', signature: await sign(body, NOW) })).toBe(false)
  })

  test('rejects a malformed signature (wrong prefix, truncated, empty)', async () => {
    const good = await sign(body, NOW)
    expect(await verify({ body, signature: good.replace('v0=', 'v1=') })).toBe(false)
    expect(await verify({ body, signature: good.slice(0, -2) })).toBe(false)
    expect(await verify({ body, signature: '' })).toBe(false)
  })
})
