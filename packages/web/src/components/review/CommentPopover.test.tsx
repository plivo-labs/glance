// Slice A2-ui — SELECT-OFFERS-A-CHIP, THE-CHIP-OPENS-THE-COMPOSER (seam S-H, in-page path).
//
// A selection must NOT open a composer: that would hijack plain select-to-copy. The chip is the
// explicit step in between, and only a click on it mints a composer. The rules themselves live in
// the A1 reducer (lib/commentPopover) — these tests drive the REAL reducer through the component,
// so they pin what the user actually sees for each state it produces.
//
// Positioning is asserted for SHAPE ONLY (the rect's numbers reach the inline style). happy-dom
// stubs getBoundingClientRect to zeros and models no layout, so a "the popover is under the
// selection" assertion here would be theatre — real geometry is proven in the browser (B4).
import { describe, expect, mock, test } from 'bun:test'
import { useReducer } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { type Anchor, initialPopover, stepPopover } from '@/lib/commentPopover'
import { CommentPopover } from './CommentPopover'

const ANCHOR: Anchor = {
  quote: 'the chart y-axis is unlabelled',
  context: { prefix: 'note that ', suffix: ' in figure 2' },
  rect: { top: 120, left: 40, width: 220, height: 18 },
}

const CHIP = { name: 'Comment on selection' }

const USERS = [{ id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' }]

// Drives the component through the real A1 reducer, seeded with a selection — exactly how the
// viewer holds it, so a click on the chip goes through 'activate' rather than a test-only shortcut.
function Harness({
  onDismiss,
  loadMentions,
  onDirtyChange,
}: {
  onDismiss?: () => void
  loadMentions?: () => Promise<typeof USERS>
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [state, dispatch] = useReducer(stepPopover, undefined, () =>
    stepPopover(initialPopover(), { type: 'select', anchor: ANCHOR, dirty: false }),
  )
  return (
    <CommentPopover
      chip={state.chip}
      composer={state.composer}
      onActivate={() => dispatch({ type: 'activate' })}
      onDismiss={() => {
        dispatch({ type: 'dismiss' })
        onDismiss?.()
      }}
      onSubmit={() => {}}
      onSubmitVoice={() => {}}
      loadMentions={loadMentions}
      onDirtyChange={onDirtyChange}
    />
  )
}

const openComposer = () => fireEvent.click(screen.getByRole('button', CHIP))

describe('A2-ui — the selection chip', () => {
  test('a selection renders a chip and NO composer', () => {
    render(<Harness />)

    expect(screen.getByRole('button', CHIP)).toBeTruthy()
    expect(screen.queryByPlaceholderText('Add a comment…')).toBeNull()
  })

  test('clicking the chip opens the popover with the quote and a Composer', () => {
    render(<Harness />)
    openComposer()

    expect(screen.getByPlaceholderText('Add a comment…')).toBeTruthy()
    // The quote is what tells the user WHICH text they are commenting on.
    expect(screen.getByText(`“${ANCHOR.quote}”`)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Comment' })).toBeTruthy()
  })

  test('Cancel closes the popover via onDismiss', () => {
    const onDismiss = mock(() => {})
    render(<Harness onDismiss={onDismiss} />)
    openComposer()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByPlaceholderText('Add a comment…')).toBeNull()
  })

  test("the intent's rect reaches the inline style of both the chip and the popover", () => {
    render(<Harness />)
    const chip = screen.getByRole('button', CHIP)
    openComposer()
    const popover = screen.getByPlaceholderText('Add a comment…').closest('div[style]') as HTMLElement

    // SHAPE ONLY: these numbers are the rect's, pinned in px. happy-dom does no layout, so where
    // the box actually lands on screen is not — and cannot be — under test here.
    for (const el of [chip, popover]) {
      expect(el.style.top).toBe(`${ANCHOR.rect.top + ANCHOR.rect.height + 8}px`)
      expect(el.style.left).toBe(`${ANCHOR.rect.left}px`)
      expect(el.style.position).toBe('') // positioned by the `absolute` class, inside the iframe's wrapper
    }
  })
})

describe('the draft reports its emptiness upward', () => {
  // `dirty` is an INPUT to the reducer (it decides whether a new selection may re-anchor an open
  // composer, and whether a click-away closes it), but the draft itself never leaves the Composer.
  test('typing reports dirty, emptying reports clean', () => {
    const onDirtyChange = mock((_dirty: boolean) => {})
    render(<Harness onDirtyChange={onDirtyChange} />)
    openComposer()
    const textarea = screen.getByPlaceholderText('Add a comment…')

    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false]) // a fresh composer has nothing to lose

    fireEvent.change(textarea, { target: { value: 'why is this red?' } })
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([true])

    // Whitespace is not a draft — same rule the submit button uses.
    fireEvent.change(textarea, { target: { value: '   ' } })
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false])
  })
})

describe('Escape belongs to the mention menu first', () => {
  test('Escape with the mention menu open closes the MENU; a second Escape closes the popover', async () => {
    const onDismiss = mock(() => {})
    render(<Harness onDismiss={onDismiss} loadMentions={() => Promise.resolve(USERS)} />)
    openComposer()

    const textarea = screen.getByPlaceholderText('Add a comment…') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '@ada' } })
    })
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeTruthy()

    // The Composer preventDefaults this one, so the popover must not act on it.
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: /Ada Lovelace/ })).toBeNull()
    expect(onDismiss).toHaveBeenCalledTimes(0)
    expect(textarea.isConnected).toBe(true)

    // Menu gone: the next Escape is the popover's.
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByPlaceholderText('Add a comment…')).toBeNull()
  })
})
