---
version: alpha
name: Night City
description: >-
  Cyberpunk 2077 UI. Acid yellow on pure black, flat and hard-edged, clipped
  corners, Rajdhani type. Cyan is the second voice; red is danger only.
colors:
  background: "#000000"
  surface: "#120f0a"
  foreground: "#fcee0a"      # acid yellow - headings, emphasis, fills
  foreground-soft: "#d8bc66" # body text (dirty gold)
  border: "#58482c"
  cyan: "#00f0ff"            # links, secondary voice
  red: "#ff003c"             # danger, hover flicker, mark
typography:
  body:
    fontFamily: "'Rajdhani', 'Bahnschrift', 'Arial Narrow', sans-serif"
    fontWeight: 500
    lineHeight: 1.55
  heading:
    fontWeight: 700
    transform: "uppercase"
    letterSpacing: "0.06em"
---

# Night City DESIGN.md

Build pages that read like the Cyberpunk 2077 UI: acid yellow on black, flat,
geometric, hard-edged. This theme is NOT a glowing terminal - no glow, no
scanlines, no monospace body.

## Rules

1. **Yellow is structure, not decoration.** The h1 is an INVERTED yellow block
   (black text on yellow) with one corner clipped
   (`clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 0 100%)`).
   Buttons are the same: yellow fill, black text, clipped corner.
2. **Three colors, three jobs.** Yellow `#fcee0a` = structure and emphasis;
   cyan `#00f0ff` = links and annotations (`// ` prefix on h2, italics);
   red `#ff003c` = danger and hover states only. Never green, never purple.
3. **Flat and sharp.** Zero border-radius, zero blur, zero text-shadow.
   Edges, clips, and hairlines carry the aesthetic.
4. **Tables are strips, not grids**: solid yellow header row (black text),
   bottom hairlines at 40% yellow, no vertical rules.
5. **Type is Rajdhani** (600-700 for headings, uppercase, tracked). Code is
   mono in cyan on the dark surface with a yellow left rule.

## Agent Prompt Guide

> Build this in the **Night City (Cyberpunk 2077) style**: pure black page,
> acid-yellow `#fcee0a` structure, Rajdhani type. h1 = inverted yellow block
> with a clipped corner; h2 uppercase yellow with a cyan `// ` prefix. Links
> cyan `#00f0ff` with a hairline underline that flickers red `#ff003c` on
> hover. Buttons = yellow fill, black text, clipped corner, no radius. Tables:
> solid yellow header strip + 40%-yellow bottom hairlines only. Flat and
> hard-edged everywhere: no glow, no shadows, no rounded corners, no green.
