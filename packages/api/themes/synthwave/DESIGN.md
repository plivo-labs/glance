---
version: alpha
name: Synthwave '84
description: >-
  Outrun neon on a deep-purple night. Hot-pink glow headings, cyan links,
  sunset-gradient rules, soft corners. The only theme that glows.
colors:
  background: "#262335"
  surface: "#241b2f"
  raised: "#34294f"          # hovers, selection
  foreground: "#f4f2f7"
  muted: "#848bbd"           # lavender secondary text
  border: "#495495"
  pink: "#ff7edb"            # headings (glowing)
  pink-hot: "#ff2975"        # glow color, hot accents
  cyan: "#36f9f6"            # links, code, strong
  orange: "#ff8b39"          # h3/h4, warm accents
  sunset-ramp: "linear-gradient(90deg, #ffd319, #ff901f, #ff2975, #f222ff, #8c1eff)"
typography:
  body:
    fontFamily: "system sans"
    lineHeight: 1.65
  heading:
    fontWeight: 700
    glow: "0 0 2px #000, 0 0 10px rgba(255,41,117,.65), 0 0 22px rgba(255,41,117,.35)"
---

# Synthwave '84 DESIGN.md

Build pages that feel like an outrun sunset: deep-purple night, neon that
GLOWS, soft edges. Palette anchored to the Synthwave '84 editor theme.

## Rules

1. **The ground is purple, never black.** Page `#262335`, panels `#241b2f`,
   hovers/selection `#34294f`.
2. **Glow is the signature.** Headings are hot pink with a layered
   text-shadow glow; links glow cyan on hover (intensity changes, not color);
   `hr` is a glowing pink line. This is the ONLY theme allowed to glow.
3. **The sunset ramp** (`#ffd319 → #ff901f → #ff2975 → #f222ff → #8c1eff`)
   appears exactly once per page, as the h1's 3px border-image underline.
4. **Four neon voices**: pink = headings, cyan = links/code/strong,
   orange = h3-h4 and warm accents, lavender `#848bbd` = secondary text.
5. **Soft geometry**: 4-6px radii on buttons, inputs, code blocks — the
   deliberate opposite of Night City's flat clipped corners. No yellow-on-
   black dominance, no green, no clip-paths.

## Agent Prompt Guide

> Build this in the **Synthwave '84 style**: deep-purple `#262335` page (never
> black), hot-pink `#ff7edb` headings with a layered neon text-shadow glow, the
> canonical sunset gradient (`#ffd319→#ff901f→#ff2975→#f222ff→#8c1eff`) as the
> h1 underline. Cyan `#36f9f6` links and code that glow brighter on hover,
> orange `#ff8b39` sub-headings, lavender `#848bbd` secondary text. Soft 4-6px
> corners, outlined pink buttons that light up. No black grounds, no yellow
> dominance, no green, no hard clipped edges.
