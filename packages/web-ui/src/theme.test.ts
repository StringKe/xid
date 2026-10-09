import { describe, expect, it } from 'vitest'
import { DEFAULT_ORG_BRANDING } from '@xid-kit/types'
import { DEFAULT_BRAND, brandFromOrgBranding } from './theme'

describe('brandFromOrgBranding', () => {
  it('maps the radius tier to the CSS length written into --xid-radius', () => {
    const brand = brandFromOrgBranding({ ...DEFAULT_ORG_BRANDING, borderRadius: 'square' })

    expect(brand.radius).toBe('0')
  })

  it('fixes the scheme only when the organization chose light or dark', () => {
    const dark = brandFromOrgBranding({ ...DEFAULT_ORG_BRANDING, colorScheme: 'dark' })
    const system = brandFromOrgBranding({
      ...DEFAULT_ORG_BRANDING,
      colorScheme: 'system',
      accentColor: '#8C6400',
    })

    expect(dark.scheme).toBe('dark')
    expect(system.scheme).toBeNull()
  })

  it('keeps the default brand when nothing is customized', () => {
    expect(brandFromOrgBranding(DEFAULT_ORG_BRANDING)).toBe(DEFAULT_BRAND)
  })
})
