import { useCallback } from 'react'

/**
 * BlueprintField — the centerpiece hero background for Glance.
 *
 * A full-viewport "engineering drafting table": a deep ink-blue technical grid
 * with a flow-field of particles advected along a dependency-free noise field.
 * Cyan-blue particles dominate; a minority drift in warm amber. Faint motion
 * trails trace the field; the grid sits underneath.
 *
 * Architecture constraints (project-wide):
 *   - NO useEffect / useLayoutEffect. ALL imperative setup lives inside a React 19
 *     ref CALLBACK that RETURNS its cleanup function. React 19 invokes the returned
 *     function when the node detaches, so the canvas lifecycle is fully self-contained.
 *   - DPR-aware (clamped) so it stays crisp on retina without melting low-end GPUs.
 *   - prefers-reduced-motion => render exactly one static frame, never start a RAF loop.
 *   - Leak-free: cancelAnimationFrame, disconnect ResizeObserver, remove all listeners.
 */

type BlueprintFieldProps = {
  /**
   * Particle density multiplier. Final count scales with viewport AREA and is
   * hard-capped for performance. 1 = default. ~0.5 calmer, ~1.5 denser.
   */
  density?: number
  /** Optional class for the wrapping element (e.g. positioning utilities). */
  className?: string
}

// ---------------------------------------------------------------------------
// Palette — deep ink-blue table, cool cyan particles, a single warm amber accent.
// ---------------------------------------------------------------------------
const COLORS = {
  bgTop: '#0b1224', // ink-blue, lighter at top for a faint overhead-light gradient
  bgBottom: '#070b16', // deepest ink at the bottom edge
  gridMinor: 'rgba(86, 130, 196, 0.060)', // hairline drafting lines
  gridMajor: 'rgba(96, 150, 220, 0.130)', // every Nth line, slightly brighter
  gridTick: 'rgba(120, 175, 240, 0.220)', // tick marks at major intersections
  trail: 'rgba(7, 11, 22, 0.082)', // translucent bg painted each frame => trails
  // Particle hues kept as HSL parts so per-particle alpha is cheap to vary.
  cyanH: 198,
  cyanS: 92,
  cyanL: 66,
  amber: '245, 158, 11', // #f59e0b
} as const

// Tuning constants (module scope => allocated once, never per frame).
const DPR_CAP = 2 // clamp devicePixelRatio: retina-crisp without 3x/4x cost
const GRID_MINOR = 28 // px between hairlines (CSS px)
const GRID_MAJOR_EVERY = 4 // every 4th hairline is a major line
const PARTICLES_PER_MPX = 150 // particles per "megapixel" of CSS area, pre-density
const PARTICLE_CAP = 900 // absolute hard ceiling regardless of screen size
const AMBER_RATIO = 0.12 // ~12% of particles are amber
const SPEED = 0.42 // base advection speed (px/frame at 60fps)
const FIELD_SCALE = 0.0016 // spatial frequency of the flow field (smaller = broader swirls)
const FIELD_DRIFT = 0.000045 // how fast the field itself evolves over time
const ROT_BIAS = 0.55 // blend toward axis-aligned angles so particles "trace" the grid
const MOUSE_RADIUS = 240 // px radius of pointer influence
const MOUSE_FORCE = 0.9 // strength of pointer push
const MOUSE_EASE = 0.06 // smoothing for parallax target (no jitter)

// ---------------------------------------------------------------------------
// Dependency-free value noise.
// Integer-lattice hash + smootherstep interpolation. ~1 octave is enough for a
// flow field; we add a slow second sample at a different scale/phase for organic
// motion without the cost (or the dependency) of full simplex noise.
// ---------------------------------------------------------------------------
function hash2(ix: number, iy: number): number {
  // Cheap deterministic hash -> [0,1). Trig-free integer mixing keeps it fast.
  let h = (ix * 374761393 + iy * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  // >>> 0 makes it unsigned before normalizing.
  return (h >>> 0) / 4294967296
}

// Smootherstep (Ken Perlin's quintic) — C2 continuous => no banding in the field.
function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smoother(x - x0)
  const fy = smoother(y - y0)
  const n00 = hash2(x0, y0)
  const n10 = hash2(x0 + 1, y0)
  const n01 = hash2(x0, y0 + 1)
  const n11 = hash2(x0 + 1, y0 + 1)
  const nx0 = n00 + fx * (n10 - n00)
  const nx1 = n01 + fx * (n11 - n01)
  return nx0 + fy * (nx1 - nx0) // [0,1)
}

