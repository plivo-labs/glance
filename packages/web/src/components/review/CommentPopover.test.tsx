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
import { ApiError } from '@/lib/api'
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
  onAsk,
}: {
  onDismiss?: () => void
  loadMentions?: () => Promise<typeof USERS>
  onDirtyChange?: (dirty: boolean) => void
  onAsk?: (question: string, anchor: Anchor, onToken: (text: string) => void, signal: AbortSignal) => Promise<void>
}) {
  const [state, dispatch] = useReducer(stepPopover, undefined, () =>
    stepPopover(initialPopover(), { type: 'select', anchor: ANCHOR, dirty: false }),
  )
  return (
    <CommentPopover
      chip={state.chip}
      composer={state.composer}
      ask={state.ask}
      onActivate={() => dispatch({ type: 'activate' })}
      onAskActivate={() => dispatch({ type: 'askActivate' })}
      onDismiss={() => {
        dispatch({ type: 'dismiss' })
        onDismiss?.()
      }}
      onSubmit={() => {}}
      onSubmitVoice={() => {}}
      onAsk={onAsk ?? (() => Promise.resolve())}
      loadMentions={loadMentions}
      onDirtyChange={onDirtyChange}
    />
  )
}

const ASK_CHIP = { name: 'Ask AI about selection' }

const openComposer = () => fireEvent.click(screen.getByRole('button', CHIP))
const openAsk = () => fireEvent.click(screen.getByRole('button', ASK_CHIP))

describe('A2-ui — the selection chip', () => {
  test('a selection renders a chip and NO composer', () => {
    render(<Harness />)

    expect(screen.getByRole('button', CHIP)).toBeTruthy()
    expect(screen.queryByPlaceholderText('Add a comment…')).toBeNull()
  })

  test('the chip advertises the C binding, without renaming itself for a screen reader', () => {
    // The binding lives inside the content iframe, so the chip is the only place it can be
    // discovered — it appears in no menu and no command palette (#117). The keycap must not leak
    // into the button's accessible name, which is what every other test here selects on.
    render(<Harness />)
    const chip = screen.getByRole('button', CHIP)

    expect(chip.querySelector('kbd')?.textContent?.trim()).toBe('C')
    expect(screen.queryByRole('button', { name: 'Comment C' })).toBeNull()
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
    // The Comment and Ask buttons are one toolbar pinned to one rect — the position lives on their
    // shared wrapper, not on either button.
    const chipWrapper = screen.getByRole('button', CHIP).closest('div[style]') as HTMLElement
    openComposer()
    const popover = screen.getByPlaceholderText('Add a comment…').closest('div[style]') as HTMLElement

    // SHAPE ONLY: these numbers are the rect's, pinned in px. happy-dom does no layout, so where
    // the box actually lands on screen is not — and cannot be — under test here.
    for (const el of [chipWrapper, popover]) {
      expect(el.style.top).toBe(`${ANCHOR.rect.top + ANCHOR.rect.height + 8}px`)
      expect(el.style.left).toBe(`${ANCHOR.rect.left}px`)
      expect(el.style.position).toBe('') // positioned by the `absolute` class, inside the iframe's wrapper
    }
  })

  test('the Ask chip sits beside Comment and opens the ask panel on click', () => {
    render(<Harness />)

    expect(screen.getByRole('button', ASK_CHIP)).toBeTruthy()
    expect(screen.getByRole('button', ASK_CHIP).querySelector('kbd')?.textContent?.trim()).toBe('A')
    openAsk()

    expect(screen.getByPlaceholderText('Ask about this selection…')).toBeTruthy()
    expect(screen.getByText(`“${ANCHOR.quote}”`)).toBeTruthy()
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

describe('the ask panel', () => {
  test('Enter submits and calls onAsk with the typed question and the anchor', async () => {
    const onAsk = mock(() => Promise.resolve())
    render(<Harness onAsk={onAsk} />)
    openAsk()

    const textarea = screen.getByPlaceholderText('Ask about this selection…')
    // Shift+Enter is a newline, not a submit.
    fireEvent.change(textarea, { target: { value: 'why is this red?' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onAsk).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })

    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(onAsk.mock.calls[0][0]).toBe('why is this red?')
    expect(onAsk.mock.calls[0][1]).toEqual(ANCHOR)
  })

  test('streamed tokens render as markdown once the answer settles', async () => {
    const onAsk = mock(async (_q: string, _a: Anchor, onToken: (t: string) => void) => {
      onToken('**bold**')
      onToken('\n\n- item')
    })
    render(<Harness onAsk={onAsk} />)
    openAsk()
    const textarea = screen.getByPlaceholderText('Ask about this selection…')
    fireEvent.change(textarea, { target: { value: 'q' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })

    expect(document.querySelector('strong')?.textContent).toBe('bold')
    expect(document.querySelector('li')?.textContent).toBe('item')
    // The question locks once submitted — readOnly, not disabled, so the panel keeps focus (and
    // with it the Escape route out).
    expect((screen.getByPlaceholderText('Ask about this selection…') as HTMLTextAreaElement).readOnly).toBe(true)
  })

  test('the close button dismisses an answered panel', async () => {
    const onAsk = mock(async (_q: string, _a: Anchor, onToken: (t: string) => void) => {
      onToken('answer')
    })
    const onDismiss = mock(() => {})
    render(<Harness onAsk={onAsk} onDismiss={onDismiss} />)
    openAsk()
    const textarea = screen.getByPlaceholderText('Ask about this selection…')
    fireEvent.change(textarea, { target: { value: 'q' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })

    // Focus-free dismissal: with the answer on screen (dirty), click-away is inert by design and
    // Escape needs focus inside the panel — the X must always work.
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('error path shows the ApiError message with a Retry that re-runs the same question', async () => {
    const onAsk = mock(() => Promise.reject(new ApiError(500, 'model unavailable')))
    render(<Harness onAsk={onAsk} />)
    openAsk()
    const textarea = screen.getByPlaceholderText('Ask about this selection…')
    fireEvent.change(textarea, { target: { value: 'why?' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })

    expect(screen.getByText('model unavailable')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })

    expect(onAsk).toHaveBeenCalledTimes(2)
    expect(onAsk.mock.calls[1][0]).toBe('why?')
  })

  test('"Ask another" resets to an empty, focused textarea', async () => {
    const onAsk = mock(async (_q: string, _a: Anchor, onToken: (t: string) => void) => onToken('the answer'))
    render(<Harness onAsk={onAsk} />)
    openAsk()
    const textarea = screen.getByPlaceholderText('Ask about this selection…')
    fireEvent.change(textarea, { target: { value: 'q' } })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ask another' }))
    const fresh = screen.getByPlaceholderText('Ask about this selection…') as HTMLTextAreaElement
    expect(fresh.value).toBe('')
    expect(fresh.disabled).toBe(false)
    expect(document.activeElement).toBe(fresh)
  })

  test('onDirtyChange reports true while typing/streaming/answered, false once reset', async () => {
    const onDirtyChange = mock((_dirty: boolean) => {})
    const onAsk = mock(async (_q: string, _a: Anchor, onToken: (t: string) => void) => onToken('the answer'))
    render(<Harness onAsk={onAsk} onDirtyChange={onDirtyChange} />)
    openAsk()

    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false]) // a fresh panel has nothing to lose

    const textarea = screen.getByPlaceholderText('Ask about this selection…')
    fireEvent.change(textarea, { target: { value: 'q' } })
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([true])

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([true]) // answer on screen

    fireEvent.click(screen.getByRole('button', { name: 'Ask another' }))
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false])
  })
})
