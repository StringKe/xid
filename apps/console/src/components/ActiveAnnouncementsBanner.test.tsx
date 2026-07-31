import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ActiveAnnouncementsBanner } from './ActiveAnnouncementsBanner'

const mocks = vi.hoisted(() => ({
  useApiQuery: vi.fn(),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/queries', () => ({
  queryKeys: { activeAnnouncements: ['announcements', 'active'] },
  useApiQuery: mocks.useApiQuery,
}))

describe('ActiveAnnouncementsBanner', () => {
  it('renders tenant-aware active announcements from Core', () => {
    mocks.useApiQuery.mockReturnValue({
      data: [
        {
          id: 'announcement_1',
          title: 'Planned maintenance',
          body: 'Authentication remains available during the database maintenance window.',
          severity: 'warning',
          startsAt: '2026-07-28T00:00:00.000Z',
          endsAt: null,
        },
      ],
      isError: false,
      isLoading: false,
    })

    const html = renderToStaticMarkup(<ActiveAnnouncementsBanner enabled />)

    expect(mocks.useApiQuery).toHaveBeenCalledWith(
      ['announcements', 'active'],
      '/v1/announcements/active',
      expect.objectContaining({ enabled: true }),
    )
    expect(html).toContain('Planned maintenance')
    expect(html).toContain('Authentication remains available')
  })
})
