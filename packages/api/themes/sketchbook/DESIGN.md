---
version: alpha
name: Sketchbook
description: >-
  Hand-drawn notes on ruled paper. Wobbly ink borders, marker-yellow
  highlights, handwritten headings (Caveat) over Patrick Hand body.
colors:
  background: "#fdfcf8"      # paper
  ink: "#26251f"
  pencil: "#6b675c"          # secondary strokes, quotes
  marker: "#fff176"          # highlighter yellow
  blue: "#2563b0"            # pen-blue links
  red: "#c94f3d"             # red-pen emphasis (em/i)
typography:
  body:
    fontFamily: "'Patrick Hand', 'Comic Sans MS', cursive"
    fontSize: "1.15rem"
  heading:
    fontFamily: "'Caveat', cursive"
    fontWeight: 700
---

# Sketchbook DESIGN.md

Build pages that feel like an engineer's paper notebook: handwritten, warm,
a little crooked - but structured.

## Rules

1. **The wobble is the signature.** Borders use asymmetric radii
   (`255px 15px 225px 15px / 15px 225px 15px 255px`) so straight CSS strokes
   read as hand-drawn. Headings and buttons tilt ±0.5deg.
2. **Ruled paper ground**: faint horizontal notebook lines via
   repeating-linear-gradient on the body background - never over content.
3. **Two pens + a highlighter.** Ink `#26251f` for text and boxes, pen-blue
   `#2563b0` for links (wavy underline), red `#c94f3d` for em/i asides.
   `strong` and `mark` get the yellow highlighter swipe.
4. **Handwriting hierarchy**: Caveat for headings (h2 gets a short wobbly
   underline stroke), Patrick Hand for body. Code stays in real monospace on
   a paper-gray field - you don't handwrite SQL.
5. **Tables look drawn**: 2px ink grid, marker-yellow header row in Caveat.

## Agent Prompt Guide

> Build this in the **Sketchbook style**: paper-white `#fdfcf8` with faint
> ruled lines, ink `#26251f` text in Patrick Hand (1.15rem), headings in
> Caveat with a slight rotate and short wobbly underline strokes. Boxes and
> buttons use wobbly borders (asymmetric radii `255px 15px 225px 15px / 15px
> 225px 15px 255px`) and tilt ~0.5deg. strong/mark = yellow `#fff176`
> highlighter; links pen-blue `#2563b0` with wavy underlines; em = red-pen
> `#c94f3d`. Tables: 2px ink grid, yellow Caveat header row. Code in real
> monospace on paper gray.
