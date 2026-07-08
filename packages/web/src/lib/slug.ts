// Mirror the API's slug rules (packages/api/src/lib/slug.ts): lowercase alphanumeric + hyphens,
// collapsed, trimmed, capped. Shared by the deploy card and the recording flow so both derive
// slugs identically.
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}
