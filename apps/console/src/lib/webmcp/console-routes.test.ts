import { describe, expect, it } from 'vitest'
import { isAllowedConsolePath, listConsoleRoutesForUser } from './console-routes'

describe('console route catalog', () => {
  it('includes platform routes only for instance managers', () => {
    const managerRoutes = listConsoleRoutesForUser({ instanceManager: true }).map(
      (route) => route.path,
    )
    const memberRoutes = listConsoleRoutesForUser({ instanceManager: false }).map(
      (route) => route.path,
    )

    expect(managerRoutes).toContain('/console/platform/users')
    expect(memberRoutes).not.toContain('/console/platform/users')
  })

  it('allows only known console paths', () => {
    expect(isAllowedConsolePath('/console/org/members')).toBe(true)
    expect(isAllowedConsolePath('/console/secret-panel')).toBe(false)
  })
})
