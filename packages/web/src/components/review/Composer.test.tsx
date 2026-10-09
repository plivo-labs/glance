// A-FAILED-WRITE-PRESERVES-THE-DRAFT-AND-STAYS-RETRYABLE (seam S-H, text path).
//
// The whole point of the write path rejecting instead of resolving-on-error is that Composer keys
// "clear the draft" off onSubmit RESOLVING. A comment lost to a 500 must look nothing like one
// that saved: the typed text stays, the box stays open, and the button comes back so the same
// draft can be sent again. onSubmit is deliberately deferred here (resolved/rejected by hand) so
// the assertions land on the settled state rather than a race.
import { describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Composer } from './Composer'

const DRAFT = 'the chart y-axis is unlabelled'

// Renders a Composer whose onSubmit hangs until the returned `settle` is called, so a test can
// hold the write open and then decide how it ends.
function renderDeferred() {
  let settle!: { resolve: () => void; reject: (err: unknown) => void }
  const onSubmit = mock(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject: (err) => reject(err) }
      }),
  )
  const onCancel = mock(() => {})
  render(<Composer placeholder="Add a comment" submitLabel="Comment" onSubmit={onSubmit} onCancel={onCancel} />)
  const textarea = screen.getByPlaceholderText('Add a comment') as HTMLTextAreaElement
  const submitButton = screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement
  return { onSubmit, onCancel, textarea, submitButton, settle: () => settle }
}

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } })
}

describe('A — Composer text submit', () => {
  test('a rejected write keeps the draft, keeps the composer open, and stays retryable', async () => {
    const { onSubmit, onCancel, textarea, submitButton, settle } = renderDeferred()

    type(textarea, DRAFT)
    expect(submitButton.disabled).toBe(false)
    fireEvent.click(submitButton)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]).toEqual([DRAFT, []])

    // The write fails the way a 500 does: the handler toasts and rethrows.
    await act(async () => {
      settle().reject(new Error('write failed'))
    })

    // Draft intact — the user's words are the only copy.
    expect(textarea.value).toBe(DRAFT)
    // Still mounted and still open: nothing asked the parent to close it.
    expect(textarea.isConnected).toBe(true)
    expect(onCancel).toHaveBeenCalledTimes(0)
    // Retryable: the busy latch released, so the same draft can be sent again.
    expect(submitButton.disabled).toBe(false)

    fireEvent.click(submitButton)
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]).toEqual([DRAFT, []])
  })

  test('a resolved write clears the draft (the other half of the contract)', async () => {
    const { onSubmit, textarea, submitButton, settle } = renderDeferred()

    type(textarea, DRAFT)
    fireEvent.click(submitButton)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    await act(async () => {
      settle().resolve()
    })

    expect(textarea.value).toBe('')
    // Empty draft → nothing to send, so the button goes back to disabled.
    expect(submitButton.disabled).toBe(true)
  })

  test('an in-flight write cannot be double-submitted', async () => {
    const { onSubmit, textarea, submitButton, settle } = renderDeferred()

    type(textarea, DRAFT)
    fireEvent.click(submitButton)
    expect(submitButton.disabled).toBe(true)
    fireEvent.click(submitButton)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    await act(async () => {
      settle().resolve()
    })
  })
})

