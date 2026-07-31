import { useState } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import { Link, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { toast } from 'sonner'
import { ApiKeyDialog } from '@/components/ApiKeyDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState, PageHeader } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, ApiError } from '@/lib/api'
import { toLogin } from '@/lib/nav'
import { isoDate, timeAgo } from '@/lib/time'
import type { ApiKeyGrants, ApiKeyItem } from '@/lib/types'

// GET /api/api-keys — see packages/api/src/routes/api-keys.ts for the full item shape.
export interface ApiKeyListData {
  items: ApiKeyItem[]
}

export async function loader({ request }: LoaderFunctionArgs): Promise<ApiKeyListData> {
  try {
    return await api.get<ApiKeyListData>('/api/api-keys')
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw toLogin(request)
    throw err
  }
}

// Inline literal, same treatment as the one on /docs/api-keys so GLANCE_TOKEN reads as a token
// in both places.
function Code({ children }: { children: string }) {
  return <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
}

// Tombstone model, matching the server (routes/api-keys.ts GET comment): revoked and expired keys
// stay in the list rather than disappearing, styled inert with no revoke action left to take.
function isInert(key: ApiKeyItem): boolean {
  return key.revokedAt !== null || new Date(key.expiresAt).getTime() <= Date.now()
}

function grantsSummary(grants: ApiKeyGrants): string {
  const parts: string[] = []
  if (grants.control) parts.push('Manage sites')
  if (!grants.data) parts.push('No data access')
  else if (grants.data.scope.kind === 'all-owned') parts.push('All owned sites')
  else {
    const n = grants.data.scope.siteIds.length
    parts.push(`${n} site${n === 1 ? '' : 's'}`)
  }
  return parts.join(' · ')
}

export function Component() {
  const { items } = useLoaderData() as ApiKeyListData
  const [keys, setKeys] = useState(items)
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <div className="mx-auto max-w-2xl">
      {/* The whole model on one line: a key IS the token, and exporting it replaces the login step.
          The docs link stays for the grant rules and the endpoint table — it is no longer the only
          way to learn what a key is. */}
      <PageHeader
        title="API Keys"
        description={
          <>
            <span className="block">
              A key is a bearer token — export it as <Code>GLANCE_TOKEN</Code> and the CLI runs without{' '}
              <Code>glance login</Code>.
            </span>
            <Link to="/docs/api-keys" className="mt-1 inline-block font-medium text-primary hover:underline">
              How keys work →
            </Link>
          </>
        }
      >
        <Button onClick={() => setDialogOpen(true)}>
          <Plus /> New key
        </Button>
      </PageHeader>
      <div className="mt-8">
        {keys.length === 0 ? (
          <EmptyState icon={KeyRound} title="No API keys yet." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Grants</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Key</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => {
                const inert = isInert(key)
                return (
                  <TableRow key={key.id} className={inert ? 'opacity-50' : undefined}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="text-muted-foreground">{grantsSummary(key.grants)}</TableCell>
                    <TableCell className="text-muted-foreground">{isoDate(key.expiresAt)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {key.lastUsedAt ? timeAgo(key.lastUsedAt) : 'Never used'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{key.secretHint}</TableCell>
                    <TableCell className="text-right">
                      {inert ? (
                        <Badge variant="secondary">{key.revokedAt ? 'Revoked' : 'Expired'}</Badge>
                      ) : (
                        <ConfirmDialog
                          title={`Revoke "${key.name}"?`}
                          description="Anything using this key stops working immediately. This can't be undone."
                          confirmLabel="Revoke"
                          destructive
                          onConfirm={async () => {
                            // Idempotent on the server: revoking an already-revoked key still
                            // succeeds, so a stale double-click here is harmless.
                            await api.delete(`/api/api-keys/${key.id}`)
                            setKeys((ks) =>
                              ks.map((k) => (k.id === key.id ? { ...k, revokedAt: new Date().toISOString() } : k)),
                            )
                            toast.success('Key revoked')
                          }}
                        >
                          <Button variant="outline" size="sm">
                            Revoke
                          </Button>
                        </ConfirmDialog>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <ApiKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} onMinted={(key) => setKeys((ks) => [key, ...ks])} />
    </div>
  )
}
