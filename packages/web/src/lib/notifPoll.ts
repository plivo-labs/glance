// Coordinates the 60s notification poll with the dashboard's shouldRevalidate. `revalidator.
// revalidate()` re-runs EVERY active loader; the poll only wants the root loader (notifications)
// refreshed, NOT the dashboard's 4 heavy feeds. The AppShell flags a tick with `begin()` right
// before revalidating; the dashboard's shouldRevalidate calls `consume()` (true exactly once per
// tick) and skips its feeds. Mutation-driven revalidations never call begin(), so they still
// refresh the dashboard normally.
let polling = false

export const notifPoll = {
  /** Mark the next revalidation as a notifications-only poll. */
  begin() {
    polling = true
  },
  /** True iff the current revalidation was flagged as a poll; resets so it fires at most once. */
  consume(): boolean {
    const was = polling
    polling = false
    return was
  },
  /** Clear the flag after a tick whose revalidation didn't match the dashboard (so it can't leak
   *  into a later mutation-driven revalidation). Safe to call unconditionally — `consume()` already
   *  cleared it when the dashboard was matched. */
  end() {
    polling = false
  },
}
