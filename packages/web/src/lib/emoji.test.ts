// The picker's whole value is that a curated list stays FINDABLE without a search library: the
// data is hand-written, so the invariants a library would guarantee (unique glyphs, every entry
// reachable by at least one word) are asserted here instead. The ranking test pins the one thing
// the UI depends on — Enter picks the first result, so the first result must be the obvious one.
import { describe, expect, test } from 'bun:test'
import { EMOJI, EMOJI_CATEGORIES, searchEmoji } from './emoji'

describe('emoji data', () => {
  test('is a curated list of ~200, flattened in category order', () => {
    expect(EMOJI.length).toBeGreaterThanOrEqual(200)
    expect(EMOJI).toEqual(EMOJI_CATEGORIES.flatMap((c) => c.emojis))
    expect(EMOJI_CATEGORIES.length).toBeGreaterThanOrEqual(6)
  })

  test('every entry is unique and searchable', () => {
    const glyphs = new Set(EMOJI.map((e) => e.emoji))
    expect(glyphs.size).toBe(EMOJI.length)
    // The picker keys cmdk items by name (cmdk lowercases values), so a repeat would silently
    // merge two glyphs into one selectable cell.
    const names = new Set(EMOJI.map((e) => e.name.toLowerCase()))
    expect(names.size).toBe(EMOJI.length)
    for (const e of EMOJI) {
      expect(e.emoji.length).toBeGreaterThan(0)
      expect(e.name.trim()).toBe(e.name)
      expect(e.name.length).toBeGreaterThan(0)
      expect(e.keywords.length).toBeGreaterThan(0)
    }
  })
})

describe('searchEmoji', () => {
  test('a blank query is the whole list (the picker shows its grid instead of filtering)', () => {
    expect(searchEmoji('')).toEqual(EMOJI)
    expect(searchEmoji('   ')).toEqual(EMOJI)
  })

  test('matches on the name, case-insensitively', () => {
    expect(searchEmoji('FIRE')[0].emoji).toBe('🔥')
    expect(searchEmoji('rocket')[0].emoji).toBe('🚀')
  })

  test('matches on keywords the name never mentions', () => {
    expect(searchEmoji('lol').map((e) => e.emoji)).toContain('😂')
    expect(searchEmoji('+1').map((e) => e.emoji)).toContain('👍')
    expect(searchEmoji('ship').map((e) => e.emoji)).toContain('🚀')
  })

  test('a name match outranks a keyword-only match', () => {
    // `star` is the NAME of ⭐ and only a keyword of 💫 (dizzy) — the star must come first, because
    // whatever lands first is what Enter picks.
    expect(searchEmoji('star')[0].emoji).toBe('⭐')
    expect(searchEmoji('star').map((e) => e.emoji)).toContain('💫')
  })

  test('no match is an empty list, not the whole list', () => {
    expect(searchEmoji('zzzzzzzz')).toEqual([])
  })
})
