import { describe, expect, test } from 'bun:test'
import { isVisibility, normalizeVisibility } from './visibility'

describe('normalizeVisibility', () => {
  test('maps the legacy `group` tier onto `members`', () => {
    expect(normalizeVisibility('group')).toBe('members')
  })
  test('passes every other value through untouched', () => {
    for (const v of ['private', 'members', 'team', 'public', 'bogus', undefined, null, 5]) {
      expect(normalizeVisibility(v)).toBe(v)
    }
  })
})

describe('isVisibility', () => {
  test('accepts the four current tiers', () => {
    for (const v of ['private', 'members', 'team', 'public']) expect(isVisibility(v)).toBe(true)
  })
  test('rejects the legacy `group` (must be normalized first) and junk', () => {
    expect(isVisibility('group')).toBe(false)
    expect(isVisibility('')).toBe(false)
    expect(isVisibility(undefined)).toBe(false)
  })
})
