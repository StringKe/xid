// 邮箱验证 JWT(ES256):明文不入库,仅存 jti SHA-256;一次性消费。

import { base64UrlEncode, sha256Hex, signJwt, verifyJwt } from '@xid-kit/crypto'
import type { JwtClaims } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm'
import { AppError } from '../lib/errors'
import type { TenantVar } from '../lib/types'
import { buildVerifyKeySet, loadActiveSigner } from '../oidc/shared'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { recordAuthTokenIssued } from '../auth/token-audit'
import { EMAIL_VERIFY_TTL_MS } from '../lib/ttl'
import { isHostedAuthIntent, type HostedAuthIntent } from '../../shared/hosted-auth-intent'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'

const PURPOSE = 'email_verification'
const MAX_INVITATION_ID_LENGTH = 255

export type VerifiedEmailToken = {
  jti: string
  userId: string
  emailHash: string
  intent: HostedAuthIntent | null
  continuePath: string | null
  applicationClientId: string | null
  invitationId: string | null
}

// 签发邮箱验证 token + 持久化 jti 哈希;TTL 内未消费的旧链接继续有效。
export async function issueEmailVerification(opts: {
  env: Env
  tenant: TenantVar
  userId: string
  email: string
  intent?: HostedAuthIntent
  continuePath?: string | null
  applicationClientId?: string | null
  invitationId?: string | null
}): Promise<void> {
  const { env, tenant, userId, email, intent } = opts
  if (intent !== undefined && !isHostedAuthIntent(intent)) throw new AppError('invalid_request')
  const invitationId = opts.invitationId?.trim() || null
  if (invitationId) {
    throw new AppError('invalid_request')
  }
  const flow = resolveHostedAuthFlow({
    intent,
    continuePath: opts.continuePath,
    applicationClientId: opts.applicationClientId,
    hasInvitation: invitationId !== null,
  })
  if (!flow) throw new AppError('invalid_request')
  const hasFlowContext = Boolean(
    intent || opts.continuePath || opts.applicationClientId || invitationId,
  )
  const normalizedEmail = email.trim().toLowerCase()
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
    email_hash: await sha256Hex(normalizedEmail),
    ...(flow.intent ? { intent: flow.intent } : {}),
    ...(hasFlowContext ? { continue_path: flow.continuePath } : {}),
    ...(flow.applicationClientId ? { client_id: flow.applicationClientId } : {}),
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
      or(
        isNotNull(schema.verificationTokens.consumedAt),
        lte(schema.verificationTokens.expiresAt, new Date()),
      ),
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
    recipient: normalizedEmail,
    payload: {
      tenantId: tenant.tenantId,
      userId,
      token,
      link: `${origin}/verify-email#${new URLSearchParams({ token }).toString()}`,
      expires: 15,
      expiresInMin: 15,
    },
  })
}

// 验签邮箱验证 JWT:签名(租户公钥集)+ exp + iss + purpose,提取精确 Email 目标。失败抛 token_*。
export async function verifyEmailVerifyJwt(
  tenant: TenantVar,
  rawToken: string,
): Promise<VerifiedEmailToken> {
  const verifyKeys = await buildVerifyKeySet(tenant)
  const verified = await verifyJwt(rawToken, verifyKeys, { expectedIssuer: tenant.issuer })
  if (!verified.ok) {
    throw new AppError(verified.error.reason === 'expired' ? 'token_expired' : 'token_invalid')
  }
  const {
    sub: userId,
    jti,
    purpose,
    email_hash: emailHash,
    intent,
    continue_path: rawContinuePath,
    client_id: rawApplicationClientId,
    invitation_id: rawInvitationId,
  } = verified.value.payload
  if (!userId || !jti || purpose !== PURPOSE) throw new AppError('token_invalid')
  if (typeof emailHash !== 'string' || !/^[0-9a-f]{64}$/.test(emailHash)) {
    throw new AppError('token_invalid')
  }
  if (
    (intent !== undefined && (typeof intent !== 'string' || !isHostedAuthIntent(intent))) ||
    (rawContinuePath !== undefined && typeof rawContinuePath !== 'string') ||
    (rawApplicationClientId !== undefined && typeof rawApplicationClientId !== 'string') ||
    (rawInvitationId !== undefined &&
      (typeof rawInvitationId !== 'string' ||
        !rawInvitationId ||
        rawInvitationId.length > MAX_INVITATION_ID_LENGTH))
  ) {
    throw new AppError('token_invalid')
  }
  const hasFlowContext =
    intent !== undefined ||
    rawContinuePath !== undefined ||
    rawApplicationClientId !== undefined ||
    rawInvitationId !== undefined
  // 存量仅 intent=sign-up 的 token 映射到同一产品 onboarding 目的地(一个 TTL 窗口内兼容)。
  const legacyProductSignUp =
    intent === 'sign-up' &&
    rawContinuePath === undefined &&
    rawApplicationClientId === undefined &&
    rawInvitationId === undefined
  const flow = resolveHostedAuthFlow({
    intent: typeof intent === 'string' ? intent : null,
    continuePath: typeof rawContinuePath === 'string' ? rawContinuePath : null,
    applicationClientId: typeof rawApplicationClientId === 'string' ? rawApplicationClientId : null,
    hasInvitation: rawInvitationId !== undefined,
  })
  if (
    !flow ||
    (hasFlowContext && !legacyProductSignUp && rawContinuePath !== flow.continuePath) ||
    (!hasFlowContext && rawContinuePath !== undefined)
  ) {
    throw new AppError('token_invalid')
  }
  return {
    jti,
    userId,
    emailHash,
    intent: hasFlowContext ? flow.intent : null,
    continuePath: hasFlowContext ? flow.continuePath : null,
    applicationClientId: hasFlowContext ? flow.applicationClientId : null,
    invitationId: typeof rawInvitationId === 'string' ? rawInvitationId : null,
  }
}

// 按 tokenHash=sha256(jti) 加载可消费行，调用方可把消费与目标 Email 更新放进同一 D1 transaction。
export async function loadEmailVerifyToken(
  db: ReturnType<typeof createTenantDb>,
  jti: string,
): Promise<typeof schema.verificationTokens.$inferSelect> {
  const tokenHash = await sha256Hex(jti)
  const row = await db.verificationTokens.findOne(
    eq(schema.verificationTokens.tokenHash, tokenHash),
  )
  if (!row || row.consumedAt !== null) throw new AppError('token_invalid')
  if (row.expiresAt.getTime() <= Date.now()) throw new AppError('token_expired')
  if (row.purpose !== PURPOSE) throw new AppError('token_invalid')
  return row
}

// jti 一次性消费:按 tokenHash=sha256(jti) 查行 + 状态校验 + 标记 consumed,返回绑定 userId(防重放)。
export async function consumeEmailVerifyToken(
  db: ReturnType<typeof createTenantDb>,
  jti: string,
): Promise<string> {
  const row = await loadEmailVerifyToken(db, jti)
  const tokenHash = await sha256Hex(jti)
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