const TAU = Math.PI * 2

/**
 * Flow angle at a point in time. Layered value noise -> [0,1), mapped to an
 * angle, then nudged toward the nearest grid axis (0 / 90 / 180 / 270) by ROT_BIAS
 * so the motion visually "draws" the blueprint instead of swirling generically.
 */
function fieldAngle(x: number, y: number, t: number): number {
  const nx = x * FIELD_SCALE
  const ny = y * FIELD_SCALE
  // Two samples at differing scale + phase, evolving in opposite time directions.
  const a = valueNoise(nx + t, ny - t * 0.7)
  const b = valueNoise(nx * 1.9 - t * 0.6 + 11.3, ny * 1.9 + t + 4.7)
  const raw = (a * 0.65 + b * 0.35) * TAU * 2 // span >TAU so the field has full rotation

  // Snap-bias toward the nearest right-angle without hard quantizing (keeps it fluid).
  const snapped = Math.round(raw / (Math.PI / 2)) * (Math.PI / 2)
  return raw + (snapped - raw) * ROT_BIAS
}

type Particle = {
  x: number
  y: number
  px: number // previous position, so we draw a segment (a "stroke") not a dot
  py: number
  speed: number
  life: number // frames remaining before respawn (prevents clumping at attractors)
  amber: boolean
  alpha: number
}

