// hosted-audit 单元测试:策略拒绝审计哈希标识符 + 队列载荷形状。
import { Hono } from 'hono'
import { describe, it, expect, vi } from 'vitest'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { HostedAuthPolicyError } from '../hosted-policy'
import {
  auditPolicyDeniedError,
  policyDeniedReason,
  recordHostedAuthPolicyDenied,
  throwUnlessPolicyDenied,
} from '../hosted-audit'

describe('policyDeniedReason', () => {
  it('returns policy reason for HostedAuthPolicyError', () => {
    expect(policyDeniedReason(new HostedAuthPolicyError('force_sso'))).toBe('force_sso')
  })

  it('returns null for non-policy errors', () => {
    expect(policyDeniedReason(new Error('x'))).toBeNull()
  })
})

describe('throwUnlessPolicyDenied', () => {
  it('re-throws non-policy errors', () => {
    expect(() => throwUnlessPolicyDenied(new Error('boom'))).toThrow('boom')
  })

  it('returns policy error unchanged', () => {
    const err = new HostedAuthPolicyError('method_disabled')
    expect(throwUnlessPolicyDenied(err)).toBe(err)
  })
})

describe('recordHostedAuthPolicyDenied', () => {
  it('queues auth.policy_denied with hashed identifier and no raw email', async () => {
    const auditSend = vi.fn()
    const tenant: TenantVar = {
      tenantId: 'tenant_audit',
      issuer: 'https://test.xid.dev',
      rpId: 'test.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    }
    const app = new Hono<XidHonoEnv>()
    app.get('/auth/password', async (ctx) => {
      await recordHostedAuthPolicyDenied(ctx, {
        tenant,
        method: 'password',
        action: 'login',
        reason: 'method_login_disabled',
        identifier: { type: 'email', value: 'User@Acme.COM' },
      })
      return ctx.json({ ok: true })
    })

    const res = await app.request(
      'http://localhost/auth/password',
      { headers: { 'cf-connecting-ip': '203.0.113.9' } },
      { AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
    )
    expect(res.status).toBe(200)
    expect(auditSend).toHaveBeenCalledTimes(1)

    const payload = auditSend.mock.calls[0]?.[0] as {
      tenantId: string
      action: string
      payload: Record<string, unknown>
    }
    expect(payload.tenantId).toBe('tenant_audit')
    expect(payload.action).toBe('auth.policy_denied')
    expect(payload.payload['method']).toBe('password')
    expect(payload.payload['reason']).toBe('method_login_disabled')
    expect(payload.payload['path']).toBe('/auth/password')
    expect(payload.payload['ip']).toBe('203.0.113.9')
    expect(payload.payload['identifierHash']).toBe(
      await sha256Hex('tenant_audit:email:user@acme.com'),
    )
    expect(payload.payload['emailDomain']).toBe('acme.com')
    expect(JSON.stringify(payload)).not.toContain('User@Acme.COM')
  })
})

describe('auditPolicyDeniedError', () => {
  it('records audit then returns policy error', async () => {
    const auditSend = vi.fn()
    const app = new Hono<XidHonoEnv>()
    const tenant: TenantVar = {
      tenantId: 'tenant_audit',
      issuer: 'https://test.xid.dev',
      rpId: 'test.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    }
    app.get('/auth/passkey', async (c) => {
      const err = await auditPolicyDeniedError(c, new HostedAuthPolicyError('force_sso'), {
        tenant,
        method: 'passkey',
        action: 'login',
      })
      return c.json({ reason: err.policyReason })
    })

    const res = await app.request('http://localhost/auth/passkey', {}, {
      AUDIT_QUEUE: { send: auditSend },
    } as unknown as Env)
    expect(res.status).toBe(200)
    expect(auditSend).toHaveBeenCalledTimes(1)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('force_sso')
  })
})
