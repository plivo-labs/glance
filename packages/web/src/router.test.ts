// Reserved-slug routes, asserted by RESOLUTION rather than by position in the config array.
//
// The obvious test here — "settings/keys comes before :space in the children array" — looks like
// it guards the hazard the whats-new comment describes, but it does not: React Router ranks
// branches by path specificity, not registration order, so moving these entries after `:space`
// changes nothing. A position assertion would therefore fail red on a harmless reorder while
// still passing if the route stopped resolving. matchRoutes asks the question that actually
// matters: given this path, which route wins?
//
// The real competitor is the top-level `/:space/:site/*` viewer, not the one-segment `:space` —
// delete either reserved route below and its path falls through to the viewer.
import { describe, expect, test } from 'bun:test'
import { matchRoutes } from 'react-router'
import { routeConfig } from './router'

const resolves = (path: string) => matchRoutes(routeConfig, path)?.at(-1)?.route.path

describe('router — reserved paths win over the space/site catch-alls', () => {
  test('/settings/keys resolves to the keys screen, not a space or site lookup', () => {
    expect(resolves('/settings/keys')).toBe('settings/keys')
  })

  test('/docs/api-keys resolves to the docs page, not a space or site lookup', () => {
    expect(resolves('/docs/api-keys')).toBe('docs/api-keys')
  })

  // Guards the inverse: the reserved entries must not have been written so broadly that they
  // swallow ordinary two-segment site URLs, which share their shape.
  test('an ordinary space/site path still reaches the viewer', () => {
    expect(resolves('/acme/deck')).toBe('/:space/:site/*')
  })
})
