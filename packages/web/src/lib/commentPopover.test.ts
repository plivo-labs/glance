import { describe, expect, test } from 'bun:test'
import {
  type Anchor,
  initialPopover,
  placePopover,
  type PopoverEvent,
  type PopoverState,
  stepPopover,
} from './commentPopover'

// Slice A1 — the select → chip → composer → save lifecycle, pinned at the reducer. A reducer suite
// cannot prove real-iframe timing (a genuine pointerdown/selectionchange race); it pins the
// decisions the viewer executes.

const A: Anchor = {
  quote: 'alpha',
  context: { prefix: 'a-', suffix: '-a' },
  rect: { top: 10, left: 10, width: 50, height: 12 },
}
const B: Anchor = {
  quote: 'bravo',
  context: { prefix: 'b-', suffix: '-b' },
  rect: { top: 90, left: 20, width: 60, height: 14 },
}

// Drive a sequence of events, returning the final state.
function run(events: PopoverEvent[]): PopoverState {
  let state = initialPopover()
  for (const e of events) state = stepPopover(state, e)
  return state
}

describe('SELECT-EMITS-CHIP-NOT-COMPOSER', () => {
  test('select from idle sets chip, composer stays null', () => {
    const state = run([{ type: 'select', anchor: A, dirty: false }])
    expect(state.chip).toEqual(A)
    expect(state.composer).toBeNull()
  })

  test('select while a composer is already open still does not open a second composer', () => {
    const state = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'select', anchor: B, dirty: false },
    ])
    expect(state.composer?.anchor).toEqual(B) // re-anchored (clean draft), not duplicated
    expect(state.chip).toEqual(B)
  })
})

describe('a dirty draft is never moved or destroyed by a new selection', () => {
  test('select with dirty:true leaves composer.anchor and composer.id EXACTLY as they were', () => {
    const opened = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }])
    const state = stepPopover(opened, { type: 'select', anchor: B, dirty: true })
    expect(state.composer).toEqual(opened.composer) // same id, same anchor — untouched
    expect(state.chip).toEqual(B) // the chip may follow the new selection
  })

  test('select with dirty:false may re-anchor the composer to the new selection, KEEPING its id', () => {
    const opened = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }])
    const state = stepPopover(opened, { type: 'select', anchor: B, dirty: false })
    expect(state.composer?.anchor).toEqual(B)
    // A re-anchor moves a composer, it does not replace it — the id is what a settle matches on,
    // and what the UI keys the draft to.
    expect(state.composer?.id).toBe(opened.composer?.id as number)
    expect(state.seq).toBe(opened.seq)
  })

  test('clicking the chip over a DIRTY composer deliberately mints a new one (draft is dropped)', () => {
    // Explicit intent, unlike a bare selection. Pinned because A2-ui keys the Composer on this id:
    // the id change is what discards the draft, and that is the ruling, not an accident.
    const dirtyOnA = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'select', anchor: B, dirty: true },
    ])
    expect(dirtyOnA.composer?.anchor).toEqual(A)
    const state = stepPopover(dirtyOnA, { type: 'activate' })
    expect(state.composer).toEqual({ id: 2, anchor: B })
  })
})

describe('chip activation survives the select-clear it causes', () => {
  test('select -> activate -> clear keeps the composer open on the right anchor', () => {
    const state = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'clear' }, // clicking the chip collapsed the iframe selection
    ])
    expect(state.composer?.anchor).toEqual(A) // still open, still on A
    expect(state.chip).toBeNull() // clear may only ever retire the chip
  })

  test('clear with no composer open just retires the chip', () => {
    const state = run([{ type: 'select', anchor: A, dirty: false }, { type: 'clear' }])
    expect(state.chip).toBeNull()
    expect(state.composer).toBeNull()
  })

  test('activate with no chip is inert — there is nothing to anchor to', () => {
    expect(run([{ type: 'activate' }])).toEqual(initialPopover())
  })
})

