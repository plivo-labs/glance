import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DownloadDialog } from './DownloadDialog'

function setup(onDownload: (o: unknown) => Promise<void> = async () => {}) {
  const onOpenChange = mock((_open: boolean) => {})
  const onPrint = mock(() => {})
  const download = mock(onDownload)
  render(<DownloadDialog open onOpenChange={onOpenChange} onDownload={download as never} onPrint={onPrint} shortcut="⌘⇧S" />)
  const pick = (name: string) => fireEvent.click(screen.getByTestId(`download-dialog-${name}-select`))
  const submit = () => fireEvent.click(screen.getByTestId('download-dialog-submit-btn'))
  return { onOpenChange, onPrint, download, pick, submit }
}

beforeEach(() => localStorage.clear())

describe('DownloadDialog', () => {
  test('defaults to an info-size PDF as designed, and Download sends exactly that, then closes', async () => {
    const { download, onOpenChange, submit } = setup()
    submit()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(download).toHaveBeenCalledWith({ format: 'pdf', size: 'info', look: 'theme', paper: 'a4' })
  })

  test('the choices are sent as picked and remembered for the next open', async () => {
    const first = setup()
    first.pick('size-full')
    first.pick('look-simple')
    first.submit()
    await waitFor(() => expect(first.download).toHaveBeenCalledWith({ format: 'pdf', size: 'full', look: 'simple', paper: 'a4' }))
    expect(JSON.parse(localStorage.getItem('glance:download') ?? '{}')).toMatchObject({ size: 'full', look: 'simple' })
  })

  test('paper only matters for info size, and plain text drops every PDF option', () => {
    const { pick } = setup()
    expect(screen.queryByTestId('download-dialog-paper-letter-select')).not.toBeNull()
    pick('size-full')
    expect(screen.queryByTestId('download-dialog-paper-letter-select')).toBeNull()
    pick('format-text')
    expect(screen.queryByTestId('download-dialog-size-info-select')).toBeNull()
    expect(screen.queryByTestId('download-dialog-print-btn')).toBeNull()
    expect(screen.getByTestId('download-dialog-submit-btn').textContent).toContain('.txt')
  })

  test('a failed download keeps the dialog open; "Use browser print" closes it and prints', async () => {
    const failing = setup(async () => {
      throw new Error('boom')
    })
    failing.submit()
    await waitFor(() => expect(failing.download).toHaveBeenCalled())
    expect(failing.onOpenChange).not.toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByTestId('download-dialog-print-btn'))
    expect(failing.onPrint).toHaveBeenCalledTimes(1)
    expect(failing.onOpenChange).toHaveBeenCalledWith(false)
  })
})
