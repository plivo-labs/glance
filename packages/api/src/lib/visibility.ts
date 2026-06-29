import type { Visibility } from '../db/schema'

// Single source of truth for the visibility tiers accepted on the wire. Shared by the create,
// upload, update, and admin-filter paths so the accepted set never drifts between them.
export const VISIBILITIES: readonly Visibility[] = ['private', 'members', 'team']

const SET: ReadonlySet<string> = new Set(VISIBILITIES)

// Legacy tiers are mapped onto their replacements before validating — never reject a legacy value,
// just normalize it. `group` → `members` (renamed; the word collided with space *type* and the
// share-modal's group picker). `public` → `team`: the public tier was removed (no anonymous access),
// so old CLI builds / saved scripts that still send `public` fall back to the broadest live tier.
export function normalizeVisibility(v: unknown): unknown {
  if (v === 'group') return 'members'
  if (v === 'public') return 'team'
  return v
}

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === 'string' && SET.has(v)
}
