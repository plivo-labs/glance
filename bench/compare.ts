// Compare two bench runs: bun bench/compare.ts <before.json> <after.json>
// Reports raw p50 delta and floor-adjusted delta (endpoint p50 minus that run's /me
// floor) so network drift between sessions doesn't masquerade as a win/regression.
const [beforePath, afterPath] = process.argv.slice(2)
if (!beforePath || !afterPath) {
  console.error('usage: bun bench/compare.ts <before.json> <after.json>')
  process.exit(1)
}
const before = await Bun.file(beforePath).json()
const after = await Bun.file(afterPath).json()

console.log(`before: ${before.label} @ ${before.when}  (floor ${before.calibrationFloorP50}ms)`)
console.log(`after:  ${after.label} @ ${after.when}  (floor ${after.calibrationFloorP50}ms)\n`)
console.log('endpoint      before-p50   after-p50    delta   floor-adj delta')
for (const k of Object.keys(before.endpoints)) {
  const b = before.endpoints[k], a = after.endpoints[k]
  if (!a) continue
  const delta = a.p50 - b.p50
  const adj = (a.p50 - after.calibrationFloorP50) - (b.p50 - before.calibrationFloorP50)
  const fmt = (v: number) => (v > 0 ? '+' : '') + v + 'ms'
  console.log(
    `  ${k.padEnd(11)} ${String(b.p50).padStart(7)}ms ${String(a.p50).padStart(8)}ms  ${fmt(delta).padStart(8)}  ${fmt(adj).padStart(8)}`,
  )
}
