---
version: alpha
name: Kapow
description: >-
  A four-color comic page on aged newsprint. Bangers action headings with
  inked outlines, speech-bubble quotes, yellow caption boxes, halftone dots,
  hard-shadow panels.
colors:
  paper: "#f6eee3"           # aged newsprint ground (+ low-alpha red halftone dots)
  ink: "#14100c"             # outlines, borders, body text
  red: "#ed1c24"             # process red - h2, em, button fill
  yellow: "#ffde00"          # process yellow - h1 fill, mark chips, table heads
  caption: "#fff48c"         # narration caption boxes (figcaption/summary)
  cyan: "#00aeef"            # process cyan - links
typography:
  display:
    fontFamily: "'Bangers', cursive"
    letterSpacing: "2px"
  body:
    fontFamily: "'Comic Neue', 'Comic Sans MS', cursive"
    fontSize: "1.05rem"
---

# Kapow DESIGN.md

Build pages like a printed comic: four process colors on newsprint, heavy
ink, everything in-universe.

## Rules

1. **Element = comic device.** blockquote is a SPEECH BUBBLE (white, 3px ink,
   30px radius, CSS-triangle tail); figcaption/summary are YELLOW CAPTION
   BOXES; mark is a SOUND-EFFECT chip (yellow, inked, skewed, Bangers);
   hr is a 6px panel GUTTER; tables/images/pre are inked PANELS with a hard
   6px offset shadow.
2. **Action-word headings**: Bangers with an ink outline
   (-webkit-text-stroke), h1 filled process yellow with a red drop, tilted
   -2deg. h2 in process red.
3. **Halftone ground**: two offset low-alpha red radial-gradient dot grids
   (9px tile) over `#f6eee3` newsprint - dots stay subtle, never over panels.
4. **Four colors only** (ink, red, yellow, cyan) + white panels. Cyan is
   links, red is emphasis/energy, yellow is fills.
5. **Body is Comic Neue, sentence case** - uppercase belongs to Bangers
   display only. No Comic Sans, no starburst clip-paths, no soft shadows.

## Agent Prompt Guide

> Build this in the **Kapow comic-book style**: aged newsprint `#f6eee3` with
> a subtle red halftone dot grid, ink `#14100c`, Comic Neue body (1.05rem),
> Bangers display. h1 = process-yellow `#ffde00` Bangers with 2px ink outline
> and a red `#ed1c24` hard shadow, tilted -2deg; h2 red Bangers. blockquote =
> white speech bubble (3px ink border, 30px radius, triangle tail);
> figcaption = yellow `#fff48c` inked caption box; mark = skewed yellow
> sound-effect chip in Bangers; hr = 6px ink gutter. Tables and images are
> white panels with 3px ink borders + 6px hard offset shadows. Links process
> cyan `#00aeef`, bold. Four colors, hard edges, no blur anywhere.
