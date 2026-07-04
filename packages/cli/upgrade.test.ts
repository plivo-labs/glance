import { describe, expect, test } from 'bun:test'
import {
  assetName,
  compareVersions,
  parseLatestTag,
  planAnnouncement,
  shouldCheck,
  type UpdateState,
} from './upgrade.ts'

describe('compareVersions', () => {
  test('compare-orders-numerically', () => {
    expect(compareVersions('0.5.0', '0.4.9')).toBeGreaterThan(0)
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareVersions('0.4', '0.4.1')).toBeLessThan(0) // missing parts count as 0
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0) // numeric, not lexicographic
  })

  test('compare-malformed-tag-never-newer', () => {
    // A non-CLI release tag (e.g. `ui-screens`) must never look like an upgrade target.
    expect(compareVersions('ui-screens', '0.0.0')).toBe(0)
    expect(compareVersions('ui-screens', '0.4.0')).toBeLessThan(0)
  })
})

describe('parseLatestTag', () => {
  test('parse-tag-from-release-url', () => {
    expect(parseLatestTag('https://github.com/plivo-labs/glance/releases/tag/v0.4.0')).toBe('v0.4.0')
    expect(parseLatestTag('http://127.0.0.1:8080/releases/tag/v9.9.9?x=1#top')).toBe('v9.9.9')
    expect(parseLatestTag('https://github.com/plivo-labs/glance/releases/tag/v0.4.0-rc%2B1')).toBe('v0.4.0-rc+1')
  })

  test('parse-no-tag-returns-null', () => {
    // No releases → /releases/latest does not redirect; the final URL has no /tag/ segment.
    expect(parseLatestTag('https://github.com/plivo-labs/glance/releases/latest')).toBeNull()
    expect(parseLatestTag('https://github.com/plivo-labs/glance/releases/tag/')).toBeNull()
  })
})

describe('assetName', () => {
  test('asset-matches-release-artifacts', () => {
    // Must match release.yml's artifact names exactly.
    expect(assetName('darwin', 'arm64')).toBe('glance-arm64-darwin')
    expect(assetName('linux', 'x64')).toBe('glance-x64-linux')
  })

  test('asset-unsupported-returns-null', () => {
    expect(assetName('win32', 'x64')).toBeNull()
    expect(assetName('linux', 'ia32')).toBeNull()
  })
})

describe('shouldCheck', () => {
  const DAY = 24 * 60 * 60 * 1000
  test('should-check-ttl-gate', () => {
    expect(shouldCheck({}, 1000)).toBe(true) // never checked
    expect(shouldCheck({ lastCheckedAt: 1000 }, 1000 + DAY - 1)).toBe(false) // within window
    expect(shouldCheck({ lastCheckedAt: 1000 }, 1000 + DAY + 1)).toBe(true) // window expired
  })
})

describe('planAnnouncement', () => {
  test('announce-after-swap-once', () => {
    const state: UpdateState = { lastCheckedAt: 1, updatedTo: '0.5.0' }
    const { message, next } = planAnnouncement(state, '0.5.0')
    expect(message).toContain('0.5.0')
    expect(next.updatedTo).toBeUndefined()
    expect(next.lastCheckedAt).toBe(1) // unrelated state survives
    // The cleared state announces nothing on the following run.
    expect(planAnnouncement(next, '0.5.0').message).toBeNull()
  })

  test('announce-stale-swap-clears-silently', () => {
    // A manual reinstall raced the background swap — never claim a version we're not running.
    const { message, next } = planAnnouncement({ updatedTo: '0.5.0' }, '0.6.0')
    expect(message).toBeNull()
    expect(next.updatedTo).toBeUndefined()
  })

  test('announce-available-nags-once-per-version', () => {
    const first = planAnnouncement({ available: '0.5.0' }, '0.4.0')
    expect(first.message).toContain('glance upgrade')
    expect(first.next.notifiedAvailable).toBe('0.5.0')
    // Same version again → silent; a NEWER available version → nags again.
    expect(planAnnouncement(first.next, '0.4.0').message).toBeNull()
    expect(planAnnouncement({ ...first.next, available: '0.6.0' }, '0.4.0').message).toContain('0.6.0')
  })

  test('announce-available-cleared-once-caught-up', () => {
    const { message, next } = planAnnouncement({ available: '0.5.0', notifiedAvailable: '0.5.0' }, '0.5.0')
    expect(message).toBeNull()
    expect(next.available).toBeUndefined()
    expect(next.notifiedAvailable).toBeUndefined()
  })

  test('announce-noop-returns-same-reference', () => {
    // Callers skip the state write when nothing changed — identity is the contract.
    const state: UpdateState = { lastCheckedAt: 1 }
    expect(planAnnouncement(state, '0.4.0').next).toBe(state)
  })
})
