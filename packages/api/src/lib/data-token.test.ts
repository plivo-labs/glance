import { describe, expect, test } from 'bun:test'
import { verifyDataToken as verify, signDataToken } from './data-token'
import { b64urlDecode, b64urlEncode, hmacSign } from './hmac'
import { signToken } from './token'

const HMAC_A = 'glance-test-aaa'
const HMAC_B = 'glance-test-bbb'

describe('data-token', () => {
  test('round-trips claims and recovers siteId/viewerId/caps', async () => {
    const tok = await signDataToken(HMAC_A, { siteId: 'site-a', viewerId: 'user-1', caps: ['read', 'write'] })
    const claims = await verify(HMAC_A, tok)
    expect(claims).not.toBeNull()
    expect(claims?.aud).toBe('data')
    expect(claims?.siteId).toBe('site-a')
    expect(claims?.viewerId).toBe('user-1')
    expect(claims?.caps).toEqual(['read', 'write'])
  })

  test('rejects a token signed with a different secret', async () => {
    const tok = await signDataToken(HMAC_B, { siteId: 'site-a', viewerId: 'user-1', caps: ['read'] })
    expect(await verify(HMAC_A, tok)).toBeNull()
  })

  test('rejects a tampered body (signature covers the whole claim set)', async () => {
    const tok = await signDataToken(HMAC_A, { siteId: 'site-a', viewerId: 'user-1', caps: ['read'] })
    const [body, mac] = tok.split('.')
    const flipped = `${body.slice(0, -1)}${body.at(-1) === 'A' ? 'B' : 'A'}.${mac}`
    expect(await verify(HMAC_A, flipped)).toBeNull()
  })

  test('ATTACK: widening caps read -> read,write without re-signing is rejected', async () => {
    // Mint a read-only token, then re-encode the body with an added 'write' cap but keep the
    // original MAC (what page JS could attempt). The MAC no longer matches -> rejected.
    const tok = await signDataToken(HMAC_A, { siteId: 'site-a', viewerId: 'user-1', caps: ['read'] })
    const [body, mac] = tok.split('.')
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
    claims.caps = ['read', 'write']
    const forgedBody = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)).buffer as ArrayBuffer)
    expect(await verify(HMAC_A, `${forgedBody}.${mac}`)).toBeNull()
  })

  test('ATTACK: a content (view) token cannot verify as a data token', async () => {
    // Same secret AND the content-token format — still rejected: different shape + no aud=data.
    const content = await signToken(HMAC_A, 'user-1', 'space/site', 300)
    expect(await verify(HMAC_A, content)).toBeNull()
  })

  test('ATTACK: a token with the right secret but aud!=data is rejected', async () => {
    const body = b64urlEncode(
      new TextEncoder()
        .encode(JSON.stringify({ aud: 'content', siteId: 'site-a', viewerId: 'user-1', caps: ['write'], exp: 9e9 }))
        .buffer as ArrayBuffer,
    )
    const forged = `${body}.${await hmacSign(HMAC_A, body)}`
    expect(await verify(HMAC_A, forged)).toBeNull()
  })

  test('rejects an expired token', async () => {
    const tok = await signDataToken(HMAC_A, { siteId: 'site-a', viewerId: 'user-1', caps: ['read'] }, -1)
    expect(await verify(HMAC_A, tok)).toBeNull()
  })

  test('rejects an unknown capability value', async () => {
    const body = b64urlEncode(
      new TextEncoder()
        .encode(JSON.stringify({ aud: 'data', siteId: 'site-a', viewerId: 'user-1', caps: ['admin'], exp: 9e9 }))
        .buffer as ArrayBuffer,
    )
    const forged = `${body}.${await hmacSign(HMAC_A, body)}`
    expect(await verify(HMAC_A, forged)).toBeNull()
  })

  test('rejects null / malformed / no-dot tokens', async () => {
    expect(await verify(HMAC_A, null)).toBeNull()
    expect(await verify(HMAC_A, '')).toBeNull()
    expect(await verify(HMAC_A, 'nodot')).toBeNull()
    expect(await verify(HMAC_A, '.onlymac')).toBeNull()
    expect(await verify(HMAC_A, 'onlybody.')).toBeNull()
  })
})
