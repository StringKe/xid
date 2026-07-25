// rbac/claims 单元测试:buildRbacClaims 装配 org/grant claims、B2C 空权限、hook 禁止键拒绝。
import { describe, expect, it } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { buildRbacClaims } from '../claims'

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

function activeUserD1(publicMetadata: Record<string, unknown> = { plan: 'pro' }): D1Database {
  const now = Date.now()
  const userRow = {
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
    public_metadata: JSON.stringify(publicMetadata),
    private_metadata: JSON.stringify({}),
    unsafe_metadata: JSON.stringify({}),
    custom_attributes: JSON.stringify({}),
    status: 'active',
    password_change_required: 0,
    is_new_user: 0,
    profile_completion_status: 'complete',
    lockout_until: null,
    failed_login_count: 0,
    last_login_at: null,
    merged_into_user_id: null,
    provisioned_by: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  }
  const orgRow = {
    id: 'org_b',
    tenant_id: 't_1',
    slug: 'acme',
    name: 'Acme',
    public_metadata: JSON.stringify({ status: 'active' }),
    private_metadata: JSON.stringify({}),
    status: 'active',
    deleted_at: null,
    created_at: now,
    updated_at: now,
  }
  return asUnknown<D1Database>({
    prepare: (sql: string) => {
      const isUser = sql.includes('"users"')
      const isOrg = sql.includes('"organizations"')
      const rows = isUser ? [userRow] : isOrg ? [orgRow] : []
      const statement = {
        bind: () => statement,
        all: async () => ({ results: rows, success: true, meta: {} }),
        first: async () => rows[0] ?? null,
        raw: async () => rows.map((row) => rowToRaw(sql, row)),
        run: async () => ({ results: [], success: true, meta: {} }),
      }
      return statement
    },
  })
}

describe('buildRbacClaims org and grant assembly', () => {
  it('B2C path omits org claims and returns empty permissions without projectId', async () => {
    const result = await buildRbacClaims({
      d1: activeUserD1(),
      ctx: TENANT,
      env: asUnknown<Env>({}),
      input: {
        userId: 'u_1',
        projectId: null,
        clientId: 'app_1',
        isFirstParty: true,
        activeOrg: null,
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['permissions']).toEqual([])
      expect(result.value['org_id']).toBeUndefined()
      expect(result.value['org_slug']).toBeUndefined()
    }
  })

  it('includes org_id and org_slug when activeOrg is set', async () => {
    const result = await buildRbacClaims({
      d1: activeUserD1(),
      ctx: TENANT,
      env: asUnknown<Env>({}),
      input: {
        userId: 'u_1',
        projectId: null,
        clientId: 'app_1',
        isFirstParty: true,
        activeOrg: { id: 'org_b', slug: 'acme' },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['org_id']).toBe('org_b')
      expect(result.value['org_slug']).toBe('acme')
    }
  })

  it('includes grant project_id and granted_org_id for Project Grant context', async () => {
    const result = await buildRbacClaims({
      d1: activeUserD1(),
      ctx: TENANT,
      env: asUnknown<Env>({}),
      input: {
        userId: 'u_1',
        projectId: 'proj_home',
        clientId: 'app_1',
        isFirstParty: false,
        activeOrg: { id: 'org_b', slug: 'acme' },
        grant: {
          grantId: 'grant_1',
          grantedProjectId: 'proj_remote',
          grantedByOrgId: 'org_a',
          grantedToOrgId: 'org_b',
        },
      },
      hook: async () => ({ extra_claims: {} }),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['project_id']).toBe('proj_remote')
      expect(result.value['granted_org_id']).toBe('org_a')
      expect(result.value['org_id']).toBe('org_b')
    }
  })
})

describe('buildRbacClaims hook merge safety', () => {
  it('rejects forbidden IANA claim keys from hook extra_claims', async () => {
    const result = await buildRbacClaims({
      d1: activeUserD1(),
      ctx: TENANT,
      env: asUnknown<Env>({}),
      input: {
        userId: 'u_1',
        projectId: null,
        clientId: 'app_1',
        isFirstParty: true,
        activeOrg: null,
      },
      hook: async () => ({ extra_claims: { aud: 'evil-rp' } }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_scope')
      expect(result.error.message).toContain('forbidden claim key')
    }
  })

  it('passes user public_metadata into hook context for ABAC', async () => {
    const result = await buildRbacClaims({
      d1: activeUserD1({ tier: 'gold', plan: 'enterprise' }),
      ctx: TENANT,
      env: asUnknown<Env>({}),
      input: {
        userId: 'u_1',
        projectId: null,
        clientId: 'app_1',
        isFirstParty: true,
        activeOrg: { id: 'org_b', slug: 'acme' },
      },
      hook: async (hookCtx) => ({
        extra_claims: {
          tier: hookCtx.user.public_metadata['tier'] ?? null,
          org_status: hookCtx.org?.public_metadata['status'] ?? null,
        },
      }),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['tier']).toBe('gold')
      expect(result.value['org_status']).toBe('active')
    }
  })
})
