import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_CONTEXT, parseIntent } from './parseIntent'

// parseIntent is a pure filter (writable today, no DOM needed): construct plain event-shaped
// objects. It is NOT a trust guard — these only prove obviously-bogus messages are dropped.

const CONTENT = 'https://glance-content.example.com'
const iframeWin = {} as Window // sentinel identity for the iframe's contentWindow
const otherWin = {} as Window

const ev = (over: { origin?: string; source?: unknown; data?: unknown }): MessageEvent =>
  ({ origin: over.origin ?? CONTENT, source: over.source ?? iframeWin, data: over.data }) as unknown as MessageEvent

const expected = { origin: CONTENT, source: iframeWin }
const validSelect = { type: 'glance:select', quote: 'the quick brown fox' }

describe('parseIntent', () => {
  test('text context cap tracks the API storage contract', () => {
    // packages/web has no dependency/tsconfig path onto packages/api (and must not gain one — that
    // would drag worker-side code into the browser bundle), so the only way to pin this against
    // drift is to read the api's source at test time and compare the live values.
    const anchorPath = join(import.meta.dir, '../../../api/src/lib/anchor.ts')
    const anchorSrc = readFileSync(anchorPath, 'utf8')
    const match = anchorSrc.match(/TEXT_CONTEXT_LIMIT\s*=\s*(\d+)/)
    if (!match) throw new Error(`could not find TEXT_CONTEXT_LIMIT in ${anchorPath}`)
    const apiLimit = Number(match[1])
    expect(MAX_CONTEXT, `MAX_CONTEXT (parseIntent.ts) = ${MAX_CONTEXT} must equal TEXT_CONTEXT_LIMIT (${anchorPath}) = ${apiLimit}`).toBe(apiLimit)
  })

  test('parseintent-rejects-wrong-origin', () => {
    expect(parseIntent(ev({ origin: 'https://evil.com', data: validSelect }), expected)).toBeNull()
  })

  test('parseintent-rejects-wrong-source', () => {
    expect(parseIntent(ev({ source: otherWin, data: validSelect }), expected)).toBeNull()
  })

  test('parseintent-rejects-bad-shape', () => {
    expect(parseIntent(ev({ data: { type: 'glance:unknown' } }), expected)).toBeNull()
    expect(parseIntent(ev({ data: 'not-an-object' }), expected)).toBeNull()
    expect(parseIntent(ev({ data: { type: 'glance:select' } }), expected)).toBeNull() // missing quote
    expect(parseIntent(ev({ data: { type: 'glance:select', quote: '' } }), expected)).toBeNull() // empty quote
  })

  test('parseintent-truncates-long-select-quote', () => {
    // A selection longer than the 2000-char cap must TRUNCATE (preserving the anchor + opening the
    // composer), not be dropped — regression for #30.
    const res = parseIntent(ev({ data: { type: 'glance:select', quote: 'y'.repeat(9000) } }), expected)
    expect(res).toEqual({ type: 'select', quote: 'y'.repeat(2000) })
  })

  test('parseintent-accepts-valid-select', () => {
    expect(parseIntent(ev({ data: validSelect }), expected)).toEqual({
      type: 'select',
      quote: 'the quick brown fox',
    })
  })

  test('parses a select-clear intent', () => {
    expect(parseIntent(ev({ data: { type: 'glance:select-clear' } }), expected)).toEqual({ type: 'clear' })
  })

  test('parses the dismissal intents the parent cannot observe inside the iframe', () => {
    expect(parseIntent(ev({ data: { type: 'glance:click-away' } }), expected)).toEqual({ type: 'clickAway' })
    expect(parseIntent(ev({ data: { type: 'glance:escape' } }), expected)).toEqual({ type: 'escape' })
  })

  test('dismissal intents are rejected on a wrong origin or wrong source, like every other intent', () => {
    for (const type of ['glance:click-away', 'glance:escape']) {
      expect(parseIntent(ev({ origin: 'https://evil.com', data: { type } }), expected)).toBeNull()
      expect(parseIntent(ev({ source: otherWin, data: { type } }), expected)).toBeNull()
    }
  })

  test('parseintent-carries-occurrence-context', () => {
    const res = parseIntent(ev({ data: { ...validSelect, context: { prefix: 'lead in ', suffix: ' tail' } } }), expected)
    expect(res).toMatchObject({ type: 'select', context: { prefix: 'lead in ', suffix: ' tail' } })
  })

  test('parseintent-clamps-context-instead-of-dropping-the-selection', () => {
    // Over-cap context must not cost the comment — the side is truncated, the quote survives.
    const tail = 'quote-adjacent'
    const prefix = `${'p'.repeat(500 - tail.length)}${tail}`
    const res = parseIntent(ev({ data: { ...validSelect, context: { prefix, suffix: '' } } }), expected)
    expect(res).toMatchObject({ type: 'select', quote: 'the quick brown fox' })
    expect((res as { context?: { prefix: string } }).context?.prefix).toBe(prefix.slice(-MAX_CONTEXT))
  })

  test('parseintent-clamps-oversize-suffix-from-the-tail-keeping-the-quote-adjacent-head', () => {
    // Suffix carries signal at its START (nearest the quote), so an over-cap suffix must clamp from
    // the opposite end — mirror of the prefix tail-clamp above, pinning the suffix's OWN clamp side.
    const head = 'quote-adjacent'
    const suffix = `${head}${'s'.repeat(500 - head.length)}`
    const res = parseIntent(ev({ data: { ...validSelect, context: { prefix: '', suffix } } }), expected)
    expect(res).toMatchObject({ type: 'select', quote: 'the quick brown fox' })
    expect((res as { context?: { suffix: string } }).context?.suffix).toBe(suffix.slice(0, MAX_CONTEXT))
  })

  test('parseintent-omits-unusable-context', () => {
    // Absent, empty, and malformed all collapse to ONE shape (undefined) so callers never branch.
    for (const context of [undefined, {}, { prefix: '', suffix: '' }, { prefix: 7 }, 'nope', null]) {
      const res = parseIntent(ev({ data: { ...validSelect, context } }), expected)
      expect(res).toEqual({ type: 'select', quote: 'the quick brown fox' })
    }
  })

  // Element (pinpoint) comment CREATION is dropped (slice C2a) — the parent no longer turns this
  // message into anything. A stale cached bundle may still post it (the annotate client's OWN
  // send is gone, but an old cached copy of client.ts could still be running in someone's tab); the
  // correct behaviour is for the parent to silently ignore it, not throw — so every shape of a
  // glance:pinpoint message, well-formed or not, parses to null now.
  test('a glance:pinpoint message (a stale cached bundle) is ignored, not parsed', () => {
    expect(
      parseIntent(ev({ data: { type: 'glance:pinpoint', selector: '#chart > svg', tag: 'svg', preview: 'Bar chart', textFallback: 'Revenue' } }), expected),
    ).toBeNull()
    expect(parseIntent(ev({ data: { type: 'glance:pinpoint', selector: '#x', rect: { top: 1, left: 2, width: 3, height: 4 } } }), expected)).toBeNull()
    expect(parseIntent(ev({ data: { type: 'glance:pinpoint', tag: 'svg' } }), expected)).toBeNull()
  })

  // The page→rail click. `id` is a thread id the parent looks up in its OWN loaded threads, so the
  // filter's whole job is shape: a string, non-empty, within the field cap.
  const anchorClick = (over: Record<string, unknown> = {}) => ({ type: 'glance:anchor-click', id: 'thread-1', ...over })

  test('parses a well-formed anchor-click', () => {
    expect(parseIntent(ev({ data: anchorClick() }), expected)).toEqual({ type: 'anchorClick', id: 'thread-1' })
  })

  test('anchor-click with a missing, non-string, or empty id is rejected', () => {
    for (const id of [undefined, null, 7, {}, '']) {
      expect(parseIntent(ev({ data: anchorClick({ id }) }), expected)).toBeNull()
    }
  })

  // str()'s length cap used to be proven only by a glance:pinpoint selector test, deleted with the
  // rest of that message type (slice C2a). Re-homed here on the field it actually still guards — an
  // id arriving from the hostile iframe — so the cap stays load-bearing, not just present.
  test('an over-cap id is rejected, not silently accepted at full length', () => {
    expect(parseIntent(ev({ data: anchorClick({ id: 'x'.repeat(2001) }) }), expected)).toBeNull()
    expect(parseIntent(ev({ data: anchorClick({ id: 'x'.repeat(2000) }) }), expected)).toMatchObject({ type: 'anchorClick' })
  })

  test('anchor-click is rejected on a wrong origin, like every other intent', () => {
    expect(parseIntent(ev({ origin: 'https://evil.com', data: anchorClick() }), expected)).toBeNull()
  })


  test('accepts a ready handshake; missing source check is skippable', () => {
    expect(parseIntent(ev({ data: { type: 'glance:ready', filePath: 'index.html' } }), expected)).toEqual({
      type: 'ready',
      filePath: 'index.html',
    })
    // When the caller cannot yet pin contentWindow, source filtering is skipped (origin still enforced).
    expect(parseIntent(ev({ source: otherWin, data: validSelect }), { origin: CONTENT, source: null })).not.toBeNull()
  })

  test('a ready handshake with an over-cap filePath is rejected, not truncated', () => {
    // Unlike the select quote (truncated, so a long selection still opens the composer), `str()`
    // rejects outright — a truncated filePath would misattribute comments to a path that doesn't exist.
    expect(parseIntent(ev({ data: { type: 'glance:ready', filePath: 'x'.repeat(2001) } }), expected)).toBeNull()
  })
})
