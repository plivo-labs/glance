import { describe, expect, test } from 'bun:test'
import type { SessionUser } from '../types'
import { checkAccess } from './access'
import { isValidSlug, slugifyHandle } from './slug'
import { signToken, verifyToken } from './token'

const owner: SessionUser = { id: 'u1', email: 'a@example.com', name: null, role: 'member' }
const other: SessionUser = { id: 'u2', email: 'b@example.com', name: null, role: 'member' }
const admin: SessionUser = { id: 'u3', email: 'c@example.com', name: null, role: 'superadmin' }
const site = (visibility: 'private' | 'group' | 'team' | 'public', status: 'active' | 'archived' = 'active') =>
  ({ visibility, status, ownerId: 'u1' }) as const

describe('checkAccess', () => {
  test('public: anyone, even anonymous', () => {
    expect(checkAccess(site('public'), null, false).ok).toBe(true)
  })
  test('team: any authed user, anon → 401', () => {
    expect(checkAccess(site('team'), other, false).ok).toBe(true)
    const r = checkAccess(site('team'), null, false)
    expect(r).toEqual({ ok: false, status: 401 })
  })
  test('private: owner ok, other → 403, anon → 401', () => {
    expect(checkAccess(site('private'), owner, false).ok).toBe(true)
    expect(checkAccess(site('private'), other, false)).toEqual({ ok: false, status: 403 })
    expect(checkAccess(site('private'), null, false)).toEqual({ ok: false, status: 401 })
  })
  test('group: member ok, non-member → 403', () => {
    expect(checkAccess(site('group'), other, true).ok).toBe(true)
    expect(checkAccess(site('group'), other, false)).toEqual({ ok: false, status: 403 })
  })
  test('archived: 410 for all except superadmin', () => {
    expect(checkAccess(site('public', 'archived'), owner, false)).toEqual({ ok: false, status: 410 })
    expect(checkAccess(site('private', 'archived'), admin, false).ok).toBe(true)
  })
  test('superadmin bypasses private + archive', () => {
    expect(checkAccess(site('private'), admin, false).ok).toBe(true)
  })
  test('explicit share grants access on any tier', () => {
    expect(checkAccess(site('private'), other, false, true).ok).toBe(true)
    expect(checkAccess(site('group'), other, false, true).ok).toBe(true)
  })
  test('explicit share is still blocked when archived (non-admin)', () => {
    expect(checkAccess(site('private', 'archived'), other, false, true)).toEqual({ ok: false, status: 410 })
  })
})

describe('isValidSlug', () => {
  test('accepts lowercase alphanumeric + hyphen, 3–40 chars', () => {
    expect(isValidSlug('abc')).toBe(true)
    expect(isValidSlug('my-runbook')).toBe(true)
    expect(isValidSlug('a1-b2-c3')).toBe(true)
  })
  test('rejects bad slugs', () => {
    expect(isValidSlug('ab')).toBe(false) // too short
    expect(isValidSlug('Abc')).toBe(false) // uppercase
    expect(isValidSlug('-lead')).toBe(false) // leading hyphen
    expect(isValidSlug('trail-')).toBe(false) // trailing hyphen
    expect(isValidSlug('a'.repeat(41))).toBe(false) // too long
    expect(isValidSlug('has space')).toBe(false)
  })
  test('rejects reserved slugs', () => {
    expect(isValidSlug('admin')).toBe(false)
    expect(isValidSlug('api')).toBe(false)
    expect(isValidSlug('content')).toBe(false)
  })
})

describe('slugifyHandle', () => {
  test('sanitizes email handles', () => {
    expect(slugifyHandle('jane.doe@example.com')).toBe('jane-doe')
    expect(slugifyHandle('jo@example.com')).toBe('jo-glance') // padded to >= 3
  })
})

describe('signToken / verifyToken', () => {
  const secret = 'test-secret'
  const uid = 'u1'
  test('valid round-trip returns the bound userId', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken(secret, 'sam/site', t)).toBe(uid)
  })
  test('wrong scope → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken(secret, 'sam/other', t)).toBeNull()
  })
  test('tampered mac → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken(secret, 'sam/site', `${t.slice(0, -2)}xx`)).toBeNull()
  })
  test('expired → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', -1)
    expect(await verifyToken(secret, 'sam/site', t)).toBeNull()
  })
  test('wrong secret → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken('other-secret', 'sam/site', t)).toBeNull()
  })
  test('missing token → null', async () => {
    expect(await verifyToken(secret, 'sam/site', null)).toBeNull()
  })
})
