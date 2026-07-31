import { describe, expect, it, vi } from 'vitest'
import { CORE_SPA_ROUTE_PATHS } from '@xid-kit/types'

vi.mock('./components/AuthAnalytics', () => ({ AuthAnalytics: () => null }))
vi.mock('./components/RouteAnalytics', () => ({ RouteAnalytics: () => null }))
vi.mock('./components/RoutePageSeo', () => ({ RoutePageSeo: () => null }))
vi.mock('./components/RequireAuth', () => ({
  RequireAuth: ({ children }: { children: unknown }) => children,
}))
vi.mock('./components/ui', () => ({ Spinner: () => null }))

describe('Core SPA route manifest', () => {
  it('matches every concrete TanStack Router path', async () => {
    const { router } = await import('./router')
    const routerPaths = Object.keys(router.routesByPath)
      .filter((path) => path !== '/' && !path.includes('$'))
      .sort()

    expect(routerPaths).toEqual([...CORE_SPA_ROUTE_PATHS].sort())
  })
})
