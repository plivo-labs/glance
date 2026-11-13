import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { domToMarkdown } from './markdown'

function md(html: string, title = ''): string {
  const win = new Window({ url: 'https://content.example.com/_t/tok/docs/site/' })
  win.document.body.innerHTML = html
  return domToMarkdown(win.document.body as unknown as Element, title)
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
