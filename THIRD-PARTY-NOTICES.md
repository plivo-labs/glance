# Third-Party Notices

Glance bundles and depends on open-source software. Each package remains under its own
license; the most significant are listed below. Run `bun pm ls` for the full resolved tree.

## Runtime

| Package | License |
| --- | --- |
| hono | MIT |
| drizzle-orm | Apache-2.0 |
| marked | MIT |
| arctic | MIT |
| react, react-dom | MIT |
| react-router | MIT |

## UI

| Package | License |
| --- | --- |
| @radix-ui/* | MIT |
| shadcn/ui (vendored components) | MIT |
| lucide-react | ISC |
| sonner | MIT |
| tailwindcss | MIT |

## Tooling

| Package | License |
| --- | --- |
| typescript | Apache-2.0 |
| wrangler | MIT OR Apache-2.0 |
| drizzle-kit | MIT |
| @biomejs/biome | MIT OR Apache-2.0 |
| oxlint, @oxlint/plugins | MIT |
| vite | MIT |

Full license texts are available in each package's directory under `node_modules/`.

## Vendored oxlint plugins (tools/oxlint)

Custom lint rules copied into this repo rather than installed, per each project's
recommendation. Upstream license texts are kept alongside the sources.

- `tools/oxlint/anti-slop` — dmmulroy/anti-slop, MIT
- `tools/oxlint/stella` — stella/stella `.oxlint-plugins`, Apache-2.0

## Vendored fonts (packages/api/themes/*/fonts)

Latin WOFF2 subsets, self-hosted so themed pages stay first-party (#155). All
licensed under the SIL Open Font License 1.1:

- Sora — © Jonathan Barnbrook, Julián Moncada (Google Fonts)
- Inter — © Rasmus Andersson (Google Fonts)
- JetBrains Mono — © JetBrains (Google Fonts)
- Bangers — © Vernon Adams (Google Fonts)
- Comic Neue — © Craig Rozynski (Google Fonts)
