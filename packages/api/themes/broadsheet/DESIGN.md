---
version: alpha
name: Broadsheet
description: >-
  A newspaper front page. Cream paper, Georgia serif, masthead headline
  between rules, drop cap on the opening paragraph, fine editorial rules.
colors:
  background: "#faf7f0"      # cream newsprint
  foreground: "#1c1b18"      # ink
  muted: "#5f5b52"           # bylines, captions
  rule: "#1c1b18"            # heavy editorial rules
  fine: "#c9c4b6"            # fine rules between rows
typography:
  body:
    fontFamily: "Georgia, 'Times New Roman', serif"
    lineHeight: 1.6
    align: "justify, hyphens auto"
  masthead:
    align: "center"
    fontSize: "2.6rem"
    fontWeight: 700
---

# Broadsheet DESIGN.md

Build pages that read like a quality newspaper: ink on cream, editorial
rules, journalistic hierarchy. (Academic is the scientific paper; this is
the front page.)

## Rules

1. **The h1 is a masthead**: centered, between a heavy top rule and a double
   bottom rule. Bylines beneath it in italic muted small text.
2. **Drop cap** on the first paragraph after the first section head - one
   per page, like a lede.
3. **Serif justification.** Georgia body, justified with hyphens. Keep
   columns at a readable measure (~72ch).
4. **Rules, not boxes.** h2 carries a fine bottom rule; hr is a double rule;
   tables are financial-pages style (heavy top rule, small-caps heads, fine
   row rules, no vertical rules).
5. **Pull quotes are centered italics** with a hanging typographic quote -
   no border, no background.
6. **Ink discipline**: no color accents at all; emphasis comes from weight,
   italics, small caps, and a pale `#f3e9c7` highlight for `mark`.

## Agent Prompt Guide

> Build this in the **Broadsheet newspaper style**: cream `#faf7f0` page, ink
> `#1c1b18` Georgia serif, justified hyphenated body at ~72ch. h1 = centered
> masthead between a 3px top rule and a double bottom rule; italic muted
> byline under it. Drop cap on the lede paragraph. h2 with a fine bottom
> rule; double-rule hr; financial-pages tables (heavy top rule, small-caps
> headers, fine row rules). Centered italic pull quotes with a hanging “.
> No color accents, no boxes, no shadows - ink only.
