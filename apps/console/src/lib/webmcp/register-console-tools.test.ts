import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@xid-kit/web-ui/api'
import { createConsoleShellWebMcpTools, createConsoleWebMcpTools } from './register-console-tools'

const sessionFixture = {
  id: 'sess_1',
  status: 'active' as const,
  expiresAt: '2099-01-01T00:00:00.000Z',
  isImpersonation: false,
  userId: 'user_1',
  activeOrganizationId: 'org_1',
  lastActiveAt: '2098-01-01T00:00:00.000Z',
}

const meFixture = {
  user: {
    id: 'user_1',
    email: 'admin@example.com',
    emailVerified: true,
    name: 'Admin',
    imageUrl: null,
    locale: 'en',
    hasMfa: false,
    instanceManager: true,
  },
  activeOrg: {
    id: 'org_1',
    slug: 'acme',
    name: 'Acme',
    role: 'admin',
    permissions: ['org:read'],
  },
  organizations: [
    {
      id: 'org_1',
      slug: 'acme',
      name: 'Acme',
      role: 'admin',
      permissions: ['org:read'],
    },
  ],
  managerAssignments: [],
  session: sessionFixture,
  activeSessionId: sessionFixture.id,
  sessions: [sessionFixture],
}

describe('console WebMCP tools', () => {
  it('defines authenticated management tools', () => {
    const tools = createConsoleWebMcpTools({
      navigate: vi.fn<(to: string) => void>(),
      getPathname: () => '/console/managed-projects',
      getPageTitle: () => 'Managed projects | Console | XID',
      api: {
        get: vi.fn<ApiClient['get']>(),
        post: vi.fn<ApiClient['post']>(),
        patch: vi.fn<ApiClient['patch']>(),
        del: vi.fn<ApiClient['del']>(),
        request: vi.fn<ApiClient['request']>(),
      },
      setActiveOrganization: vi.fn<(organizationId: string | null) => Promise<boolean>>(
        async () => true,
      ),
      me: meFixture,
    })

    const names = tools.map((tool) => tool.name)
    expect(names).toContain('get_console_context')
    expect(names).toContain('list_console_routes')
    expect(names).toContain('navigate_to_console')
    expect(names).toContain('list_org_members')
    expect(names).toContain('list_platform_users')
  })

  it('rejects unknown console navigation targets', async () => {
    const navigate = vi.fn<(to: string) => void>()
    const tools = createConsoleShellWebMcpTools({ navigate })
    const navigateTool = tools.find((tool) => tool.name === 'navigate_to_console')

    const result = await navigateTool?.execute({ path: '/console/secret-panel' })
    expect(navigate).not.toHaveBeenCalled()
    expect(result).toContain('not an allowed console route')
  })

  it('exposes the current user exact delegated project scopes', async () => {
    const tools = createConsoleWebMcpTools({
      navigate: vi.fn<(to: string) => void>(),
      getPathname: () => '/console/managed-projects',
      getPageTitle: () => 'Managed projects | Console | XID',
      api: {
        get: vi.fn<ApiClient['get']>(),
        post: vi.fn<ApiClient['post']>(),
        patch: vi.fn<ApiClient['patch']>(),
        del: vi.fn<ApiClient['del']>(),
        request: vi.fn<ApiClient['request']>(),
      },
      setActiveOrganization: vi.fn<(organizationId: string | null) => Promise<boolean>>(
        async () => true,
      ),
      me: {
        ...meFixture,
        managerAssignments: [
          {
            id: 'manager_assignment_1',
            managerRole: 'project_manager',
            scopeType: 'project',
            scopeId: 'project_1',
            scopeStatus: 'deleted',
          },
        ],
      },
    })

    const contextTool = tools.find((tool) => tool.name === 'get_console_context')
    const result = await contextTool?.execute({})

    expect(result).toContain('"managerRole": "project_manager"')
    expect(result).toContain('"scopeId": "project_1"')
    expect(result).toContain('"scopeStatus": "deleted"')
  })

  it('exposes shell tools before authentication completes', async () => {
    const tools = createConsoleShellWebMcpTools({
      navigate: vi.fn<(to: string) => void>(),
      getPathname: () => '/console',
      getPageTitle: () => 'Console | XID',
    })
    const contextTool = tools.find((tool) => tool.name === 'get_console_context')
    const result = await contextTool?.execute({})

    expect(result).toContain('"authenticated": false')
    expect(result).toContain('"/console"')
  })
})
