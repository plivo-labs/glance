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
