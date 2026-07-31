import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import ManagedProjects from './ManagedProjects'

const state = vi.hoisted(() => ({
  managerAssignments: [] as Array<{
    id: string
    managerRole: 'project_manager' | 'project_grant_manager'
    scopeType: 'project' | 'grant'
    scopeId: string
    scopeStatus: 'active' | 'deleted'
  }>,
  project: null as null | {
    id: string
    org_id: string
    name: string
    description: string | null
    status: 'active' | 'deleted'
    deleted_at: string | null
    created_at: string
    updated_at: string
  },
  grant: null as null | {
    id: string
    granted_project_id: string
    granted_by_org_id: string
    granted_to_org_id: string
    status: 'active'
    revoked_at: null
    created_at: string
    updated_at: string
  },
}))

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  managedProjectQuery: vi.fn(),
  managedProjectGrantQuery: vi.fn(),
  mutation: {
    error: null,
    isPending: false,
    variables: undefined,
    mutateAsync: vi.fn(),
  },
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    managerAssignments: state.managerAssignments,
    refresh: mocks.refresh,
  }),
}))

vi.mock('../org/OrgRoles', () => ({
  default: ({
    managedProjectId,
    grantId,
    readOnly,
  }: {
    managedProjectId?: string
    grantId?: string
    readOnly?: boolean
  }) => (
    <div
      data-role-definitions
      data-project-id={managedProjectId}
      data-grant-id={grantId}
      data-read-only={String(readOnly)}
    >
      Role definitions
    </div>
  ),
}))

vi.mock('../org/queries', () => ({
  useManagedProjectQuery: mocks.managedProjectQuery,
  useManagedProjectGrantQuery: mocks.managedProjectGrantQuery,
  useUpdateManagedProject: () => mocks.mutation,
  useDeleteManagedProject: () => mocks.mutation,
  useRestoreManagedProject: () => mocks.mutation,
  useProjectRolesQuery: () => ({
    data: {
      data: [
        {
          id: 'role_1',
          key: 'reader',
          display_name: 'Reader',
        },
      ],
    },
    isLoading: false,
  }),
  useUserGrantsQuery: () => ({
    data: {
      data: [
        {
          id: 'user_grant_1',
          user_id: 'user_1',
          project_id: 'project_1',
          role_id: 'role_1',
          granted_via_grant_id: 'grant_1',
          revoked_at: null,
          created_at: '2026-07-28T00:00:00.000Z',
          updated_at: '2026-07-28T00:00:00.000Z',
        },
      ],
      next_cursor: null,
      has_more: false,
    },
    isError: false,
    isLoading: false,
  }),
  useCreateUserGrant: () => mocks.mutation,
  useRevokeUserGrant: () => mocks.mutation,
}))

describe('ManagedProjects', () => {
  beforeEach(() => {
    state.managerAssignments = []
    state.project = null
    state.grant = null
    mocks.refresh.mockReset()
    mocks.managedProjectQuery.mockReset()
    mocks.managedProjectGrantQuery.mockReset()
    mocks.managedProjectQuery.mockImplementation(() => ({
      data: state.project
        ? {
            data: [state.project],
            next_cursor: null,
            has_more: false,
          }
        : undefined,
      isError: false,
    }))
    mocks.managedProjectGrantQuery.mockImplementation(() => ({
      data: state.grant ?? undefined,
      isError: false,
    }))
  })

  it('renders a safe empty state without requiring an active organization', () => {
    const html = renderToStaticMarkup(<ManagedProjects />)

    expect(html).toContain('No project management scopes are assigned to your user.')
  })

  it('lets an exact project manager discover a deleted project and restore it', () => {
    state.managerAssignments = [
      {
        id: 'assignment_1',
        managerRole: 'project_manager',
        scopeType: 'project',
        scopeId: 'project_1',
        scopeStatus: 'deleted',
      },
    ]
    state.project = {
      id: 'project_1',
      org_id: 'org_1',
      name: 'Billing',
      description: 'Billing authorization',
      status: 'deleted',
      deleted_at: '2026-07-28T00:00:00.000Z',
      created_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-28T00:00:00.000Z',
    }

    const html = renderToStaticMarkup(<ManagedProjects />)

    expect(mocks.managedProjectQuery).toHaveBeenCalledWith('project_1', undefined, 'all')
    expect(html).toContain('Restore project')
    expect(html).not.toContain('Role definitions')
    expect(html).not.toContain('User grants')
  })

  it('keeps project definitions read-only while allowing exact grant user management', () => {
    state.managerAssignments = [
      {
        id: 'assignment_2',
        managerRole: 'project_grant_manager',
        scopeType: 'grant',
        scopeId: 'grant_1',
        scopeStatus: 'active',
      },
    ]
    state.grant = {
      id: 'grant_1',
      granted_project_id: 'project_1',
      granted_by_org_id: 'org_owner',
      granted_to_org_id: 'org_recipient',
      status: 'active',
      revoked_at: null,
      created_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-27T00:00:00.000Z',
    }
    state.project = {
      id: 'project_1',
      org_id: 'org_owner',
      name: 'Billing',
      description: null,
      status: 'active',
      deleted_at: null,
      created_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-27T00:00:00.000Z',
    }

    const html = renderToStaticMarkup(<ManagedProjects />)

    expect(mocks.managedProjectGrantQuery).toHaveBeenCalledWith('grant_1')
    expect(mocks.managedProjectQuery).toHaveBeenCalledWith('project_1', 'grant_1', 'active')
    expect(html).toContain('data-project-id="project_1"')
    expect(html).toContain('data-grant-id="grant_1"')
    expect(html).toContain('data-read-only="true"')
    expect(html).toContain('User grants')
    expect(html).toContain('Grant role to user')
    expect(html).not.toContain('Edit project')
    expect(html).not.toContain('Delete project')
  })
})
