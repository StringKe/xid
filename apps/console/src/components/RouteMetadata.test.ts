import { describe, expect, it, vi } from 'vitest'

vi.mock('@lingui/react', () => ({
  useLingui: () => ({ i18n: { _: (descriptor: { message: string }) => descriptor.message } }),
}))

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({
    id: strings.join(''),
    message: strings.join(''),
  }),
}))

vi.mock('@xid-kit/web-ui/locale-context', () => ({
  useLocale: () => ({ locale: 'en' }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  useLocation: () => ({ pathname: '/console', search: '' }),
}))

vi.mock('../lib/google-analytics', () => ({
  trackPageView: vi.fn<(input: unknown) => void>(),
}))

import { normalizeConsoleMetadataPath, titleForPath } from './RouteMetadata'

describe('Console route metadata', () => {
  it('normalizes one or more trailing slashes before title lookup', () => {
    expect(normalizeConsoleMetadataPath('/console/org/')).toBe('/console/org')
    expect(normalizeConsoleMetadataPath('/console/org///')).toBe('/console/org')
    expect(titleForPath('/console/org/').message).toBe('Organization overview | Console | XID')
  })

  it('keeps unknown routes on the not-found title', () => {
    expect(titleForPath('/console/unknown/').message).toBe('Page not found | XID')
  })

  it('defines metadata for both control-plane manager surfaces', () => {
    expect(titleForPath('/console/managed-projects').message).toBe(
      'Managed projects | Console | XID',
    )
    expect(titleForPath('/console/org/projects').message).toBe(
      'Projects and access | Console | XID',
    )
    expect(titleForPath('/console/platform/managers').message).toBe(
      'Instance managers | Console | XID',
    )
  })
})
