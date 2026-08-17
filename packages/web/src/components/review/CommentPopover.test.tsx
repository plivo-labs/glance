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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  test('the Ask chip sits beside Comment and opens the ask panel on click', async () => {
    render(<Harness />)

    expect(screen.getByRole('button', ASK_CHIP)).toBeTruthy()
    expect(screen.getByRole('button', ASK_CHIP).querySelector('kbd')?.textContent?.trim()).toBe('A')
    await act(async () => openAsk())

    expect(screen.getByPlaceholderText('Ask a follow-up…')).toBeTruthy()
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
  test('opening auto-asks the default question — zero typing', async () => {
    const onAsk = mock(async (_q: string, _a: Anchor, onToken: (t: string) => void) => onToken('an answer'))
    render(<Harness onAsk={onAsk} />)
    await act(async () => openAsk())

    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(onAsk.mock.calls[0][0]).toBe('Explain this')
    expect(onAsk.mock.calls[0][1]).toEqual(ANCHOR)
    // The auto-asked question is visible as the turn's label, the answer under it.
    expect(screen.getByText('Explain this')).toBeTruthy()
    expect(screen.getByText('an answer')).toBeTruthy()
  })

  test('a typed follow-up runs as a new turn, keeping the first on screen', async () => {
    const onAsk = mock(async (q: string, _a: Anchor, onToken: (t: string) => void) => onToken(`answer to ${q}`))
    render(<Harness onAsk={onAsk} />)
    await act(async () => openAsk())

    const textarea = screen.getByPlaceholderText('Ask a follow-up…')
    // Shift+Enter is a newline, not a submit.
    fireEvent.change(textarea, { target: { value: 'why is this red?' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onAsk).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' })
    })

    expect(onAsk).toHaveBeenCalledTimes(2)
    expect(onAsk.mock.calls[1][0]).toBe('why is this red?')
    // Both turns visible; the follow-up box cleared for the next question.
    expect(screen.getByText('answer to Explain this')).toBeTruthy()
    expect(screen.getByText('answer to why is this red?')).toBeTruthy()
    expect((textarea as HTMLTextAreaElement).value).toBe('')
  })

  test('streamed tokens render as markdown WHILE streaming (Streamdown)', async () => {
    // The stream never settles: onAsk emits tokens then hangs, so this asserts mid-stream state.
    let emit: ((t: string) => void) | null = null
    const onAsk = mock((_q: string, _a: Anchor, onToken: (t: string) => void) => {
      emit = onToken
      return new Promise<void>(() => {}) // never resolves — the turn stays streaming
    })
    render(<Harness onAsk={onAsk} />)
    await act(async () => openAsk())
    act(() => {
      emit?.('**bold**')
      emit?.('\n\n- item')
    })

    // Streamdown marks semantics with data-streamdown attributes (bold is a styled span).
    // waitFor, not a plain expect: with isAnimating the token fade commits DOM behind animation
    // frames, so on a slow runner the elements land a tick after the act() above (CI-only flake).
    await waitFor(() => {
      expect(document.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold')
      expect(document.querySelector('[data-streamdown="list-item"]')?.textContent?.trim()).toBe('item')
    })
    // The follow-up box locks while streaming — readOnly, not disabled, so the panel keeps focus
    // (and with it the Escape route out).
    expect((screen.getByPlaceholderText('Ask a follow-up…') as HTMLTextAreaElement).readOnly).toBe(true)
  })

  test('the close button dismisses an answered panel', async () => {
    const onAsk = mock(async (_q: string, _a: Anchor, onToken: (t: string) => void) => onToken('answer'))
    const onDismiss = mock(() => {})
    render(<Harness onAsk={onAsk} onDismiss={onDismiss} />)
    await act(async () => openAsk())

    // Focus-free dismissal: with the answer on screen (dirty), click-away is inert by design and
    // Escape needs focus inside the panel — the X must always work.
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('error path shows the ApiError message with a Retry that re-runs the same question', async () => {
    const onAsk = mock(() => Promise.reject(new ApiError(500, 'model unavailable')))
    render(<Harness onAsk={onAsk} />)
    await act(async () => openAsk())

    expect(screen.getByText('model unavailable')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })

    // The retried turn replaces the dead one — same question, and only one turn on screen.
    expect(onAsk).toHaveBeenCalledTimes(2)
    expect(onAsk.mock.calls[1][0]).toBe('Explain this')
    expect(screen.getAllByText('Explain this')).toHaveLength(1)
  })

  test('onDirtyChange is true for the panel’s whole life, false once dismissed', async () => {
    const onDirtyChange = mock((_dirty: boolean) => {})
    const onAsk = mock(async (_q: string, _a: Anchor, onToken: (t: string) => void) => onToken('the answer'))
    render(<Harness onAsk={onAsk} onDirtyChange={onDirtyChange} />)
    await act(async () => openAsk())

    // The auto-asked turn means there is ALWAYS something on screen worth keeping.
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([true])

    fireEvent.click(screen.getByLabelText('Close'))
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false])
  })
})
