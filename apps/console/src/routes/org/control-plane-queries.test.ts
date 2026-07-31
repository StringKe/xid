import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>())
const mutationMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>())

vi.mock('@xid-kit/web-ui/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/web-ui/queries')>()
  return {
    ...actual,
    useApiQuery: queryMock,
    useApiMutation: mutationMock,
  }
})

vi.mock('./useOrgTarget', () => ({
  useCanManageOrg: () => true,
}))

import {
  useManagedProjectGrantQuery,
  useManagedProjectQuery,
  useManagerAssignmentsQuery,
  useProjectPermissionsQuery,
  useProjectRolesQuery,
  useProjectsQuery,
  useRolePermissionsQuery,
  useUserGrantsQuery,
} from './queries'
import { useInstanceManagerAssignmentsQuery } from '../platform/queries'

describe('control-plane Console query contracts', () => {
  beforeEach(() => {
    queryMock.mockReset()
    mutationMock.mockReset()
    queryMock.mockReturnValue({})
    mutationMock.mockReturnValue({})
  })

  it('keeps active and deleted project lists in distinct persistent queries', () => {
    useProjectsQuery('org_1', 'active', 'cursor_active')
    useProjectsQuery('org_1', 'deleted', 'cursor_deleted')

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      ['organizations', 'org_1', 'projects', 'active', { cursor: 'cursor_active' }],
      '/v1/projects',
      {
        enabled: true,
        query: {
          org_id: 'org_1',
          status: 'active',
          limit: 50,
          cursor: 'cursor_active',
        },
      },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      ['organizations', 'org_1', 'projects', 'deleted', { cursor: 'cursor_deleted' }],
      '/v1/projects',
      {
        enabled: true,
        query: {
          org_id: 'org_1',
          status: 'deleted',
          limit: 50,
          cursor: 'cursor_deleted',
        },
      },
    )
  })

  it('requests role and permission recycle bins from the flat Management API', () => {
    useProjectRolesQuery('project_1', 'deleted')
    useProjectPermissionsQuery('project_1', 'deleted')

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      ['projects', 'project_1', 'roles', 'deleted', { cursor: null, grantId: null }],
      '/v1/roles',
      {
        enabled: true,
        query: {
          project_id: 'project_1',
          grant_id: undefined,
          status: 'deleted',
          limit: 50,
          cursor: undefined,
        },
      },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      ['projects', 'project_1', 'permissions', 'deleted', { cursor: null, grantId: null }],
      '/v1/permissions',
      {
        enabled: true,
        query: {
          project_id: 'project_1',
          grant_id: undefined,
          status: 'deleted',
          limit: 50,
          cursor: undefined,
        },
      },
    )
  })

  it('binds every delegated read to the exact project grant', () => {
    useManagedProjectGrantQuery('grant_1')
    useManagedProjectQuery('project_1', 'grant_1')
    useProjectRolesQuery('project_1', 'active', undefined, 'grant_1')
    useProjectPermissionsQuery('project_1', 'active', undefined, 'grant_1')
    useRolePermissionsQuery('role_1', undefined, 'grant_1')
    useUserGrantsQuery('project_1', 'grant_1')

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      ['project-grants', 'grant_1'],
      '/v1/project-grants/grant_1',
      { enabled: true },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      ['managed-projects', 'project_1', 'active', { grantId: 'grant_1' }],
      '/v1/projects',
      {
        enabled: true,
        query: {
          project_id: 'project_1',
          grant_id: 'grant_1',
          status: 'active',
          limit: 1,
        },
      },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      ['projects', 'project_1', 'roles', 'active', { cursor: null, grantId: 'grant_1' }],
      '/v1/roles',
      {
        enabled: true,
        query: {
          project_id: 'project_1',
          grant_id: 'grant_1',
          status: 'active',
          limit: 50,
          cursor: undefined,
        },
      },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      4,
      ['projects', 'project_1', 'permissions', 'active', { cursor: null, grantId: 'grant_1' }],
      '/v1/permissions',
      {
        enabled: true,
        query: {
          project_id: 'project_1',
          grant_id: 'grant_1',
          status: 'active',
          limit: 50,
          cursor: undefined,
        },
      },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      5,
      ['roles', 'role_1', 'permissions', { cursor: null, grantId: 'grant_1' }],
      '/v1/role-permissions',
      {
        enabled: true,
        query: {
          role_id: 'role_1',
          grant_id: 'grant_1',
          limit: 50,
          cursor: undefined,
        },
      },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      6,
      ['projects', 'project_1', 'user-grants', 'grant_1', { cursor: null }],
      '/v1/user-grants',
      {
        enabled: true,
        query: {
          project_id: 'project_1',
          granted_via_grant_id: 'grant_1',
          limit: 50,
          cursor: undefined,
        },
      },
    )
  })

  it('lets an exact project manager discover a deleted project for restoration', () => {
    useManagedProjectQuery('project_1', undefined, 'all')

    expect(queryMock).toHaveBeenCalledWith(
      ['managed-projects', 'project_1', 'all', { grantId: null }],
      '/v1/projects',
      {
        enabled: true,
        query: {
          project_id: 'project_1',
          grant_id: undefined,
          status: 'all',
          limit: 1,
        },
      },
    )
  })

  it('binds a manager list to one exact scope and keeps platform managers separate', () => {
    useManagerAssignmentsQuery('grant', 'project_grant_1')
    useInstanceManagerAssignmentsQuery()

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      ['manager-assignments', 'grant', 'project_grant_1', { cursor: null }],
      '/v1/manager-assignments',
      {
        enabled: true,
        query: {
          scope_type: 'grant',
          scope_id: 'project_grant_1',
          limit: 50,
          cursor: undefined,
        },
      },
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      ['platform', 'manager-assignments', { cursor: null }],
      '/v1/platform/manager-assignments',
      { query: { limit: 50, cursor: undefined } },
    )
  })
})
