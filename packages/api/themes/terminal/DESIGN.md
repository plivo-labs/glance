---
version: alpha
name: Terminal
description: >-
  Amber-phosphor VT220 terminal. Warm near-black canvas, #ffb000 text with a
  soft glow, monospace everything, shell-prompt heading prefixes.
colors:
  background: "#100b00"
  foreground: "#ffb000"      # amber phosphor - body text
  foreground-dim: "#b37c00"  # secondary, prompts, rules
  foreground-bright: "#ffd75e" # headings, links, emphasis
  surface: "#1a1200"         # code blocks, inputs
  border: "#4d3800"
typography:
  body:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    lineHeight: 1.55
  heading:
    fontFamily: "inherit (mono)"
    fontWeight: 700
    letterSpacing: "0.04em"
---

# Terminal DESIGN.md

Build pages that read like an amber-phosphor serial terminal: warm dark
canvas, glowing `#ffb000` text, everything monospace, shell-prompt affordances.

## Rules

1. **Amber, three intensities.** Dim `#b37c00` for chrome and prompts, base
   `#ffb000` for body, bright `#ffd75e` for headings, links and emphasis.
   No other hues.
2. **Soft glow** (`text-shadow: 0 0 4px rgba(255,176,0,.4)`) on text; the
   background is a warm near-black `#100b00`, never pure black.
3. **Prompt prefixes.** `$ ` before h1, `>> ` before h2, in dim amber -
   headings read like commands.
4. **Monospace everything**; tables are 1px full grids; horizontal rules are
   dashed hairlines; buttons are outlined, not filled.
5. **No decoration beyond the phosphor.** No rounded corners, no shadows
   (except glow), no gradients.
6. **Images** warm to match: `sepia(1) saturate(2.2) brightness(0.9)`.

## Agent Prompt Guide

> Build this in the **amber Terminal style**: warm near-black `#100b00`
> background, amber monospace text (`#ffb000`, dim `#b37c00`, bright `#ffd75e`
> for headings/links) with a soft glow, `$ `/`>> ` prompt-prefixed headings,
> dashed amber hairlines, 1px-grid tables, outlined buttons. Monospace
> everything, no other colors, no gradients or rounded corners.
