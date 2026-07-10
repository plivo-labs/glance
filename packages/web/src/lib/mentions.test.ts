import { describe, expect, test } from 'bun:test'
import { type MentionUser, insertMention, mentionQuery, notificationHref } from './mentions'

const ada: MentionUser = { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com' }
const noName: MentionUser = { id: 'u-x', name: null, email: 'x@example.com' }

describe('C17 — mentionQuery: active @token or null', () => {
  test('@ at start of text → query from the caret', () => {
    expect(mentionQuery('@ad', 3)).toEqual({ query: 'ad', start: 0 })
  })

  test('@ after a space triggers; query is the typed fragment up to the caret', () => {
    expect(mentionQuery('hey @ad', 7)).toEqual({ query: 'ad', start: 4 })
  })

  test('bare @ (nothing typed yet) → empty query', () => {
    expect(mentionQuery('hey @', 5)).toEqual({ query: '', start: 4 })
  })

  test('@ glued to a word (email-like) does NOT trigger', () => {
    expect(mentionQuery('mail me at ada@example.com', 26)).toBeNull()
  })

  test('whitespace between the caret and the nearest @ → no active token', () => {
    expect(mentionQuery('@ada done', 9)).toBeNull()
  })

  test('caret mid-string picks the token it is inside, not text after it', () => {
    // "hey @ad|a more" — caret after "@ad"
    expect(mentionQuery('hey @ada more', 7)).toEqual({ query: 'ad', start: 4 })
  })

  test('no @ at all → null', () => {
    expect(mentionQuery('plain text', 10)).toBeNull()
  })
})

describe('C18 — insertMention: replace token with @Label, caret after', () => {
  test('replaces the active token with @Name and a trailing space', () => {
    const r = insertMention('hey @ad', 7, ada)
    expect(r.text).toBe('hey @Ada Lovelace ')
    expect(r.caret).toBe(r.text.length)
  })

  test('preserves text after the caret', () => {
    const r = insertMention('hey @ad more', 7, ada)
    expect(r.text).toBe('hey @Ada Lovelace  more')
    // caret sits right after the inserted "@Ada Lovelace "
    expect(r.text.slice(0, r.caret)).toBe('hey @Ada Lovelace ')
  })

  test('falls back to email when the user has no name', () => {
    expect(insertMention('@', 1, noName).text).toBe('@x@example.com ')
  })

  test('no active token → unchanged', () => {
    expect(insertMention('plain', 5, ada)).toEqual({ text: 'plain', caret: 5 })
  })
})

describe('C21 — notificationHref: deep-link into the viewer review rail', () => {
  test('space/site + file + thread', () => {
    expect(notificationHref({ siteLabel: 'acme/doc', filePath: 'index.html', threadId: 't1' })).toBe(
      '/acme/doc/index.html?thread=t1&review=1',
    )
  })

  test('missing file → site root with review flag', () => {
    expect(notificationHref({ siteLabel: 'acme/doc', filePath: null, threadId: 't1' })).toBe('/acme/doc?thread=t1&review=1')
  })

  test('strips a leading slash on the file path', () => {
    expect(notificationHref({ siteLabel: 'acme/doc', filePath: '/nested/p.html', threadId: null })).toBe(
      '/acme/doc/nested/p.html?review=1',
    )
  })

  test('no site label → home', () => {
    expect(notificationHref({ siteLabel: null, filePath: null, threadId: null })).toBe('/')
  })
})
