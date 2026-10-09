// auth-policy 保存前的前置条件:强制 SSO 需要 active 企业连接,direct attestation 需要可信根。

import { schema } from '@xid-kit/db'
import type { createTenantDb } from '@xid-kit/db'
import type { HostedAuthPolicy } from '@xid-kit/types'
import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { loadTrustedAttestationRoots } from './webauthn-trusted-roots'

type OrgDb = ReturnType<ReturnType<typeof createTenantDb>['forOrg']>

// 与 passkey 注册仪式同源:实例级或租户级可信根任一存在即可。
export async function hasAttestationTrustedRoots(c: Context<XidHonoEnv>): Promise<boolean> {
  return (await loadTrustedAttestationRoots(c.env, c.get('tenant').tenantId)).length > 0
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
  // 强制 SSO 依赖域名路由,只有 SAML 与 OIDC 连接参与路由。
  const active = await orgDb.ssoConnections.count(
    and(
      eq(schema.ssoConnections.status, 'active'),
      inArray(schema.ssoConnections.protocol, ['saml', 'oidc']),
    ),
  )
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
