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
    expect(managerRoutes).toContain('/console/platform/managers')
    expect(managerRoutes).toContain('/console/managed-projects')
    expect(managerRoutes).toContain('/console/org/projects')
    expect(memberRoutes).toContain('/console/managed-projects')
    expect(memberRoutes).not.toContain('/console/platform/users')
    expect(memberRoutes).not.toContain('/console/platform/managers')
  })

  it('allows only known console paths', () => {
    expect(isAllowedConsolePath('/console/managed-projects')).toBe(true)
    expect(isAllowedConsolePath('/console/org/members')).toBe(true)
    expect(isAllowedConsolePath('/console/secret-panel')).toBe(false)
  })
})
