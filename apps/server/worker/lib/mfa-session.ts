import { createTenantDb, schema } from '@xid-kit/db'
import type { AmrValue } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { isProductSignUpIntent } from '../../shared/hosted-auth-intent'
import { smsDeliveryReady } from '../auth/delivery-channels'
import {
  PENDING_MFA_SESSION_STATUS,
  PENDING_MFA_SETUP_SESSION_STATUS,
  type ReadSessionStatus,
} from './session'
import type { TenantVar, XidHonoEnv } from './types'

export { PENDING_MFA_SESSION_STATUS, PENDING_MFA_SETUP_SESSION_STATUS }

function sessionUsedPasskeyPrimary(sessionAmr?: readonly AmrValue[] | null): boolean {
  return Boolean(sessionAmr?.includes('phr'))
}

async function hasChallengeablePasskeyFactor(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
  sessionAmr?: readonly AmrValue[] | null,
): Promise<boolean> {
  if (!sessionUsedPasskeyPrimary(sessionAmr)) {
    const credential = await db.passkeyCredentials.findOne(
      and(
        eq(schema.passkeyCredentials.userId, userId),
        isNull(schema.passkeyCredentials.revokedAt),
      ),
    )
    return credential !== undefined
  }

  const passkeyFactor = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.status, 'active'),
      eq(schema.mfaFactors.factorType, 'passkey'),
    ),
  )
  return passkeyFactor !== undefined
}

export async function shouldRequireMfaChallenge(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  userId: string,
  sessionAmr?: readonly AmrValue[] | null,
): Promise<boolean> {
  if (tenant.policy.mfaEnforcement === 'disabled') return false
  const db = createTenantDb(c.env.DB, tenant)
  const factor = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.status, 'active'),
      eq(schema.mfaFactors.factorType, 'totp'),
    ),
  )
  if (factor) return true

  const backup = await db.backupCodes.findOne(
    and(eq(schema.backupCodes.userId, userId), eq(schema.backupCodes.used, false)),
  )
  if (backup) return true

  if (await hasChallengeablePasskeyFactor(db, userId, sessionAmr)) return true

  if (!smsDeliveryReady(tenant, c.env)) return false
  const phone = await db.userPhones.findOne(
    and(eq(schema.userPhones.userId, userId), eq(schema.userPhones.verified, true)),
  )
  return Boolean(phone)
}

export async function shouldRequireMfaSetup(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  userId: string,
  sessionAmr?: readonly AmrValue[] | null,
): Promise<boolean> {
  if (tenant.policy.mfaEnforcement !== 'required') return false
  if (await shouldRequireMfaChallenge(c, tenant, userId, sessionAmr)) return false
  return true
}

export function sanitizeLocalReturn(value: string | undefined | null): string {
  if (!value) return '/console'
  if (!value.startsWith('/') || value.startsWith('//')) return '/console'
  try {
    const parsed = new URL(value, 'https://xid.local')
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/console'
  }
}

export function postAuthRedirectPath(opts: {
  invitationToken?: string | null
  intent?: string | null
  continueParam?: string | null
}): string {
  const token = opts.invitationToken?.trim()
  if (token) return `/accept-invitation?token=${encodeURIComponent(token)}`
  if (isProductSignUpIntent(opts.intent)) return '/create-organization'
  return sanitizeLocalReturn(opts.continueParam)
}

export function mfaRedirectPath(returnTo: string | undefined | null): string {
  const params = new URLSearchParams({ redirect_to: sanitizeLocalReturn(returnTo) })
  return `/mfa?${params.toString()}`
}

export function mfaSetupRedirectPath(returnTo: string | undefined | null): string {
  const params = new URLSearchParams({
    setup: 'mfa',
    redirect_to: sanitizeLocalReturn(returnTo),
  })
  return `/account/security?${params.toString()}`
}

export type PostAuthMfaGate = {
  sessionStatus?: ReadSessionStatus
  redirectUrl?: string
}

export type PostAuthMfaGateInput = {
  userId: string
  returnPath: string
  sessionAmr?: readonly AmrValue[] | null
}

// 登录后 MFA 门控:先 challenge(已有因子待验证),再 setup(强制 MFA 但无因子)。
export async function resolvePostAuthMfaGate(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: PostAuthMfaGateInput,
): Promise<PostAuthMfaGate> {
  const requiresChallenge = await shouldRequireMfaChallenge(
    c,
    tenant,
    input.userId,
    input.sessionAmr,
  )
  if (requiresChallenge) {
    return {
      sessionStatus: PENDING_MFA_SESSION_STATUS,
      redirectUrl: mfaRedirectPath(input.returnPath),
    }
  }
  const requiresSetup = await shouldRequireMfaSetup(c, tenant, input.userId, input.sessionAmr)
  if (requiresSetup) {
    return {
      sessionStatus: PENDING_MFA_SETUP_SESSION_STATUS,
      redirectUrl: mfaSetupRedirectPath(input.returnPath),
    }
  }
  return {}
}
