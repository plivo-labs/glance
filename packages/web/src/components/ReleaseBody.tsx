import { cn } from '@/lib/utils'

// Shared rendering of a release note's pre-escaped body + its date, used by BOTH the header Sheet
// (WhatsNewButton) and the /whats-new archive. Single-sourced so the prose class list and the
// dangerouslySetInnerHTML escape rationale don't drift between the two surfaces.
const PROSE = cn(
  '[&_a]:text-primary [&_a]:underline',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_p]:my-2',
  '[&_h1]:mt-3 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:font-semibold',
)

// Optional header art for a release, shared by the first-run dialog, the Sheet and the archive.
// The file is a static asset under web/public/whats-new/ and the note's frontmatter carries only
// the BASENAME, so a note never encodes a URL path. Decorative by design: the title right below it
// says the same thing, so alt="" keeps a screen reader from hearing the release twice.
export function ReleaseImage({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={`/whats-new/${src}`}
      alt=""
      loading="lazy"
      className={cn('mb-3 aspect-[5/2] w-full rounded-md border border-border/60 object-cover', className)}
    />
  )
}

export function ReleaseBody({ html, className }: { html: string; className?: string }) {
  return (
    <div
      className={cn('leading-relaxed text-foreground/90', PROSE, className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html is escaped at build time by the shared Marked instance (api lib/markdown.ts)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Format an ISO release date for display. Falls back to the raw string if unparseable. */
export function formatReleaseDate(iso: string, month: 'short' | 'long' = 'short'): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month, day: 'numeric' })
}
