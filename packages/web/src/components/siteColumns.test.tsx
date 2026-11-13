import { expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import type { SiteSummary } from '@/lib/types'
import { nameColumn } from './siteColumns'

const SITE = { id: 's1', spaceSlug: 'sp', siteSlug: 'site', title: 'T', visibility: 'team', status: 'active', url: 'https://x.example/sp/site', createdAt: '2026-01-01T00:00:00.000Z' } as SiteSummary
const cell = (o: Partial<SiteSummary>) => render(<div>{nameColumn<SiteSummary>().render({ ...SITE, ...o })}</div>).container.textContent ?? ''

test('name column: an active expiry shows its date, an expired site says expired (no date), an archived one stays archived', () => {
  expect(cell({ expiresAt: '2026-12-31T23:59:59.999Z' })).toContain('expires 2026-12-31')
  expect(cell({ expiresAt: null })).not.toContain('expires')
  const expired = cell({ status: 'expired', expiresAt: '2026-01-02T00:00:00.000Z' })
  expect(expired).toContain('expired')
  expect(expired).not.toContain('expires 2026')
  expect(cell({ status: 'archived' })).toContain('archived')
})
