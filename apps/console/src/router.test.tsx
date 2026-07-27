import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { usesDocumentNavigation } from '@xid-kit/web-ui/router'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({
    id: strings.join(''),
    message: strings.join(''),
  }),
}))

import { CONSOLE_SPA_ROUTE_PATHS, router } from './router'

describe('isolated Console router', () => {
  it('registers the 27 SPA routes and leaves account aliases to the Worker', () => {
    const registeredPaths = Object.keys(router.routesByPath)

    expect(CONSOLE_SPA_ROUTE_PATHS).toHaveLength(27)
    expect(registeredPaths).toEqual(expect.arrayContaining(CONSOLE_SPA_ROUTE_PATHS))
    expect(registeredPaths).not.toContain('/console/sessions')
    expect(registeredPaths).not.toContain('/console/security')
  })

  it('keeps Console links client-side and leaves Core surfaces to document navigation', () => {
    expect(usesDocumentNavigation('console', '/console/org/members', '/console')).toBe(false)
    expect(usesDocumentNavigation('console', '/sign-in', '/console')).toBe(true)
    expect(usesDocumentNavigation('console', '/mfa', '/console')).toBe(true)
    expect(usesDocumentNavigation('console', '/account/security', '/console')).toBe(true)
  })
})
