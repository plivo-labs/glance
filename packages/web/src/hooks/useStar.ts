import { useState } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'
import { setStar, type StarTarget } from '@/lib/stars'

// One optimistic toggle behind BOTH star surfaces (the table cell and the viewer top bar), so a
// star behaves identically wherever it's clicked.
//
// The optimistic value is held until the revalidated loader data catches up, and reconciled
// DURING RENDER rather than in an effect — the same pattern OwnerVisibilityCell uses, and for the
// same reason: clearing on request success (before revalidation lands) flickers the control back
// to its old state for the whole round trip. On failure the override is dropped, which snaps the
// control back to server truth, and the toast says why.
export function useStar(site: StarTarget & { starred?: boolean }) {
  const revalidator = useRevalidator()
  const [pending, setPending] = useState<boolean | null>(null)
  const server = site.starred ?? false
  if (pending !== null && server === pending) setPending(null)
  const starred = pending ?? server

  async function toggle() {
    const next = !starred
    setPending(next)
    try {
      await setStar(site, next)
      revalidator.revalidate() // `pending` stays until the fresh data matches (see above)
    } catch (err) {
      setPending(null)
      toast.error(next ? 'Could not star this page' : 'Could not remove the star', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  return { starred, toggle }
}
