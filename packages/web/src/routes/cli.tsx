import { useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { CircleCheck, Plug, Terminal } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import type { Me } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/states'

export async function loader({ request }: LoaderFunctionArgs) {
  const code = new URL(request.url).searchParams.get('code') ?? ''
  try {
    const user = await api.get<Me>('/api/auth/me')
    return { code, user }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

type ApproveState = 'idle' | 'approving' | 'done' | 'error'

export function Component() {
  const { code, user } = useLoaderData() as { code: string; user: Me }
  const [value, setValue] = useState(code.toUpperCase())
  const [state, setState] = useState<ApproveState>('idle')

  const isApproving = state === 'approving'
  const isDone = state === 'done'
  const canSubmit = value.trim().length > 0 && !isApproving

  async function handleApprove() {
    setState('approving')
    try {
      await api.post('/api/auth/cli/approve', { userCode: value.trim() })
      setState('done')
    } catch {
      setState('error')
    }
  }

  return (
    <Card className="mx-auto mt-[8vh] max-w-md">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-lg border border-border bg-muted text-primary">
          {isDone ? (
            <Plug className="size-5" aria-hidden />
          ) : (
            <Terminal className="size-5" aria-hidden />
          )}
        </div>
        <CardTitle className="mt-3">Connect CLI</CardTitle>
        <CardDescription>
          Signed in as <span className="font-mono text-foreground">{user.email}</span>
        </CardDescription>
      </CardHeader>

      <CardContent>
        {isDone ? (
          <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-4 text-sm">
            <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
            <div>
              <p className="font-medium text-foreground">CLI connected</p>
              <p className="mt-0.5 text-muted-foreground">
                You can return to your terminal.
              </p>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSubmit) void handleApprove()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="device-code">Device code</Label>
              <Input
                id="device-code"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value.toUpperCase())
                  if (state === 'error') setState('idle')
                }}
                placeholder="ABCD1234"
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={isApproving}
                aria-invalid={state === 'error'}
                className="font-mono text-lg tracking-[0.3em] uppercase"
              />
            </div>

            {state === 'error' && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Invalid or expired code.
              </p>
            )}

            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {isApproving && <Spinner className="size-4" />}
              {isApproving ? 'Approving…' : 'Approve'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
