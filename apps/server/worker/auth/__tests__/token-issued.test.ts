// 邮件类认证 token 签发审计:
// Magic Link / Email verification / password reset 均使用 TenantContext issuer 和 active signing key。
// 审计 payload 只记录 issuer/kid/purpose/user hash,不记录 token/jti/code/link。

import { describe, expect, it, vi } from 'vitest'
import { base64UrlDecodeToString } from '@xid-kit/crypto'
import type { TenantVar } from '../../lib/types'
import { createResetToken } from '../password'
import { recordAuthTokenIssued } from '../token-audit'

function tenant(): TenantVar {
  return {
    tenantId: 'org_admin',
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    signingKeys: {
      activeKid: 'kid_instance',
      defaultAlg: 'ES256',
      keys: [],
    },
    policy: { hostedAuth: {} },
  } as unknown as TenantVar
}

async function signer() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])
  return { kid: 'kid_instance', alg: 'ES256' as const, privateKey: keyPair.privateKey }
}

function jwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('missing payload')
  return JSON.parse(base64UrlDecodeToString(payload)) as Record<string, unknown>
}

describe('auth.token_issued audit', () => {
  it('password reset token uses instance issuer, tenant_id and active kid', async () => {
    const activeSigner = await signer()
    const { token } = await createResetToken('user-1', activeSigner, {
      issuer: 'https://xid.dev',
      tenantId: 'org_admin',
    })

    expect(jwtPayload(token)).toEqual(
      expect.objectContaining({
        iss: 'https://xid.dev',
        sub: 'user-1',
        purpose: 'password_reset',
        tenant_id: 'org_admin',
      }),
    )

    const header = JSON.parse(base64UrlDecodeToString(token.split('.')[0] ?? ''))
    expect(header).toEqual(expect.objectContaining({ kid: 'kid_instance', alg: 'ES256' }))
  })

  it('token issued audit excludes token, jti, link and code', async () => {
    const auditSend = vi.fn().mockResolvedValue(undefined)
    await recordAuthTokenIssued({
      env: { AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
      tenant: tenant(),
      purpose: 'magic_link',
      userId: 'user-1',
      kid: 'kid_instance',
    })

    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'org_admin',
        actorId: 'user-1',
        action: 'auth.token_issued',
        payload: expect.objectContaining({
          purpose: 'magic_link',
          issuer: 'https://xid.dev',
          tenantId: 'org_admin',
          kid: 'kid_instance',
          userIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    )
    const serialized = JSON.stringify(auditSend.mock.calls[0]?.[0])
    expect(serialized).not.toContain('"token":')
    expect(serialized).not.toContain('"jti":')
    expect(serialized).not.toContain('"link":')
    expect(serialized).not.toContain('"code":')
    expect(serialized).not.toContain('raw.jwt.value')
    expect(serialized).not.toContain('jti-value')
    expect(serialized).not.toContain('https://xid.dev/auth/magic-link/verify')
    expect(serialized).not.toContain('123456')
  })
})
