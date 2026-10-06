// 密码重置 / 首次设密 token:签发(JWT + DB 只存 sha256)与重置邮件入队。
// 续跑上下文(intent / continue / client_id)和收件邮箱哈希写进签名 claim,重置成功后据此回到原流程。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNotNull, lte, or } from 'drizzle-orm'
import type { HostedAuthFlowResolution } from '../../shared/hosted-auth-continuation'
import { createResetToken } from '../auth/password'
import type { ResetTokenContext } from '../auth/password'
import { recordAuthTokenIssued } from '../auth/token-audit'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { enqueueTransactionalEmail } from '../lib/transactional-email'
import type { TenantVar } from '../lib/types'
import { loadActiveSigner } from '../oidc/shared'

const RESET_PURPOSE = 'password_reset'

export type ResetFlow = Pick<
  HostedAuthFlowResolution,
  'intent' | 'continuePath' | 'applicationClientId'
>

type IssueResetTokenInput = {
  env: Env
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  userId: string
  flow?: ResetFlow | null
  email?: string | null
}

async function resetTokenContext(input: IssueResetTokenInput): Promise<Partial<ResetTokenContext>> {
  const email = input.email?.trim().toLowerCase()
  return {
    intent: input.flow?.intent ?? null,
    continuePath: input.flow?.continuePath ?? null,
    clientId: input.flow?.applicationClientId ?? null,
    emailHash: email ? await sha256Hex(email) : null,
  }
}

export async function issuePasswordResetToken(
  input: IssueResetTokenInput,
): Promise<{ token: string; expiresAt: Date }> {
  const { env, tenant, db, userId } = input
  const signer = await loadActiveSigner(tenant, env.KEK)
  const { token, tokenHash, expiresAt } = await createResetToken(userId, signer, {
    issuer: tenant.issuer,
    tenantId: tenant.tenantId,
    context: await resetTokenContext(input),
  })
  await db.passwordResetTokens.hardDelete(
    and(
      eq(schema.passwordResetTokens.userId, userId),
      eq(schema.passwordResetTokens.purpose, RESET_PURPOSE),
      or(
        isNotNull(schema.passwordResetTokens.consumedAt),
        lte(schema.passwordResetTokens.expiresAt, new Date()),
      ),
    ),
  )
  await db.passwordResetTokens.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    userId,
    tokenHash,
    purpose: RESET_PURPOSE,
    expiresAt,
  })
  await recordAuthTokenIssued({ env, tenant, purpose: RESET_PURPOSE, userId, kid: signer.kid })
  return { token, expiresAt }
}

export async function sendPasswordResetEmail(
  input: IssueResetTokenInput & { email: string; locale: string },
): Promise<void> {
  const { token } = await issuePasswordResetToken(input)
  const fragment = new URLSearchParams({ token }).toString()
  await enqueueTransactionalEmail(input.env, {
    type: 'password_reset',
    recipient: input.email,
    locale: input.locale,
    payload: {
      tenantId: input.tenant.tenantId,
      userId: input.userId,
      token,
      link: `${hostedAuthOriginForTenant(input.tenant)}/reset-password#${fragment}`,
      expires: 15,
      expiresInMin: 15,
    },
  })
}