export function BlueprintField({ density = 1, className }: BlueprintFieldProps) {
  // setCanvas is the React 19 ref callback. Everything — context, sizing,
  // particles, listeners, the RAF loop — is created here and torn down by the
  // returned cleanup. useCallback keeps the ref identity stable so React doesn't
  // detach/reattach (which would needlessly restart the animation) across renders.
  const setCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return

      const reduceMotion =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches

      // Live, mutable render state. Kept in one object so the closure has a single
      // source of truth and the cleanup can flip `running` to stop any in-flight work.
      const state = {
        wCss: 0, // CSS pixels (logical)
        hCss: 0,
        dpr: 1,
        particles: [] as Particle[],
        rafId: 0,
        running: true,
        t: 0, // field time accumulator
        // Pointer parallax: `mx/my` chase `tmx/tmy` for buttery, jitter-free influence.
        mx: -9999,
        my: -9999,
        tmx: -9999,
        tmy: -9999,
        hasPointer: false,
      }

      // --- Sizing (DPR-aware) -------------------------------------------------
      // Backing store = CSS size * clamped DPR; context scaled so all draw calls
      // use CSS px. Recomputed on resize; particle pool rescaled to the new area.
      function resize() {
        const rect = canvas!.getBoundingClientRect()
        const wCss = Math.max(1, Math.round(rect.width))
        const hCss = Math.max(1, Math.round(rect.height))
        const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP)
        state.wCss = wCss
        state.hCss = hCss
        state.dpr = dpr
        canvas!.width = Math.round(wCss * dpr)
        canvas!.height = Math.round(hCss * dpr)
        // Reset transform to identity, then scale to CSS px (avoids compounding).
        ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
        rebuildParticles()
        paintBackground()
        drawGrid()
        if (reduceMotion) drawParticlesStatic() // one-shot render, no loop
      }

      // --- Particle pool ------------------------------------------------------
      // Count scales with CSS area (megapixels), then density, then hard cap.
      function targetCount(): number {
        const mpx = (state.wCss * state.hCss) / 1_000_000
        return Math.min(PARTICLE_CAP, Math.round(mpx * PARTICLES_PER_MPX * density))
      }

      function spawn(p: Particle) {
        p.x = Math.random() * state.wCss
        p.y = Math.random() * state.hCss
        p.px = p.x
        p.py = p.y
        p.speed = SPEED * (0.6 + Math.random() * 0.9)
        p.life = 120 + Math.random() * 360
        p.amber = Math.random() < AMBER_RATIO
        p.alpha = 0.25 + Math.random() * 0.45
        return p
      }

      // Grow/shrink the pool in place — reuses existing objects so resize never
      // churns the heap. Allocation happens here only, never inside the frame loop.
      function rebuildParticles() {
        const want = targetCount()
        const arr = state.particles
        while (arr.length < want) arr.push(spawn({} as Particle))
        if (arr.length > want) arr.length = want
      }

      // --- Static layers ------------------------------------------------------
      function paintBackground() {
        const g = ctx!.createLinearGradient(0, 0, 0, state.hCss)
        g.addColorStop(0, COLORS.bgTop)
        g.addColorStop(1, COLORS.bgBottom)
        ctx!.fillStyle = g
        ctx!.fillRect(0, 0, state.wCss, state.hCss)
      }

      function drawGrid() {
        const w = state.wCss
        const h = state.hCss
        ctx!.lineWidth = 1

        // Minor hairlines.
        ctx!.beginPath()
        ctx!.strokeStyle = COLORS.gridMinor
        for (let x = 0; x <= w; x += GRID_MINOR) {
          // +0.5 aligns the 1px stroke to the device pixel grid => no blur.
          const gx = Math.round(x) + 0.5
          ctx!.moveTo(gx, 0)
          ctx!.lineTo(gx, h)
        }
        for (let y = 0; y <= h; y += GRID_MINOR) {
          const gy = Math.round(y) + 0.5
          ctx!.moveTo(0, gy)
          ctx!.lineTo(w, gy)
        }
        ctx!.stroke()

        // Major lines (every GRID_MAJOR_EVERY cells).
        const major = GRID_MINOR * GRID_MAJOR_EVERY
        ctx!.beginPath()
        ctx!.strokeStyle = COLORS.gridMajor
        for (let x = 0; x <= w; x += major) {
          const gx = Math.round(x) + 0.5
          ctx!.moveTo(gx, 0)
          ctx!.lineTo(gx, h)
        }
        for (let y = 0; y <= h; y += major) {
          const gy = Math.round(y) + 0.5
          ctx!.moveTo(0, gy)
          ctx!.lineTo(w, gy)
        }
        ctx!.stroke()

        // Tick crosses at major intersections — the small detail that reads as
        // "engineering drawing" rather than "spreadsheet".
        ctx!.strokeStyle = COLORS.gridTick
        ctx!.beginPath()
        for (let x = 0; x <= w; x += major) {
          for (let y = 0; y <= h; y += major) {
            const gx = Math.round(x) + 0.5
            const gy = Math.round(y) + 0.5
            ctx!.moveTo(gx - 3, gy)
            ctx!.lineTo(gx + 3, gy)
            ctx!.moveTo(gx, gy - 3)
            ctx!.lineTo(gx, gy + 3)
          }
        }
        ctx!.stroke()
      }

      // --- Particle drawing ---------------------------------------------------
      // Renders each particle as a short stroke from its previous to current
      // position. additive blending makes overlaps glow like phosphor on a CRT.
      function drawParticleStroke(p: Particle) {
        const hue = p.amber ? null : COLORS.cyanH
        if (hue === null) {
          ctx!.strokeStyle = `rgba(${COLORS.amber}, ${p.alpha})`
        } else {
          ctx!.strokeStyle = `hsla(${hue}, ${COLORS.cyanS}%, ${COLORS.cyanL}%, ${p.alpha})`
        }
        ctx!.lineWidth = p.amber ? 1.4 : 1.1
        ctx!.beginPath()
        ctx!.moveTo(p.px, p.py)
        ctx!.lineTo(p.x, p.y)
        ctx!.stroke()
      }

      // Static fallback frame: scatter dots once (no trails, no motion).
      function drawParticlesStatic() {
        ctx!.globalCompositeOperation = 'lighter'
        for (let i = 0; i < state.particles.length; i++) {
          const p = state.particles[i]
          if (p.amber) ctx!.fillStyle = `rgba(${COLORS.amber}, ${p.alpha})`
          else
            ctx!.fillStyle = `hsla(${COLORS.cyanH}, ${COLORS.cyanS}%, ${COLORS.cyanL}%, ${p.alpha})`
          ctx!.beginPath()
          ctx!.arc(p.x, p.y, p.amber ? 1.6 : 1.2, 0, TAU)
          ctx!.fill()
        }
        ctx!.globalCompositeOperation = 'source-over'
      }

      // --- The frame ----------------------------------------------------------
      function frame() {
        if (!state.running) return
        const w = state.wCss
        const h = state.hCss

        // 1) Translucent bg wash => previous frame fades, leaving motion trails.
        //    (We intentionally do NOT redraw the full opaque bg or grid every frame;
        //     letting the grid soften under trails is part of the look and far cheaper.)
        ctx!.globalCompositeOperation = 'source-over'
        ctx!.fillStyle = COLORS.trail
        ctx!.fillRect(0, 0, w, h)

        // 2) Periodically restamp the grid faintly so trails never fully bury it.
        //    Cheap because it's just a couple of strokes, gated to every 6th frame.
        gridRestampCounter++
        if (gridRestampCounter >= 6) {
          gridRestampCounter = 0
          drawGrid()
        }

        // 3) Advance the field clock and the eased pointer parallax.
        state.t += FIELD_DRIFT * 1000
        state.mx += (state.tmx - state.mx) * MOUSE_EASE
        state.my += (state.tmy - state.my) * MOUSE_EASE

        // 4) Advect + draw every particle. Additive blend for the phosphor glow.
        ctx!.globalCompositeOperation = 'lighter'
        const haveMouse = state.hasPointer
        for (let i = 0; i < state.particles.length; i++) {
          const p = state.particles[i]
          p.px = p.x
          p.py = p.y

          const ang = fieldAngle(p.x, p.y, state.t)
          let vx = Math.cos(ang) * p.speed
          let vy = Math.sin(ang) * p.speed

          // Pointer influence: gentle radial push within MOUSE_RADIUS, falling off
          // smoothly. Subtle — it perturbs the field rather than dominating it.
          if (haveMouse) {
            const dx = p.x - state.mx
            const dy = p.y - state.my
            const d2 = dx * dx + dy * dy
            const r2 = MOUSE_RADIUS * MOUSE_RADIUS
            if (d2 < r2 && d2 > 0.0001) {
              const d = Math.sqrt(d2)
              const f = (1 - d / MOUSE_RADIUS) * MOUSE_FORCE
              vx += (dx / d) * f
              vy += (dy / d) * f
            }
          }

          p.x += vx
          p.y += vy
          p.life--

          // Respawn when expired or off-canvas — keeps density even, prevents
          // every particle pooling in the field's attractors over time.
          if (
            p.life <= 0 ||
            p.x < -10 ||
            p.x > w + 10 ||
            p.y < -10 ||
            p.y > h + 10
          ) {
            spawn(p)
            continue // don't draw a stroke across the respawn teleport
          }

          drawParticleStroke(p)
        }
        ctx!.globalCompositeOperation = 'source-over'

        state.rafId = requestAnimationFrame(frame)
      }
      let gridRestampCounter = 0

      // --- Listeners ----------------------------------------------------------
      // Pointer only sets the *target*; the loop eases toward it => no per-event work
      // beyond two assignments, and motion stays smooth regardless of event rate.
      function onPointerMove(e: PointerEvent) {
        const rect = canvas!.getBoundingClientRect()
        state.tmx = e.clientX - rect.left
        state.tmy = e.clientY - rect.top
        if (!state.hasPointer) {
          // First move: snap (don't ease in from the off-screen sentinel).
          state.mx = state.tmx
          state.my = state.tmy
          state.hasPointer = true
        }
      }
      function onPointerLeave() {
        state.hasPointer = false
        state.tmx = -9999
        state.tmy = -9999
      }

      // ResizeObserver handles container resize, orientation change, and zoom —
      // more reliable than window 'resize' for an element that fills its parent.
      const ro = new ResizeObserver(() => resize())
      ro.observe(canvas)

      // --- Boot ---------------------------------------------------------------
      resize() // sizes, builds particles, paints bg + grid (+ static frame if reduced)

      if (!reduceMotion) {
        window.addEventListener('pointermove', onPointerMove, { passive: true })
        canvas.addEventListener('pointerleave', onPointerLeave, { passive: true })
        state.rafId = requestAnimationFrame(frame)
      }

      // --- Cleanup (React 19 runs this when the node detaches) ----------------
      // Stops the loop, kills the RAF, disconnects the observer, removes listeners,
      // and drops particle references so nothing is retained after unmount.
      return () => {
        state.running = false
        cancelAnimationFrame(state.rafId)
        ro.disconnect()
        window.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerleave', onPointerLeave)
        state.particles.length = 0
      }
    },
    [density],
  )

  return (
    <div
      className={className}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
    >
      <canvas
        ref={setCanvas}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  )
}

export default BlueprintField