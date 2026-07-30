import { describe, expect, test } from 'bun:test'
import { type HighlightState, initialHighlight, stepHighlight } from './highlightTarget'

// The parent-side decision B3b never had its own seam: the highlight (which thread ids the iframe
// paints into the hover-only CSS Custom Highlight right now) was decided inline in viewer.tsx
// callbacks, so nothing here proved hover REPLACES rather than unions, or that leaving/navigating
// clears it. Mirrors lib/badges.ts's reducer-plus-identity-bailout shape.

describe('initialHighlight', () => {
  test('starts empty', () => {
    expect(initialHighlight()).toEqual({ ids: [] })
  })
})

describe('stepHighlight — hover REPLACES, never unions', () => {
  test('hover([a]) then hover([b]) leaves ids exactly [b]', () => {
    const afterA = stepHighlight(initialHighlight(), { type: 'hover', ids: ['a'] })
    expect(afterA.ids).toEqual(['a'])
    const afterB = stepHighlight(afterA, { type: 'hover', ids: ['b'] })
    expect(afterB.ids).toEqual(['b'])
  })
})

describe('stepHighlight — leave / exitReview / navigate all clear to empty', () => {
  const lit = (): HighlightState => stepHighlight(initialHighlight(), { type: 'hover', ids: ['a'] })

  test('leave from a lit state clears', () => {
    expect(stepHighlight(lit(), { type: 'leave' }).ids).toEqual([])
  })

  test('exitReview from a lit state clears', () => {
    expect(stepHighlight(lit(), { type: 'exitReview' }).ids).toEqual([])
  })

  test('navigate from a lit state clears — a deep-link mount lights nothing', () => {
    expect(stepHighlight(lit(), { type: 'navigate' }).ids).toEqual([])
  })
})

describe('stepHighlight — identity bailout so the caller can skip the postMessage', () => {
  test('an event producing the SAME set returns the SAME object', () => {
    const state = stepHighlight(initialHighlight(), { type: 'hover', ids: ['a'] })
    const same = stepHighlight(state, { type: 'hover', ids: ['a'] })
    expect(same).toBe(state)
  })

  test('navigate from empty stays empty and is the SAME object — a deep-link mount lights nothing', () => {
    const state = initialHighlight()
    const next = stepHighlight(state, { type: 'navigate' })
    expect(next).toBe(state)
  })

  test('leave from an already-empty state is the SAME object', () => {
    const state = initialHighlight()
    const next = stepHighlight(state, { type: 'leave' })
    expect(next).toBe(state)
  })

  test('exitReview from an already-empty state is the SAME object', () => {
    const state = initialHighlight()
    const next = stepHighlight(state, { type: 'exitReview' })
    expect(next).toBe(state)
  })

  test('hover with the same ids (even a new array instance) is the SAME object', () => {
    const state = stepHighlight(initialHighlight(), { type: 'hover', ids: ['a', 'b'] })
    const next = stepHighlight(state, { type: 'hover', ids: ['a', 'b'] })
    expect(next).toBe(state)
  })

  test('hover with a different id, same length, is a NEW object', () => {
    const state = stepHighlight(initialHighlight(), { type: 'hover', ids: ['a'] })
    const next = stepHighlight(state, { type: 'hover', ids: ['b'] })
    expect(next).not.toBe(state)
  })
})
