import { describe, expect, test } from 'bun:test'
import { ApiError } from './api'
import { deriveFeedState, type FeedSlot, type FeedSlots } from './feedState'
import type { CommentFeedItem, SiteSummary, SpaceSummary, TeamUpload } from './types'

// deriveFeedState is the dashboard's per-feed render brain: these tests pin which tabs exist,
// per-tab content state, 401 signalling, ?new=space steering fire-once, and temporal stability.
// NOTE: a pure-helper suite cannot fail the original bug (the component gating all tabs on one
// Promise.all before ANY tab painted) — the G4 real-browser progressive-paint smoke is the net
// for that; these tests guard the derivation the component now renders from.

const site = (id: string): SiteSummary => ({
  id,
  spaceSlug: 'me',
  siteSlug: id,
  title: id,
  visibility: 'private',
  status: 'active',
  url: `https://glance.test/me/${id}`,
  createdAt: '2026-07-01T00:00:00.000Z',
})

const space = (id: string, type: SpaceSummary['type']): SpaceSummary => ({
  id,
  slug: id,
  name: id,
  type,
})

const upload = (id: string): TeamUpload => ({
  ...site(id),
  uploaderName: 'Sam',
  uploaderEmail: 'sam@example.com',
})

const comment = (id: string): CommentFeedItem => ({
  kind: 'mention',
  id,
  snippet: 'Take a look',
  actorName: 'Ada',
  spaceSlug: 'docs',
  siteSlug: 'guide',
  siteTitle: 'Guide',
  filePath: 'index.html',
  threadId: `thread-${id}`,
  threadStatus: 'open',
  createdAt: '2026-07-01T00:00:00.000Z',
  editedAt: null,
})

const pending = { status: 'pending' } as const
const resolved = <T>(data: T): FeedSlot<T> => ({ status: 'resolved', data })
const rejected = (error: unknown): FeedSlot<never> => ({ status: 'rejected', error })

const allPending = (): FeedSlots => ({
  sites: pending,
  shared: pending,
  spaces: pending,
  team: pending,
  comments: pending,
})

const onSites = { requestedTab: 'sites', wantsNewSpace: false } as const

// Every state a feed slot can be in — Comments' behavior must be invariant across all of them.
const commentSlotStates: FeedSlot<CommentFeedItem[]>[] = [
  pending,
  resolved([]),
  resolved([comment('c1')]),
  rejected(new Error('boom')),
]

