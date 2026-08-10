---
version: alpha
name: Plivo
description: >-
  Developer-precision, monochrome-first product design for a cloud
  communications and voice-AI platform. Near-neutral surfaces, one blue
  accent used sparingly, Sora display type, JetBrains Mono for metadata,
  hairline elevation, and bracket-framed "instrument" panels. First-class
  light and dark themes driven entirely by semantic tokens.
colors:
  # Brand
  primary: "#323dfe"            # Plivo blue - accent, links, focus (light)
  primary-dark: "#323dfe"       # dark fills LOCKED to brand blue by the Instrument Panel theme
  primary-text-dark: "#4d6aff"  # blue TEXT on dark, lifted for legibility (~4.2:1)
  primary-foreground: "#ffffff"
  # Neutrals - light theme
  background: "#ffffff"
  foreground: "#09090b"
  surface: "#fafafa"            # first elevation (cards on page)
  surface-2: "#f4f4f5"          # second elevation (popovers, dark bands)
  muted: "#f4f4f5"
  muted-foreground: "#67676f"
  border: "#e4e4e7"             # hairline
  border-strong: "#c9c9cf"      # emphasis / focus border
  code: "#f4f4f5"               # code + terminal surface
  code-foreground: "#1c1c22"
  # Neutrals - dark theme
  background-dark: "#0a0c0f"
  foreground-dark: "#f4f4f5"
  surface-dark: "#111317"
  surface-2-dark: "#181a20"
  muted-dark: "#1d1f26"
  muted-foreground-dark: "#a0a0a7"
  border-dark: "#282b33"
  border-strong-dark: "#40444f"
  code-dark: "#181a20"
  code-foreground-dark: "#e4e4e7"
  # Semantic status (Tailwind scale; keep low saturation in dark)
  success: "#22c55e"
  warning: "#eab308"
  danger: "#ef4444"
  info: "#2563eb"
typography:
  display:
    fontFamily: "Sora"
    fontSize: "3.25rem"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Sora"
    fontSize: "3rem"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "-0.035em"
  card-title:
    fontFamily: "Sora"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body-lg:
    fontFamily: "Inter"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Inter"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: "Inter"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Inter"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
  kicker:
    fontFamily: "JetBrains Mono"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.12em"
    fontFeature: "uppercase, tabular-nums"
  mono-stat:
    fontFamily: "JetBrains Mono"
    fontSize: "1.25rem"
    fontWeight: 600
    fontFeature: "tabular-nums"
rounded:
  none: "0"
  chamfer: "2px"    # UNIVERSAL: cards, panels, buttons, inputs, chips, tables, terminals
  full: "9999px"    # pills, status dots, avatars ONLY (circles preserved)
  note: "Instrument Panel theme (live site) forces a 2px chamfer on all containers"
spacing:
  px: "1px"
  1: "0.25rem"
  2: "0.5rem"
  3: "0.75rem"
  4: "1rem"
  6: "1.5rem"
  8: "2rem"
  12: "3rem"
  16: "4rem"
  20: "5rem"
  24: "6rem"
components:
  button-primary:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.chamfer}"
    padding: "0.625rem 1rem"
    hover: "background {colors.primary}, text #ffffff"
    note: "CTAs render JetBrains Mono UPPERCASE 11px/600/0.14em; active presses translateY(1px)"
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.border-strong}"
    rounded: "{rounded.chamfer}"
    padding: "0.625rem 1rem"
  button-accent:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.chamfer}"
    note: "use sparingly, one per view at most"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.border-strong}"
    rounded: "{rounded.chamfer}"
  card:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.chamfer}"
  pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted-foreground}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.full}"
    typography: "0.6875rem / 500"
  terminal-panel:
    backgroundColor: "{colors.surface}"
    bodyColor: "{colors.code}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.chamfer}"
---

# Plivo DESIGN.md

A drop-in design brief for coding agents and designers. Give it to any agent
and ask it to build a page "in the Plivo style," it will have the tokens,
type, components, and guardrails it needs. Values below are the real tokens
from the production site.

## Overview

**Atmosphere: developer-precision, quietly technical.** Plivo is infrastructure
for voice AI and communications, and the interface should read like a precision
instrument, not a consumer app. Think Linear or Vercel restraint: near-neutral
surfaces, generous space, hairline rules, and a single blue accent that appears
only where it earns attention.

Principles, in priority order:

