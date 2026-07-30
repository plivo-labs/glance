// The picker is a click-to-pick surface layered over a textarea, so the tests are about the two
// things that break silently: the popover actually opening under the composer's blur handling, and
// a pick reporting the glyph exactly once and then getting out of the way.
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { EmojiPicker } from './EmojiPicker'

function open(onPick = mock((_: string) => {})) {
  render(<EmojiPicker onPick={onPick} />)
  fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }))
  return { onPick, search: screen.getByPlaceholderText('Search emoji') as HTMLInputElement }
}

describe('EmojiPicker', () => {
  test('opens on the trigger and shows the category grid', () => {
    open()
    expect(screen.getByText('Smileys').isConnected).toBe(true)
    expect(screen.getByText('Symbols').isConnected).toBe(true)
  })

  test('typing switches to flat results and drops the headings', () => {
    const { search } = open()
    fireEvent.change(search, { target: { value: 'rocket' } })
    expect(screen.queryByText('Smileys')).toBe(null)
    expect(screen.getByText('🚀').isConnected).toBe(true)
    expect(screen.queryByText('😀')).toBe(null)
  })

  test('clicking an emoji reports it once and closes the popover', () => {
    const { onPick, search } = open()
    fireEvent.change(search, { target: { value: 'rocket' } })
    fireEvent.click(screen.getByText('🚀'))
    expect(onPick.mock.calls).toEqual([['🚀']])
    expect(screen.queryByPlaceholderText('Search emoji')).toBe(null)
  })

  test('Enter picks the first result', () => {
    const { onPick, search } = open()
    fireEvent.change(search, { target: { value: 'fire' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onPick.mock.calls).toEqual([['🔥']])
  })

  test('Escape closes without picking', () => {
    const { onPick, search } = open()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Search emoji')).toBe(null)
    expect(onPick).toHaveBeenCalledTimes(0)
  })

  test('a reopened picker starts from a clean query', () => {
    const { search } = open()
    fireEvent.change(search, { target: { value: 'rocket' } })
    fireEvent.click(screen.getByText('🚀'))
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }))
    expect((screen.getByPlaceholderText('Search emoji') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Smileys').isConnected).toBe(true)
  })
})
