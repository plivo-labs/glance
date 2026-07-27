import { describe, expect, test } from 'bun:test'
import { extractHtmlMeta, extractText, isSupportedEntry, pickEntry, resolveIndexPath, TEXT_CAP, type EntryFile } from './extract'

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

describe('isSupportedEntry', () => {
  test('supports HTML and Markdown paths with nullable MIME types', () => {
    for (const path of ['index.html', 'page.htm', 'readme.md', 'notes.markdown']) {
      expect(isSupportedEntry({ path, mimeType: null }), path).toBe(true)
    }
  })

  test('rejects code, styles, media, images, and plain text', () => {
    for (const entry of [
      { path: 'app.js', mimeType: 'text/javascript' },
      { path: 'style.css', mimeType: 'text/css' },
      { path: 'clip.webm', mimeType: 'audio/webm' },
      { path: 'pic.png', mimeType: 'image/png' },
      { path: 'notes.txt', mimeType: 'text/plain' },
    ]) {
      expect(isSupportedEntry(entry), entry.path).toBe(false)
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

  test('strips hidden, aria-hidden, and template content so it cannot crowd visible text out of the cap', async () => {
    // A hidden flood longer than TEXT_CAP: if it leaked into extraction, the cap would discard
    // the real visible content and the summary would be generated from invisible text only.
    const hiddenFlood = 'HIDDEN_FLOOD '.repeat(4_000)
    expect(hiddenFlood.length).toBeGreaterThan(TEXT_CAP)
    const body = `<!doctype html><html><body>
      <div hidden>${hiddenFlood}</div>
      <span aria-hidden="true">ARIA_LEAK</span>
      <template>TEMPLATE_LEAK</template>
      <p>Visible signal survives</p>
    </body></html>`

    const result = await extractText({ path: 'index.html', mimeType: 'text/html' }, body)
    if (!result.ok) throw new Error(result.reason)

    for (const leak of ['HIDDEN_FLOOD', 'ARIA_LEAK', 'TEMPLATE_LEAK']) {
      expect(result.text).not.toContain(leak)
    }
    expect(result.text).toContain('Visible signal survives')
    expect(result.truncated).toBeFalse()
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

// The title half of the one-pass extractor — every title case below predates the description
// field and reads better without the `.title` noise at each call site.
const titleOf = async (entry: EntryFile, body: Blob | string) => (await extractHtmlMeta(entry, body)).title

describe('extractHtmlMeta — title', () => {
  const entry = { path: 'index.html', mimeType: 'text/html' }

  test('returns the document title, whitespace-collapsed and trimmed', async () => {
    const body = '<html><head><title>  CX Team —\n  What They\'re Managing </title></head><body>x</body></html>'
    expect(await titleOf(entry, body)).toBe("CX Team — What They're Managing")
  })

  test('only the first <title> counts — a later inline svg title is ignored', async () => {
    const body = '<html><head><title>Real</title></head><body><svg><title>icon label</title></svg></body></html>'
    expect(await titleOf(entry, body)).toBe('Real')
  })

  test('missing or empty title → null; non-HTML entry → null', async () => {
    expect(await titleOf(entry, '<html><body>no title</body></html>')).toBeNull()
    expect(await titleOf(entry, '<title>   </title>')).toBeNull()
    expect(await titleOf({ path: 'readme.md', mimeType: null }, '# Title')).toBeNull()
    expect(await titleOf({ path: 'clip.webm', mimeType: 'audio/webm' }, 'x')).toBeNull()
  })

  test('caps at 200 chars', async () => {
    const long = 'a'.repeat(300)
    expect(await titleOf(entry, `<title>${long}</title>`)).toBe('a'.repeat(200))
  })
})

describe('extractHtmlMeta — description', () => {
  const entry = { path: 'index.html', mimeType: 'text/html' }
  const descOf = async (body: string) => (await extractHtmlMeta(entry, body)).description

  test('reads <meta name="description">, whitespace-collapsed and entity-decoded', async () => {
    expect(await descOf('<meta name="description" content="Q3  revenue &amp;\n churn">')).toBe('Q3 revenue & churn')
  })

  test('og:description wins over name=description, even when it comes second', async () => {
    const body = '<meta name="description" content="seo blurb"><meta property="og:description" content="share blurb">'
    expect(await descOf(body)).toBe('share blurb')
  })

  test('first of each kind wins; the name match is case-insensitive', async () => {
    expect(await descOf('<meta name="Description" content="first"><meta name="description" content="second">')).toBe(
      'first',
    )
  })

  test('absent, empty, or non-HTML → null', async () => {
    expect(await descOf('<html><head><title>t</title></head></html>')).toBeNull()
    expect(await descOf('<meta name="description" content="   ">')).toBeNull()
    expect(await descOf('<meta name="description">')).toBeNull()
    expect((await extractHtmlMeta({ path: 'readme.md', mimeType: null }, '<meta name="description" content="x">')).description).toBeNull()
  })

  test('caps at 300 chars without leaving an unpaired surrogate', async () => {
    expect(await descOf(`<meta name="description" content="${'a'.repeat(400)}">`)).toBe('a'.repeat(300))
    const emoji = await descOf(`<meta name="description" content="${'a'.repeat(299)}😀">`)
    expect(emoji).toBe('a'.repeat(299))
    expect(emoji).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  test('title and description come from ONE pass over the same body', async () => {
    const body = '<title>Report</title><meta name="description" content="How the numbers moved">'
    expect(await extractHtmlMeta(entry, body)).toEqual({ title: 'Report', description: 'How the numbers moved' })
  })
})

describe('extractHtmlMeta — svg exclusion, implied head, entities, streaming', () => {
  const entry = { path: 'index.html', mimeType: 'text/html' }

  test('an svg title BEFORE the document title never wins; an svg-only doc yields null', async () => {
    const before = '<svg><title>icon label</title></svg><title>Real</title>'
    expect(await titleOf(entry, before)).toBe('Real')
    const svgOnly = '<html><body><svg><title>Download icon</title></svg></body></html>'
    expect(await titleOf(entry, svgOnly)).toBeNull()
    const tpl = '<template><title>inert</title></template><title>Live</title>'
    expect(await titleOf(entry, tpl)).toBe('Live')
  })

  test('implied-head fragments (no literal <head>) still resolve their title', async () => {
    const fragment = '<!doctype html><meta charset="utf-8"><title>Implied Head</title><style>x{}</style><h1>hi</h1>'
    expect(await titleOf(entry, fragment)).toBe('Implied Head')
  })

  test('decodes numeric and common named entities', async () => {
    const body = '<title>Mentions &amp; Notifications &#8212; A&nbsp;B &#x2192; C &unknown; &#1114112;</title>'
    expect(await titleOf(entry, body)).toBe('Mentions & Notifications — A B → C &unknown; &#1114112;')
  })

  test('cap never leaves an unpaired surrogate', async () => {
    const title = await titleOf(entry, `<title>${'a'.repeat(199)}😀</title>`)
    expect(title).toBe('a'.repeat(199))
    expect(title).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  test('accepts a Blob body (the upload path streams the File, never buffering it)', async () => {
    expect(await titleOf(entry, new Blob(['<title>From Blob</title>']))).toBe('From Blob')
  })
})
