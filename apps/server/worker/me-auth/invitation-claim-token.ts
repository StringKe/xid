// Invitation Email claim 是独立于 user 的短期证明。JWT 只绑定 invitationId、Tenant 和
// 精确 Email 哈希；数据库只保存 jti 哈希，raw invitation token 和 claim token 均不落库。

import { base64UrlEncode, sha256Hex, signJwt, verifyJwt } from '@xid-kit/crypto'
import type { JwtClaims } from '@xid-kit/crypto'
import { AppError } from '../lib/errors'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import type { TenantVar } from '../lib/types'
import { INVITATION_EMAIL_CLAIM_TTL_MS } from '../lib/ttl'
import { buildVerifyKeySet, loadActiveSigner } from '../oidc/shared'

export const INVITATION_EMAIL_CLAIM_PURPOSE = 'invitation_email_claim'

export type SignedInvitationEmailClaim = {
  invitationId: string
  jti: string
  emailHash: string
}

export async function signInvitationEmailClaim(opts: {
  env: Env
  tenant: TenantVar
  invitationId: string
  normalizedEmail: string
}): Promise<{
  token: string
  tokenHash: string
  emailHash: string
  expiresAt: Date
  verifyUrl: string
}> {
  const { env, tenant, invitationId, normalizedEmail } = opts
  const signer = await loadActiveSigner(tenant, env.KEK)
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const emailHash = await sha256Hex(normalizedEmail)
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtClaims = {
    iss: tenant.issuer,
    sub: invitationId,
    jti,
    iat: now,
    exp: now + INVITATION_EMAIL_CLAIM_TTL_MS / 1000,
    purpose: INVITATION_EMAIL_CLAIM_PURPOSE,
    tenant_id: tenant.tenantId,
    email_hash: emailHash,
  }
  const token = await signJwt(
    { header: { alg: signer.alg, kid: signer.kid }, payload },
    signer.privateKey,
  )
  const verifyUrl = new URL('/accept-invitation', hostedAuthOriginForTenant(tenant))
  verifyUrl.hash = new URLSearchParams({ claim_token: token }).toString()
  return {
    token,
    tokenHash: await sha256Hex(jti),
    emailHash,
    expiresAt: new Date(Date.now() + INVITATION_EMAIL_CLAIM_TTL_MS),
    verifyUrl: verifyUrl.toString(),
  }
}

export async function verifyInvitationEmailClaimJwt(
  tenant: TenantVar,
  rawToken: string,
): Promise<SignedInvitationEmailClaim> {
  const verified = await verifyJwt(rawToken, await buildVerifyKeySet(tenant), {
    expectedIssuer: tenant.issuer,
  })
  if (!verified.ok) {
    throw new AppError(verified.error.reason === 'expired' ? 'token_expired' : 'token_invalid')
  }
  const {
    sub: invitationId,
    jti,
    purpose,
    tenant_id: tenantId,
    email_hash: emailHash,
  } = verified.value.payload
  if (
    typeof invitationId !== 'string' ||
    invitationId.length === 0 ||
    invitationId.length > 255 ||
    typeof jti !== 'string' ||
    jti.length === 0 ||
    purpose !== INVITATION_EMAIL_CLAIM_PURPOSE ||
    tenantId !== tenant.tenantId ||
    typeof emailHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(emailHash)
  ) {
    throw new AppError('token_invalid')
  }
  return { invitationId, jti, emailHash }
}
