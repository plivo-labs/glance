import type { Visibility } from '../db/schema'

// Single source of truth for the visibility tiers accepted on the wire. Shared by the create,
// upload, update, and admin-filter paths so the accepted set never drifts between them.
export const VISIBILITIES: readonly Visibility[] = ['private', 'members', 'team', 'public']

const SET: ReadonlySet<string> = new Set(VISIBILITIES)

// `group` was renamed to `members` (it was the only tier meaning "this space's people, not the
// whole org"; the word collided with space *type* and the share-modal's group picker). Old CLI
// builds + saved scripts still send `group`, so normalize it before validating — never reject a
// legacy value, just map it onto its replacement.
export function normalizeVisibility(v: unknown): unknown {
  return v === 'group' ? 'members' : v
}

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === 'string' && SET.has(v)
}
