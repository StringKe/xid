// RBAC 单元测试(02 章 7.2/7.3):permission 解析(fake store)+ ABAC condition 求值 +
// claims merge(forbidden key)+ rbac_override。纯逻辑,不依赖 D1/Worker binding。

import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { applyConditions, applyRbacOverride, evalCondition, mergeExtraClaims } from '../action'
import type { PreAccessTokenContext } from '../action'
import { buildRbacClaims } from '../claims'
import { resolveUserPermissions } from '../permissions'
import type { RbacStore, ResolvedPermission } from '../permissions'

function asUnknown<T>(v: unknown): T {
  return v as T
}

function projectionColumns(sql: string): string[] {
  const head = /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

function rowToRaw(sql: string, row: Record<string, unknown>): unknown[] {
  return projectionColumns(sql).map((column) => row[column] ?? null)
}

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function ctx(overrides: Partial<PreAccessTokenContext> = {}): PreAccessTokenContext {
  return {
    user: {
      id: 'u_1',
      public_metadata: { plan: 'enterprise', tier: 'gold' },
      unsafe_metadata: {},
    },
    org: { id: 'org_b', slug: 'acme', public_metadata: { status: 'active' } },
    client: { id: 'app_1', project_id: 'proj_1', is_first_party: true },
    token_type: 'access_token',
    rbac: { roles: [], permissions: [] },
    grant: null,
    ...overrides,
  }
}

describe('evalCondition (ABAC 7.3)', () => {
  it('null condition grants unconditionally', () => {
    expect(evalCondition(null, ctx())).toBe(true)
  })

  it('eq matches and mismatches', () => {
    expect(
      evalCondition({ op: 'eq', var: 'user.public_metadata.plan', value: 'enterprise' }, ctx()),
    ).toBe(true)
    expect(
      evalCondition({ op: 'eq', var: 'user.public_metadata.plan', value: 'free' }, ctx()),
    ).toBe(false)
  })

  it('in / not_in over arrays', () => {
    expect(
      evalCondition(
        { op: 'in', var: 'user.public_metadata.tier', value: ['gold', 'platinum'] },
        ctx(),
      ),
    ).toBe(true)
    expect(
      evalCondition({ op: 'not_in', var: 'user.public_metadata.tier', value: ['silver'] }, ctx()),
    ).toBe(true)
  })

  it('not_eq over org metadata', () => {
    expect(
      evalCondition({ op: 'not_eq', var: 'org.public_metadata.status', value: 'suspended' }, ctx()),
    ).toBe(true)
  })

  it('resolves org.id / org.slug', () => {
    expect(evalCondition({ op: 'eq', var: 'org.id', value: 'org_b' }, ctx())).toBe(true)
    expect(evalCondition({ op: 'eq', var: 'org.slug', value: 'acme' }, ctx())).toBe(true)
  })

  it('undefined var: eq/in false, not_eq/not_in true (7.3 失败处理)', () => {
    const c = ctx()
    expect(evalCondition({ op: 'eq', var: 'user.public_metadata.missing', value: 'x' }, c)).toBe(
      false,
    )
    expect(evalCondition({ op: 'in', var: 'user.public_metadata.missing', value: ['x'] }, c)).toBe(
      false,
    )
    expect(
      evalCondition({ op: 'not_eq', var: 'user.public_metadata.missing', value: 'x' }, c),
    ).toBe(true)
    expect(
      evalCondition({ op: 'not_in', var: 'user.public_metadata.missing', value: ['x'] }, c),
    ).toBe(true)
  })

  it('org null -> org var undefined', () => {
    const c = ctx({ org: null })
    expect(evalCondition({ op: 'eq', var: 'org.public_metadata.status', value: 'active' }, c)).toBe(
      false,
    )
  })

  it('AND requires all true', () => {
    const expr = {
      and: [
        { op: 'eq', var: 'user.public_metadata.plan', value: 'enterprise' },
        { op: 'not_in', var: 'org.public_metadata.status', value: ['suspended'] },
      ],
    }
    expect(evalCondition(expr, ctx())).toBe(true)
  })

  it('AND false when one child false', () => {
    const expr = {
      and: [
        { op: 'eq', var: 'user.public_metadata.plan', value: 'enterprise' },
        { op: 'eq', var: 'org.public_metadata.status', value: 'suspended' },
      ],
    }
    expect(evalCondition(expr, ctx())).toBe(false)
  })

  it('unknown operator -> null (配置错误)', () => {
    expect(
      evalCondition({ op: 'gt', var: 'user.public_metadata.plan', value: 1 }, ctx()),
    ).toBeNull()
  })

  it('malformed structure -> null', () => {
    expect(evalCondition({ foo: 'bar' }, ctx())).toBeNull()
    expect(evalCondition({ or: [] }, ctx())).toBeNull()
  })
})

describe('applyConditions (7.2)', () => {
  it('dedupes granted keys, drops false, reports invalid', () => {
    const perms: ResolvedPermission[] = [
      { key: 'document:read', condition: null },
      {
        key: 'document:read',
        condition: { op: 'eq', var: 'user.public_metadata.plan', value: 'free' },
      },
      {
        key: 'billing:manage',
        condition: { op: 'eq', var: 'user.public_metadata.plan', value: 'enterprise' },
      },
      { key: 'admin:all', condition: { op: 'bogus', var: 'x', value: 1 } },
    ]
    const out = applyConditions(perms, ctx())
    expect(out.permissions.sort()).toEqual(['billing:manage', 'document:read'])
    expect(out.invalid).toEqual(['admin:all'])
  })
})

describe('mergeExtraClaims (7.1 step 3)', () => {
  it('merges non-reserved keys', () => {
    const r = mergeExtraClaims({ permissions: [] }, { foo: 'bar', tenant_tier: 'gold' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ permissions: [], foo: 'bar', tenant_tier: 'gold' })
  })

  it('rejects reserved IANA claim key', () => {
    const r = mergeExtraClaims({}, { sub: 'evil' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_scope')
      expect(r.error.message).toContain('forbidden claim key: sub')
    }
  })

  it('rejects reserved OIDC claim key', () => {
    const r = mergeExtraClaims({}, { amr: ['x'] })
    expect(r.ok).toBe(false)
  })
})

describe('applyRbacOverride (7.1 step 4)', () => {
  it('uses platform permissions when no override', () => {
    expect(applyRbacOverride(['a', 'b'], undefined)).toEqual(['a', 'b'])
  })
  it('override replaces platform result', () => {
    expect(applyRbacOverride(['a'], { permissions: ['x', 'y'] })).toEqual(['x', 'y'])
  })
})

describe('resolveUserPermissions (7.2 query path)', () => {
  function fakeStore(
    rolesByKey: Record<string, string[]>,
    permsByRole: Record<string, ResolvedPermission[]>,
  ): RbacStore {
    return {
      findRoleIds: async (input) =>
        rolesByKey[input.grantId ? `grant:${input.grantId}` : 'normal'] ?? [],
      findRolePermissions: async (roleIds) => roleIds.flatMap((r) => permsByRole[r] ?? []),
    }
  }

  it('unions permissions across multiple roles', async () => {
    const store = fakeStore(
      { normal: ['role_admin', 'role_editor'] },
      {
        role_admin: [{ key: 'user:delete', condition: null }],
        role_editor: [{ key: 'document:write', condition: null }],
      },
    )
    const out = await resolveUserPermissions(store, { userId: 'u', projectId: 'p' })
    expect(out.map((p) => p.key).sort()).toEqual(['document:write', 'user:delete'])
  })

  it('empty roles -> empty permissions', async () => {
    const store = fakeStore({}, {})
    expect(await resolveUserPermissions(store, { userId: 'u', projectId: 'p' })).toEqual([])
  })

  it('grant path uses grant-scoped roles (7.4)', async () => {
    const store = fakeStore(
      { 'grant:g_1': ['role_grant'] },
      { role_grant: [{ key: 'project:view', condition: null }] },
    )
    const out = await resolveUserPermissions(store, { userId: 'u', projectId: 'p', grantId: 'g_1' })
    expect(out.map((p) => p.key)).toEqual(['project:view'])
  })
})

describe('buildRbacClaims soft delete gate', () => {
  it('does not load user metadata from a soft deleted user', async () => {
    const d1 = asUnknown<D1Database>({
      prepare: (sql: string) => {
        const now = Date.now()
        const rows = sql.includes('"deleted_at" is null')
          ? []
          : [
              {
                id: 'u_1',
                tenant_id: 't_1',
                username: null,
                external_id: null,
                primary_email_id: null,
                primary_phone_id: null,
                first_name: null,
                last_name: null,
                display_name: null,
                avatar_url: null,
                locale: null,
                timezone: null,
                public_metadata: JSON.stringify({ plan: 'deleted-user-plan' }),
                private_metadata: JSON.stringify({}),
                unsafe_metadata: JSON.stringify({ internal: 'deleted-user-secret' }),
                custom_attributes: JSON.stringify({}),
                status: 'deleted',
                password_change_required: 0,
                is_new_user: 0,
                profile_completion_status: 'complete',
                lockout_until: null,
                failed_login_count: 0,
                last_login_at: null,
                merged_into_user_id: null,
                provisioned_by: null,
                deleted_at: Date.now(),
                created_at: now,
                updated_at: now,
              },
            ]
        const statement = {
          bind: () => statement,
          all: async () => {
            return { results: rows, success: true, meta: {} }
          },
          first: async () => rows[0] ?? null,
          raw: async () => rows.map((row) => rowToRaw(sql, row)),
          run: async () => ({ results: [], success: true, meta: {} }),
        }
        return statement
      },
    })

    const result = await buildRbacClaims({
      d1,
      ctx: TENANT,
      env: asUnknown<Env>({}),
      input: {
        userId: 'u_1',
        projectId: null,
        clientId: 'app_1',
        isFirstParty: true,
        activeOrg: null,
      },
      hook: async (hookCtx) => ({
        extra_claims: { seen_plan: hookCtx.user.public_metadata['plan'] ?? null },
      }),
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value['seen_plan']).toBeNull()
  })
})