describe('deriveFeedState', () => {
  // T10.1 — mine resolved, everything else still pending: Your sites is renderable with rows
  // immediately; Shared is ABSENT (not a skeleton tab) until its feed proves it has rows.
  test('T10.1 sites resolve first: Your sites has rows, Shared absent, rest loading', () => {
    const mine = [site('a'), site('b')]
    const state = deriveFeedState({ ...allPending(), sites: resolved(mine) }, onSites)

    expect(state.tabs).toEqual([
      { id: 'sites', label: 'Your sites', count: 2, content: { kind: 'rows', rows: mine } },
      { id: 'spaces', label: 'Your spaces', count: null, content: { kind: 'loading' } },
      { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
      { id: 'comments', label: 'Comments', count: null, content: { kind: 'loading' } },
    ])
    expect(state.activeTab).toBe('sites')
    expect(state.unauthorized).toBe(false)
    expect(state.steerTo).toBeNull()
  })

  // T10.2 — the Shared tab pops in only when its feed resolves with rows; an empty resolve keeps
  // the tab absent forever (user-decided behavior).
  test('T10.2 shared resolves with rows: tab pops in with its count', () => {
    const theirs = [site('x'), site('y'), site('z')]
    const state = deriveFeedState({ ...allPending(), shared: resolved(theirs) }, onSites)

    expect(state.tabs).toEqual([
      { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
      { id: 'shared', label: 'Shared with me', count: 3, content: { kind: 'rows', rows: theirs } },
      { id: 'spaces', label: 'Your spaces', count: null, content: { kind: 'loading' } },
      { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
      { id: 'comments', label: 'Comments', count: null, content: { kind: 'loading' } },
    ])
  })

  test('T10.2 shared resolves empty: tab stays absent', () => {
    const state = deriveFeedState({ ...allPending(), shared: resolved([]) }, onSites)
    expect(state.tabs.map((t) => t.id)).toEqual(['sites', 'spaces', 'team', 'comments'])
  })

  // T10.3 — one failed feed degrades only its own tab; the rest render from their own slots.
  test('T10.3 team rejects: contained error in the Team tab, other tabs intact', () => {
    const mine = [site('a')]
    const state = deriveFeedState(
      {
        sites: resolved(mine),
        shared: resolved([site('s')]),
        spaces: resolved([space('g', 'group')]),
        team: rejected(new ApiError(500, 'D1 exploded')),
        comments: pending,
      },
      onSites,
    )

    expect(state.tabs).toEqual([
      { id: 'sites', label: 'Your sites', count: 1, content: { kind: 'rows', rows: mine } },
      {
        id: 'shared',
        label: 'Shared with me',
        count: 1,
        content: { kind: 'rows', rows: [site('s')] },
      },
      {
        id: 'spaces',
        label: 'Your spaces',
        count: 1,
        content: { kind: 'rows', rows: [space('g', 'group')] },
      },
      { id: 'team', label: 'Team activity', count: null, content: { kind: 'error', message: 'D1 exploded' } },
      { id: 'comments', label: 'Comments', count: null, content: { kind: 'loading' } },
    ])
    expect(state.unauthorized).toBe(false)
  })

  test('T10.3 non-Error rejection gets the generic message', () => {
    const state = deriveFeedState({ ...allPending(), team: rejected('nope') }, onSites)
    expect(state.tabs.find((t) => t.id === 'team')?.content).toEqual({
      kind: 'error',
      message: 'Something went wrong. Try refreshing.',
    })
  })

  test('T10.3 a 401 from ANY feed raises the login-redirect signal; non-401 does not', () => {
    const lapsed = deriveFeedState({ ...allPending(), shared: rejected(new ApiError(401, 'Unauthorized')) }, onSites)
    expect(lapsed.unauthorized).toBe(true)
    // A non-401 shared failure means we cannot prove it has rows — the tab stays absent.
    const broken = deriveFeedState({ ...allPending(), shared: rejected(new ApiError(500, 'boom')) }, onSites)
    expect(broken.unauthorized).toBe(false)
    expect(broken.tabs.map((t) => t.id)).toEqual(['sites', 'spaces', 'team', 'comments'])
  })

  // T10.4 — ?new=space steers IMMEDIATELY (the Spaces tab always exists, so a slow/rejected feed
  // must not kill the deep link); consuming the signal (requestedTab becomes 'spaces') makes
  // every later derive return steerTo: null.
  test('T10.4 ?new=space steers immediately, fires exactly once', () => {
    const spaces = [space('personal', 'personal'), space('g1', 'group'), space('g2', 'group')]
    const wants = { requestedTab: 'sites', wantsNewSpace: true } as const

    // Pending spaces: steering fires anyway — the tab exists even before its feed settles.
    const before = deriveFeedState(allPending(), wants)
    expect(before.steerTo).toBe('spaces')

    // A rejected feed doesn't kill the deep link either.
    const broken = deriveFeedState({ ...allPending(), spaces: rejected(new Error('boom')) }, wants)
    expect(broken.steerTo).toBe('spaces')

    // Resolve → count counts only GROUP spaces; steering still on while the active tab is elsewhere.
    const fired = deriveFeedState({ ...allPending(), spaces: resolved(spaces) }, wants)
    expect(fired.tabs.find((t) => t.id === 'spaces')?.count).toBe(2)
    expect(fired.steerTo).toBe('spaces')

    // The component consumes the signal by requesting 'spaces'; re-derives (fresh slot
    // identities, same data, param still in the URL) must NOT re-fire.
    const after = deriveFeedState(
      { ...allPending(), spaces: resolved(spaces.map((s) => ({ ...s }))) },
      { requestedTab: 'spaces', wantsNewSpace: true },
    )
    expect(after.steerTo).toBeNull()
    expect(after.activeTab).toBe('spaces')
  })

  // T10.5 — TEMPORAL: revalidation hands the component brand-new promise/slot/object identities
  // carrying the same data; the derived model must be identical (same tab ids, order, counts,
  // active tab) so nothing churns or steals focus.
  test('T10.5 re-derive with new slot identities + same data: identical model, stable active tab', () => {
    const build = (): FeedSlots => ({
      sites: resolved([site('a'), site('b')]),
      shared: resolved([site('x')]),
      spaces: resolved([space('g', 'group')]),
      team: resolved([upload('t')]),
      comments: pending,
    })
    const view = { requestedTab: 'team', wantsNewSpace: false } as const

    const first = deriveFeedState(build(), view)
    const second = deriveFeedState(build(), view)

    expect(second).toEqual(first)
    expect(second.tabs.map((t) => t.id)).toEqual(['sites', 'shared', 'spaces', 'team', 'comments'])
    expect(second.activeTab).toBe('team')
  })

  test('T10.5 shared pop-in while user sits on Team does not steal the active tab', () => {
    const view = { requestedTab: 'team', wantsNewSpace: false } as const
    const before = deriveFeedState(allPending(), view)
    expect(before.activeTab).toBe('team')
    expect(before.tabs.map((t) => t.id)).toEqual(['sites', 'spaces', 'team', 'comments'])

    const after = deriveFeedState({ ...allPending(), shared: resolved([site('x')]) }, view)
    expect(after.tabs.map((t) => t.id)).toEqual(['sites', 'shared', 'spaces', 'team', 'comments'])
    expect(after.activeTab).toBe('team')
    expect(after.steerTo).toBeNull()
  })

  test('T10.5 active Shared tab disappearing (feed emptied) falls back to Your sites', () => {
    const view = { requestedTab: 'shared', wantsNewSpace: false } as const
    const withShared = deriveFeedState({ ...allPending(), shared: resolved([site('x')]) }, view)
    expect(withShared.activeTab).toBe('shared')

    const emptied = deriveFeedState({ ...allPending(), shared: resolved([]) }, view)
    expect(emptied.activeTab).toBe('sites')
  })

  test('C5.1 comments tab is always present across every slot state', () => {
    for (const comments of commentSlotStates) {
      const state = deriveFeedState({ ...allPending(), comments }, onSites)
      expect(state.tabs.map((tab) => tab.id)).toEqual(['sites', 'spaces', 'team', 'comments'])
    }
  })

  test('C5.1 comments count stays null even with rows', () => {
    const state = deriveFeedState({ ...allPending(), comments: resolved([comment('c1')]) }, onSites)
    expect(state.tabs.find((tab) => tab.id === 'comments')?.count).toBeNull()
  })

  test('C5.1 a 401 from only the comments slot raises the login-redirect signal', () => {
    const state = deriveFeedState(
      { ...allPending(), comments: rejected(new ApiError(401, 'Unauthorized')) },
      onSites,
    )
    expect(state.unauthorized).toBe(true)
  })

  test('C5.1 requested Comments stays active across every slot state', () => {
    for (const comments of commentSlotStates) {
      const state = deriveFeedState(
        { ...allPending(), comments },
        { requestedTab: 'comments', wantsNewSpace: false },
      )
      expect(state.activeTab).toBe('comments')
    }
  })

  test('C5.1 tab order keeps Comments last with and without Shared', () => {
    const withShared = deriveFeedState(
      { ...allPending(), shared: resolved([site('shared')]) },
      onSites,
    )
    expect(withShared.tabs.map((tab) => tab.id)).toEqual([
      'sites',
      'shared',
      'spaces',
      'team',
      'comments',
    ])

    const withoutShared = deriveFeedState({ ...allPending(), shared: resolved([]) }, onSites)
    expect(withoutShared.tabs.map((tab) => tab.id)).toEqual(['sites', 'spaces', 'team', 'comments'])
  })

  test('C5.2 five-wide derivation preserves representative four-feed goldens', () => {
    const cases = [
      {
        slots: allPending(),
        view: onSites,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            { id: 'spaces', label: 'Your spaces', count: null, content: { kind: 'loading' } },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'sites',
          unauthorized: false,
          steerTo: null,
        },
      },
      {
        slots: { ...allPending(), shared: resolved([site('shared')]) },
        view: { requestedTab: 'team', wantsNewSpace: false } as const,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            {
              id: 'shared',
              label: 'Shared with me',
              count: 1,
              content: { kind: 'rows', rows: [site('shared')] },
            },
            { id: 'spaces', label: 'Your spaces', count: null, content: { kind: 'loading' } },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'team',
          unauthorized: false,
          steerTo: null,
        },
      },
      {
        slots: { ...allPending(), shared: resolved([]) },
        view: { requestedTab: 'shared', wantsNewSpace: false } as const,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            { id: 'spaces', label: 'Your spaces', count: null, content: { kind: 'loading' } },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'sites',
          unauthorized: false,
          steerTo: null,
        },
      },
      {
        slots: { ...allPending(), spaces: resolved([space('personal', 'personal')]) },
        view: { requestedTab: 'sites', wantsNewSpace: true } as const,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            { id: 'spaces', label: 'Your spaces', count: 0, content: { kind: 'rows', rows: [] } },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'sites',
          unauthorized: false,
          steerTo: 'spaces',
        },
      },
    ]

    for (const { slots, view, expected } of cases) {
      const state = deriveFeedState(slots, view)
      expect(state.tabs.at(-1)?.id).toBe('comments')
      expect({ ...state, tabs: state.tabs.filter((tab) => tab.id !== 'comments') }).toEqual(expected)
    }
  })
})
