// POST /v1/sessions/token:取 short-lived JWT 供 networkless 验证(前端 auth-context getToken)。
// 认证:cookie session(c.get('session')/readSession),不是 sk_live Bearer(区别于 v1/sessions 列表/撤销)。
// 复用 loadActiveSigner @ oidc/shared(instance ES256 active signer)+ buildAccessTokenClaims/signAccessTokenClaims @ protocol。
// claims:sub=userId,aud/azp/client_id=issuer(first-party self),scope='openid',sid=sessionId,
// ttl=租户 token 策略 sessionTokenTtlSec(默认 60s,见 api-sdk-conventions:getToken 返回 short-lived JWT)。

import { buildAccessTokenClaims, signAccessTokenClaims } from '@xid-kit/protocol'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { loadActiveSigner, tokenPolicyOf } from '../oidc/shared'
import { requireSession } from './shared'

export async function handleSessionToken(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)

  const signer = await loadActiveSigner(tenant, c.env.KEK)
  const now = Math.floor(Date.now() / 1000)
  const claims = buildAccessTokenClaims({
    ctx: tenant,
    subject: { userId: session.userId },
    clientId: tenant.issuer,
    scope: 'openid',
    audience: tenant.issuer,
    now,
    ttlSec: tokenPolicyOf(tenant).sessionTokenTtlSec,
    options: { sid: session.sessionId },
  })
  const token = await signAccessTokenClaims(tenant, signer.privateKey, claims)

  return c.json({ token })
}
