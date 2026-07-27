import { describe, expect, it } from 'vitest'
import { isConsoleWebMcpSurface } from './support'

describe('WebMCP surface gating', () => {
  it('matches only the isolated console route namespace', () => {
    expect(isConsoleWebMcpSurface('/console')).toBe(true)
    expect(isConsoleWebMcpSurface('/console/org/members')).toBe(true)
    expect(isConsoleWebMcpSurface('/account/security')).toBe(false)
    expect(isConsoleWebMcpSurface('/docs')).toBe(false)
  })
})