1. **Monochrome-first.** The palette is white/near-black neutrals. Blue
   (`#323dfe`) is the one accent and is used sparingly, for a link, a focus
   ring, an active state, a key data point. Bold decorative blue everywhere
   reads as cheap; restraint reads as trustworthy.
2. **Tokens, not hex.** Every surface and text color is a semantic token that
   resolves to a light and a dark value. Build with `bg-surface`,
   `text-foreground`, `border-border`, never raw hex.
3. **Both themes are first-class.** Light and dark are designed together, not
   inverted. The site defaults to the visitor's system preference.
4. **Elevation by surface + hairline, not shadow.** Depth comes from the
   surface ladder (`background` to `surface` to `surface-2`) and 1px borders,
   not drop shadows. The look is flat and editorial.
5. **The Instrument Panel chamfer governs everything.** A sitewide theme
   (`.ip-cta-scope` on `<body>`, `src/styles/instrument-panel.css`) flattens
   EVERY container to a **2px corner** with `!important`, sets CTAs in mono
   uppercase, locks the accent to `#323dfe` in both themes, and presses
   buttons down 1px on click. Whatever radius utility the markup carries
   (`rounded-md`, `rounded-lg`), the rendered corner is 2px; only
   `rounded-full` circles (pills, dots, avatars) stay round.
6. **Technical texture is a feature.** Monospace kicker labels with a numbered
   index, dotted-grid backdrops, bracket "TechFrame" corners, and terminal /
   waveform panels give pages their signature. Reach for these before color.

**Voice:** plain, confident, lowercase-friendly in metadata. No hype, no
exclamation stacking. Numbers are exact and monospaced.

## Colors

Every color is a theme token. The table lists the CSS variable, the light
value, the dark value, and the role. Consume via Tailwind utilities
(`bg-surface`, `text-muted-foreground`, `border-border-strong`).

### Neutrals and surfaces

| Token (CSS var)         | Light      | Dark       | Role |
|-------------------------|------------|------------|------|
| `--background`          | `#ffffff`  | `#0a0c0f`  | page background |
| `--foreground`          | `#09090b`  | `#f4f4f5`  | primary text, headlines |
| `--surface`             | `#fafafa`  | `#111317`  | first elevation, cards |
| `--surface-2`           | `#f4f4f5`  | `#181a20`  | second elevation, popovers, dark bands |
| `--muted`               | `#f4f4f5`  | `#1d1f26`  | inert chips, tab tracks |
| `--muted-foreground`    | `#67676f`  | `#a0a0a7`  | body, captions, metadata |
| `--border`              | `#e4e4e7`  | `#282b33`  | hairline |
| `--border-strong`       | `#c9c9cf`  | `#40444f`  | emphasis, focus, input borders |
| `--code`                | `#f4f4f5`  | `#181a20`  | code + terminal body |
| `--code-foreground`     | `#1c1c22`  | `#e4e4e7`  | code text |

### Brand accent (blue)

| Use                        | Light     | Dark      |
|----------------------------|-----------|-----------|
| Fills, buttons, dots, rings (`--primary`) | `#323dfe` | `#323dfe` (locked by Instrument Panel theme) |
| **Text and links** (lifted for legibility) | `#323dfe` | **`#4d6aff`** |
| On-accent text (`--primary-foreground`)   | `#ffffff` | `#ffffff` |

**Critical rule:** brand blue is a great *fill* but a low-contrast *text* color
on dark surfaces (`#323dfe` is ~2.4:1 on dark). So **blue text lifts to
`#4d6aff`** (~4.2:1, a clear lift over the fill blue, just under strict AA 4.5
for small text) in dark mode only. Fills, buttons,
LED dots and waveforms keep the brand blue. On the site this is automatic (a
dark-scoped override on `text-primary`); if you rebuild it, encode the same
split: `--primary` for fills, a lifted `#4d6aff` for text on dark.

### Semantic status

Low-saturation, theme-aware. Prefer the pill/alert utilities over raw colors.

| Meaning | Light text/accent | Dark text/accent |
|---------|-------------------|------------------|
| Success | `#166534` on `#f0fdf4` | `#86efac` on `#064e3b`/35% |
| Warning | `#854d0e` on `#fefce8` | `#fcd34d` on `#78350f`/35% |
| Danger  | `#991b1b` on `#fef2f2` | `#fca5a5` on `#7f1d1d`/35% |
| Info    | `#1d4ed8` on `#eff6ff` | `#93c5fd` on `#1e3a8a`/30% |

