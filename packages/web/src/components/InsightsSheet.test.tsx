import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
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
    expect(screen.getByRole('img', { name: /^Views per day/ }).children).toHaveLength(30)
    expect(screen.getByText('index.html').nextElementSibling?.textContent).toBe('4')
    expect(screen.getByText('about.html')).toBeTruthy()
  })

  test('a page nobody opened says so instead of drawing an empty chart', async () => {
    stubFetch({ days: 30, totalViews: 0, uniqueViewers: 0, series: series.map((p) => ({ ...p, views: 0 })), pages: [] })
    renderSheet()
    expect(await screen.findByText('No views in the last 30 days.')).toBeTruthy()
    expect(screen.queryByRole('img', { name: /^Views per day/ })).toBeNull()
  })

  test('a failed load says so, and Try again fetches again', async () => {
    stubFetch({ error: 'boom' }, 500)
    renderSheet()
    expect(await screen.findByText('Could not load insights.')).toBeTruthy()
    const urls = stubFetch({ days: 30, totalViews: 5, uniqueViewers: 2, series, pages: [{ path: 'index.html', views: 5 }] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Loading insights…')).toBeTruthy()
    expect(await screen.findByText('Unique viewers')).toBeTruthy()
    expect(urls).toEqual(['/api/sites/acme/doc/stats'])
  })

  test('the chart label states the total and the busiest day, since the per-day numbers are hover-only', async () => {
    const busy = series.map((p, i) => ({ ...p, views: i === 9 ? 3 : i === 19 ? 7 : 0 }))
    stubFetch({ days: 30, totalViews: 10, uniqueViewers: 1, series: busy, pages: [{ path: 'index.html', views: 10 }] })
    renderSheet()
    const chart = await screen.findByRole('img', { name: /^Views per day/ })
    const peakDay = new Date('2026-07-20T00:00:00Z').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })
    expect(chart.getAttribute('aria-label')).toBe(`Views per day: 10 views in total, busiest day ${peakDay} with 7 views`)
    expect(chart.children[19].getAttribute('title')).toBe(`${peakDay}: 7 views`)
  })
})
