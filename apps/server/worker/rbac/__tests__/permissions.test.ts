// rbac/permissions 单元测试:store 注入解析 permission 并集。
import { describe, expect, it, vi } from 'vitest'
import { resolveUserPermissions, type RbacStore } from '../permissions'

describe('resolveUserPermissions', () => {
  it('returns empty list when user has no role grants', async () => {
    const store: RbacStore = {
      findRoleIds: vi.fn().mockResolvedValue([]),
      findRolePermissions: vi.fn(),
    }
    await expect(
      resolveUserPermissions(store, { userId: 'user_1', projectId: 'proj_1' }),
    ).resolves.toEqual([])
    expect(store.findRolePermissions).not.toHaveBeenCalled()
  })

  it('deduplicates role ids and merges permissions from all roles', async () => {
    const store: RbacStore = {
      findRoleIds: vi.fn().mockResolvedValue(['role_a', 'role_a', 'role_b']),
      findRolePermissions: vi.fn().mockResolvedValue([
        { key: 'users.read', condition: null },
        { key: 'users.write', condition: { org_id: 'org_1' } },
      ]),
    }
    const result = await resolveUserPermissions(store, {
      userId: 'user_1',
      projectId: 'proj_1',
      grantId: 'grant_1',
    })
    expect(store.findRoleIds).toHaveBeenCalledWith({
      userId: 'user_1',
      projectId: 'proj_1',
      grantId: 'grant_1',
    })
    expect(result).toHaveLength(2)
  })
})
