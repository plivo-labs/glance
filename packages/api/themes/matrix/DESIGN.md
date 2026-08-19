---
version: alpha
name: Matrix
description: >-
  Phosphor-green terminal noir. Pure black canvas, #00e63a glowing text,
  CRT scanlines, monospace everything, uppercase prompt-prefixed headings.
colors:
  background: "#000000"
  foreground: "#008722"      # dual-ground green: ~4.5:1 on BOTH black and white
  foreground-dim: "#067027"  # secondary text, prompts, rules
  foreground-bright: "#00e63a" # neon - ONLY on theme-owned dark surfaces (thead, code, buttons)
  foreground-max: "#ccffcc"    # ONLY on the thead strip
  surface: "#041207"         # code blocks, inputs, thead
  border: "#0c4d1d"
typography:
  body:
    fontFamily: "'Courier New', ui-monospace, monospace"
    lineHeight: 1.55
  heading:
    fontFamily: "inherit (mono)"
    fontWeight: 700
    transform: "uppercase"
    letterSpacing: "0.08em"
---

# Matrix DESIGN.md

Build pages that feel like a terminal inside the Matrix: phosphor green on
pure black, soft CRT glow, scanlines, everything monospace.

## Rules

1. **One color, and it must read on ANY ground.** Bare text (body, headings,
   links) is dual-ground green `#008722` - legible on the black page AND on a
   card an author painted white. Neon `#00e63a`/`#ccffcc` appears ONLY on
   surfaces the theme itself paints dark (thead strip, code blocks, button
   hover). No other hues, ever.
2. **Glow is a headline privilege.** Only h1/h2 carry the text-shadow glow
   (`0 0 8px rgba(0,230,58,.5)`); body copy stays crisp. Backgrounds stay
   pure black - the ground vignette provides the atmosphere.
3. **Monospace everything.** Body, headings, tables, buttons. Headings are
   UPPERCASE with wide tracking and a `> ` prompt prefix.
4. **Texture lives on the GROUND, never over content.** Fine scanlines +
   a soft green vignette as body background-image layers (fixed attachment).
   A container that paints its own background covers the CRT cleanly — the
   texture must never stripe someone's cards or images.
5. **Borders are dim green hairlines**, dashed for horizontal rules. Tables
   use full 1px grids like a curses UI.
6. **Motion is a flicker, not a dance.** At most a subtle opacity flicker on
   the h1; respect `prefers-reduced-motion`.
7. **Never filter images** - charts and screenshots must stay legible.

## Agent Prompt Guide

> Build this in the **Matrix style**: pure black background, phosphor-green
> monospace text (`#00e63a`, dim `#00a32c`, bright `#ccffcc` for headings and
> links). Glow on h1/h2 ONLY - body copy stays crisp. UPPERCASE `> `-prefixed
> headings, fine CRT scanlines + a soft green vignette as the page BACKGROUND
> (never an overlay above content), dashed green hairline rules, curses-style
> bordered tables, unfiltered images.
> No other colors, no rounded corners, no shadows except glow. Subtle h1
> flicker only, behind `prefers-reduced-motion`.
