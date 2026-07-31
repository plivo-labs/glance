import { useCallback, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  API_KEY_PREFIX,
  type ApiKeyGrants,
  type ApiKeyItem,
  DATA_LEVELS,
  type DataLevel,
  KEY_DURATIONS,
  type MintedApiKey,
  type SiteSummary,
} from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MountSensor } from '@/components/ui/mount-sensor'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/states'

type Duration = (typeof KEY_DURATIONS)[number]
type Scope = 'sites' | 'all-owned'

const DURATION_LABEL: Record<Duration, string> = {
  1: '1 day',
  7: '7 days',
  30: '30 days',
  90: '90 days',
  180: '180 days',
  365: '1 year',
}

// A mint response never round-trips through the list endpoint, so the row shown right away is
// built here — same secretHint fragment the server computes for GET (routes/api-keys.ts): the
// last 4 chars of the plaintext, which is the only place on this screen the full secret is sliced
// from. Nothing beyond that fragment is kept.
function itemFromMinted(minted: MintedApiKey): ApiKeyItem {
  return {
    id: minted.id,
    name: minted.name,
    grants: minted.grants,
    createdAt: minted.createdAt,
    expiresAt: minted.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    secretHint: `${API_KEY_PREFIX}…${minted.secret.slice(-4)}`,
  }
}

// Copy-to-clipboard for the secret specifically: NOT the shared CopyButton (components/CopyButton),
// because that toasts the copied value back onto the screen as its description — a second on-screen
// echo of a secret that already stops being recoverable the moment this dialog closes.
function CopySecretButton({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(secret)
          setCopied(true)
          toast.success('Secret copied')
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error("Couldn't copy to clipboard")
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      Copy
    </Button>
  )
}

// Mint dialog. The plaintext secret exists client-side for exactly one render: it lives in
// `minted` state, set only by a successful POST, and is cleared the instant the dialog closes
// (handleOpenChange) rather than merely hidden — a re-open always starts from the empty form, it
// never re-shows or re-fetches a prior secret.
export function ApiKeyDialog({
  open,
  onOpenChange,
  onMinted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onMinted: (key: ApiKeyItem) => void
}) {
  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState<Duration>(30)
  // Allowlist is the default grants shape (Sam's ruling) — a fresh key starts scoped to sites you
  // explicitly pick, not silently widened to everything you own.
  const [scope, setScope] = useState<Scope>('sites')
  // Least privilege by default, for the same reason the scope defaults to an allowlist: widening
  // is a deliberate act. The server intersects whatever lands here with the user's own access, so
  // this can only ever narrow — but a key minted with the full set can never be narrowed later.
  const [dataLevel, setDataLevel] = useState<DataLevel>('read')
  const [control, setControl] = useState(false)
  const [siteIds, setSiteIds] = useState<string[]>([])
  const [sites, setSites] = useState<SiteSummary[]>([])
  const [loadingSites, setLoadingSites] = useState(false)
  const [minting, setMinting] = useState(false)
  const [minted, setMinted] = useState<MintedApiKey | null>(null)

  // Reseed on every open, MountSensor-driven like ForkDialog/MoveDialog: a fresh form, a fresh
  // site list, and — critically — `minted` reset to null so a closed-then-reopened dialog can
  // never render a stale secret.
  const seed = useCallback(() => {
    setName('')
    setExpiresInDays(30)
    setScope('sites')
    setDataLevel('read')
    setControl(false)
    setSiteIds([])
    setMinted(null)
    setLoadingSites(true)
    api
      .get<SiteSummary[]>('/api/sites/mine')
      .then(setSites)
      .catch((err) =>
        toast.error('Could not load sites', { description: err instanceof Error ? err.message : undefined }),
      )
      .finally(() => setLoadingSites(false))
  }, [])

  function handleOpenChange(o: boolean) {
    if (minting) return
    // Show-once: the secret is dropped HERE, on close, not left for a future open to render.
    if (!o) setMinted(null)
    onOpenChange(o)
  }

  async function mint() {
    if (minting) return
    setMinting(true)
    try {
      const grants: ApiKeyGrants = {
        control,
        data: {
          scope: scope === 'all-owned' ? { kind: 'all-owned' } : { kind: 'sites', siteIds },
          caps: [...(DATA_LEVELS.find((l) => l.value === dataLevel) ?? DATA_LEVELS[0]).caps],
        },
      }
      const result = await api.post<MintedApiKey>('/api/api-keys', { name, expiresInDays, grants })
      setMinted(result)
      onMinted(itemFromMinted(result))
    } catch (err) {
      toast.error('Could not create key', { description: err instanceof Error ? err.message : undefined })
    } finally {
      setMinting(false)
    }
  }

  const canMint = name.trim().length > 0 && (scope === 'all-owned' || siteIds.length > 0)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <MountSensor onMount={seed} />
        {minted ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>
                Copy it now — this is the only time it’s shown. Glance stores only its hash.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                {minted.secret}
              </code>
              <CopySecretButton secret={minted.secret} />
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>Keys authenticate CLI/API requests as you.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={name}
                disabled={minting}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CI pipeline"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-expiry">Expires</Label>
              {/* Fixed dropdown over KEY_DURATIONS only — never a free-text date, so the server's
                  fixed duration set is the only thing this control can ever produce. */}
              <Select
                value={String(expiresInDays)}
                onValueChange={(v) => setExpiresInDays(Number(v) as Duration)}
                disabled={minting}
              >
                <SelectTrigger id="key-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_DURATIONS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {DURATION_LABEL[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-data-level">Data access</Label>
              {/* The capability CEILING. The server intersects it with the caller's own access
                  (dataCapsFor), so picking Full access on a site you only view still mints
                  read+create — this control can narrow, never widen. */}
              <Select
                value={dataLevel}
                onValueChange={(v) => setDataLevel(v as DataLevel)}
                disabled={minting}
              >
                <SelectTrigger id="key-data-level" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATA_LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Site access</Label>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="key-scope"
                    checked={scope === 'sites'}
                    disabled={minting}
                    onChange={() => setScope('sites')}
                  />
                  Selected sites
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="key-scope"
                    checked={scope === 'all-owned'}
                    disabled={minting}
                    onChange={() => setScope('all-owned')}
                  />
                  All owned sites
                </label>
              </div>
              {scope === 'sites' &&
                (loadingSites ? (
                  <div className="flex justify-center py-4">
                    <Spinner />
                  </div>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                    {sites.length === 0 && <p className="text-sm text-muted-foreground">No sites yet.</p>}
                    {sites.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={siteIds.includes(s.id)}
                          disabled={minting}
                          onChange={(e) =>
                            setSiteIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)))
                          }
                        />
                        <span className="font-mono">
                          {s.spaceSlug}/{s.siteSlug}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={control}
                disabled={minting}
                onChange={(e) => setControl(e.target.checked)}
              />
              Also allow managing sites (deploy, create, fork)
            </label>
            <DialogFooter>
              <Button variant="outline" disabled={minting} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={minting || !canMint} onClick={() => void mint()}>
                {minting && <Spinner />}
                Create key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