describe('C opens the composer in exactly one state (#117)', () => {
  test('chip showing, no composer: commentKey opens the composer on the chip — same as a click', () => {
    const clicked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }])
    const keyed = run([{ type: 'select', anchor: A, dirty: false }, { type: 'commentKey' }])
    expect(keyed).toEqual(clicked)
  })

  test('composer already open: inert, draft and all — the user is typing, `c` is a letter', () => {
    for (const dirty of [false, true]) {
      const open = run([
        { type: 'select', anchor: A, dirty: false },
        { type: 'activate' },
        { type: 'select', anchor: B, dirty },
      ])
      expect(stepPopover(open, { type: 'commentKey' })).toBe(open) // same reference: nothing happened
    }
  })

  test('no chip: inert — the iframe fires on its own selection, the parent may have dismissed', () => {
    // Exactly the state Escape/click-away leaves behind while the frame's selection survives, which
    // is why the iframe is allowed to fire liberally.
    const dismissed = run([{ type: 'select', anchor: A, dirty: false }, { type: 'dismiss' }])
    expect(stepPopover(dismissed, { type: 'commentKey' })).toBe(dismissed)
    expect(run([{ type: 'commentKey' }])).toEqual(initialPopover())
  })

  test('a saving composer is still a composer: commentKey cannot mint one over an in-flight write', () => {
    const saving = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    expect(stepPopover(saving, { type: 'commentKey' })).toBe(saving)
  })
})

describe('askActivate / askKey — the ask panel (mirrors activate / commentKey)', () => {
  test('askActivate with no chip is inert', () => {
    expect(run([{ type: 'askActivate' }])).toEqual(initialPopover())
  })

  test('askActivate opens ask on the chip anchor and mints a fresh seq', () => {
    const state = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    expect(state.ask).toEqual({ id: 1, anchor: A })
    expect(state.seq).toBe(1)
  })

  test('askActivate closes an open composer, even a dirty one', () => {
    const dirty = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'select', anchor: B, dirty: true },
    ])
    expect(dirty.composer).not.toBeNull()
    const state = stepPopover(dirty, { type: 'askActivate' })
    expect(state.composer).toBeNull()
    expect(state.ask?.anchor).toEqual(B) // askActivate anchors on the CURRENT chip
  })

  test('activate closes an open ask panel (mutual exclusion)', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    expect(asked.ask).not.toBeNull()
    const state = stepPopover(asked, { type: 'activate' })
    expect(state.ask).toBeNull()
    expect(state.composer?.anchor).toEqual(A)
  })

  test('askKey opens ask in exactly one state: chip showing, no composer, no ask', () => {
    const clicked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    const keyed = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askKey' }])
    expect(keyed).toEqual(clicked)
  })

  test('askKey is inert with no chip', () => {
    expect(run([{ type: 'askKey' }])).toEqual(initialPopover())
  })

  test('askKey is inert while a composer is open', () => {
    const composing = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }])
    expect(stepPopover(composing, { type: 'askKey' })).toBe(composing)
  })

  test('askKey is inert while ask is already open', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askKey' }])
    expect(stepPopover(asked, { type: 'askKey' })).toBe(asked)
  })

  test('commentKey is inert while ask is open (symmetry with its composer gate)', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    expect(stepPopover(asked, { type: 'commentKey' })).toBe(asked)
  })

  test('commentKey closes an open ask panel when it fires', () => {
    // Reach commentKey-fires state (chip, no composer, no ask) via dismiss first.
    const dismissedAsk = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'askActivate' },
      { type: 'dismiss' },
      { type: 'select', anchor: A, dirty: false },
    ])
    expect(dismissedAsk.ask).toBeNull()
    const state = stepPopover(dismissedAsk, { type: 'commentKey' })
    expect(state.ask).toBeNull()
    expect(state.composer?.anchor).toEqual(A)
  })

  test('select does NOT re-anchor or close an open ask panel — the answer stays put while reading', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    const state = stepPopover(asked, { type: 'select', anchor: B, dirty: false })
    expect(state.ask).toEqual(asked.ask) // untouched: same id, same anchor (still A)
    expect(state.chip).toEqual(B) // the chip still tracks the live selection
  })

  test('clear (chip-only) does not close ask', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }, { type: 'clear' }])
    expect(asked.ask).not.toBeNull()
    expect(asked.chip).toBeNull()
  })

  test('clickAway with dirty:true leaves ask open (nothing to lose, but nothing forces it shut either)', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    const state = stepPopover(asked, { type: 'clickAway', dirty: true })
    expect(state.ask).toEqual(asked.ask)
  })

  test('clickAway with dirty:false closes ask', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    const state = stepPopover(asked, { type: 'clickAway', dirty: false })
    expect(state.ask).toBeNull()
  })

  test('dismiss closes ask', () => {
    const asked = run([{ type: 'select', anchor: A, dirty: false }, { type: 'askActivate' }])
    const state = stepPopover(asked, { type: 'dismiss' })
    expect(state.ask).toBeNull()
  })
})

