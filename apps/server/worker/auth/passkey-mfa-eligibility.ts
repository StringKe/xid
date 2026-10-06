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
export function excludedMfaMethods(context: MfaChallengeContext): readonly MfaMethod[] {
  const isLoginChallenge =
    context.status === 'gate' || context.status === PENDING_MFA_SESSION_STATUS
  return isLoginChallenge ? mfaMethodsUsedByPrimary(context.amr) : []
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
