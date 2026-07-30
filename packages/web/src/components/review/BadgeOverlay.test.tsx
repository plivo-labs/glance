// Slice B2c — the overlay that PAINTS the badges buildBadges (lib/badges) computes. A dumb
// renderer, no state of its own: every prop is already the shape to draw. Mirrors CommentPopover's
// test style (S-H harness, shape-only positioning assertions — happy-dom does no layout).
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Badge } from '@/lib/badges'
import { BadgeOverlay } from './BadgeOverlay'

function mkBadge(overrides: Partial<Badge> & { key: string }): Badge {
  return {
    key: overrides.key,
    top: 10,
    left: 20,
    threadIds: ['t1'],
    authors: [{ id: 'u1', name: 'Amy Adams' }],
    extra: 0,
    count: 1,
    ...overrides,
  }
}

describe('B2c — BadgeOverlay', () => {
  // The chip hangs 8px BELOW the anchor's own top (NUDGE_Y) so it clears the line of text it
  // belongs to; `left` is taken as-is.
  test('two badges render two buttons, keyed and positioned from their top/left', () => {
    const badges = [
      mkBadge({ key: 't1', top: 15, left: 25, threadIds: ['t1'] }),
      mkBadge({ key: 't2', top: 55, left: 65, threadIds: ['t2'] }),
    ]
    render(<BadgeOverlay badges={badges} onOpen={() => {}} onHoverChange={() => {}} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.style.top).toBe('23px')
    expect(buttons[0]?.style.left).toBe('25px')
    expect(buttons[1]?.style.top).toBe('63px')
    expect(buttons[1]?.style.left).toBe('65px')
  })

  test('a badge with extra 0 renders one round avatar per author, no reply count and no +N', () => {
    const badge = mkBadge({
      key: 't1',
      authors: [
        { id: 'u1', name: 'Amy Adams' },
        { id: 'u2', name: 'Bob Brown' },
      ],
      extra: 0,
      count: 3,
    })
    const { container } = render(<BadgeOverlay badges={[badge]} onOpen={() => {}} onHoverChange={() => {}} />)

    const avatars = [...container.querySelectorAll('[data-slot="avatar"]')]
    expect(avatars).toHaveLength(2)
    for (const avatar of avatars) expect(avatar.className).toContain('rounded-full')
    // No photo can load under happy-dom, so every avatar sits on its initials fallback — which is
    // also the real-world path for an author with no Google photo.
    const button = screen.getByRole('button')
    expect(button.textContent).toContain('A')
    expect(button.textContent).toContain('B')
    expect(button.textContent).not.toContain('+')
    // The reply count is the rail's job — it must not be painted on the page, only labelled.
    expect(button.textContent).not.toContain('3')
    expect(button.getAttribute('aria-label')).toBe('Open comments (3)')
  })

  test('a badge with extra 2 renders a +2 circle alongside the 3 avatars', () => {
    const badge = mkBadge({
      key: 't1',
      authors: [
        { id: 'u1', name: 'Amy Adams' },
        { id: 'u2', name: 'Bob Brown' },
        { id: 'u3', name: 'Cara Clark' },
      ],
      extra: 2,
      count: 5,
    })
    const { container } = render(<BadgeOverlay badges={[badge]} onOpen={() => {}} onHoverChange={() => {}} />)

    expect(container.querySelectorAll('[data-slot="avatar"]')).toHaveLength(3)
    expect(container.querySelector('[data-slot="avatar-group-count"]')?.textContent).toBe('+2')
  })

  test('clicking a badge calls onOpen with exactly that badge threadIds', () => {
    const onOpen = mock((_ids: string[]) => {})
    const badges = [
      mkBadge({ key: 't1', threadIds: ['t1'] }),
      mkBadge({ key: 't2,t3', threadIds: ['t2', 't3'] }),
    ]
    render(<BadgeOverlay badges={badges} onOpen={onOpen} onHoverChange={() => {}} />)

    fireEvent.click(screen.getAllByRole('button')[1] as HTMLElement)

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(['t2', 't3'])
  })

  test('the root layer carries pointer-events-none and each chip carries pointer-events-auto', () => {
    const badge = mkBadge({ key: 't1' })
    const { container } = render(<BadgeOverlay badges={[badge]} onOpen={() => {}} onHoverChange={() => {}} />)

    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('pointer-events-none')
    expect(screen.getByRole('button').className).toContain('pointer-events-auto')
  })

  test('badges: [] renders no buttons', () => {
    render(<BadgeOverlay badges={[]} onOpen={() => {}} onHoverChange={() => {}} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  test('aria-label carries the count for a stable handle', () => {
    const badge = mkBadge({ key: 't1', count: 4 })
    render(<BadgeOverlay badges={[badge]} onOpen={() => {}} onHoverChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Open comments (4)' })).toBeTruthy()
  })

  // B3b — the highlight is a HOVER affordance, never a persistent one: BadgeOverlay reports its
  // own hover/focus state up so the caller can paint (or clear) the highlight, but owns none of
  // that painting itself.
  test('pointerenter reports the chip own threadIds; pointerleave clears to []', () => {
    const onHoverChange = mock((_ids: string[]) => {})
    const badge = mkBadge({ key: 't1', threadIds: ['t1'] })
    render(<BadgeOverlay badges={[badge]} onOpen={() => {}} onHoverChange={onHoverChange} />)
    const button = screen.getByRole('button')

    fireEvent.pointerEnter(button)
    expect(onHoverChange).toHaveBeenCalledTimes(1)
    expect(onHoverChange).toHaveBeenLastCalledWith(['t1'])

    fireEvent.pointerLeave(button)
    expect(onHoverChange).toHaveBeenCalledTimes(2)
    expect(onHoverChange).toHaveBeenLastCalledWith([])
  })

  test('focus reports the chip own threadIds; blur clears to [] — keyboard counts as hover', () => {
    const onHoverChange = mock((_ids: string[]) => {})
    const badge = mkBadge({ key: 't1', threadIds: ['t1'] })
    render(<BadgeOverlay badges={[badge]} onOpen={() => {}} onHoverChange={onHoverChange} />)
    const button = screen.getByRole('button')

    fireEvent.focus(button)
    expect(onHoverChange).toHaveBeenCalledTimes(1)
    expect(onHoverChange).toHaveBeenLastCalledWith(['t1'])

    fireEvent.blur(button)
    expect(onHoverChange).toHaveBeenCalledTimes(2)
    expect(onHoverChange).toHaveBeenLastCalledWith([])
  })

  test('hovering chip A then chip B reports A then B — each chip its OWN ids, never a union', () => {
    const onHoverChange = mock((_ids: string[]) => {})
    const badges = [mkBadge({ key: 't1', threadIds: ['t1'] }), mkBadge({ key: 't2', threadIds: ['t2'] })]
    render(<BadgeOverlay badges={badges} onOpen={() => {}} onHoverChange={onHoverChange} />)
    const [a, b] = screen.getAllByRole('button')

    fireEvent.pointerEnter(a as HTMLElement)
    fireEvent.pointerEnter(b as HTMLElement)

    expect(onHoverChange.mock.calls.map((c) => c[0])).toEqual([['t1'], ['t2']])
  })
})