### Retired, do not use

- **Purple `#cd3ef9`** (old brand accent, fully retired).
- **Gradient utilities** `bg-plivo-gradient` / `text-gradient` (unused; the brand
  is monochrome + one flat blue, no gradient text or buttons).

## Typography

Three families, each with a job:

- **Sora** (`--font-sora`), display and headlines. Set at weight **400**
  (normal) with **tight negative tracking**, this is the signature look. Also
  used for card titles at weight 600.
- **Inter** (`--font-sans`), all body, UI, labels.
- **JetBrains Mono** (`--font-mono`), kicker/eyebrow labels, metadata, code,
  stats. Always `tabular-nums` for numbers.

### Scale

| Role | Font | Size (clamp) | Weight | Leading | Tracking |
|------|------|--------------|--------|---------|----------|
| H1 / display | Sora | `2.25rem` to `3.25rem` | 400 | 1.04 | `-0.04em` |
| H2 / section | Sora | `2rem` to `3rem` | 400 | 1.04 | `-0.035em` |
| H3 / card title | Sora | `1.25rem` | 600 | 1.3 | `-0.015em` |
| H4 | Inter/Sora | `1.0625rem` | 600 | 1.4 | `-0.015em` |
| Body large | Inter | `1.125rem` | 400 | 1.6 | normal |
| Body | Inter | `1rem` | 400 | 1.6 | normal |
| Body small | Inter | `0.875rem` | 400 | 1.5 | normal |
| Caption | Inter | `0.75rem` | 400 | 1.4 | normal |
| Kicker / mono label | JetBrains Mono | `0.6875rem` (11px) | 500 | 1.25 | `0.12em`, UPPERCASE |
| Stat / big number | JetBrains Mono | `1.25rem`+ | 600 | 1 | `tabular-nums` |

Reference H1: `font-sora text-[2.25rem] sm:text-[2.75rem] md:text-[3.25rem]
font-normal leading-[1.04] tracking-[-0.04em] text-foreground`.

## Layout & Spacing

- **Grid unit: 4px.** Use the standard 4px spacing scale (`gap-2` = 8px,
  `p-6` = 24px, etc.).
- **Container:** centered, `max-width: 1228px` (`max-w-7xl` in practice), with
  `px-4 sm:px-6` gutters.
- **Section rhythm:** vertical padding `py-12` (small) to `py-24` (large);
  `py-16` to `py-20` is the common band. Section content is separated by top
  hairlines (`border-t border-border`), not big shadows or color blocks.
- **Card padding:** `p-6` to `p-8`. **Gaps:** `gap-4` for form fields/buttons,
  `gap-5`/`gap-6` for card grids.
- **Card grids fill the container** flush with the section heading; do not add
  an inner `max-w-*xl mx-auto` cap on grids.
- **Centered blocks:** when a heading is centered, the description must carry
  `mx-auto` (plus its `max-w-*`) or it will hug the left edge.

## Elevation & Depth

Depth is **flat and hairline-based**. Do not use drop shadows to signify
elevation. The ladder:

1. `background` (page)
2. `surface` + `border` (cards, first lift)
3. `surface-2` + `border` (popovers, dropdowns, dark bands, second lift)

Shadows are used only rarely and softly (`shadow-sm` on a floating control).
For a "locked dark band" (a dark pre-footer on a light page), wrap it in
`class="dark dark-band"` so the dark tokens apply on a light page; the headline
still uses `text-foreground` and resolves to white.

## Shapes

- **Radius: a universal 2px chamfer.** The live site's Instrument Panel theme
  flattens every container (cards, panels, buttons, inputs, chips, tables,
  terminals) to `2px`; only true circles stay round (`rounded-full` pills,
  status dots, avatars). One corner language across the site.
- **Borders are 1px hairlines** in `--border`, stepping up to `--border-strong`
  for emphasis, focus, and input outlines.
- **Corners can be "framed"** with the TechFrame device (see Signature Patterns):
  L-shaped bracket ticks at the four corners plus faint edge ticks.

## Components

### Buttons

**Instrument Panel CTA voice (live site):** primary and outline CTAs render in
JetBrains Mono, UPPERCASE, 11px, weight 600, letter-spacing 0.14em, 2px radius.
Hover converges to solid brand blue `#323dfe` with white text; active presses
down with `translateY(1px)`. Apply this to every button-like control.

