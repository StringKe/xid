// Passkey MFA 可挑战凭证筛选:与 passkey-mfa-challenge / mfa-factors 列表对齐。
// 主 passkey 登录(phr)后仅允许已链接 mfa_factors 的凭证作第二因子。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { SessionData } from '../lib/types'
import { PASSKEY_LIMIT } from './passkey-helpers'

export type EligiblePasskeyCredential = {
  credentialId: string
  transports: string[]
  backedUp: boolean
  credentialDeviceType: string
  attestationFmt: string
  enterpriseAttestationVerified: boolean
}

function sessionUsedPasskeyPrimary(session: SessionData): boolean {
  return Boolean(session.amr?.includes('phr'))
}

export async function listEligiblePasskeyCredentials(
  db: ReturnType<typeof createTenantDb>,
  session: SessionData,
): Promise<EligiblePasskeyCredential[]> {
  const rows = await db.passkeyCredentials.findMany(
    and(
      eq(schema.passkeyCredentials.userId, session.userId),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
    { limit: PASSKEY_LIMIT },
  )
  if (!sessionUsedPasskeyPrimary(session)) {
    return rows.map((row) => ({
      credentialId: row.credentialId,
      transports: row.transports ?? [],
      backedUp: row.backedUp,
      credentialDeviceType: row.credentialDeviceType,
      attestationFmt: row.attestationFmt,
      enterpriseAttestationVerified: row.enterpriseAttestationVerified,
    }))
  }

  const passkeyFactors = await db.mfaFactors.findMany(
    and(
      eq(schema.mfaFactors.userId, session.userId),
      eq(schema.mfaFactors.status, 'active'),
      eq(schema.mfaFactors.factorType, 'passkey'),
    ),
    { limit: PASSKEY_LIMIT },
  )
  const linkedIds = new Set(
    passkeyFactors
      .map((factor) => factor.passkeyCredentialId)
      .filter((id): id is string => Boolean(id)),
  )
  return rows
    .filter((row) => linkedIds.has(row.credentialId))
    .map((row) => ({
      credentialId: row.credentialId,
      transports: row.transports ?? [],
      backedUp: row.backedUp,
      credentialDeviceType: row.credentialDeviceType,
      attestationFmt: row.attestationFmt,
      enterpriseAttestationVerified: row.enterpriseAttestationVerified,
    }))
}
