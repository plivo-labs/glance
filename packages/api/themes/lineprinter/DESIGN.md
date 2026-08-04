---
version: alpha
name: Line Printer
description: >-
  Greenbar tractor-feed printout from the mainframe room. Alternating green
  bars locked to the line grid, punched sprocket margins, one print face,
  perforation rules. Legacy PRINT, not a CRT.
colors:
  paper: "#fbfbf4"
  bar: "#d9ead3"             # the half-inch green bars
  ink: "#2a2a35"             # faded dot-matrix blue-black
  faint: "#b9c9b2"           # perforations, hole rings, frames
  marker: "#f5e97a"          # the operator's highlighter (mark)
typography:
  everything:
    fontFamily: "'Courier Prime', 'Courier New', monospace"
    fontSize: "0.95rem"
    lineHeight: "1.5rem"     # LOCKS text to the bars like a 6-LPI printer
---

# Line Printer DESIGN.md

Build pages like a 1978 batch-job printout: the page IS greenbar paper.

## Rules

1. **The bars are the page**: `repeating-linear-gradient` of `#d9ead3`/
   `#fbfbf4` in 1.5rem stripes, with body `line-height: 1.5rem` so every
   text line sits on its bar exactly like a line printer.
2. **Sprocket margins**: punched-hole columns down both edges
   (body::before/::after, radial-gradient dots), always BEHIND content.
3. **One font.** Courier Prime for everything including headings - a printer
   can only differentiate with CAPS, underlines, and `*** BANNERS ***`.
   h1 = `*** TITLE ***` double-underlined; h2 = `>> HEADING` underlined.
4. **Report tables**: heavy top/bottom rules, a single rule under the header
   row, NO vertical rules, no cell borders - column alignment does the work.
5. **Perforations, not dividers**: hr and pre boundaries are dashed
   `#b9c9b2` lines. Buttons are `[ BRACKETED ]` caps. mark = the operator's
   yellow highlighter stroke.
6. **No color beyond the bars**, no radius, no shadows - paper has none.

## Agent Prompt Guide

> Build this in the **Line Printer greenbar style**: the page is tractor-feed
> paper - alternating `#d9ead3`/`#fbfbf4` half-inch bars with body
> `line-height: 1.5rem` locking text to the bars, punched sprocket-hole
> margins on both edges (behind content). Everything in Courier Prime
> `#2a2a35` (faded dot-matrix ink): h1 = `*** TITLE ***` in caps with a
> double underline, h2 = `>> HEADING` underlined. Report-format tables (heavy
> top/bottom rules, header rule, no vertical rules). Dashed `#b9c9b2`
> perforations for hr, `[ BRACKETED ]` caps buttons, yellow `#f5e97a`
> highlighter for mark. No other color, no radius, no shadows.
