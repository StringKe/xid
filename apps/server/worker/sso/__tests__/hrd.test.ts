// hrd.ts 单元测试。
// 验证:域名提取/精确匹配/wildcard 匹配/未验证域名不触发/无 connection 时返回 null。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'

// 租户查询层 mock。
const mockFindOne = vi.fn()
vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    organizationDomains: { findOne: mockFindOne },
    ssoConnections: { findOne: mockFindOne },
  })),
  resolveInstanceLogin: vi.fn(),
  resolveTenantContextById: vi.fn(),
  schema: {
    organizationDomains: {
      domain: 'domain',
      verificationStatus: 'verification_status',
      status: 'status',
      isWildcard: 'is_wildcard',
      orgId: 'org_id',
    },
    ssoConnections: {
      orgId: 'org_id',
      status: 'status',
    },
  },
}))

import { resolveInstanceLogin, resolveTenantContextById } from '@xid-kit/db'
import { registerHrdRoutes, resolveHrd } from '../hrd'

const fakeEnv = { DB: {} } as unknown as Env

const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json(
      { code: err.code, message: err.code },
      err.httpStatus as Parameters<typeof c.json>[1],
    )
  }
  return c.json({ code: 'server_error', message: 'server_error' }, 500)
}

function makeTenant(overrides: Partial<Record<string, unknown>> = {}): TenantVar {
  return {
    tenantId: 'tenant-1',
    issuer: 'https://tenant-1.xid.dev',
    rpId: 'tenant-1.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {
      hostedAuth: {
        identifierMode: 'email',
        requireVerifiedEmail: true,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
        forceSso: false,
        allowUserCreation: true,
        allowExistingUserLogin: true,
        password: { enabled: false, allowLogin: false, allowUserCreation: false },
        magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
        emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
        enterpriseSso: {
          enabled: true,
          allowLogin: true,
          allowJitUserCreation: true,
          domainDiscovery: true,
          allowedEmailDomains: [],
          blockedEmailDomains: [],
          ...overrides,
        },
      },
    },
  } as unknown as TenantVar
}

function makeTenantWithHostedAuth(
  hostedOverrides: Partial<Record<string, unknown>>,
  enterpriseOverrides: Partial<Record<string, unknown>> = {},
): TenantVar {
  const tenant = makeTenant(enterpriseOverrides)
  Object.assign((tenant.policy.hostedAuth ?? {}) as Record<string, unknown>, hostedOverrides)
  return tenant
}

function makeDomainRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'dom-1',
    domain: 'corp.example.com',
    orgId: 'org-1',
    verificationStatus: 'verified',
    isWildcard: false,
    ...overrides,
  }
}

function makeConnectionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conn-1',
    orgId: 'org-1',
    protocol: 'oidc',
    status: 'active',
    ...overrides,
  }
}

