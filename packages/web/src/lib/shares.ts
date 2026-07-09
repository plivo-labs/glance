import type { ShareRole } from './types'

// Pure builder for the PUT /shares payload from the ShareDialog's selection state. Users carry a
// role (viewer|editor) — a Map, not a Set — so "grant edit" round-trips; groups stay view-only (no
// role). Kept pure + exported so the role-mapping invariant is unit-tested without the dialog.
export function buildSharePayload(
  selUsers: Map<string, ShareRole>,
  selGroups: Set<string>,
): { users: { id: string; role: ShareRole }[]; groupIds: string[] } {
  return {
    users: [...selUsers].map(([id, role]) => ({ id, role })),
    groupIds: [...selGroups],
  }
}
