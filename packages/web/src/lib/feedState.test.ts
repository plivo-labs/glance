import { describe, expect, test } from 'bun:test'
import { ApiError } from './api'
import { deriveFeedState, feedRowPath, tabFromParam, type FeedSlot, type FeedSlots } from './feedState'
import { notificationHref } from './mentions'
import type { CommentFeedItem, SiteSummary, SpaceSummary, TeamUpload } from './types'

// deriveFeedState is the dashboard's per-feed render brain: these tests pin which tabs exist,
// per-tab content state, 401 signalling, the ?tab= URL parse, and temporal stability.
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

const onSites = { requestedTab: 'sites' } as const

// Every state a feed slot can be in — Comments' behavior must be invariant across all of them.
const commentSlotStates: FeedSlot<CommentFeedItem[]>[] = [
  pending,
  resolved([]),
  resolved([comment('c1')]),
  rejected(new Error('boom')),
]

describe('deriveFeedState', () => {
  // T10.1 — mine resolved, everything else still pending: Your sites is renderable with rows
  // immediately; Shared and Spaces are ABSENT (not skeleton tabs) until their feeds prove rows.
  test('T10.1 sites resolve first: Your sites has rows, Shared/Spaces absent, rest loading', () => {
    const mine = [site('a'), site('b')]
    const state = deriveFeedState({ ...allPending(), sites: resolved(mine) }, onSites)

    expect(state.tabs).toEqual([
      { id: 'sites', label: 'Your sites', count: 2, content: { kind: 'rows', rows: mine } },
      { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
      { id: 'comments', label: 'Comments', count: null, content: { kind: 'loading' } },
    ])
    expect(state.activeTab).toBe('sites')
    expect(state.unauthorized).toBe(false)
  })

  // T10.2 — the Shared tab pops in only when its feed resolves with rows; an empty resolve keeps
  // the tab absent forever (user-decided behavior).
  test('T10.2 shared resolves with rows: tab pops in with its count', () => {
    const theirs = [site('x'), site('y'), site('z')]
    const state = deriveFeedState({ ...allPending(), shared: resolved(theirs) }, onSites)

    expect(state.tabs).toEqual([
      { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
      { id: 'shared', label: 'Shared with me', count: 3, content: { kind: 'rows', rows: theirs } },
      { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
      { id: 'comments', label: 'Comments', count: null, content: { kind: 'loading' } },
    ])
  })

  test('T10.2 shared resolves empty: tab stays absent', () => {
    const state = deriveFeedState({ ...allPending(), shared: resolved([]) }, onSites)
    expect(state.tabs.map((t) => t.id)).toEqual(['sites', 'team', 'comments'])
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
    expect(broken.tabs.map((t) => t.id)).toEqual(['sites', 'team', 'comments'])
  })

  // T10.4 — the Spaces tab mirrors Shared: it exists only once its feed resolves with at least
  // one GROUP space. The personal space never earns the tab; a pending or failed feed keeps it
  // absent (the toolbar, rendering off the same slot, surfaces a spaces-feed failure).
  test('T10.4 spaces tab exists only when the feed resolves with group spaces', () => {
    const absent = (slot: FeedSlot<SpaceSummary[]>) =>
      deriveFeedState({ ...allPending(), spaces: slot }, onSites).tabs.map((t) => t.id)

    expect(absent(pending)).toEqual(['sites', 'team', 'comments'])
    expect(absent(rejected(new Error('boom')))).toEqual(['sites', 'team', 'comments'])
    expect(absent(resolved([]))).toEqual(['sites', 'team', 'comments'])
    expect(absent(resolved([space('personal', 'personal')]))).toEqual(['sites', 'team', 'comments'])

    // Group spaces present → tab pops in, counting and listing ONLY the group spaces.
    const groups = [space('g1', 'group'), space('g2', 'group')]
    const state = deriveFeedState(
      { ...allPending(), spaces: resolved([space('personal', 'personal'), ...groups]) },
      onSites,
    )
    expect(state.tabs.find((t) => t.id === 'spaces')).toEqual({
      id: 'spaces',
      label: 'Your spaces',
      count: 2,
      content: { kind: 'rows', rows: groups },
    })
  })

  test('T10.4 requested Spaces without a spaces tab falls back to Your sites', () => {
    const view = { requestedTab: 'spaces' } as const
    expect(deriveFeedState(allPending(), view).activeTab).toBe('sites')
    // The URL keeps ?tab=spaces, so once the feed proves group spaces the tab activates.
    const landed = deriveFeedState({ ...allPending(), spaces: resolved([space('g', 'group')]) }, view)
    expect(landed.activeTab).toBe('spaces')
  })

  // T10.6 — staleTab: a ?tab= pointing at an absent conditional tab is a legitimate deep link
  // while the feed is pending, and STALE (component clears the param) only once the feed RESOLVES
  // without producing the tab. A rejection (transient error or the 401 heading to login) proves
  // nothing about absence — the deep link must survive it.
  test('T10.6 staleTab fires only after the governing feed resolves without the tab', () => {
    const wantSpaces = { requestedTab: 'spaces' } as const
    expect(deriveFeedState(allPending(), wantSpaces).staleTab).toBe(false)
    expect(deriveFeedState({ ...allPending(), spaces: resolved([]) }, wantSpaces).staleTab).toBe(true)
    expect(
      deriveFeedState({ ...allPending(), spaces: resolved([space('p', 'personal')]) }, wantSpaces).staleTab,
    ).toBe(true)
    expect(deriveFeedState({ ...allPending(), spaces: rejected(new Error('boom')) }, wantSpaces).staleTab).toBe(false)
    expect(
      deriveFeedState({ ...allPending(), spaces: rejected(new ApiError(401, 'Unauthorized')) }, wantSpaces).staleTab,
    ).toBe(false)
    expect(
      deriveFeedState({ ...allPending(), spaces: resolved([space('g', 'group')]) }, wantSpaces).staleTab,
    ).toBe(false)

    const wantShared = { requestedTab: 'shared' } as const
    expect(deriveFeedState(allPending(), wantShared).staleTab).toBe(false)
    expect(deriveFeedState({ ...allPending(), shared: resolved([]) }, wantShared).staleTab).toBe(true)
    expect(deriveFeedState({ ...allPending(), shared: rejected(new Error('boom')) }, wantShared).staleTab).toBe(false)
    expect(deriveFeedState({ ...allPending(), shared: resolved([site('x')]) }, wantShared).staleTab).toBe(false)

    // Always-present tabs can never go stale.
    expect(deriveFeedState(allPending(), onSites).staleTab).toBe(false)
    expect(deriveFeedState(allPending(), { requestedTab: 'comments' }).staleTab).toBe(false)
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
    const view = { requestedTab: 'team' } as const

    const first = deriveFeedState(build(), view)
    const second = deriveFeedState(build(), view)

    expect(second).toEqual(first)
    expect(second.tabs.map((t) => t.id)).toEqual(['sites', 'shared', 'spaces', 'team', 'comments'])
    expect(second.activeTab).toBe('team')
  })

  test('T10.5 shared pop-in while user sits on Team does not steal the active tab', () => {
    const view = { requestedTab: 'team' } as const
    const before = deriveFeedState(allPending(), view)
    expect(before.activeTab).toBe('team')
    expect(before.tabs.map((t) => t.id)).toEqual(['sites', 'team', 'comments'])

    const after = deriveFeedState({ ...allPending(), shared: resolved([site('x')]) }, view)
    expect(after.tabs.map((t) => t.id)).toEqual(['sites', 'shared', 'team', 'comments'])
    expect(after.activeTab).toBe('team')
  })

  test('T10.5 active Shared tab disappearing (feed emptied) falls back to Your sites', () => {
    const view = { requestedTab: 'shared' } as const
    const withShared = deriveFeedState({ ...allPending(), shared: resolved([site('x')]) }, view)
    expect(withShared.activeTab).toBe('shared')

    const emptied = deriveFeedState({ ...allPending(), shared: resolved([]) }, view)
    expect(emptied.activeTab).toBe('sites')
  })

  test('C5.1 comments tab is always present across every slot state', () => {
    for (const comments of commentSlotStates) {
      const state = deriveFeedState({ ...allPending(), comments }, onSites)
      expect(state.tabs.map((tab) => tab.id)).toEqual(['sites', 'team', 'comments'])
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
      const state = deriveFeedState({ ...allPending(), comments }, { requestedTab: 'comments' })
      expect(state.activeTab).toBe('comments')
    }
  })

  test('C5.1 tab order keeps Comments last with and without Shared', () => {
    const withShared = deriveFeedState(
      { ...allPending(), shared: resolved([site('shared')]) },
      onSites,
    )
    expect(withShared.tabs.map((tab) => tab.id)).toEqual(['sites', 'shared', 'team', 'comments'])

    const withoutShared = deriveFeedState({ ...allPending(), shared: resolved([]) }, onSites)
    expect(withoutShared.tabs.map((tab) => tab.id)).toEqual(['sites', 'team', 'comments'])
  })

  test('C5.2 five-wide derivation preserves representative four-feed goldens', () => {
    const cases = [
      {
        slots: allPending(),
        view: onSites,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'sites',
          unauthorized: false,
          staleTab: false,
        },
      },
      {
        slots: { ...allPending(), shared: resolved([site('shared')]) },
        view: { requestedTab: 'team' } as const,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            {
              id: 'shared',
              label: 'Shared with me',
              count: 1,
              content: { kind: 'rows', rows: [site('shared')] },
            },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'team',
          unauthorized: false,
          staleTab: false,
        },
      },
      {
        slots: { ...allPending(), shared: resolved([]) },
        view: { requestedTab: 'shared' } as const,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'sites',
          unauthorized: false,
          staleTab: true, // requested Shared, whose feed settled empty
        },
      },
      {
        // The personal space alone never earns the Spaces tab.
        slots: { ...allPending(), spaces: resolved([space('personal', 'personal')]) },
        view: onSites,
        expected: {
          tabs: [
            { id: 'sites', label: 'Your sites', count: null, content: { kind: 'loading' } },
            { id: 'team', label: 'Team activity', count: null, content: { kind: 'loading' } },
          ],
          activeTab: 'sites',
          unauthorized: false,
          staleTab: false,
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

describe('tabFromParam — the ?tab= URL parse', () => {
  test('passes through every known tab id', () => {
    for (const id of ['sites', 'shared', 'spaces', 'team', 'comments'] as const) {
      expect(tabFromParam(id)).toBe(id)
    }
  })

  test('falls back to sites for a missing or unknown value', () => {
    expect(tabFromParam(null)).toBe('sites')
    expect(tabFromParam('')).toBe('sites')
    expect(tabFromParam('bogus')).toBe('sites')
  })
})

describe('C5.4 — feedRowPath: hide redundant root-file paths', () => {
  test('hides index.html', () => {
    expect(feedRowPath({ filePath: 'index.html', siteSlug: 'anything' })).toBeNull()
  })

  test('hides a lone file whose basename matches the site slug', () => {
    expect(feedRowPath({ filePath: 'report.html', siteSlug: 'report' })).toBeNull()
  })

  test('slugifies a spaced basename before matching the site slug', () => {
    expect(feedRowPath({ filePath: 'Q3 Report.html', siteSlug: 'q3-report' })).toBeNull()
  })

  test('shows a nested path even when its basename could match', () => {
    expect(feedRowPath({ filePath: 'charts/revenue.html', siteSlug: 'revenue' })).toBe(
      'charts/revenue.html',
    )
  })

  test('matching is extension-agnostic', () => {
    expect(feedRowPath({ filePath: 'report.md', siteSlug: 'report' })).toBeNull()
  })

  test('matching is case-insensitive through slugify', () => {
    expect(feedRowPath({ filePath: 'REPORT.HTML', siteSlug: 'report' })).toBeNull()
  })

  test('a hidden display path is still carried by notificationHref', () => {
    const item = { filePath: 'report.html', siteSlug: 'report' }
    expect(feedRowPath(item)).toBeNull()
    expect(notificationHref({ siteLabel: 'docs/report', filePath: item.filePath, threadId: 't1' })).toBe(
      '/docs/report/report.html?thread=t1&review=1',
    )
  })
})