- **Primary** (default CTA): `bg-foreground text-background`, `rounded-md`,
  `px-4 py-2.5`, `text-[13.5px] font-medium`. Hover flips to
  `bg-primary text-white`. In dark this is a white button that turns blue on hover.
- **Secondary**: `border border-border-strong bg-background text-foreground`,
  hover `bg-surface`. Pair secondary (left) + primary (right) in heroes.
- **Accent** (rare): solid `bg-primary text-white` (`.btn-primary`), one per view
  at most. Not a gradient.
- **Disabled**: reduced contrast, `cursor-not-allowed`.
- Sizes: sm / default / lg / icon.

### Inputs and forms

`bg-background border border-border-strong text-foreground
placeholder:text-muted-foreground`, `rounded-md`. Error state uses the danger
token and a helper line. Checkboxes/switches use the blue accent when active.
Labels: `text-sm font-medium text-foreground/80`.

### Cards

`rounded-lg border border-border bg-surface` in markup (the Instrument Panel
theme renders every container corner at 2px). Feature cards can add a subtle
accent wash (`bg-gradient-to-b from-primary/10 via-primary/5 to-transparent`)
or stay neutral `bg-surface`. Always bordered so they read on any background.

### Pills and badges (one system)

Four utilities, defined once, used everywhere:

- `.pill` - default tag: hairline outline on surface, muted text, 11px.
- `.pill-mono` - metadata/version: monospace, 10px, UPPERCASE, `0.08em`.
- `.pill-accent` - reply chip / soft highlight: 6% primary tint, foreground text.
- `.pill-active` - on/live: solid `bg-primary text-white`. Use sparingly.

Status dots: `h-2 w-2 rounded-full` in green/amber/red with a text label.

### Tabs, accordion, tables

Flat and hairline. Tab track `bg-muted`, active tab `bg-background
text-foreground`. Accordion items divided by `border-border`, trigger hovers to
`text-primary`. Tables: header row with a `border-b border-border`, rows with
`divide-y divide-border`, numbers `tabular-nums`.

### Alerts

2px chamfer, hairline, tinted background, theme-aware (light tint in light, ~30%
dark tint in dark) for info / success / warning / danger, each with a leading
icon.

## Motion

Restrained and quick. Transitions are `150-200ms ease`. Common:

- `transition-colors` on hover for links, buttons, rows.
- CTA press: buttons move down with `translateY(1px)` on `:active` (50ms), the
  Instrument Panel button feel.
- Hover lift `hover:-translate-y-0.5` on interactive tiles; hover border step
  `hover:border-border-strong` on panels.
- `animate-appear` (fade + 10px rise, 0.5s) for on-load reveals; staggered
  ~95ms for lists.
- Live indicators: a pulsing dot (`animate-ping` behind a solid dot).
- Marquee for logo strips (~40s linear).
- Respect `prefers-reduced-motion`, canvas instruments render a static frame.

## Signature Patterns (Precision UI)

These are what make a page look like Plivo. Use them instead of decorative color.

- **Section kicker / eyebrow.** Opens most sections: a mono UPPERCASE row with a
  numbered index, a short rule, the label, and a dashed hairline that fills the
  row. `01 -- voice ai ------------`. Classes:
  `flex items-center gap-3 font-mono-ui text-[11px] uppercase tracking-[0.12em]
  text-muted-foreground`, with `tabular-nums text-foreground/70` on the index.
- **TechFrame.** A decorative precision frame overlaid on hero/section content:
  L-bracket corners, tick-mark edge strips, a faint quadrant cross, a center
  crosshair. Theme-aware (black in light, white in dark).
- **Dotted grid.** Radial-dot lattice backdrop (`dev-grid-bg`, 28px; or
  `dev-grid-bg-fine`, 16px) layered under content at low opacity with a
  linear-gradient mask so it fades out.
- **Hairlines.** 1px dividers/outlines (`.hairline`, `.hairline-strong`) instead
  of gray borders.
- **Terminal / code-scope panel.** Window chrome: titlebar with a pulsing
  live-dot (or three traffic-light dots), a mono title and accent status, a
  `bg-code` body, optional status footer. Used for code, calls, and API demos.
- **Waveform / instrument panel.** A play control beside a bar-waveform whose
  bars flip from muted to brand blue as playback progresses; the hero uses a
  live canvas oscilloscope.
- **Bento feature panel.** Rounded `bg-surface` card, hairline that strengthens
  on hover, an internal masked dotted-grid texture, a mono path label header
  (`/stack/programmable`) and a body region.
