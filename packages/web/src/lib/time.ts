// Relative "time ago" for activity feeds and tables — compact, no dependency.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

export function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs >= 30 * 86_400)
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  for (const [unit, unitSecs] of UNITS) {
    // Floor so an age is never rounded UP (90s must read as 1 minute, not 2).
    if (secs >= unitSecs) return rtf.format(-Math.floor(secs / unitSecs), unit)
  }
  return rtf.format(0, 'second') // "now"
}

// Calendar date for a FUTURE timestamp (key expiry) — "expires 2026-10-29", not relative math:
// an expiry you might screenshot into a runbook should read as a fixed date, not "in 47 days".
export function isoDate(iso: string): string {
  return iso.slice(0, 10)
}
