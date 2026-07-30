import { describe, expect, test } from 'bun:test'
import { deepLinkReady, railFromSearch, shouldReveal } from './viewerCommands'

// Slice B-wire — the viewer's remaining inline decisions, extracted so each is pinned by a test
// instead of living silently in viewer.tsx (mirrors lib/commentPopover.ts).

describe('railFromSearch — the ONLY place the deep-link URL→rail decision is made (slice C1a)', () => {
  test('the legacy `review=1` (baked into already-sent Slack/notification links) opens the rail forever', () => {
    expect(railFromSearch(new URLSearchParams('review=1'))).toBe(true)
  })

  test('no param at all does not open the rail', () => {
    expect(railFromSearch(new URLSearchParams(''))).toBe(false)
  })

  test('review=0 and any other value than the documented "1" is ignored, not truthy-coerced', () => {
    expect(railFromSearch(new URLSearchParams('review=0'))).toBe(false)
    expect(railFromSearch(new URLSearchParams('review=yes'))).toBe(false)
  })
})

describe('deepLinkReady — content-kind readiness gate for the ?thread deep link (slice C1b, kills the audio bug)', () => {
  test('audio never gets a frame load — ready as soon as its thread has arrived, loaded or not', () => {
    expect(deepLinkReady({ isAudio: true, loaded: false, hasThread: true })).toBe(true)
  })

  test('HTML must wait for the iframe onLoad even once the thread is in', () => {
    expect(deepLinkReady({ isAudio: false, loaded: false, hasThread: true })).toBe(false)
  })

  test('HTML is ready once both the frame has loaded and the thread is in', () => {
    expect(deepLinkReady({ isAudio: false, loaded: true, hasThread: true })).toBe(true)
  })

  test('neither kind reveals a thread that has not arrived yet', () => {
    expect(deepLinkReady({ isAudio: true, loaded: true, hasThread: false })).toBe(false)
    expect(deepLinkReady({ isAudio: false, loaded: true, hasThread: false })).toBe(false)
  })
})

describe('shouldReveal — reveal-request gate keyed on NONCE not id (slice C1b, kills the one-shot-per-id bug)', () => {
  test('the same thread id requested twice with a bumped nonce reveals twice', () => {
    expect(shouldReveal({ id: 't1', nonce: 1 }, 0, true)).toBe(true)
    // Simulates the rail having handled nonce 1 already, then the SAME id comes back at nonce 2.
    expect(shouldReveal({ id: 't1', nonce: 2 }, 1, true)).toBe(true)
  })

  test('an unchanged nonce across an unrelated re-render does not re-reveal', () => {
    expect(shouldReveal({ id: 't1', nonce: 1 }, 1, true)).toBe(false)
  })

  test('a different id with a bumped nonce reveals', () => {
    expect(shouldReveal({ id: 't2', nonce: 2 }, 1, true)).toBe(true)
  })

  test('no request, or a target that has not arrived, never reveals', () => {
    expect(shouldReveal(null, 1, true)).toBe(false)
    expect(shouldReveal({ id: 't1', nonce: 2 }, 1, false)).toBe(false)
  })
})
