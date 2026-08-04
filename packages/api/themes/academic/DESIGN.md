---
version: alpha
name: Academic
description: >-
  A LaTeX paper on the web. Warm-white page, Palatino serif, justified and
  hyphenated body text, centered title, booktabs tables, restrained ink-blue links.
colors:
  background: "#fffdf7"      # warm paper white
  foreground: "#1a1a1a"      # near-black ink
  muted-foreground: "#555550"
  border: "#d8d5c8"
  rule: "#1a1a1a"            # booktabs table rules
  link: "#1d4ed8"            # restrained ink blue
typography:
  body:
    fontFamily: "Palatino, 'Palatino Linotype', 'Book Antiqua', Georgia, serif"
    fontSize: "1.05rem"
    lineHeight: 1.65
    align: "justify, hyphens auto"
  title:
    align: "center"
    fontSize: "1.9rem"
    fontWeight: 700
  subsection:
    fontSize: "1.15rem"
    fontStyle: "italic"
    fontWeight: 400
---

# Academic DESIGN.md

Build pages that read like a typeset paper: quiet, dense, serif, no chrome.

## Rules

1. **Paper, not screen.** Warm white `#fffdf7` page, near-black ink, a single
   centered column (~65-70ch). No cards, no shadows, no colored bands.
2. **Palatino serif** for everything except code (system monospace, slightly
   reduced size). Body is justified with `hyphens: auto`.
3. **Heading hierarchy like LaTeX**: centered bold title (h1), bold numbered
   sections (h2), italic unbolded subsections (h3). Number sections in
   content ("2.1 Method") rather than with CSS counters.
4. **Booktabs tables**: heavy top and bottom rules, a light midrule under the
   header, NO vertical rules, generous cell padding, centered on the page.
5. **Figures are centered** with small muted captions beneath ("Figure 1: ...").
6. **Links are ink-blue `#1d4ed8`**, undecorated until hover - citations, not
   buttons. Horizontal rules are short centered strokes (33% width).
7. **No decoration.** If it wouldn't survive being printed in a journal,
   leave it out.

## Agent Prompt Guide

> Build this in the **Academic paper style**: warm-white `#fffdf7` page,
> near-black Palatino serif, single centered ~68ch column, justified
> hyphenated body text. Centered bold title, bold section headings, italic
> subsections, in-content section numbering. Booktabs tables (heavy top/bottom
> rules, light header midrule, no vertical rules), centered figures with muted
> "Figure N:" captions, ink-blue undecorated links. No cards, shadows,
> gradients, or decorative color.
