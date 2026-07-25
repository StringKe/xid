// enterprise-policy 单元测试:企业 SSO 策略门控失败写审计后原样抛出。
import { Hono } from 'hono'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { HostedAuthPolicyError } from '../../auth/hosted-policy'
import { enforceEnterpriseSsoPolicy } from '../enterprise-policy'

const auditPolicyDeniedError = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../../auth/hosted-audit', () => ({
  auditPolicyDeniedError,
}))

function makeCtx(tenant: TenantVar) {
  const app = new Hono<XidHonoEnv>()
  let ctx!: Parameters<typeof enforceEnterpriseSsoPolicy>[0]['c']
  app.get('/probe', async (c) => {
    ctx = c
    return c.text('ok')
  })
  return {
    async get() {
      await app.request('https://test.xid.dev/probe', {}, {} as Env)
      ctx.set('tenant', tenant)
      return ctx
    },
  }
}

function tenantWithSsoDisabled(): TenantVar {
  return {
    tenantId: 'tenant_1',
    issuer: 'https://tenant_1.xid.dev',
    rpId: 'tenant_1.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {
      hostedAuth: {
        ...DEFAULT_HOSTED_AUTH_POLICY,
        enterpriseSso: {
          enabled: false,
          allowLogin: false,
          allowJitUserCreation: false,
          domainDiscovery: false,
        },
      },
    },
  } as TenantVar
}

describe('enforceEnterpriseSsoPolicy', () => {
  beforeEach(() => {
    auditPolicyDeniedError.mockClear()
  })

  it('no-ops for logout action', async () => {
    const c = await makeCtx(tenantWithSsoDisabled()).get()
    await expect(
      enforceEnterpriseSsoPolicy({ c, action: 'logout', email: 'user@example.com' }),
    ).resolves.toBeUndefined()
    expect(auditPolicyDeniedError).not.toHaveBeenCalled()
  })

  it('audits and rethrows when enterprise SSO login disallowed', async () => {
    const tenant = tenantWithSsoDisabled()
    const c = await makeCtx(tenant).get()
    await expect(
      enforceEnterpriseSsoPolicy({ c, action: 'login', email: 'user@acme.com' }),
    ).rejects.toBeInstanceOf(HostedAuthPolicyError)
    expect(auditPolicyDeniedError).toHaveBeenCalledWith(
      c,
      expect.any(HostedAuthPolicyError),
      expect.objectContaining({
        tenant,
        method: 'enterpriseSso',
        action: 'login',
        identifier: { type: 'email', value: 'user@acme.com' },
      }),
    )
  })
})
