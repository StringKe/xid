import { describe, expect, it } from 'vitest'
import {
  getWebMcpSurfaceKind,
  isBlockedWebMcpPath,
  isConsoleWebMcpSurface,
  isPublicWebMcpSurface,
} from './support'

describe('WebMCP surface gating', () => {
  it('treats marketing and docs as public surfaces', () => {
    expect(isPublicWebMcpSurface('/')).toBe(true)
    expect(isPublicWebMcpSurface('/docs')).toBe(true)
    expect(isPublicWebMcpSurface('/docs/oidc-oauth')).toBe(true)
    expect(getWebMcpSurfaceKind('/docs/webhooks')).toBe('public')
  })

  it('treats console as a dedicated surface and no longer blocks it', () => {
    expect(isConsoleWebMcpSurface('/console')).toBe(true)
    expect(isConsoleWebMcpSurface('/console/org/members')).toBe(true)
    expect(isBlockedWebMcpPath('/console')).toBe(false)
    expect(getWebMcpSurfaceKind('/console/users')).toBe('console')
  })

  it('keeps auth and account flows blocked', () => {
    expect(isBlockedWebMcpPath('/sign-in')).toBe(true)
    expect(isBlockedWebMcpPath('/account/security')).toBe(true)
    expect(getWebMcpSurfaceKind('/sign-in')).toBe('blocked')
  })
})
