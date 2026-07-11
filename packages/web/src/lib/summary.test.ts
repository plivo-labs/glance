import { describe, expect, test } from 'bun:test'
import { ApiError } from './api'
import { SUMMARY_INITIAL_STATE, siteSummary, summaryReducer } from './summary'

function stubFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(
      new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }),
    )
  }) as unknown as typeof fetch
  return calls
}

const readyResponse = {
  status: 'ready',
  stale: false,
  currentVersion: 7,
  summary: 'A concise summary.',
  meta: {
    provider: 'workers-ai',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    forVersion: 7,
    generatedAt: '2026-07-12T10:00:00.000Z',
    truncated: false,
  },
} as const

const readySnapshot = {
  stale: readyResponse.stale,
  currentVersion: readyResponse.currentVersion,
  summary: readyResponse.summary,
  meta: readyResponse.meta,
}

describe('C33 summary state machine', () => {
  test('open starts a GET-backed loading request', () => {
    expect(summaryReducer(SUMMARY_INITIAL_STATE, { type: 'open', requestToken: 1 })).toEqual({
      kind: 'loading',
      requestToken: 1,
    })
  })

  test('GET status none becomes an empty summary for the current version', () => {
    const loading = summaryReducer(SUMMARY_INITIAL_STATE, { type: 'open', requestToken: 1 })
    expect(
      summaryReducer(loading, {
        type: 'getResolved',
        requestToken: 1,
        response: { status: 'none', stale: false, currentVersion: 7 },
      }),
    ).toEqual({ kind: 'empty', currentVersion: 7, requestToken: 1 })
  })

  test('generating from empty has no prior summary', () => {
    const empty = { kind: 'empty', currentVersion: 7, requestToken: 1 } as const
    expect(summaryReducer(empty, { type: 'generateStarted', requestToken: 2, force: false })).toEqual({
      kind: 'generating',
      retryForce: false,
      requestToken: 2,
    })
  })

  test('a successful POST becomes a fresh ready snapshot', () => {
    const generating = { kind: 'generating', retryForce: false, requestToken: 2 } as const
    expect(
      summaryReducer(generating, { type: 'postResolved', requestToken: 2, response: readyResponse }),
    ).toEqual({ kind: 'ready', requestToken: 2, snapshot: readySnapshot })
  })

  test('a stale GET snapshot retains both banner versions', () => {
    const loading = { kind: 'loading', requestToken: 3 } as const
    const response = {
      ...readyResponse,
      stale: true,
      currentVersion: 12,
      meta: { ...readyResponse.meta, forVersion: 11 },
    }
    const state = summaryReducer(loading, { type: 'getResolved', requestToken: 3, response })
    expect(state).toEqual({
      kind: 'ready',
      requestToken: 3,
      snapshot: {
        stale: true,
        currentVersion: 12,
        summary: readyResponse.summary,
        meta: { ...readyResponse.meta, forVersion: 11 },
      },
    })
  })

  test('a failed POST preserves the prior summary text', () => {
    const generating = { kind: 'generating', requestToken: 4, prior: readySnapshot, retryForce: true } as const
    const state = summaryReducer(generating, {
      type: 'postFailed',
      requestToken: 4,
      error: new ApiError(502, 'generation failed'),
    })
    expect(state).toEqual({
      kind: 'failed',
      requestToken: 4,
      prior: readySnapshot,
      retryable: true,
      rateLimited: false,
      retryForce: true,
    })
    if (state.kind === 'failed') expect(state.prior?.summary).toBe('A concise summary.')
  })

  test('force regeneration restores the intact fresh snapshot on failure', () => {
    const ready = { kind: 'ready', requestToken: 5, snapshot: readySnapshot } as const
    const generating = summaryReducer(ready, { type: 'generateStarted', requestToken: 6, force: true })
    expect(generating).toEqual({
      kind: 'generating',
      requestToken: 6,
      prior: readySnapshot,
      retryForce: true,
    })

    const failed = summaryReducer(generating, {
      type: 'postFailed',
      requestToken: 6,
      error: new ApiError(502, 'generation failed'),
    })
    expect(failed).toEqual({
      kind: 'failed',
      requestToken: 6,
      prior: readySnapshot,
      retryable: true,
      rateLimited: false,
      retryForce: true,
    })
  })

  test('a 429 POST failure is retryable and rate limited', () => {
    const generating = { kind: 'generating', requestToken: 7, retryForce: false } as const
    expect(
      summaryReducer(generating, {
        type: 'postFailed',
        requestToken: 7,
        error: new ApiError(429, 'rate limited'),
      }),
    ).toEqual({
      kind: 'failed',
      requestToken: 7,
      retryable: true,
      rateLimited: true,
      retryForce: false,
    })
  })

  test('GET status unavailable becomes the honest provider-empty state', () => {
    const loading = { kind: 'loading', requestToken: 7 } as const
    expect(
      summaryReducer(loading, {
        type: 'getResolved',
        requestToken: 7,
        response: { status: 'unavailable', stale: false, currentVersion: 7 },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'provider', requestToken: 7 })
  })

  test('a GET resolving after a later successful POST is ignored', () => {
    const loading = summaryReducer(SUMMARY_INITIAL_STATE, { type: 'open', requestToken: 8 })
    const generating = summaryReducer(loading, { type: 'generateStarted', requestToken: 9, force: false })
    const ready = summaryReducer(generating, {
      type: 'postResolved',
      requestToken: 9,
      response: readyResponse,
    })
    const afterLateGet = summaryReducer(ready, {
      type: 'getResolved',
      requestToken: 8,
      response: { status: 'none', stale: false, currentVersion: 7 },
    })
    expect(afterLateGet).toBe(ready)
  })

  test('a non-ApiError becomes a non-retryable failure without prior text', () => {
    const loading = { kind: 'loading', requestToken: 10 } as const
    expect(
      summaryReducer(loading, {
        type: 'getFailed',
        requestToken: 10,
        error: new Error('network failed'),
      }),
    ).toEqual({
      kind: 'failed',
      requestToken: 10,
      retryable: false,
      rateLimited: false,
      retryForce: false,
    })
  })

  test('a 422 POST failure becomes the nothing-to-summarize state', () => {
    const generating = { kind: 'generating', requestToken: 11, retryForce: false } as const
    expect(
      summaryReducer(generating, {
        type: 'postFailed',
        requestToken: 11,
        error: new ApiError(422, 'nothing to summarize'),
      }),
    ).toEqual({ kind: 'unavailable', reason: 'nothing', requestToken: 11 })
  })
})

describe('C34 summary API wire', () => {
  test('get() uses the exact summary path with GET and credentials', async () => {
    const calls = stubFetch({ status: 'none', stale: false, currentVersion: 7 })
    await siteSummary.get('acme', 'doc')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/sites/acme/doc/summary')
    expect(calls[0].init?.credentials).toBe('include')
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
  })

  test('generate() POSTs an empty JSON object to the exact summary path', async () => {
    const calls = stubFetch(readyResponse)
    await siteSummary.generate('acme', 'doc')
    expect(calls[0].url).toBe('/api/sites/acme/doc/summary')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.credentials).toBe('include')
    expect(calls[0].init?.body).toBe('{}')
  })

  test('generate(..., true) POSTs the force flag', async () => {
    const calls = stubFetch(readyResponse)
    await siteSummary.generate('acme', 'doc', true)
    expect(calls[0].init?.body).toBe('{"force":true}')
  })

  test('a generation 502 rejects with the api error status and message', async () => {
    stubFetch({ error: 'generation failed', retryable: true }, 502)
    const error = await siteSummary.generate('acme', 'doc').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(502)
    expect((error as ApiError).message).toBe('generation failed')
  })
})
