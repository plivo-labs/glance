import { describe, expect, mock, test } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { useDownloadShortcut } from './useDownloadShortcut'

const ORIGIN = 'https://content.example.com'
const frameWin = {} as Window

function setup(enabled = true) {
  const onOpen = mock(() => {})
  renderHook(() => useDownloadShortcut(enabled, onOpen, () => frameWin, ORIGIN))
  return onOpen
}
const fromFrame = (origin: string, source: unknown, name = 'download') =>
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'glance:shortcut', name }, origin, source: source as MessageEventSource }))

describe('useDownloadShortcut', () => {
  test('Cmd+Shift+S in the app opens the dialog and is swallowed; a lone Cmd+S is not ours', () => {
    const onOpen = setup()
    const ev = new KeyboardEvent('keydown', { key: 'S', metaKey: true, shiftKey: true, cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('only OUR frame, from its own origin, can ask for it; disabled hears nothing', () => {
    const onOpen = setup()
    fromFrame('https://evil.example.com', frameWin)
    fromFrame(ORIGIN, {})
    fromFrame(ORIGIN, frameWin, 'other')
    expect(onOpen).not.toHaveBeenCalled()
    fromFrame(ORIGIN, frameWin)
    expect(onOpen).toHaveBeenCalledTimes(1)
    const off = setup(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true }))
    expect(off).not.toHaveBeenCalled()
  })
})
