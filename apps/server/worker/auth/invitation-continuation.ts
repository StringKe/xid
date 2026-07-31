import { base64UrlEncode, signJwt, verifyJwt } from '@xid-kit/crypto'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { INVITATION_AUTH_CONTINUATION_TTL_MS } from '../lib/ttl'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { resolveTokenTenant } from '../me-auth/token-tenant'
import { buildVerifyKeySet, loadActiveSigner } from '../oidc/shared'

const PURPOSE = 'invitation_auth_continuation'
const MAX_IDENTIFIER_LENGTH = 255

export type InvitationAuthContinuation = {
  tenant: TenantVar
  userId: string
  sessionId: string
  invitationId: string
}

export async function issueInvitationAuthContinuation(opts: {
  env: Env
  tenant: TenantVar
  userId: string
  sessionId: string
  invitationId: string
}): Promise<string> {
  const { env, tenant, userId, sessionId, invitationId } = opts
  if (
    !userId ||
    userId.length > MAX_IDENTIFIER_LENGTH ||
    !sessionId ||
    sessionId.length > MAX_IDENTIFIER_LENGTH ||
    !invitationId ||
    invitationId.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new AppError('server_error')
  }
  const signer = await loadActiveSigner(tenant, env.KEK)
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: signer.alg, kid: signer.kid },
      payload: {
        iss: tenant.issuer,
        sub: userId,
        jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
        iat: now,
        exp: now + INVITATION_AUTH_CONTINUATION_TTL_MS / 1000,
        purpose: PURPOSE,
        tenant_id: tenant.tenantId,
        sid: sessionId,
        invitation_id: invitationId,
      },
    },
    signer.privateKey,
  )
}

export function invitationAuthContinuationPath(token: string): string {
  return `/accept-invitation?continuation_token=${encodeURIComponent(token)}`
}

export async function verifyInvitationAuthContinuation(
  c: Context<XidHonoEnv>,
  rawToken: string,
): Promise<InvitationAuthContinuation> {
  const tenant = await resolveTokenTenant(c, rawToken, 'invitation_invalid')
  const verified = await verifyJwt(rawToken, await buildVerifyKeySet(tenant), {
    expectedIssuer: tenant.issuer,
  })
  if (!verified.ok) throw new AppError('invitation_invalid')
  const {
    sub: userId,
    jti,
    iat,
    exp,
    purpose,
    tenant_id: tenantId,
    sid: sessionId,
    invitation_id: invitationId,
  } = verified.value.payload
  if (
    purpose !== PURPOSE ||
    typeof jti !== 'string' ||
    !jti ||
    typeof iat !== 'number' ||
    !Number.isSafeInteger(iat) ||
    typeof exp !== 'number' ||
    !Number.isSafeInteger(exp) ||
    exp <= iat ||
    tenantId !== tenant.tenantId ||
    typeof userId !== 'string' ||
    !userId ||
    userId.length > MAX_IDENTIFIER_LENGTH ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    sessionId.length > MAX_IDENTIFIER_LENGTH ||
    typeof invitationId !== 'string' ||
    !invitationId ||
    invitationId.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new AppError('invitation_invalid')
  }
  return { tenant, userId, sessionId, invitationId }
}
