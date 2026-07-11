import { ApiError, api } from '@/lib/api'

export interface SummaryMeta {
  provider: string
  model: string
  forVersion: number
  generatedAt: string
  truncated: boolean
}

export type SummaryResponse =
  | { status: 'none' | 'unavailable'; stale: boolean; currentVersion: number }
  | {
      status: 'ready'
      stale: boolean
      currentVersion: number
      summary: string
      meta: SummaryMeta
    }

export type ReadySnapshot = Omit<Extract<SummaryResponse, { status: 'ready' }>, 'status'>

export const siteSummary = {
  get: (space: string, site: string) => api.get<SummaryResponse>(`/api/sites/${space}/${site}/summary`),
  generate: (space: string, site: string, force = false) =>
    api.post<SummaryResponse>(`/api/sites/${space}/${site}/summary`, force ? { force: true } : {}),
}

export type SummaryState =
  | { kind: 'loading'; requestToken: number }
  | { kind: 'empty'; currentVersion: number; requestToken: number }
  | { kind: 'unavailable'; reason: 'provider' | 'nothing'; requestToken: number }
  | { kind: 'generating'; prior?: ReadySnapshot; retryForce: boolean; requestToken: number }
  | { kind: 'ready'; snapshot: ReadySnapshot; requestToken: number }
  | {
      kind: 'failed'
      prior?: ReadySnapshot
      retryable: boolean
      rateLimited: boolean
      retryForce: boolean
      requestToken: number
    }

export type SummaryEvent =
  | { type: 'open'; requestToken: number }
  | { type: 'getResolved'; requestToken: number; response: SummaryResponse }
  | { type: 'getFailed'; requestToken: number; error: unknown }
  | { type: 'generateStarted'; requestToken: number; force: boolean }
  | { type: 'postResolved'; requestToken: number; response: SummaryResponse }
  | { type: 'postFailed'; requestToken: number; error: unknown }

export const SUMMARY_INITIAL_STATE: SummaryState = { kind: 'loading', requestToken: 0 }

function failedState(
  error: unknown,
  requestToken: number,
  prior?: ReadySnapshot,
  retryForce = false,
): SummaryState {
  return {
    kind: 'failed',
    prior,
    retryable: error instanceof ApiError && (error.status === 429 || error.status === 502),
    rateLimited: error instanceof ApiError && error.status === 429,
    retryForce,
    requestToken,
  }
}

function resolvedState(response: SummaryResponse, requestToken: number): SummaryState {
  if (response.status === 'ready') {
    const { status: _, ...snapshot } = response
    return { kind: 'ready', snapshot, requestToken }
  }
  if (response.status === 'unavailable') return { kind: 'unavailable', reason: 'provider', requestToken }
  return { kind: 'empty', currentVersion: response.currentVersion, requestToken }
}

export function summaryReducer(state: SummaryState, event: SummaryEvent): SummaryState {
  // 'open' and 'generateStarted' mint a fresh token; every other event carries the outcome of an
  // in-flight request and is ignored if a later request has superseded it (e.g. a slow GET
  // resolving after the user already generated).
  const mintsToken = event.type === 'open' || event.type === 'generateStarted'
  if (!mintsToken && event.requestToken !== state.requestToken) return state

  switch (event.type) {
    case 'open':
      return { kind: 'loading', requestToken: event.requestToken }
    case 'getResolved':
      return resolvedState(event.response, event.requestToken)
    case 'getFailed':
      return failedState(event.error, event.requestToken)
    case 'generateStarted': {
      const prior = state.kind === 'ready' ? state.snapshot : state.kind === 'failed' ? state.prior : undefined
      return {
        kind: 'generating',
        prior,
        retryForce: event.force || Boolean(prior && !prior.stale),
        requestToken: event.requestToken,
      }
    }
    case 'postResolved':
      return resolvedState(event.response, event.requestToken)
    case 'postFailed':
      if (event.error instanceof ApiError && event.error.status === 422) {
        return { kind: 'unavailable', reason: 'nothing', requestToken: event.requestToken }
      }
      return failedState(
        event.error,
        event.requestToken,
        state.kind === 'generating' ? state.prior : undefined,
        state.kind === 'generating' ? state.retryForce : false,
      )
  }
}
