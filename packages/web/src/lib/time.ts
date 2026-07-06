// Relative "time ago" for activity feeds and tables — compact, no dependency.
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  // Floor at every step so an age is never rounded UP (90s must read "1m", not "2m").
  const secs = Math.floor((Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
