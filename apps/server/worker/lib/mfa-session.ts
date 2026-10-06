import { createTenantDb, schema } from '@xid-kit/db'
import type { AmrValue } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { normalizeLocalContinuePath } from '../../shared/hosted-auth-continuation'
import { isProductSignUpIntent } from '../../shared/hosted-auth-intent'
import {
  addMfaToAuthContext,
  normalizeAuthAssuranceLevel,
  normalizeIssuedAcr,
  PASSWORD_AUTH_CONTEXT,
  type MfaMethod,
} from './auth-context'
import { AppError } from './errors'
import { listMfaMethods } from './mfa-methods'
import {
  ACTIVE_SESSION_STATUS,
  PENDING_MFA_SESSION_STATUS,
  PENDING_MFA_SETUP_SESSION_STATUS,
  readSession,
  type ReadSessionStatus,
} from './session'
import type { SessionData, TenantVar, XidHonoEnv } from './types'

export { PENDING_MFA_SESSION_STATUS, PENDING_MFA_SETUP_SESSION_STATUS }

type PrimaryAuthInput = {
  userId: string
  sessionAmr: readonly AmrValue[] | null
}

export async function shouldRequireMfaChallenge(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: PrimaryAuthInput,
): Promise<boolean> {
  if (tenant.policy.mfaEnforcement === 'disabled') return false
  const methods = await listMfaMethods(c, tenant, {
    userId: input.userId,
    amr: input.sessionAmr,
    status: 'gate',
  })
  return methods.length > 0
}

// passkey 主认证带 UV 已达 AAL2,本身满足强制 MFA,不再要求另行绑定。
export async function shouldRequireMfaSetup(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: PrimaryAuthInput,
): Promise<boolean> {
  if (tenant.policy.mfaEnforcement !== 'required') return false
  if (input.sessionAmr?.includes('phr')) return false
  return !(await shouldRequireMfaChallenge(c, tenant, input))
}

export function sanitizeLocalReturn(value: string | undefined | null, fallback: string): string {
  return normalizeLocalContinuePath(value) ?? fallback
}

export function postAuthRedirectPath(opts: {
  invitationToken?: string | null
  intent?: string | null
  continueParam?: string | null
  fallback: string
}): string {
  const token = opts.invitationToken?.trim()
  if (token) return `/accept-invitation?token=${encodeURIComponent(token)}`
  if (isProductSignUpIntent(opts.intent)) return '/create-organization'
  return sanitizeLocalReturn(opts.continueParam, opts.fallback)
}

export function mfaRedirectPath(returnTo: string): string {
  const params = new URLSearchParams({ redirect_to: returnTo })
  return `/mfa?${params.toString()}`
}

export function mfaSetupRedirectPath(returnTo: string): string {
  const params = new URLSearchParams({ setup: 'mfa', redirect_to: returnTo })
  return `/account/security?${params.toString()}`
}

// MFA 挑战与 step-up 端点:只接受 active(step-up)与 pending_mfa(登录第二因子)。
export async function requireMfaSession(c: Context<XidHonoEnv>): Promise<SessionData> {
  const allowed: readonly ReadSessionStatus[] = [ACTIVE_SESSION_STATUS, PENDING_MFA_SESSION_STATUS]
  const current = c.get('session')
  if (current && allowed.includes(current.status)) return current
  const session = await readSession(c, allowed)
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  c.set('session', session)
  return session
}

// 完成一个第二因子后把会话升为 active,并在同一次写入里记录 acr/amr/aal。
export async function completeMfaOnSession(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { session: SessionData; method: MfaMethod },
): Promise<void> {
  const { session, method } = input
  const next = addMfaToAuthContext(
    {
      acr: normalizeIssuedAcr(session.acr) ?? PASSWORD_AUTH_CONTEXT.acr,
      amr: session.amr ?? PASSWORD_AUTH_CONTEXT.amr,
      aal: normalizeAuthAssuranceLevel(session.aal) ?? 1,
    },
    method,
  )
  const db = createTenantDb(c.env.DB, tenant)
  await db.sessions.update(
    {
      status: ACTIVE_SESSION_STATUS,
      lastActiveAt: new Date(),
      acr: next.acr,
      amr: [...next.amr],
      aal: next.aal,
    },
    eq(schema.sessions.id, session.sessionId),
  )
}

// 强制绑定期间登记因子后,仅在租户 MFA 要求已满足时把 session 升为 active;绑定时的验证即一次第二因子。
export async function activateSessionAfterMfaSetup(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { session: SessionData; method: MfaMethod },
): Promise<void> {
  const { session } = input
  if (session.status !== PENDING_MFA_SETUP_SESSION_STATUS) return
  const requirement = { userId: session.userId, sessionAmr: session.amr ?? null }
  if (await shouldRequireMfaSetup(c, tenant, requirement)) return
  await completeMfaOnSession(c, tenant, input)
}

export type PostAuthMfaGate = {
  sessionStatus?: ReadSessionStatus
  redirectUrl?: string
}

export type PostAuthMfaGateInput = PrimaryAuthInput & {
  returnPath: string
}

// 登录后 MFA 门控:先 challenge(已有可用第二因子),再 setup(强制 MFA 但无可用因子)。
export async function resolvePostAuthMfaGate(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: PostAuthMfaGateInput,
): Promise<PostAuthMfaGate> {
  if (await shouldRequireMfaChallenge(c, tenant, input)) {
    return {
      sessionStatus: PENDING_MFA_SESSION_STATUS,
      redirectUrl: mfaRedirectPath(input.returnPath),
    }
  }
  if (await shouldRequireMfaSetup(c, tenant, input)) {
    return {
      sessionStatus: PENDING_MFA_SETUP_SESSION_STATUS,
      redirectUrl: mfaSetupRedirectPath(input.returnPath),
    }
  }
  return {}
}
