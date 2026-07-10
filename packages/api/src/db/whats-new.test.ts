import { describe, expect, test } from 'bun:test'
import { makeDb, seedUser } from '../test/harness'
import { getWatermark, setSeen } from './whats-new'

const OLD = '2026-01-01T00:00:00.000Z'
const MID = '2026-03-15T12:30:00.000Z'
const NEW = '2026-06-20T09:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

async function userAt(watermark: string | null) {
  const db = makeDb()
  const id = await seedUser(db, { id: 'u1' })
  if (watermark !== null) await setSeen(db, id, watermark, NEW) // seed via the same conditional write
  return { db, id }
}

describe('C3 setSeen.monotonic — an older throughDate never regresses a newer watermark', () => {
  test('setSeen(OLD) when watermark is already NEW → stays NEW', async () => {
    const { db, id } = await userAt(NEW)
    await setSeen(db, id, OLD, NEW)
    expect(await getWatermark(db, id)).toBe(NEW)
  })
})

describe('C4 setSeen.clamp & empty', () => {
  test('setSeen(FUTURE) clamps to the newest release date', async () => {
    const { db, id } = await userAt(null)
    await setSeen(db, id, FUTURE, NEW)
    expect(await getWatermark(db, id)).toBe(NEW)
  })
  test('empty catalog (newest null) → no-op, watermark stays null', async () => {
    const { db, id } = await userAt(null)
    await setSeen(db, id, MID, null)
    expect(await getWatermark(db, id)).toBeNull()
  })
})

describe('C5 setSeen.isolation — one user\'s watermark never touches another\'s', () => {
  test('setSeen(userA) leaves userB untouched', async () => {
    const db = makeDb()
    const a = await seedUser(db, { id: 'a' })
    const b = await seedUser(db, { id: 'b' })
    await setSeen(db, a, NEW, NEW)
    expect(await getWatermark(db, a)).toBe(NEW)
    expect(await getWatermark(db, b)).toBeNull()
  })
})

describe('C10 setSeen.keepsLarger — both serial orders converge on the newer watermark', () => {
  test('older→newer', async () => {
    const { db, id } = await userAt(null)
    await setSeen(db, id, OLD, NEW)
    await setSeen(db, id, MID, NEW)
    expect(await getWatermark(db, id)).toBe(MID)
  })
  test('newer→older converges on the same larger value (keep-larger, not last-write)', async () => {
    const { db, id } = await userAt(null)
    await setSeen(db, id, MID, NEW)
    await setSeen(db, id, OLD, NEW)
    expect(await getWatermark(db, id)).toBe(MID)
  })
})
