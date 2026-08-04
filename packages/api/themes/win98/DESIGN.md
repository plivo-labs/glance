---
version: alpha
name: Windows 98
description: >-
  Faithful Win98 chrome (98.css values): silver #c0c0c0, navy title-bar
  headings, pixel bevels, sunken white fields, pure-blue links. 13px Tahoma.
colors:
  silver: "#c0c0c0"          # page + control faces
  foreground: "#222222"
  hilight: "#ffffff"         # bevel light edge, field backgrounds
  face: "#dfdfdf"            # bevel inner light
  shadow: "#808080"          # bevel inner dark
  frame: "#0a0a0a"           # bevel outer dark
  navy: "#000080"            # title bar gradient start, selection
  navy-2: "#1084d0"          # title bar gradient end
  link: "#0000ff"
  link-visited: "#660099"
typography:
  body:
    fontFamily: "Tahoma, 'MS Sans Serif', 'Segoe UI', sans-serif"
    fontSize: "13px"
  code:
    fontFamily: "'Fixedsys', 'Courier New', monospace"
---

# Windows 98 DESIGN.md

Build pages that read like a Win98 dialog. The illusion lives in three
devices: title bars, bevels, and sunken fields.

## Rules

1. **h1/h2 are title bars**: `linear-gradient(90deg, #000080, #1084d0)`,
   white bold text, 4px padding. Instantly iconic — use them as section chrome.
2. **Bevels are exact** (from 98.css). Raised (buttons, table headers):
   `inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px #808080,
   inset 2px 2px #dfdfdf`. Sunken (inputs, pre, tables, images): the same
   recipe flipped. `:active` buttons swap raised → sunken.
3. **Fields are white wells**: inputs, code blocks, and tables sit on
   `#ffffff` with the sunken bevel; table headers are raised silver cells
   like Explorer columns.
4. **Period-correct details**: links pure `#0000ff` (visited `#660099`),
   13px Tahoma body, dotted focus outline inside buttons, grooved fieldsets.
5. **Absolutely no** border-radius, blur, soft shadows, or gradients other
   than the title bar. Body text over 13px breaks the illusion.

## Agent Prompt Guide

> Build this in the **Windows 98 style** (98.css values): silver `#c0c0c0`
> page, 13px Tahoma. h1/h2 = navy title bars (`#000080→#1084d0` gradient,
> white bold). Buttons = silver with the exact 98.css raised bevel
> (inset shadows, no border-radius) that flips sunken on :active. Inputs,
> code blocks, and tables = white sunken wells; table headers = raised silver
> Explorer-style cells. Links pure blue `#0000ff`, visited purple. No radius,
> no blur, no modern shadows anywhere.
