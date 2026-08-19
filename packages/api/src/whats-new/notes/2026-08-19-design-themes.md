---
title: Design themes
slug: design-themes
date: 2026-08-19T12:00:00.000Z
image: design-themes.jpg
featured: true
---
Give any page a designed look without touching its HTML. Pick a **theme** when you deploy, or switch it live from the viewer — Glance injects the stylesheet at serve time, so your stored files never change and **Default** always means your page's own design.

- **Four themes to start** — Plivo (the brand), Broadsheet (newspaper editorial), Kapow (comic book), Matrix (green phosphor terminal)
- **Switch without a redeploy** — owners get a theme chip in the viewer top bar and a Theme menu on each dashboard row
- **From the CLI**: `glance deploy report.html --theme plivo` — and agents can browse `/api/themes` for each theme's full design brief before generating a page
- Plain, semantic HTML transforms completely; pages that carry their own styling keep their look
