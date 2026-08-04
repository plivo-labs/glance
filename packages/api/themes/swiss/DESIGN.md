---
version: alpha
name: Swiss
description: >-
  International Typographic Style. White ground, Helvetica, extreme scale
  contrast, hairline rules, exactly one accent - Swiss red.
colors:
  background: "#ffffff"
  foreground: "#111111"
  muted: "#767676"
  hairline: "#111111"
  red: "#e30613"             # the ONLY accent
typography:
  body:
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif"
    lineHeight: 1.55
  display:
    fontSize: "3.2rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
---

# Swiss DESIGN.md

Build pages in the International Typographic Style: objective, gridded,
typographic. The design IS the typography.

## Rules

1. **One accent, used with intent.** Swiss red `#e30613` appears as the short
   program-bar above each h2, link underlines, `mark` fills, and hovers.
   Never as body text, never a second accent color.
2. **Extreme scale contrast.** h1 at 3.2rem/700/tight tracking against 1rem
   body - the jump is the drama. Flush left, ragged right, never centered.
3. **Hairline discipline.** Tables: one heavy top rule, hairline row rules,
   nothing vertical. hr = 2px black. No boxes, no shadows, no radius.
4. **Helvetica only** - body, headings, even buttons (black rectangle, white
   text). Code steps to system mono on a light gray field.
5. **Whitespace is structure.** Generous margins; sections breathe; the grid
   does the aligning, not borders.

## Agent Prompt Guide

> Build this in the **Swiss / International Typographic Style**: pure white
> page, Helvetica everywhere, near-black `#111` text. Giant flush-left
> headings (3.2rem, 700, -0.02em); a short 4px red `#e30613` bar above each
> section head. Tables = one heavy black top rule + gray hairline rows, no
> vertical rules. Black rectangular buttons, red on hover. Links underlined
> in red. No shadows, no radius, no second accent, no centering.