- **Spec-list rows.** Hairline rows: bordered icon chip, Sora name, muted detail,
  right-aligned mono index `[01]`.
- **Stat strip.** A `dl` with 1px grid-gap dividers over a border-colored
  background; big values in mono `tabular-nums`, tiny UPPERCASE mono labels.
- **Prefooter (default CTA).** A locked-dark band, mono kicker, then a 12-col
  split: headline + dual CTAs + mono feature list on the left, terminal card on
  the right.

## Responsive Behavior

- Mobile-first; the 4px scale and container gutters (`px-4 sm:px-6`) hold across
  breakpoints. Common breaks: `sm` 640, `md` 768, `lg` 1024, `xl` 1280.
- Multi-column grids collapse to one column below `md`/`lg`
  (`grid-cols-1 lg:grid-cols-2`, `md:grid-cols-3`).
- TechFrame edge ticks hide below 640px, corners below 480px, so small screens
  stay clean.
- Touch targets are at least 40px; buttons/inputs are `py-2.5` or taller.
- Type scales via `clamp`-style responsive sizes (see the H1 reference).

## Do's and Don'ts

**Do**
- Build with semantic tokens; let light/dark resolve automatically.
- Keep it monochrome with one blue accent used sparingly.
- Use Sora at weight 400 with tight negative tracking for headings.
- Open sections with a mono numbered kicker; add texture with TechFrame /
  dotted grid / hairlines, not color.
- Use `tabular-nums` for all numbers, and keep **consistent decimal places** for
  rates shown together (pad with trailing zeros, e.g. `$0.0046` vs `$0.0070`).
- Lift blue **text** to `#4d6aff` on dark; keep blue **fills** at brand blue.
- Elevate with surface + hairline.
- Keep the universal 2px chamfer on every container; round only pills, status
  dots and avatars.

**Don't**
- Use em dashes or en dashes in any copy. Use a comma or hyphen. (Preserve a
  source's own punctuation verbatim.)
- Use the retired purple `#cd3ef9` or any gradient text/buttons.
- Scatter bold decorative blue; it reads as "kiddish."
- Use drop shadows to fake elevation, or heavy colored section backgrounds.
- Soften the 2px chamfer back to 8-12px corners, or shape buttons as pills.
- Hardcode hex, use tokens.
- Mix decimal precision on numbers that sit near each other.
- Center a heading while leaving its description left-aligned (add `mx-auto`).

## Agent Prompt Guide

Paste this to brief an agent quickly:

> Build this in the **Plivo style**: monochrome-first, developer-precision, flat.
> Neutral surfaces with a single blue accent (`#323dfe`) used sparingly. First-class
> light and dark via semantic tokens (`background`, `surface`, `surface-2`,
> `foreground`, `muted-foreground`, `border`, `border-strong`, `primary`). Headings
> in **Sora, weight 400, tight tracking** (`-0.035em` to `-0.04em`); body in **Inter**;
> metadata, kickers and stats in **JetBrains Mono** with `tabular-nums`. Open sections
> with a mono UPPERCASE numbered kicker + dashed rule. Elevate with 1px hairline
> borders and the surface ladder, not shadows. Buttons: primary = foreground fill that
> turns blue on hover; secondary = hairline outline; all CTAs render mono
> UPPERCASE 11px/600, letter-spacing 0.14em, and press down 1px on click.
> Every container takes a **2px chamfer** corner; only pills, status dots and
> avatars are round. Add technical texture with bracket
> "TechFrame" corners, dotted-grid backdrops, and terminal/waveform panels. On **dark**,
> lift blue **text** to `#4d6aff` (blue fills stay `#323dfe`, locked in both themes). No em dashes, no purple,
> no gradients, no bold decorative blue.

**Quick color reference**

```
accent (fill)   #323dfe light AND dark (locked by Instrument Panel theme)
accent (text)   #323dfe light / #4d6aff dark   <- lifted for legibility
bg              #ffffff / #0a0c0f
fg              #09090b / #f4f4f5
surface         #fafafa / #111317
surface-2       #f4f4f5 / #181a20
muted-fg        #67676f / #a0a0a7
border          #e4e4e7 / #282b33
border-strong   #c9c9cf / #40444f
fonts           Sora (display) · Inter (body) · JetBrains Mono (mono)
radius          2px chamfer on ALL containers · full only for pills/dots
```
