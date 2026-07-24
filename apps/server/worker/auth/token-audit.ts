import { sha256Hex } from '@xid-kit/crypto'
import type { TenantVar } from '../lib/types'

type TokenPurpose = 'magic_link' | 'email_verification' | 'password_reset'

type TokenIssuedInput = {
  env: Env
  tenant: TenantVar
  purpose: TokenPurpose
  userId: string
  kid: string
}

export async function recordAuthTokenIssued(input: TokenIssuedInput): Promise<void> {
  const { env, tenant, purpose, userId, kid } = input
  await env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'auth.token_issued',
    actorId: userId,
    ts: Date.now(),
    payload: {
      purpose,
      issuer: tenant.issuer,
      tenantId: tenant.tenantId,
      kid,
      userIdHash: await sha256Hex(`${tenant.tenantId}:user:${userId}`),
    },
  })
}
