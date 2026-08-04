---
version: alpha
name: Matrix
description: >-
  Phosphor-green terminal noir. Pure black canvas, #00ff41 glowing text,
  CRT scanlines, monospace everything, uppercase prompt-prefixed headings.
colors:
  background: "#000000"
  foreground: "#00ff41"      # phosphor green - body text
  foreground-dim: "#00b32e"  # secondary text, prompts, rules
  foreground-bright: "#ccffcc" # headings, links, emphasis (the "white rabbit" tier)
  surface: "#030a04"         # code blocks, inputs
  border: "#0a3d17"
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

1. **One color, three intensities.** Everything is green: dim `#00b32e` for
   chrome and prompts, base `#00ff41` for body, bright `#ccffcc` for headings
   and links. No other hues, ever. White appears only inside `::selection`.
2. **Glow, don't glare.** Text carries a soft `text-shadow` glow
   (`0 0 6px rgba(0,255,65,.55)`); headings glow harder. Backgrounds stay
   pure black - the glow provides all the atmosphere.
3. **Monospace everything.** Body, headings, tables, buttons. Headings are
   UPPERCASE with wide tracking and a `> ` prompt prefix.
4. **Texture: scanlines.** A fixed repeating-linear-gradient overlay
   (2px transparent / 1px rgba(0,0,0,.22)) over the whole page, pointer-events
   none. Optional: a canvas digital-rain background at very low opacity behind
   content — never over it.
5. **Borders are dim green hairlines**, dashed for horizontal rules. Tables
   use full 1px grids like a curses UI.
6. **Motion is a flicker, not a dance.** At most a subtle opacity flicker on
   the h1; respect `prefers-reduced-motion`.
7. **Images** get a green treatment: `sepia(1) hue-rotate(70deg) saturate(3)`.

## Agent Prompt Guide

> Build this in the **Matrix style**: pure black background, phosphor-green
> monospace text (`#00ff41`, dim `#00b32e`, bright `#ccffcc` for headings and
> links), soft green text-shadow glow, UPPERCASE `> `-prefixed headings, CRT
> scanline overlay, dashed green hairline rules, curses-style bordered tables.
> No other colors, no rounded corners, no shadows except glow. Subtle h1
> flicker only, behind `prefers-reduced-motion`.