describe('saving(A) -> select(B) -> saveSettled(ok,A) leaves B live', () => {
  test('a settle whose id no longer matches the open composer clears saving and NOTHING else', () => {
    const savingA = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    const idA = savingA.saving?.id
    expect(idA).toBe(savingA.composer?.id as number)

    // the old composer goes away and a NEW one is opened on B while A's write is in flight
    const live = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'submit' },
      { type: 'dismiss' },
      { type: 'select', anchor: B, dirty: false },
      { type: 'activate' },
    ])
    expect(live.composer?.anchor).toEqual(B)
    const settled = stepPopover(live, { type: 'saveSettled', id: idA as number, ok: true })
    expect(settled.composer).toEqual(live.composer) // B untouched — not closed, not re-anchored
    expect(settled.chip).toEqual(live.chip) // and the newer chip is not wiped
    expect(settled.saving).toBeNull()
  })

  test('the LITERAL sequence: a success for the composer still open must not wipe the newer chip', () => {
    // No dismiss in between — the composer that submitted A is still open (its text keeps it
    // dirty) while the user highlights B. The settle may close that composer; the chip is the
    // CURRENT selection and is none of its business.
    const dirtyOnB = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'submit' },
      { type: 'select', anchor: B, dirty: true },
    ])
    expect(dirtyOnB.chip).toEqual(B)
    const settled = stepPopover(dirtyOnB, { type: 'saveSettled', id: dirtyOnB.saving?.id as number, ok: true })
    expect(settled.chip).toEqual(B) // B stays live
    expect(settled.composer).toBeNull() // the composer whose write landed is done
  })

  test('a settle never touches a chip when no composer is open at all', () => {
    const chipOnly = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'submit' },
      { type: 'dismiss' },
      { type: 'select', anchor: B, dirty: false },
    ])
    expect(chipOnly.composer).toBeNull()
    const settled = stepPopover(chipOnly, { type: 'saveSettled', id: chipOnly.saving?.id as number, ok: true })
    expect(settled.chip).toEqual(B)
    expect(settled.saving).toBeNull()
  })
})

describe('a failed settle clears only saving; the composer stays open and retryable', () => {
  test('saveSettled ok:false closes nothing', () => {
    const submitted = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    const state = stepPopover(submitted, { type: 'saveSettled', id: submitted.saving?.id as number, ok: false })
    expect(state.composer).toEqual(submitted.composer) // same id + anchor → the draft survives
    expect(state.saving).toBeNull() // retryable
  })

  test('a SUCCESSFUL settle for the currently open composer closes it', () => {
    // The whole real sequence: the chip-click collapsed the selection ('clear') before the write,
    // so success leaves the popover fully torn down.
    const submitted = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'clear' },
      { type: 'submit' },
    ])
    const state = stepPopover(submitted, { type: 'saveSettled', id: submitted.saving?.id as number, ok: true })
    expect(state.composer).toBeNull()
    expect(state.chip).toBeNull()
    expect(state.saving).toBeNull()
  })

  test('a failed write can be retried: the second submit re-tags the SAME composer id', () => {
    const submitted = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    const failed = stepPopover(submitted, { type: 'saveSettled', id: submitted.saving?.id as number, ok: false })
    const retried = stepPopover(failed, { type: 'submit' })
    expect(retried.saving).toEqual(submitted.saving) // the tag identifies the composer, not the attempt
    const state = stepPopover(retried, { type: 'saveSettled', id: retried.saving?.id as number, ok: true })
    expect(state.composer).toBeNull()
    expect(state.saving).toBeNull()
  })

  test('submit leaves the chip alone — the selection affordance is not the write', () => {
    const state = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    expect(state.chip).toEqual(A)
  })

  test('a success retires the chip when it is the quote that was just commented on', () => {
    // No 'clear' in between: clicking a PARENT chip does not reliably collapse the selection inside
    // a cross-origin iframe (focus leaves the frame, but browsers keep the range), so the trailing
    // clear the other tests lean on may simply never arrive. Without this, a successful save leaves
    // a live "Comment" chip sitting on the sentence the user just finished commenting on.
    const submitted = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    expect(submitted.chip).toEqual(A)
    const state = stepPopover(submitted, { type: 'saveSettled', id: submitted.saving?.id as number, ok: true })
    expect(state.composer).toBeNull()
    expect(state.chip).toBeNull()
  })

  test('a FAILED write leaves that same chip alone — nothing was commented on', () => {
    const submitted = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    const state = stepPopover(submitted, { type: 'saveSettled', id: submitted.saving?.id as number, ok: false })
    expect(state.chip).toEqual(A)
    expect(state.composer).toEqual(submitted.composer)
  })
})

