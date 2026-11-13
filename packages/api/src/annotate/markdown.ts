// The visible page as Markdown, for the viewer's Download > Markdown. It walks the LIVE DOM (so
// script-rendered content is included) and writes what a reader sees: headings, paragraphs, lists,
// quotes, code, tables, links and images. Scripts, styles, navigation, forms and hidden nodes are
// left out. It is an export, not a round trip: a page that was authored as .md comes back as its
// rendered content, not byte for byte (`glance read --pull` gives the exact source).

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'HEAD', 'LINK', 'META', 'NAV', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'DIALOG'])
const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'UL'])

// A hard line break survives whitespace collapsing as this marker, and becomes "  \n" at the end.
const BREAK = '\u0001'

type Markdownable = Element & { checkVisibility?: () => boolean }

function skipped(el: Element): boolean {
  if (SKIP.has(el.tagName.toUpperCase())) return true
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || el.id.startsWith('glance-')) return true
  try {
    return (el as Markdownable).checkVisibility?.() === false
  } catch {
    return false
  }
}

const escapeText = (s: string): string => s.replace(/[\\`*[\]<]/g, '\\$&')
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Wraps `text` in a mark, keeping its edge whitespace outside so `** bold **` never happens. */
function wrap(mark: string, text: string): string {
  const inner = text.trim()
  if (!inner) return text
  const lead = text.slice(0, text.length - text.trimStart().length)
  const trail = text.slice(text.trimEnd().length)
  return `${lead}${mark}${inner}${mark}${trail}`
}

function inlineChildren(parent: Node): string {
  return Array.from(parent.childNodes, inline).join('')
}

function inline(node: Node): string {
  if (node.nodeType === 3) return escapeText(node.nodeValue ?? '')
  if (node.nodeType !== 1) return ''
  const el = node as Element
  if (skipped(el)) return ''
  switch (el.tagName.toUpperCase()) {
    case 'BR':
      return BREAK
    case 'A': {
      const text = inlineChildren(el)
      const href = (el as HTMLAnchorElement).href
      if (!href || /^javascript:/i.test(href) || !collapse(text)) return text
      return `[${collapse(text)}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`
    }
    case 'IMG': {
      const src = (el as HTMLImageElement).src
      return src && !src.startsWith('data:') ? `![${escapeText(el.getAttribute('alt') ?? '')}](${src})` : ''
    }
    case 'STRONG':
    case 'B':
      return wrap('**', inlineChildren(el))
    case 'EM':
    case 'I':
      return wrap('*', inlineChildren(el))
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrap('~~', inlineChildren(el))
    case 'CODE': {
      const code = el.textContent ?? ''
      const fence = '`'.repeat(Math.max(0, ...(code.match(/`+/g) ?? []).map((m) => m.length)) + 1)
      return code ? `${fence}${code}${fence}` : ''
    }
    default:
      // Inline-level wrappers (span, label, small…) just pass their content through.
      return inlineChildren(el)
  }
}

const indent = (text: string, pad: string): string => text.split('\n').map((l) => (l ? pad + l : l)).join('\n')

function listItems(list: Element, ordered: boolean): string {
  let n = Number((list as HTMLOListElement).getAttribute('start') ?? 1) || 1
  const items: string[] = []
  for (const li of Array.from(list.children)) {
    if (li.tagName.toUpperCase() !== 'LI' || skipped(li)) continue
    const marker = ordered ? `${n++}. ` : '- '
    const [first = '', ...rest] = blocks(li)
    items.push(marker + first + (rest.length ? `\n${rest.map((r) => indent(r, ' '.repeat(marker.length))).join('\n')}` : ''))
  }
  return items.join('\n')
}

function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr'), (tr) =>
    Array.from(tr.children, (cell) => collapse(inlineChildren(cell)).split(BREAK).join(' ').replace(/\|/g, '\\|')),
  ).filter((r) => r.length)
  const width = Math.max(0, ...rows.map((r) => r.length))
  if (!width) return ''
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  const [head = [], ...body] = rows
  return [line(head), line(Array(width).fill('---')), ...body.map(line)].join('\n')
}

function block(el: Element, tag: string): string[] {
  switch (tag) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const text = collapse(inlineChildren(el)).split(BREAK).join(' ')
      return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : []
    }
    case 'HR':
      return ['---']
    case 'UL':
    case 'OL': {
      const list = listItems(el, tag === 'OL')
      return list ? [list] : []
    }
    case 'BLOCKQUOTE': {
      const inner = blocks(el).join('\n\n')
      return inner ? [inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')] : []
    }
    case 'PRE': {
      const code = (el.textContent ?? '').replace(/\n+$/, '')
      if (!code.trim()) return []
      const lang = /language-([\w+#-]+)/.exec(el.querySelector('code')?.className ?? el.className)?.[1] ?? ''
      const fence = '`'.repeat(Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length)) + 1)
      return [`${fence}${lang}\n${code}\n${fence}`]
    }
    case 'TABLE': {
      const t = table(el)
      return t ? [t] : []
    }
    case 'DT':
    case 'SUMMARY': {
      const text = collapse(inlineChildren(el))
      return text ? [wrap('**', text)] : []
    }
    default:
      return blocks(el)
  }
}

/** The block-level pieces under `parent`; loose inline content between blocks becomes a paragraph. */
function blocks(parent: Node): string[] {
  const out: string[] = []
  let run = ''
  const flush = () => {
    const text = collapse(run).split(BREAK).join('  \n')
    if (text) out.push(text)
    run = ''
  }
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType !== 1) {
      run += inline(child)
      continue
    }
    const el = child as Element
    if (skipped(el)) continue
    const tag = el.tagName.toUpperCase()
    if (!BLOCK.has(tag)) {
      run += inline(el)
      continue
    }
    flush()
    out.push(...block(el, tag))
  }
  flush()
  return out
}

export function domToMarkdown(root: Element, title = ''): string {
  const body = blocks(root).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  const heading = title.trim()
  return `${body.startsWith('# ') || !heading ? body : `# ${heading}\n\n${body}`}\n`
}
