import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import type { SiteInsights } from '@/lib/insights'
import { InsightsSheet } from './InsightsSheet'

const DATES = Array.from({ length: 30 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`)
const series = DATES.map((date, i) => ({ date, views: i === 29 ? 5 : 0 }))

function stubFetch(body: unknown, status = 200) {
  const urls: string[] = []
  globalThis.fetch = ((url: string) => {
    urls.push(url)
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  }) as unknown as typeof fetch
  return urls
}

const renderSheet = () =>
  render(<InsightsSheet spaceSlug="acme" siteSlug="doc" open onOpenChange={() => {}} />)

describe('InsightsSheet', () => {
  test('shows views, unique viewers, the 30-day chart and the per-page list', async () => {
    const data: SiteInsights = {
      days: 30,
      totalViews: 5,
      uniqueViewers: 2,
      series,
      pages: [
        { path: 'index.html', views: 4 },
        { path: 'about.html', views: 1 },
      ],
    }
    const urls = stubFetch(data)
    renderSheet()
    expect(await screen.findByText('Unique viewers')).toBeTruthy()
    expect(urls).toEqual(['/api/sites/acme/doc/stats'])
    expect(screen.getByText('Views').nextElementSibling?.textContent).toBe('5')
    expect(screen.getByText('Unique viewers').nextElementSibling?.textContent).toBe('2')
    expect(screen.getByText('Avg / day').nextElementSibling?.textContent).toBe('0.2')
    expect(screen.getByRole('img', { name: 'Views per day' }).children).toHaveLength(30)
    expect(screen.getByText('index.html').nextElementSibling?.textContent).toBe('4')
    expect(screen.getByText('about.html')).toBeTruthy()
  })

  test('a page nobody opened says so instead of drawing an empty chart', async () => {
    stubFetch({ days: 30, totalViews: 0, uniqueViewers: 0, series: series.map((p) => ({ ...p, views: 0 })), pages: [] })
    renderSheet()
    expect(await screen.findByText('No views in the last 30 days.')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Views per day' })).toBeNull()
  })
})
