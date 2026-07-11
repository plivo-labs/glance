import { Sparkles } from 'lucide-react'
import { useCallback, useReducer, useRef } from 'react'
import { toast } from 'sonner'
import { Spinner } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { MountSensor } from '@/components/ui/mount-sensor'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  SUMMARY_INITIAL_STATE,
  type ReadySnapshot,
  type SummaryEvent,
  type SummaryState,
  siteSummary,
  summaryReducer,
} from '@/lib/summary'

type Props = {
  spaceSlug: string
  siteSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onGenerated?: () => void
}

function showLoadError(error: unknown) {
  toast.error('Could not load summary', { description: error instanceof Error ? error.message : undefined })
}

function SummaryText({ snapshot, dimmed = false }: { snapshot: ReadySnapshot; dimmed?: boolean }) {
  return (
    <p className={cn('whitespace-pre-line text-sm leading-6', dimmed && 'text-muted-foreground')}>
      {snapshot.summary}
    </p>
  )
}

function PendingBody({ label, dimmed = false }: { label: string; dimmed?: boolean }) {
  return (
    <div className="space-y-3 py-2">
      <div className={cn('flex items-center gap-2 text-sm', dimmed && 'text-muted-foreground')}>
        <Spinner />
        {label}
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

function SummaryBadge({ snapshot }: { snapshot: ReadySnapshot }) {
  return (
    <span className="inline-flex rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
      [AI · v{snapshot.meta.forVersion}]
    </span>
  )
}

function SummaryBody({ state }: { state: SummaryState }) {
  switch (state.kind) {
    case 'loading':
      return <PendingBody label="Loading summary…" dimmed />
    case 'empty':
      return <p className="py-10 text-center text-muted-foreground text-sm">No summary yet</p>
    case 'unavailable':
      return (
        <p className="py-10 text-center text-muted-foreground text-sm">
          {state.reason === 'nothing'
            ? 'Nothing to summarize on this site.'
            : 'AI is not configured on this instance.'}
        </p>
      )
    case 'generating':
      return <PendingBody label="Summarizing…" />
    case 'ready':
      return (
        <div className="space-y-4">
          {state.snapshot.stale && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-800 text-sm dark:text-amber-300">
              ⚠ Written for v{state.snapshot.meta.forVersion} — site is v{state.snapshot.currentVersion}
            </div>
          )}
          <SummaryBadge snapshot={state.snapshot} />
          <SummaryText snapshot={state.snapshot} dimmed={state.snapshot.stale} />
        </div>
      )
    case 'failed':
      return (
        <div className="space-y-4">
          <p className="font-medium text-sm">Generation failed</p>
          {state.prior && (
            <>
              <SummaryBadge snapshot={state.prior} />
              <SummaryText snapshot={state.prior} dimmed />
            </>
          )}
        </div>
      )
  }
}

function SummaryFooter({ state, generate }: { state: SummaryState; generate: (force?: boolean) => void }) {
  switch (state.kind) {
    case 'empty':
      return (
        <Button onClick={() => generate()}>
          <Sparkles />
          Summarize
        </Button>
      )
    case 'ready':
      return state.snapshot.stale ? (
        <Button onClick={() => generate()}>↻ Update summary</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={() => generate(true)}>
            Regenerate anyway
          </Button>
          <p className="text-center text-muted-foreground text-xs">Summarizes the entry page only.</p>
        </>
      )
    case 'failed':
      return state.retryable ? <Button onClick={() => generate(state.retryForce)}>↻ Try again</Button> : null
    case 'loading':
    case 'unavailable':
    case 'generating':
      return null
  }
}

export function SummarySheet({ spaceSlug, siteSlug, open, onOpenChange, onGenerated }: Props) {
  const [state, dispatch] = useReducer(summaryReducer, SUMMARY_INITIAL_STATE)
  const stateRef = useRef(state)
  stateRef.current = state
  const nextRequestToken = useRef(0)
  const reduceAndDispatch = useCallback((event: SummaryEvent) => {
    const previous = stateRef.current
    const next = summaryReducer(previous, event)
    stateRef.current = next
    dispatch(event)
    return { changed: next !== previous, next }
  }, [])

  const loadOnMount = useCallback(
    () => {
      const requestToken = nextRequestToken.current + 1
      nextRequestToken.current = requestToken
      reduceAndDispatch({ type: 'open', requestToken })
      void siteSummary
        .get(spaceSlug, siteSlug)
        .then((response) => reduceAndDispatch({ type: 'getResolved', requestToken, response }))
        .catch((error: unknown) => {
          reduceAndDispatch({ type: 'getFailed', requestToken, error })
          showLoadError(error)
        })
    },
    [spaceSlug, siteSlug, reduceAndDispatch],
  )

  const generate = useCallback(
    (force = false) => {
      const requestToken = nextRequestToken.current + 1
      nextRequestToken.current = requestToken
      const startedEvent = { type: 'generateStarted', requestToken, force } as const
      reduceAndDispatch(startedEvent)
      void siteSummary
        .generate(spaceSlug, siteSlug, force)
        .then((response) => {
          reduceAndDispatch({ type: 'postResolved', requestToken, response })
          onGenerated?.()
        })
        .catch((error: unknown) => {
          const failedEvent = { type: 'postFailed', requestToken, error } as const
          const { changed, next } = reduceAndDispatch(failedEvent)
          if (changed && next.kind === 'failed' && next.rateLimited) {
            toast.error('Rate limited — try again in a minute')
          } else if (changed && next.kind === 'failed' && !next.retryable) {
            toast.error('Could not generate summary', {
              description: error instanceof Error ? error.message : undefined,
            })
          }
        })
    },
    [spaceSlug, siteSlug, onGenerated, reduceAndDispatch],
  )

  const hasFooter =
    state.kind === 'empty' || state.kind === 'ready' || (state.kind === 'failed' && state.retryable)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <MountSensor onMount={loadOnMount} />
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Summary
          </SheetTitle>
          <SheetDescription className="sr-only">AI-generated summary of the site entry page.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <SummaryBody state={state} />
        </div>
        {hasFooter && (
          <div className="flex flex-col gap-2 border-t px-5 py-3">
            <SummaryFooter state={state} generate={generate} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
