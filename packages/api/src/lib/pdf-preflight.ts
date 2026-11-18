// Pages the server PDF render cannot reproduce: answered BEFORE a billed browser starts, as a 501
// the viewer turns into the browser's print dialog (which prints the page exactly as it is on screen).
import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { files, sites } from '../db/schema'
import { isTheme } from '../themes/registry'
import { batchAll } from './d1'
import { resolveIndexPath } from './extract'

/** The SDK spelled out in a page: `glance.db`, `glance?.db`, `glance['db']`, or its script / boot global. */
const GLANCE_DB_USE =
  /\bglance\s*\??\.\s*db\b|\bglance\s*\[\s*['"]db['"]\s*\]|__GLANCE_DB__|\/_glance\/db\.js|\/api\/glance\.js/

export const usesGlanceDb = (html: string): boolean => GLANCE_DB_USE.test(html)

const MARKDOWN = /\.(md|markdown)$/i

/**
 * Why this page must be printed by the browser instead, or null when the server can render it.
 * `rawPath` is the request's `path` (already decoded, like `files.path`); empty means the site's
 * entry page, resolved the way the content worker resolves it.
 *
 * glance.db: the headless render has no Glance app around the page to answer the SDK (a broker
 * that needs the parent viewer frame), so a page that uses it never gets its data, or its SDK at
 * all. Detected from the page's source, plus a site that holds documents (the SDK code may live in
 * a script file the page loads). Known gap: a page that loads the SDK from a script file of its own
 * and has no documents yet still renders without the SDK. Markdown cannot run scripts, so skips this.
 *
 * Unthemed markdown + a theme chosen in the viewer (`themeHref`): the render adds the theme's
 * <link> after load, but an unthemed markdown page is served with `style-src 'unsafe-inline'` (no
 * 'self', content.ts markdownCsp), so the browser blocks it and the PDF would lack the theme. The
 * content worker has no theme override to widen that policy for, and the CSP is never bypassed, so
 * the browser prints it. A themed site (a shipped theme, as content.ts resolves it) is served with
 * 'self' and takes the link; HTML pages carry no style-src.
 */
export async function pdfPrintOnlyReason(
  db: DrizzleD1Database,
  bucket: R2Bucket,
  site: { id: string; theme: string | null },
  rawPath: string | undefined,
  themeHref: string | null,
): Promise<string | null> {
  const [fileRows, countRows] = await batchAll(db, [
    db.select({ path: files.path, storageKey: files.storageKey }).from(files).where(eq(files.siteId, site.id)),
    db.select({ docCount: sites.docCount }).from(sites).where(eq(sites.id, site.id)).limit(1),
  ])
  const page = rawPath || resolveIndexPath(fileRows.map((f) => f.path))
  // No such file (a directory listing, or a path that 404s): nothing to judge, the render answers it.
  const file = fileRows.find((f) => f.path === page)
  if (!file) return null
  if (MARKDOWN.test(page)) {
    return themeHref && !isTheme(site.theme)
      ? 'a theme chosen in the viewer cannot be applied to this markdown page in a server-side PDF'
      : null
  }

  const reason = 'this page uses glance.db, which a server-side PDF cannot load'
  if ((countRows[0]?.docCount ?? 0) > 0) return reason
  const object = await bucket.get(file.storageKey)
  return object && usesGlanceDb(await object.text()) ? reason : null
}
