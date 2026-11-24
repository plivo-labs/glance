import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { domToMarkdown, siteUrlRewriter } from './markdown'

const PAGE = 'https://content.example.com/_t/SECRET.TOKEN/docs/site/guide/page.html'

function md(html: string, title = '', opts: { exportUrls?: boolean } = {}): string {
  const win = new Window({ url: PAGE })
  win.document.body.innerHTML = html
  const rewrite = opts.exportUrls ? siteUrlRewriter(PAGE, 'https://app.example.com') : undefined
  return domToMarkdown(win.document.body as unknown as Element, title, rewrite)
}

describe('domToMarkdown', () => {
  test('headings, paragraphs and inline marks, with links made absolute', () => {
    expect(md('<h1>Plan</h1><p>It is <strong>right</strong>, <em>mostly</em>; see <a href="/a(1)">the doc</a> and <code>run()</code>.</p>')).toBe(
      '# Plan\n\nIt is **right**, *mostly*; see [the doc](https://content.example.com/a%281%29) and `run()`.\n',
    )
  })

  test('lists nest, ordered lists keep their start, quotes and rules and tables come through', () => {
    const out = md(
      '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul><ol start="3"><li>x</li></ol><blockquote><p>wise</p></blockquote><hr><table><tr><th>K</th><th>V</th></tr><tr><td>a|b</td><td>2</td></tr></table>',
    )
    expect(out).toContain('- a\n  - b\n- c')
    expect(out).toContain('3. x')
    expect(out).toContain('> wise')
    expect(out).toContain('---')
    expect(out).toContain('| K | V |\n| --- | --- |\n| a\\|b | 2 |')
  })

  test('code keeps its whitespace and language, and a fence never collides with backticks inside', () => {
    expect(md('<pre><code class="language-js">const a = 1\n  b()</code></pre>')).toBe('```js\nconst a = 1\n  b()\n```\n')
    expect(md('<pre>use ``` here</pre>')).toContain('````\nuse ``` here\n````')
  })

  test('scripts, styles, navigation, buttons, hidden nodes and inlined images are left out', () => {
    const out = md(
      '<nav>Menu</nav><script>x()</script><style>p{}</style><button>Copy</button><p hidden>secret</p><p>kept <img src="data:image/gif;base64,AA" alt="px"><img src="/pic.png" alt="a chart"></p>',
    )
    expect(out).toBe('kept ![a chart](https://content.example.com/pic.png)\n')
  })

  test('the page title heads the output unless the page already opens with a heading', () => {
    expect(md('<p>body</p>', 'My page')).toBe('# My page\n\nbody\n')
    expect(md('<h1>Own title</h1><p>body</p>', 'My page')).toBe('# Own title\n\nbody\n')
  })
})

describe('domToMarkdown — fidelity', () => {
  test('task-list boxes keep done and not done apart', () => {
    expect(md('<ul><li><input type="checkbox" checked> shipped</li><li><input type="checkbox"> next</li></ul>')).toBe('- [x] shipped\n- [ ] next\n')
  })

  test('a table keeps its caption, and a column-spanning cell does not shift the rest', () => {
    const out = md('<table><caption>Revenue</caption><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2">wide</td><td>x</td></tr></table>')
    expect(out).toContain('**Revenue**')
    expect(out).toContain('| A | B | C |\n| --- | --- | --- |\n| wide |  | x |')
  })
})

describe('export never carries the content token', () => {
  const html =
    '<p><a href="#verdict">jump</a> <a href="../other.html?glance_annotate=1#top">other</a> <a href="https://example.com/x">ext</a> <img src="img/a.png" alt="chart"> <a href="/_glance/theme/x.css">asset</a></p>'

  test('links into the site become viewer URLs, images the in-site path, and other content URLs are dropped', () => {
    const out = md(html, '', { exportUrls: true })
    expect(out).toContain('[jump](#verdict)')
    expect(out).toContain('[other](https://app.example.com/docs/site/other.html#top)')
    expect(out).toContain('[ext](https://example.com/x)')
    expect(out).toContain('![chart](guide/img/a.png)')
    expect(out).not.toContain('asset](')
    expect(out).not.toContain('SECRET.TOKEN')
    expect(out).not.toContain('glance_annotate')
  })

  test('without a rewriter the converter would leak it, which is what the rewriter exists to prevent', () => {
    expect(md(html)).toContain('SECRET.TOKEN')
  })
})

