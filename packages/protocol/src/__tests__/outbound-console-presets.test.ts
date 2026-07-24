import { describe, it, expect } from 'vitest'
import { OUTBOUND_CONSOLE_PRESETS } from '../outbound-console-presets'

describe('OUTBOUND_CONSOLE_PRESETS', () => {
  it('contains unique preset keys', () => {
    const keys = OUTBOUND_CONSOLE_PRESETS.map((preset) => preset.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('includes required SaaS outbound targets', () => {
    const keys = new Set(OUTBOUND_CONSOLE_PRESETS.map((preset) => preset.key))
    expect(keys.has('slack')).toBe(true)
    expect(keys.has('github-enterprise')).toBe(true)
    expect(keys.has('microsoft-enterprise-app')).toBe(true)
    expect(keys.has('atlassian')).toBe(true)
    expect(keys.has('salesforce')).toBe(true)
    expect(keys.has('zoom')).toBe(true)
  })

  it('marks hybrid providers with oidc redirect placeholder', () => {
    const salesforce = OUTBOUND_CONSOLE_PRESETS.find((preset) => preset.key === 'salesforce')
    expect(salesforce?.protocol).toBe('saml-oidc')
    expect(salesforce?.oidcRedirectPlaceholder).toContain('authcallback')
  })
})
