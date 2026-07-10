import { describe, expect, test } from 'bun:test'
import { buildSharePayload } from './shares'

describe('buildSharePayload — ShareDialog selection → PUT body', () => {
  test('shareDialog.role.map: selecting Editor sends role editor (Map, not Set)', () => {
    const selUsers = new Map<string, 'viewer' | 'editor'>([
      ['a', 'editor'],
      ['b', 'viewer'],
    ])
    expect(buildSharePayload(selUsers, new Set(['g1']))).toEqual({
      users: [
        { id: 'a', role: 'editor' },
        { id: 'b', role: 'viewer' },
      ],
      groupIds: ['g1'],
    })
  })

  test('empty selection → empty payload', () => {
    expect(buildSharePayload(new Map(), new Set())).toEqual({ users: [], groupIds: [] })
  })
})
