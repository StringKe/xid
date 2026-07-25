// 邮箱验证 token 签发/核销(sign-up 的 verify_email 分支 + /auth/verify-email + /auth/resend-verification 共用)。
// 对齐 magic-link.ts 模式:token = 租户 active 签名密钥(ES256)签的 JWT(sub/exp/jti,purpose='email_verification'),
// server 只存 jti 的 SHA-256 哈希(verificationTokens.tokenHash),token 明文不入 DB。一次性消费 consumedAt。
// JWT 验签走 buildVerifyKeySet/verifyJwt @ oidc/shared(租户公钥集)。

import { base64UrlEncode, sha256Hex, signJwt, verifyJwt } from '@xid-kit/crypto'
import type { JwtClaims } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { AppError } from '../lib/errors'
import type { TenantVar } from '../lib/types'
import { buildVerifyKeySet, loadActiveSigner } from '../oidc/shared'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { recordAuthTokenIssued } from '../auth/token-audit'
import { EMAIL_VERIFY_TTL_MS } from '../lib/ttl'

const PURPOSE = 'email_verification'

// 签发邮箱验证 token + 持久化 jti 哈希(删旧同 purpose token),入队发验证邮件。
export async function issueEmailVerification(opts: {
  env: Env
  tenant: TenantVar
  userId: string
  email: string
}): Promise<void> {
  const { env, tenant, userId, email } = opts
  const origin = hostedAuthOriginForTenant(tenant)
  const signer = await loadActiveSigner(tenant, env.KEK)
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtClaims = {
    iss: tenant.issuer,
    sub: userId,
    jti,
    iat: now,
    exp: now + EMAIL_VERIFY_TTL_MS / 1000,
    purpose: PURPOSE,
    tenant_id: tenant.tenantId,
  }
  const token = await signJwt(
    { header: { alg: signer.alg, kid: signer.kid }, payload },
    signer.privateKey,
  )
  const tokenHash = await sha256Hex(jti)

  const db = createTenantDb(env.DB, tenant)
  await db.verificationTokens.hardDelete(
    and(
      eq(schema.verificationTokens.userId, userId),
      eq(schema.verificationTokens.purpose, PURPOSE),
    ),
  )
  await db.verificationTokens.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    userId,
    tokenHash,
    purpose: PURPOSE,
    expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
  })
  await recordAuthTokenIssued({
    env,
    tenant,
    purpose: PURPOSE,
    userId,
    kid: signer.kid,
  })

  await env.EMAIL_QUEUE.send({
    type: 'verify_email',
    recipient: email,
    payload: {
      tenantId: tenant.tenantId,
      userId,
      token,
      link: `${origin}/verify-email?token=${encodeURIComponent(token)}`,
      expires: 15,
      expiresInMin: 15,
    },
  })
}

// 验签邮箱验证 JWT:签名(租户公钥集)+ exp + iss + purpose,提取 jti。失败抛 token_*。
export async function verifyEmailVerifyJwt(tenant: TenantVar, rawToken: string): Promise<string> {
  const verifyKeys = await buildVerifyKeySet(tenant)
  const verified = await verifyJwt(rawToken, verifyKeys, { expectedIssuer: tenant.issuer })
  if (!verified.ok) {
    throw new AppError(verified.error.reason === 'expired' ? 'token_expired' : 'token_invalid')
  }
  const { sub: userId, jti, purpose } = verified.value.payload
  if (!userId || !jti || purpose !== PURPOSE) throw new AppError('token_invalid')
  return jti
}

// jti 一次性消费:按 tokenHash=sha256(jti) 查行 + 状态校验 + 标记 consumed,返回绑定 userId(防重放)。
export async function consumeEmailVerifyToken(
  db: ReturnType<typeof createTenantDb>,
  jti: string,
): Promise<string> {
  const tokenHash = await sha256Hex(jti)
  const row = await db.verificationTokens.findOne(
    eq(schema.verificationTokens.tokenHash, tokenHash),
  )
  if (!row || row.consumedAt !== null) throw new AppError('token_invalid')
  if (row.expiresAt.getTime() <= Date.now()) throw new AppError('token_expired')
  if (row.purpose !== PURPOSE) throw new AppError('token_invalid')
  const consumed = await db.verificationTokens.update(
    { consumedAt: new Date() },
    and(
      eq(schema.verificationTokens.tokenHash, tokenHash),
      eq(schema.verificationTokens.purpose, PURPOSE),
      isNull(schema.verificationTokens.consumedAt),
      gt(schema.verificationTokens.expiresAt, new Date()),
    ),
  )
  if (consumed && consumed.length === 0 && row.id) throw new AppError('token_invalid')
  return row.userId
}
