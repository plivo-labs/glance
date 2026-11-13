// Server-side PDF through Cloudflare Browser Rendering (the BROWSER binding). Kept out of pdf.ts so
// tests never load puppeteer: the route imports this lazily, and tests inject PDF_RENDER instead.
import puppeteer from '@cloudflare/puppeteer'
import type { PdfRenderRequest } from './pdf'

const NAVIGATION_TIMEOUT_MS = 20_000
// Late fetches get this long to land. A dashboard that polls never goes quiet, so it is a cap, not a wait.
const IDLE_WAIT_MS = 5_000
const MAX_SCROLL_STEPS = 60

// Browser-side snippets, as strings: this package compiles without the DOM lib.
//
// Re-point (or create) the stamped theme <link>, like the annotate client does for a viewer override,
// and wait for the sheet so the PDF is not taken mid-restyle.
const applyTheme = (href: string) => `new Promise((resolve) => {
  let l = document.getElementById('glance-theme')
  if (!l) { l = document.createElement('link'); l.id = 'glance-theme'; l.rel = 'stylesheet'; document.head.appendChild(l) }
  if (l.getAttribute('href') === ${JSON.stringify(href)}) return resolve(true)
  l.addEventListener('load', () => resolve(true)); l.addEventListener('error', () => resolve(false))
  l.setAttribute('href', ${JSON.stringify(href)})
})`

// Lazy images only load when scrolled near; walk the page once so a long document is not full of
// blanks, then wait for web fonts.
const settle = `(async () => {
  for (let i = 0, y = 0; i < ${MAX_SCROLL_STEPS} && y < document.documentElement.scrollHeight; i++, y += innerHeight) {
    scrollTo(0, y); await new Promise((r) => setTimeout(r, 60))
  }
  scrollTo(0, 0)
  await document.fonts.ready
  return true
})()`

export async function renderPdf(binding: Fetcher, req: PdfRenderRequest): Promise<Uint8Array> {
  const { plan } = req
  const browser = await puppeteer.launch(binding)
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: plan.viewportWidth, height: 1100 })
    await page.emulateMediaType(plan.media)
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: plan.scheme }])
    const res = await page.goto(req.url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
    if (!res?.ok()) throw new Error(`pdf render: page answered ${res?.status() ?? 'nothing'}`)
    await page.waitForNetworkIdle({ idleTime: 500, timeout: IDLE_WAIT_MS }).catch(() => {})
    if (req.themeHref) await page.evaluate(applyTheme(req.themeHref))
    await page.evaluate(settle)
    return await page.pdf({
      width: plan.width,
      height: plan.height,
      margin: plan.margin,
      printBackground: plan.printBackground,
      preferCSSPageSize: false,
    })
  } finally {
    await browser.close()
  }
}
