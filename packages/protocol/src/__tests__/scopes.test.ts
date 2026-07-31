import { describe, expect, it } from 'vitest'
import { STANDARD_OIDC_SCOPES, hasScope, parseScopeSet } from '../scopes'

describe('standard OIDC scope catalog', () => {
  it('matches the implemented server semantics', () => {
    expect(STANDARD_OIDC_SCOPES).toEqual([
      'openid',
      'profile',
      'email',
      'phone',
      'offline_access',
      'organization',
    ])
    expect(STANDARD_OIDC_SCOPES).not.toContain('address')
  })

  it('parses whitespace consistently for authorize and userinfo', () => {
    expect([...parseScopeSet('openid   organization\nemail')]).toEqual([
      'openid',
      'organization',
      'email',
    ])
    expect(hasScope('openid organization', 'organization')).toBe(true)
  })
})
