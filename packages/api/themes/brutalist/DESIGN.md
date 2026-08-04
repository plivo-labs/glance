---
version: alpha
name: Brutalist
description: >-
  Neo-brutalism. Raw off-white, 3px black borders, hard offset shadows
  (never blurred), marker-yellow highlights, shouty Arial Black headings.
colors:
  background: "#fffef5"
  foreground: "#000000"
  yellow: "#ffe600"          # marker highlight, h1 slab, table heads, buttons
  pink: "#ff90e8"            # mark, button hover
  cyan: "#23d5d5"            # link underlines, link hover fill
  shadow: "4px 4px 0 #000000"
typography:
  body:
    fontFamily: "Arial, 'Helvetica Neue', sans-serif"
  heading:
    fontFamily: "'Arial Black', Arial, sans-serif"
    fontWeight: 900
    transform: "uppercase"
---

# Brutalist DESIGN.md

Build pages that punch: raw structure, thick borders, hard shadows, marker
highlights. Nothing subtle, nothing soft.

## Rules

1. **Borders are 3px black; shadows are hard offsets** (`4px 4px 0 #000`) -
   never blurred, never gray. Zero border-radius.
2. **The h1 is a yellow slab**: `#ffe600` fill, 3px border, hard shadow,
   UPPERCASE Arial Black. h2 = thick black underline.
3. **Highlights are markers.** `strong` gets a yellow swipe, `mark` a pink
   one (bordered). Links underline 3px cyan and fill cyan on hover.
4. **Physicality.** Buttons visibly depress on :active (shadow collapses,
   element translates). Tables/quotes/images are bordered boxes with shadows.
5. **Code inverts**: black block, yellow text, hard shadow.

## Agent Prompt Guide

> Build this in the **neo-brutalist style**: off-white `#fffef5` page, black
> Arial text, UPPERCASE Arial Black headings. h1 = yellow `#ffe600` slab with
> 3px black border + hard `4px 4px 0 #000` shadow. Everything boxed: 3px
> black borders, hard offset shadows, zero radius, zero blur. strong = yellow
> marker swipe; mark = bordered pink `#ff90e8`; links = 3px cyan `#23d5d5`
> underline, cyan fill on hover. Buttons depress on click. Code = black block
> with yellow text.
