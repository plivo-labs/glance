import { describe, expect, test } from 'bun:test'
import { notificationLabel } from './notifications'

describe('W1 — notificationLabel: actor + verb for mention/comment', () => {
  test('mention → actor name and "mentioned you"', () => {
    expect(notificationLabel({ type: 'mention', actorName: 'Dev R' })).toEqual({
      actor: 'Dev R',
      verb: 'mentioned you',
    })
  })

  test('comment → actor name and "commented on"', () => {
    expect(notificationLabel({ type: 'comment', actorName: 'Priya N' })).toEqual({
      actor: 'Priya N',
      verb: 'commented on',
    })
  })

  test('null actorName → "Someone" for both types', () => {
    expect(notificationLabel({ type: 'mention', actorName: null }).actor).toBe('Someone')
    expect(notificationLabel({ type: 'comment', actorName: null }).actor).toBe('Someone')
  })
})