describe('monotonic save ids; a stale settle is inert', () => {
  test('ids are never reused across composers', () => {
    const ids: number[] = []
    let state = initialPopover()
    for (const anchor of [A, B, A]) {
      for (const e of [{ type: 'select', anchor, dirty: false }, { type: 'activate' }] as PopoverEvent[]) {
        state = stepPopover(state, e)
      }
      ids.push(state.composer?.id as number)
      state = stepPopover(state, { type: 'dismiss' })
    }
    expect(ids).toEqual([1, 2, 3])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a settle for an id that was never the open composer changes nothing', () => {
    const submitted = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'submit' }])
    expect(stepPopover(submitted, { type: 'saveSettled', id: 999, ok: true })).toEqual(submitted)
    expect(stepPopover(initialPopover(), { type: 'saveSettled', id: 1, ok: true })).toEqual(initialPopover())
  })

  test('submit with no composer open is inert', () => {
    expect(run([{ type: 'submit' }])).toEqual(initialPopover())
  })
})

describe('dismiss closes; clickAway with dirty:true does NOT close', () => {
  test('dismiss always closes the composer AND the chip', () => {
    const state = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }, { type: 'dismiss' }])
    expect(state.composer).toBeNull()
    expect(state.chip).toBeNull()
  })

  test('dismiss does NOT cancel an in-flight write — the spinner outlives the popover', () => {
    const state = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'submit' },
      { type: 'dismiss' },
    ])
    expect(state.saving).toEqual({ id: 1 }) // the reducer cannot abort a request it did not make
  })

  test('dismiss closes even a DIRTY composer — it is explicit intent', () => {
    const state = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'select', anchor: B, dirty: true },
      { type: 'dismiss' },
    ])
    expect(state.composer).toBeNull()
  })

  test('clickAway with dirty:true leaves the dirty composer open on its anchor', () => {
    const opened = run([{ type: 'select', anchor: A, dirty: false }, { type: 'activate' }])
    const state = stepPopover(opened, { type: 'clickAway', dirty: true })
    expect(state.composer).toEqual(opened.composer) // a pointerdown is also how the next drag starts
  })

  test('clickAway with dirty:false closes the composer and the chip', () => {
    const state = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'clickAway', dirty: false },
    ])
    expect(state.composer).toBeNull()
    expect(state.chip).toBeNull()
  })

  test('a dirty clickAway does not block the NEXT selection from re-chipping', () => {
    const state = run([
      { type: 'select', anchor: A, dirty: false },
      { type: 'activate' },
      { type: 'clickAway', dirty: true },
      { type: 'select', anchor: B, dirty: true },
    ])
    expect(state.chip).toEqual(B)
    expect(state.composer?.anchor).toEqual(A) // still the dirty draft's anchor
  })
})

// placePopover — pure flip/shift geometry. The container is the iframe wrapper (the rect's own
// coordinate space); measuring real elements is the component's job, so these pin only the math.
describe('PLACE-POPOVER-STAYS-IN-CONTAINER', () => {
  const CONTAINER = { width: 800, height: 600 }
  const SIZE = { width: 320, height: 150 }

  test('fits below: pinned under the rect at its left edge', () => {
    expect(placePopover({ top: 100, left: 40, width: 200, height: 18 }, SIZE, CONTAINER)).toEqual({
      top: 100 + 18 + 8,
      left: 40,
    })
  })

  test('near the right edge: shifted left just enough to fit, still below', () => {
    const p = placePopover({ top: 100, left: 700, width: 80, height: 18 }, SIZE, CONTAINER)
    expect(p.left).toBe(800 - 320 - 8)
    expect(p.top).toBe(100 + 18 + 8)
  })

  test('near the bottom: flipped above, anchored by `bottom` so growth extends upward', () => {
    const p = placePopover({ top: 550, left: 40, width: 200, height: 18 }, SIZE, CONTAINER)
    expect(p.top).toBeUndefined()
    expect(p.bottom).toBe(600 - 550 + 8)
    expect(p.left).toBe(40)
  })

  test('fits on neither side: takes the side with more room rather than flipping blindly', () => {
    // Rect near the top of a short container — below overflows, but above has even less room.
    const p = placePopover({ top: 20, left: 10, width: 50, height: 12 }, SIZE, { width: 800, height: 300 })
    expect(p.top).toBe(20 + 12 + 8)
    expect(p.bottom).toBeUndefined()
  })

  test('never shifted past the container’s own left inset', () => {
    expect(placePopover({ top: 100, left: -20, width: 50, height: 12 }, SIZE, CONTAINER).left).toBe(8)
  })
})
