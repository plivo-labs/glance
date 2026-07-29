import { describe, expect, test } from 'bun:test'
import type { Thread } from '@/lib/comments'
import { badgeOpenTarget, deepLinkReady, frameViewport, highlightCommand, railFromSearch, shouldReveal } from './viewerCommands'

// Slice B-wire — the viewer's remaining inline decisions, extracted so each is pinned by a test
// instead of living silently in viewer.tsx (mirrors lib/badges.ts, lib/commentPopover.ts).

// Minimal Thread builder: only `id` (and `status` where relevant) is meaningful here.
function mkThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    id: overrides.id,
    filePath: '/f',
    anchorType: 'text',
    quote: 'q',
    anchor: null,
    context: null,
    status: 'open',
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    createdBy: null,
    createdByName: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comments: [],
    ...overrides,
  }
}

describe('highlightCommand — the ONLY place the glance:highlight wire literal is written (kills M1)', () => {
  test('wraps ids into the exact iframe message shape', () => {
    expect(highlightCommand({ ids: ['a', 'b'] })).toEqual({ type: 'glance:highlight', ids: ['a', 'b'] })
  })

  test('an empty id list is still posted — that IS how a highlight clears, not a skipped post', () => {
    expect(highlightCommand({ ids: [] })).toEqual({ type: 'glance:highlight', ids: [] })
  })
})

describe('frameViewport — the iframe box IS the frame viewport (kills M5)', () => {
  test('not mounted yet (null) is {0,0} — buildBadges already treats that as "nothing visible yet"', () => {
    expect(frameViewport(null)).toEqual({ width: 0, height: 0 })
  })

  // Deliberately NOT 800x600: that's the archetypal hardcoded viewport, so a fixture using it can't
  // distinguish a real measurement from a constant standing in for one. A non-default pair only
  // passes if the values actually flow through from the element.
  test('a mounted iframe reports its own clientWidth/clientHeight', () => {
    expect(frameViewport({ clientWidth: 137, clientHeight: 41 })).toEqual({ width: 137, height: 41 })
  })
})

describe('badgeOpenTarget — which thread a badge click reveals (kills M6)', () => {
  test('an empty id list opens nothing', () => {
    expect(badgeOpenTarget([], [mkThread({ id: 't1' })])).toBeNull()
  })

  test('ids matching no live thread open nothing', () => {
    expect(badgeOpenTarget(['ghost'], [mkThread({ id: 't1' })])).toBeNull()
  })

  test('returns the first member that matches a live thread', () => {
    const threads = [mkThread({ id: 't1' }), mkThread({ id: 't2' })]
    expect(badgeOpenTarget(['t1', 't2'], threads)).toBe(threads[0]!)
  })

  test('skips a first member resolved/deleted between the rect batch and the click, returns the second', () => {
    // A blind threadIds[0] would return undefined here (t1 no longer exists) and silently open
    // nothing — the exact case a cluster's stale first member breaks.
    const threads = [mkThread({ id: 't2' })]
    expect(badgeOpenTarget(['t1', 't2'], threads)).toBe(threads[0]!)
  })
})

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