// The submit button advertises ⌘↵, so the binding it advertises had better exist — and the keycap
// must not rename the button, which is how 13 selectors across this suite (and every screen reader)
// refer to it.
describe('A — ⌘/Ctrl+Enter submits, and the button says so', () => {
  const enter = (textarea: HTMLTextAreaElement, mods: Record<string, boolean>) =>
    fireEvent.keyDown(textarea, { key: 'Enter', ...mods })

  // Separate tests, not a loop: renderDeferred mounts into the shared container, so a second render
  // in one test leaves two composers and every by-placeholder lookup goes ambiguous.
  for (const [name, mods] of [
    ['⌘+Enter', { metaKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }],
  ] as const) {
    test(`${name} submits the draft`, () => {
      const { onSubmit, textarea } = renderDeferred()
      type(textarea, DRAFT)
      enter(textarea, mods)
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(onSubmit.mock.calls[0]).toEqual([DRAFT, []])
    })
  }

  test('a bare Enter does NOT submit — it types a newline, which is what a comment box is for', () => {
    const { onSubmit, textarea } = renderDeferred()
    type(textarea, DRAFT)
    enter(textarea, {})
    expect(onSubmit).toHaveBeenCalledTimes(0)
  })

  test('an empty draft is not submittable by keyboard either', () => {
    const { onSubmit, textarea } = renderDeferred()
    type(textarea, '   ')
    enter(textarea, { metaKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(0)
  })

  test('the keycaps are on the button but NOT in its accessible name', () => {
    const { submitButton } = renderDeferred()
    // One cap per physical key — two frames, not `⌘↵` sharing one.
    expect([...submitButton.querySelectorAll('kbd')].map((k) => k.textContent?.trim())).toEqual(['⌘', '↵'])
    // The button's own aria-label is what keeps this true; without it the keycap joins the content
    // and the name becomes "Comment ⌘↵".
    expect(screen.getByRole('button', { name: 'Comment' })).toBe(submitButton)
  })
})

describe('A — emoji picker', () => {
  // Appending to the end would be the easy implementation and the wrong one: the trigger is a click
  // away from a textarea the user is mid-sentence in, so the glyph has to land where the caret was
  // and the caret has to come back just past it, ready for the next word.
  test('picking an emoji inserts it at the caret, not at the end', () => {
    render(<Composer placeholder="Add a comment" submitLabel="Comment" onSubmit={() => {}} />)
    const textarea = screen.getByPlaceholderText('Add a comment') as HTMLTextAreaElement

    type(textarea, 'hello world')
    textarea.setSelectionRange(5, 5)

    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }))
    fireEvent.change(screen.getByPlaceholderText('Search emoji'), { target: { value: 'rocket' } })
    fireEvent.click(screen.getByText('🚀'))

    expect(textarea.value).toBe('hello🚀 world')
    expect(textarea.selectionStart).toBe(5 + '🚀'.length)
    // The picker closed itself, so the next keystroke goes to the draft.
    expect(screen.queryByPlaceholderText('Search emoji')).toBe(null)
  })

  test('an emoji is a draft like any other — the submit button wakes up', async () => {
    const onSubmit = mock((_body: string, _mentions: string[]) => {})
    render(<Composer placeholder="Add a comment" submitLabel="Comment" onSubmit={onSubmit} />)
    const submitButton = screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement
    expect(submitButton.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }))
    fireEvent.change(screen.getByPlaceholderText('Search emoji'), { target: { value: 'fire' } })
    fireEvent.click(screen.getByText('🔥'))

    expect(submitButton.disabled).toBe(false)
    fireEvent.click(submitButton)
    expect(onSubmit.mock.calls[0]).toEqual(['🔥', []])
    // submit() is async even though this onSubmit is sync — the `await` still yields a tick, and
    // its continuation (clearing the draft) must settle inside act before the test returns.
    await act(async () => {})
  })
})

describe('A — onDirtyChange', () => {
  test('a composer that goes away reports itself clean on the way out', () => {
    // The popover reducer reads `dirty` from the LAST report. A successful save closes the composer
    // in the same commit that would have reported the cleared draft, so without an unmount report
    // the parent is left believing a draft that no longer exists is still dirty — and every
    // dirty-guarded transition after that (click-away, re-anchoring) silently does nothing.
    const onDirtyChange = mock((_: boolean) => {})
    const { unmount } = render(
      <Composer placeholder="Add a comment" submitLabel="Comment" onSubmit={() => {}} onDirtyChange={onDirtyChange} />,
    )
    const textarea = screen.getByPlaceholderText('Add a comment') as HTMLTextAreaElement

    type(textarea, DRAFT)
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([true])

    unmount()
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([false])
  })
})

// S11: the composer is the only thing that knows a human is typing. It reports EVERY keystroke —
// the 15s cap lives in commentStream, so a composer that tried to be clever here would just be a
// second, drifting copy of the cost model.
describe('A — typing signal', () => {
  test('every keystroke reports typing, and blur reports a stop', () => {
    const onTyping = mock(() => {})
    const onTypingStop = mock(() => {})
    render(
      <Composer
        placeholder="Add a comment"
        submitLabel="Comment"
        onSubmit={() => {}}
        onTyping={onTyping}
        onTypingStop={onTypingStop}
      />,
    )
    const textarea = screen.getByPlaceholderText('Add a comment') as HTMLTextAreaElement

    type(textarea, 't')
    type(textarea, 'th')
    type(textarea, 'the')
    expect(onTyping).toHaveBeenCalledTimes(3)
    expect(onTypingStop).toHaveBeenCalledTimes(0)

    // Clicking away is the commonest way a draft is abandoned — the peer's indicator must not hang
    // there for the full server TTL.
    fireEvent.blur(textarea)
    expect(onTypingStop).toHaveBeenCalledTimes(1)
  })

  test('a submitted comment reports a stop; a failed one does not — the draft is still being typed', async () => {
    const onTypingStop = mock(() => {})
    let settle!: { resolve: () => void; reject: (err: unknown) => void }
    const onSubmit = mock(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject: (err) => reject(err) }
        }),
    )
    render(
      <Composer placeholder="Add a comment" submitLabel="Comment" onSubmit={onSubmit} onTypingStop={onTypingStop} />,
    )
    const textarea = screen.getByPlaceholderText('Add a comment') as HTMLTextAreaElement
    const submitButton = screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement

    type(textarea, DRAFT)
    fireEvent.click(submitButton)
    await act(async () => {
      settle.reject(new Error('write failed'))
    })
    // Same rule the draft itself follows: a rejected write changed nothing, and the user is still
    // sitting on their text.
    expect(onTypingStop).toHaveBeenCalledTimes(0)

    fireEvent.click(submitButton)
    await act(async () => {
      settle.resolve()
    })
    expect(onTypingStop).toHaveBeenCalledTimes(1)
  })
})
