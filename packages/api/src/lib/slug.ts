// Flat-namespace slug rules (spec Phase 3): lowercase alphanumeric + hyphens,
// 3–40 chars, no leading/trailing hyphen. A denylist prevents slugs from shadowing
// system routes — applies to both space creation and auto-generated personal handles.

export const RESERVED_SLUGS = new Set([
  'api', 'admin', 'login', 'logout', 'dashboard', 'content', 'assets', 'auth',
  'static', 'public', 'app', 'www', 'health', 'me', 'settings', 'about', 'help',
  'spaces', 'sites', 'upload', 'files', 'cli', 'new', 'edit', 'delete', '_t',
  'whats-new', 'docs',
])

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug)
}

/** Best-effort conversion of an email handle into a candidate personal-space slug. */
export function slugifyHandle(email: string): string {
  return slugifyText(email.split('@')[0] ?? 'user', 'user')
}

/** Best-effort conversion of an identity-provider group name into a candidate group-space slug. */
export function slugifyGroup(name: string): string {
  return slugifyText(name, 'group')
}

/** The base slug, then `-1`…`-25`: the bounded list a creator walks on slug collisions. */
export function slugCandidates(base: string): string[] {
  const first = RESERVED_SLUGS.has(base) ? `${base}-1` : base
  return [first, ...Array.from({ length: 25 }, (_, i) => `${first}-${i + 1}`)]
}

function slugifyText(text: string, fallback: string): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length < 3) s = `${s || fallback}-glance`
  return s.slice(0, 40).replace(/-+$/g, '')
}
