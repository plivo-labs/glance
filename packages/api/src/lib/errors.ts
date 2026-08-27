/** One-line description of a thrown value for Workers Logs. `name: message` for a real Error,
 *  `String(err)` for anything else a rejection can carry (a string, a DOMException-like, null).
 *  Kept in one place because every fire-and-forget catch in the codebase logs the same shape —
 *  changing the format (adding a stack, a request id) should be one edit, not nine. */
export const describeError = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err)
