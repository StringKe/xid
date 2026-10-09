// auth-policy 保存前的前置条件:强制 SSO 需要 active 企业连接,direct attestation 需要可信根。

import { schema } from '@xid-kit/db'
import type { createTenantDb } from '@xid-kit/db'
import type { HostedAuthPolicy } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { trustedRootsKvKey } from './webauthn-trusted-roots'

type OrgDb = ReturnType<ReturnType<typeof createTenantDb>['forOrg']>

// 与 passkey 注册仪式同源:实例级 WEBAUTHN_TRUSTED_ROOTS_PEM 或租户 KV 可信根任一存在即可。
export async function hasAttestationTrustedRoots(c: Context<XidHonoEnv>): Promise<boolean> {
  const tenantRoots = await c.env.CACHE.get(trustedRootsKvKey(c.get('tenant').tenantId))
  return [c.env.WEBAUTHN_TRUSTED_ROOTS_PEM, tenantRoots].some(
    (pem) => typeof pem === 'string' && pem.length > 0,
  )
}

function preconditionFailed(paramName: string): AppError {
  return new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
}

// 只在本次开启时检查,已开启的设置不阻塞其他字段的保存。
export async function assertForceSsoReady(
  orgDb: OrgDb,
  turnedOn: { column: boolean; hostedAuth: boolean },
): Promise<void> {
  if (!turnedOn.column && !turnedOn.hostedAuth) return
  const active = await orgDb.ssoConnections.count(eq(schema.ssoConnections.status, 'active'))
  if (active > 0) return
  throw preconditionFailed(turnedOn.column ? 'loginPolicy.forceSso' : 'hostedAuth.forceSso')
}

export async function assertAttestationModeReady(
  c: Context<XidHonoEnv>,
  previous: HostedAuthPolicy,
  next: HostedAuthPolicy,
): Promise<void> {
  if (next.attestationMode !== 'direct' || previous.attestationMode === 'direct') return
  if (await hasAttestationTrustedRoots(c)) return
  throw preconditionFailed('hostedAuth.attestationMode')
}
