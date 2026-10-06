// Passkey 作为第二因子或 step-up 时可挑战的凭证:MFA 门控、/mfa 因子列表与 passkey MFA options/verify 共用。
// 登录挑战(pending_mfa)排除一次认证已用过的方法类别;step-up(active)接受任意未吊销凭证重新认证。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { mfaMethodsUsedByPrimary, type MfaMethod } from '../lib/auth-context'
import { PENDING_MFA_SESSION_STATUS } from '../lib/session'
import type { SessionData } from '../lib/types'
import { PASSKEY_LIMIT } from './passkey-helpers'

export type EligiblePasskeyCredential = {
  id: string
  credentialId: string
  transports: string[]
  deviceName: string | null
  createdAt: Date
}

export type MfaChallengeContext = Pick<SessionData, 'userId' | 'amr'> & {
  status: SessionData['status'] | 'gate'
}

// gate:一次认证刚完成、session 尚未签发,与 pending_mfa 同属本次登录的第二因子挑战。
// SMS 登录的会话在 step-up 中同样不接受 SMS:同一持有因子不能再次证明身份;SMS 因子必伴随强因子,不会无方法可用。
// passkey 会话的 step-up 仍接受 passkey:passkey-only 用户没有别的方法可以重新验证。
export function excludedMfaMethods(context: MfaChallengeContext): readonly MfaMethod[] {
  const isLoginChallenge =
    context.status === 'gate' || context.status === PENDING_MFA_SESSION_STATUS
  const used = mfaMethodsUsedByPrimary(context.amr)
  return isLoginChallenge ? used : used.filter((method) => method === 'sms')
}

export async function listEligiblePasskeyCredentials(
  db: ReturnType<typeof createTenantDb>,
  context: MfaChallengeContext,
): Promise<EligiblePasskeyCredential[]> {
  if (excludedMfaMethods(context).includes('passkey')) return []
  const rows = await db.passkeyCredentials.findMany(
    and(
      eq(schema.passkeyCredentials.userId, context.userId),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
    { limit: PASSKEY_LIMIT },
  )
  return rows.map((row) => ({
    id: row.id,
    credentialId: row.credentialId,
    transports: row.transports ?? [],
    deviceName: row.deviceName ?? null,
    createdAt: row.createdAt,
  }))
}