describe('resolveHrd', () => {
  beforeEach(() => {
    mockFindOne.mockReset()
  })

  it('email 无 @ 返回 null', async () => {
    const result = await resolveHrd(fakeEnv, makeTenant(), 'notanemail')
    expect(result).toBeNull()
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('enterprise SSO 未启用时不查询域名', async () => {
    const result = await resolveHrd(
      fakeEnv,
      makeTenant({ enabled: false }),
      'user@corp.example.com',
    )
    expect(result).toBeNull()
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('domain discovery 未启用时不查询域名', async () => {
    const result = await resolveHrd(
      fakeEnv,
      makeTenant({ domainDiscovery: false }),
      'user@corp.example.com',
    )
    expect(result).toBeNull()
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('邮箱域名被 blockedEmailDomains 拒绝时不查询域名', async () => {
    const result = await resolveHrd(
      fakeEnv,
      makeTenant({ blockedEmailDomains: ['corp.example.com'] }),
      'user@corp.example.com',
    )
    expect(result).toBeNull()
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('邮箱域名被全局 blockedEmailDomains 拒绝时不查询域名', async () => {
    const result = await resolveHrd(
      fakeEnv,
      makeTenantWithHostedAuth({ blockedEmailDomains: ['corp.example.com'] }),
      'user@corp.example.com',
    )
    expect(result).toBeNull()
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('邮箱域名不在 allowedEmailDomains 时不查询域名', async () => {
    const result = await resolveHrd(
      fakeEnv,
      makeTenant({ allowedEmailDomains: ['allowed.example.com'] }),
      'user@corp.example.com',
    )
    expect(result).toBeNull()
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('邮箱域名不在全局 allowedEmailDomains 时不查询域名', async () => {
    const result = await resolveHrd(
      fakeEnv,
      makeTenantWithHostedAuth({ allowedEmailDomains: ['allowed.example.com'] }),
      'user@corp.example.com',
    )
    expect(result).toBeNull()
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('精确域名匹配 verified 域名返回 connectionId', async () => {
    // 第一次 findOne: 返回 domainRow(精确匹配)
    // 第二次 findOne: 返回 connectionRow
    mockFindOne.mockResolvedValueOnce(makeDomainRow()).mockResolvedValueOnce(makeConnectionRow())

    const result = await resolveHrd(fakeEnv, makeTenant(), 'user@corp.example.com')
    expect(result).toEqual({
      organizationId: 'tenant-1',
      connectionId: 'conn-1',
      orgId: 'org-1',
      protocol: 'oidc',
    })
  })

  it('精确匹配无 verified 域名 -> 尝试 wildcard(父域)', async () => {
    // 第一次 findOne(精确 corp.example.com): null
    // 第二次 findOne(wildcard example.com): 返回 domainRow
    // 第三次 findOne(connection): 返回 connectionRow
    mockFindOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(makeDomainRow({ domain: 'example.com', isWildcard: true }))
      .mockResolvedValueOnce(makeConnectionRow())

    const result = await resolveHrd(fakeEnv, makeTenant(), 'user@sub.example.com')
    expect(result).toEqual({
      organizationId: 'tenant-1',
      connectionId: 'conn-1',
      orgId: 'org-1',
      protocol: 'oidc',
    })
  })

  it('域名未验证(pending)不触发 SSO 路由', async () => {
    // findOne 按 verificationStatus=verified 过滤,此处 mock 返回 undefined 模拟 no match
    mockFindOne.mockResolvedValue(undefined)

    const result = await resolveHrd(fakeEnv, makeTenant(), 'user@pending.example.com')
    expect(result).toBeNull()
  })

  it('域名 verified 但无 active connection -> 返回 null', async () => {
    mockFindOne.mockResolvedValueOnce(makeDomainRow()).mockResolvedValueOnce(undefined) // no connection

    const result = await resolveHrd(fakeEnv, makeTenant(), 'user@corp.example.com')
    expect(result).toBeNull()
  })

  it('SAML connection protocol 正确透传', async () => {
    mockFindOne
      .mockResolvedValueOnce(makeDomainRow())
      .mockResolvedValueOnce(makeConnectionRow({ protocol: 'saml' }))

    const result = await resolveHrd(fakeEnv, makeTenant(), 'user@corp.example.com')
    expect(result?.protocol).toBe('saml')
  })

  it('顶级二段域名(无父域)不触发 wildcard 查询', async () => {
    // example.com 只有 2 段,不尝试 wildcard
    mockFindOne.mockResolvedValueOnce(undefined) // 精确匹配失败
    // 第二次 findOne 若被调用代表错误
    mockFindOne.mockResolvedValueOnce(makeConnectionRow())

    const result = await resolveHrd(fakeEnv, makeTenant(), 'user@example.com')
    // example.com split('.') = ['example','com'],length == 2,不尝试 wildcard -> null
    expect(result).toBeNull()
    // 只应调用了 1 次(精确匹配),没有 wildcard 调用
    expect(mockFindOne).toHaveBeenCalledTimes(1)
  })
})

describe('POST /sso/hrd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOne.mockReset()
  })

  it('enterprise SSO 未启用时返回 null 并写策略拒绝审计', async () => {
    const auditSend = vi.fn()
    const tenant = makeTenant({ enabled: false })
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', tenant as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerHrdRoutes(app)

    const res = await app.request(
      '/sso/hrd',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@corp.example.com' }),
      },
      { DB: {}, AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connectionId: null })
    expect(mockFindOne).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'domain_discovery',
          reason: 'enterprise_sso_disabled',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
    expect(JSON.stringify(auditSend.mock.calls[0])).not.toContain('user@corp.example.com')
  })

  it('全局 blockedEmailDomains 拒绝 HRD 并写策略拒绝审计', async () => {
    const auditSend = vi.fn()
    const tenant = makeTenantWithHostedAuth({ blockedEmailDomains: ['corp.example.com'] })
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', tenant as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerHrdRoutes(app)

    const res = await app.request(
      '/sso/hrd',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@corp.example.com' }),
      },
      { DB: {}, AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connectionId: null })
    expect(mockFindOne).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'domain_discovery',
          reason: 'email_domain_blocked',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
    expect(JSON.stringify(auditSend.mock.calls[0])).not.toContain('user@corp.example.com')
  })

  it('root 入口按 email resolver 切到最终 tenant 后做 HRD', async () => {
    const auditSend = vi.fn()
    const resolvedTenant = makeTenant()
    resolvedTenant.tenantId = 'tenant-resolved'
    const rootTenant = {
      ...makeTenant(),
      tenantId: 'tenant-entry',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveInstanceLogin).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant, matchedBy: 'email' },
    } as never)
    mockFindOne.mockResolvedValueOnce(makeDomainRow()).mockResolvedValueOnce(makeConnectionRow())
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', rootTenant as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerHrdRoutes(app)

    const res = await app.request(
      'https://xid.dev/sso/hrd',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@corp.example.com' }),
      },
      { DB: {}, AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      organizationId: 'tenant-resolved',
      connectionId: 'conn-1',
      orgId: 'org-1',
      protocol: 'oidc',
    })
    expect(resolveInstanceLogin).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      kind: 'email',
      value: 'user@corp.example.com',
    })
  })

  it('root 入口带 organizationId 时按选中 organization 做 HRD', async () => {
    const auditSend = vi.fn()
    const resolvedTenant = makeTenant()
    resolvedTenant.tenantId = 'tenant-selected'
    resolvedTenant.issuer = 'https://xid.dev'
    resolvedTenant.rpId = 'xid.dev'
    const rootTenant = {
      ...makeTenant(),
      tenantId: 'tenant-entry',
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    mockFindOne.mockResolvedValueOnce(makeDomainRow()).mockResolvedValueOnce(makeConnectionRow())
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', rootTenant as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerHrdRoutes(app)

    const res = await app.request(
      'https://xid.dev/sso/hrd',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'user@corp.example.com',
          organizationId: 'tenant-selected',
        }),
      },
      { DB: {}, AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      organizationId: 'tenant-selected',
      connectionId: 'conn-1',
      orgId: 'org-1',
      protocol: 'oidc',
    })
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-selected',
    )
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
  })
})
