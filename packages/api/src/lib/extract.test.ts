import { describe, expect, test } from 'bun:test'
import { extractText, pickEntry, resolveIndexPath, TEXT_CAP, type EntryFile } from './extract'

describe('pickEntry', () => {
  test('prefers the root index, returns a lone file, and rejects ambiguous sites', () => {
    const root = { path: 'index.html', mimeType: 'text/html' }
    const nested = { path: 'docs/index.html', mimeType: 'text/html' }
    expect(pickEntry([nested, root])).toBe(root)

    const audio = { path: 'recording.webm', mimeType: 'audio/webm' }
    expect(pickEntry([audio])).toBe(audio)

    expect(pickEntry([nested, { path: 'about.html', mimeType: 'text/html' }])).toBeNull()
  })

  test('matches resolveIndexPath for the same file lists', () => {
    const fixtures: EntryFile[][] = [
      [],
      [{ path: 'recording.webm', mimeType: 'audio/webm' }],
      [
        { path: 'docs/index.html', mimeType: 'text/html' },
        { path: 'index.html', mimeType: 'text/html' },
      ],
      [
        { path: 'about.html', mimeType: 'text/html' },
        { path: 'readme.md', mimeType: null },
      ],
      [{ path: 'docs/index.html', mimeType: 'text/html' }],
    ]

    for (const files of fixtures) {
      expect(pickEntry(files)?.path ?? '').toBe(resolveIndexPath(files.map((file) => file.path)))
    }
  })
})

describe('extractText', () => {
  test('extracts visible HTML text in order without leaking active content or attributes', async () => {
    const sentinel = 'END_OF_LONG_TEXT'
    const longText = `${'😀'.repeat(17_000)}${sentinel}`
    expect(new TextEncoder().encode(longText).byteLength).toBeGreaterThan(64 * 1024)
    const body = `<!doctype html><html><body>
      <a href="HREF_LEAK">AAA</a>
      <script>SCRIPT_LEAK</script>
      <style>STYLE_LEAK</style>
      <noscript>NOSCRIPT_LEAK</noscript>
      <img onerror="ONERROR_LEAK">
      <button onclick="ONCLICK_LEAK">BBB</button>
      <p>${longText}</p>
    </body></html>`

    const result = await extractText({ path: 'index.html', mimeType: 'text/html' }, body)
    if (!result.ok) throw new Error(result.reason)

    expect(result.text.indexOf('AAA')).toBeLessThan(result.text.indexOf('BBB'))
    for (const leak of ['HREF_LEAK', 'SCRIPT_LEAK', 'STYLE_LEAK', 'NOSCRIPT_LEAK', 'ONERROR_LEAK', 'ONCLICK_LEAK']) {
      expect(result.text).not.toContain(leak)
    }
    expect(result.text.split(sentinel)).toHaveLength(2)
  })

  test('caps markdown at the exact boundary without splitting surrogate pairs', async () => {
    const entry = { path: 'readme.md', mimeType: 'text/markdown' }

    const exact = await extractText(entry, 'a'.repeat(TEXT_CAP))
    if (!exact.ok) throw new Error(exact.reason)
    expect(exact.truncated).toBe(false)
    expect(exact.text).toHaveLength(TEXT_CAP)

    const over = await extractText(entry, 'a'.repeat(TEXT_CAP + 1))
    if (!over.ok) throw new Error(over.reason)
    expect(over.truncated).toBe(true)
    expect(over.text.length).toBeLessThanOrEqual(TEXT_CAP)

    const astral = await extractText(entry, `${'a'.repeat(TEXT_CAP - 1)}😀`)
    if (!astral.ok) throw new Error(astral.reason)
    expect(astral.truncated).toBe(true)
    expect(() => encodeURIComponent(astral.text)).not.toThrow()
    expect(astral.text).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  test('recognizes markdown by path with nullable MIME and keeps text/plain unsupported', async () => {
    const body = '# Heading\n\n  raw markdown  '
    for (const mimeType of ['text/markdown', null]) {
      const entry = { path: 'readme.md', mimeType }
      expect(pickEntry([entry])).toBe(entry)
      expect(await extractText(entry, body)).toEqual({ ok: true, text: body, truncated: false })
    }

    const plain = await extractText({ path: 'notes.txt', mimeType: 'text/plain' }, 'plain text')
    expect(plain.ok).toBe(false)
    if (plain.ok) throw new Error('expected unsupported text')
    expect(plain.reason).toStartWith('unsupported')
  })

  test('rejects unsupported code, data, audio, and image entries', async () => {
    const entries: EntryFile[] = [
      { path: 'app.js', mimeType: 'text/javascript' },
      { path: 'style.css', mimeType: 'text/css' },
      { path: 'data.json', mimeType: 'application/json' },
      { path: 'clip.webm', mimeType: 'audio/webm' },
      { path: 'pic.png', mimeType: 'image/png' },
    ]

    for (const entry of entries) {
      const result = await extractText(entry, 'content')
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`expected ${entry.path} to be unsupported`)
      expect(result.reason).toStartWith('unsupported')
    }
  })

  test('rejects HTML that strips to empty', async () => {
    const result = await extractText(
      { path: 'index.html', mimeType: 'text/html' },
      '<html><head><script>x()</script></head><body>   </body></html>',
    )
    expect(result).toEqual({ ok: false, reason: 'empty' })
  })
})
