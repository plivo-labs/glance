---
version: alpha
name: Flat-Pack
description: >-
  Furniture-manual / safety-card information design. Instructional blue,
  giant step numbers, safety-yellow warning panels, hairline diagram frames,
  clinical whitespace. The humor is the deadpan.
colors:
  background: "#ffffff"
  foreground: "#3d3e42"      # instructional grey body
  blue: "#0058a3"            # headings, step numbers, rules, buttons
  safety: "#ffdb00"          # warning panels (blockquote), mark
  hairline: "#d1d1d1"        # diagram frames, table rules
  part: "#8a8a8a"            # captions, part numbers, small
typography:
  body:
    fontFamily: "'Archivo', 'Helvetica Neue', Arial, sans-serif"
    lineHeight: 1.6
  heading:
    fontWeight: 700
    transform: "uppercase"
    letterSpacing: "0.06em"
---

# Flat-Pack DESIGN.md

Build pages like an assembly manual: methodical, pictogram-calm, wordlessly
confident. Applied to a dashboard or report, the clinical calm IS the joke -
and it stays genuinely readable because it's a real information-design
language.

## Rules

1. **Ordered lists are the hero.** Giant outdented blue step numbers
   (`li::marker` at 1.6em/700) with generous spacing between steps - every
   procedure looks like STEP 1, STEP 2.
2. **Sections are steps**: each h2 is uppercase blue over a 3px blue top
   rule with a big margin above - the "new step" beat.
3. **Warnings are safety-yellow**: blockquote = `#ffdb00` panel, bold dark
   text, ⚠ prefix, square corners. mark = yellow highlight.
4. **Diagram frames**: tables and images sit in `#d1d1d1` hairline boxes;
   captions are tiny uppercase grey part numbers.
5. **Strictly flat**: no shadows, no gradients, no border-radius anywhere.
   Buttons are solid blue rectangles. Whitespace is rigid and generous.
6. **One blue, one yellow.** Nothing else gets color.

## Agent Prompt Guide

> Build this in the **Flat-Pack assembly-manual style**: white page, grey
> `#3d3e42` Archivo body, uppercase instructional-blue `#0058a3` headings -
> each h2 over a 3px blue rule with generous space above (a new step).
> Ordered lists get giant blue step numbers (1.6em markers). blockquote =
> safety-yellow `#ffdb00` warning panel with a ⚠ prefix, square corners.
> Tables/images in `#d1d1d1` hairline diagram frames with tiny uppercase grey
> part-number captions. Solid blue rectangular buttons. Strictly flat: no
> shadows, no gradients, no radius, no colors beyond the one blue and the
> safety yellow.
