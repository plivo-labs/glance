// The unfurl card's real PNG renderer, split from lib/og-image.ts on purpose: workers-og drags
// ~700 KiB gz of satori/resvg wasm into whichever bundle imports it, so ONLY the content worker
// (which serves the image) may import this file — the main worker mints URLs via og-image.ts and
// must never grow the wasm. The import inside stays DYNAMIC so bun tests that import content.ts
// never load the wasm either (routes inject the OG_RENDER env seam instead, like SLACK_FETCH).

import { type OgCard, ogCardHtml } from './og-image'

/** workers-og (satori→SVG, resvg→PNG) at the canonical OG 1200×630. Displayed size is Slack's
 *  call, not ours: the card ships as a legacy attachment whose image_url is capped at 400×500
 *  (slack-unfurl.ts), so the full canvas just makes that 400px display retina-crisp. The font
 *  loads at render time via the Workers cache (loadGoogleFont) — bundling a typeface would cost
 *  more than the rest of the worker combined, and Slack's own image cache makes renders rare. */
export async function renderOgPng(card: OgCard): Promise<Response> {
  const { ImageResponse, loadGoogleFont } = await import('workers-og')
  const font = await loadGoogleFont({ family: 'IBM Plex Sans', weight: 600 })
  return new ImageResponse(ogCardHtml(card), {
    width: 1200,
    height: 630,
    fonts: [{ name: 'IBM Plex Sans', data: font, weight: 600, style: 'normal' }],
  })
}
